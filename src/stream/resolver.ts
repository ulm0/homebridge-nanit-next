import type { Logging } from 'homebridge';
import type { StreamMode } from '../settings.js';
import type { NanitApiClient } from '../nanit/api.js';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import { LocalRtmpServer } from './local.js';
import { getCloudStreamUrl } from './cloud.js';
import type { StreamInfo } from '../nanit/types.js';
import { networkInterfaces } from 'node:os';

// Interfaces commonly created by Docker/container runtimes that should be
// skipped when auto-detecting the host LAN address.
const IGNORED_IFACE_PREFIXES = [
  'docker', 'br-', 'veth', 'cni', 'flannel', 'cali', 'tunl', 'weave',
  'virbr', 'lxc', 'lxd', 'podman',
];

export class StreamResolver {
  private rtmpServer: LocalRtmpServer;
  private readonly configuredAddress?: string;
  /** Serializes concurrent local stream negotiation to avoid competing stop/start sequences. */
  private negotiationLock: Promise<StreamInfo> | null = null;

  constructor(
    private readonly log: Logging,
    private readonly api: NanitApiClient,
    private readonly mode: StreamMode,
    rtmpPort?: number,
    localAddress?: string,
  ) {
    this.rtmpServer = new LocalRtmpServer(log, rtmpPort);
    this.configuredAddress = localAddress;
  }

  async initialize(): Promise<void> {
    if (this.mode === 'local' || this.mode === 'auto') {
      await this.rtmpServer.start();
    }
  }

  /** True when a local stream negotiation (stop/start/wait) is currently in progress. */
  get isNegotiating(): boolean {
    return this.negotiationLock !== null;
  }

  async getStreamSource(
    babyUid: string,
    wsClient: NanitWebSocketClient,
  ): Promise<StreamInfo> {
    if (this.mode === 'cloud') {
      return this.getCloudStream(babyUid, wsClient);
    }

    if (this.mode === 'local') {
      return this.serializedGetLocalStream(babyUid, wsClient);
    }

    // auto mode: try local first, fall back to cloud
    if (wsClient.isConnected) {
      try {
        return await this.serializedGetLocalStream(babyUid, wsClient);
      } catch (err) {
        this.log.warn('Local stream failed, falling back to cloud:', err);
      }
    }

    return this.getCloudStream(babyUid, wsClient);
  }

  /**
   * Returns the play URL of an already-active local stream for `babyUid`,
   * or null if no stream is currently publishing. Does NOT trigger any
   * negotiation — safe to call from the prebuffer without risk of competing
   * with an in-flight stop/start sequence.
   */
  getActiveStreamUrl(babyUid: string): string | null {
    if (this.rtmpServer.isRunning && this.rtmpServer.isStreamActive(babyUid)) {
      return this.rtmpServer.getLocalPlayUrl(babyUid);
    }
    return null;
  }

  private serializedGetLocalStream(
    babyUid: string,
    wsClient: NanitWebSocketClient,
  ): Promise<StreamInfo> {
    // If a negotiation is already in-flight for any stream, chain behind it
    // so we never have two concurrent stop/start sequences.
    const prev = this.negotiationLock ?? Promise.resolve(null);
    const next = prev
      .catch(() => null)
      .then(() => this.getLocalStream(babyUid, wsClient));

    this.negotiationLock = next;

    // Clear the lock reference once this attempt settles so future independent
    // calls start fresh. Use a separate .then/.catch to avoid creating an
    // additional unhandled-rejection branch on `next` itself.
    next.then(
      () => { if (this.negotiationLock === next) this.negotiationLock = null; },
      () => { if (this.negotiationLock === next) this.negotiationLock = null; },
    );

    return next;
  }

  /**
   * Waits up to `timeoutMs` for a local RTMP stream for `babyUid` to become
   * active. Returns the play URL on success, or null on timeout.
   * Does NOT trigger any negotiation.
   */
  waitForActiveStream(babyUid: string, timeoutMs = 30_000): Promise<string | null> {
    const playUrl = this.rtmpServer.getLocalPlayUrl(babyUid);

    return this.rtmpServer.waitForStream(babyUid, timeoutMs).then(ready =>
      ready ? playUrl : null,
    );
  }

  private async getCloudStream(
    babyUid: string,
    wsClient: NanitWebSocketClient,
  ): Promise<StreamInfo> {
    const url = await getCloudStreamUrl(this.api, babyUid);
    this.log.debug(`Using cloud stream: ${url.replace(/\.[^.]+$/, '.<token>')}`);

    try {
      await wsClient.startStreaming(url);
    } catch (err) {
      this.log.warn('Failed to signal camera to start cloud streaming:', err);
    }

    return { url, type: 'cloud' };
  }

  private static readonly LOCAL_STREAM_MAX_ATTEMPTS = 2;
  private static readonly LOCAL_STREAM_WAIT_MS = 15_000;

  private async getLocalStream(
    babyUid: string,
    wsClient: NanitWebSocketClient,
  ): Promise<StreamInfo> {
    if (!this.rtmpServer.isRunning) {
      await this.rtmpServer.start();
    }

    const localAddress = this.getLocalAddress();
    const streamKey = babyUid;
    const rtmpUrl = this.rtmpServer.getLocalRtmpUrl(streamKey, localAddress);

    if (!this.rtmpServer.isStreamActive(streamKey)) {
      try {
        await wsClient.stopStreaming();
      } catch {
        // Best effort
      }

      let ready = false;
      for (let attempt = 1; attempt <= StreamResolver.LOCAL_STREAM_MAX_ATTEMPTS; attempt++) {
        this.log.debug(`Requesting camera to publish locally (attempt ${attempt}/${StreamResolver.LOCAL_STREAM_MAX_ATTEMPTS})...`);
        await wsClient.startStreaming(rtmpUrl);

        ready = await this.rtmpServer.waitForStream(streamKey, StreamResolver.LOCAL_STREAM_WAIT_MS);
        if (ready) {
          break;
        }

        this.log.warn(`Camera did not start publishing within timeout (attempt ${attempt}/${StreamResolver.LOCAL_STREAM_MAX_ATTEMPTS})`);

        if (attempt < StreamResolver.LOCAL_STREAM_MAX_ATTEMPTS) {
          try {
            await wsClient.stopStreaming();
          } catch {
            // Best effort before retry
          }
        }
      }

      if (!ready) {
        throw new Error('Camera did not start publishing after all retry attempts');
      }
    }

    const playUrl = this.rtmpServer.getLocalPlayUrl(streamKey);
    this.log.debug(`Using local stream: ${playUrl}`);
    return { url: playUrl, type: 'local' };
  }

  async stopStream(wsClient: NanitWebSocketClient): Promise<void> {
    await wsClient.stopStreaming();
  }

  /**
   * Returns the local RTMP play URL for a baby if that stream is currently
   * active on the local server, or null otherwise.
   */
  getActiveLocalPlayUrl(babyUid: string): string | null {
    if (this.rtmpServer.isRunning && this.rtmpServer.isStreamActive(babyUid)) {
      return this.rtmpServer.getLocalPlayUrl(babyUid);
    }
    return null;
  }

  /**
   * Returns an RTMP ingest URL (reachable by the camera) for the given stream
   * key on the local RTMP server. The server must be running.
   */
  getLocalRtmpIngestUrl(streamKey: string): string | null {
    if (!this.rtmpServer.isRunning) return null;
    return this.rtmpServer.getLocalRtmpUrl(streamKey, this.getLocalAddress());
  }

  /**
   * Returns the IP address from which the camera is publishing its RTMP
   * stream. This is the camera's LAN IP, auto-detected from the RTMP session.
   * Returns null if the stream is not active or the IP is unknown.
   */
  getCameraPublisherIp(babyUid: string): string | null {
    return this.rtmpServer.getPublisherIp(babyUid);
  }

  getLocalAddress(): string {
    if (this.configuredAddress) {
      return this.configuredAddress;
    }

    const interfaces = networkInterfaces();
    const candidates: Array<{ name: string; address: string }> = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (IGNORED_IFACE_PREFIXES.some(p => name.startsWith(p))) {
        continue;
      }
      for (const iface of addrs ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          candidates.push({ name, address: iface.address });
        }
      }
    }

    if (candidates.length === 0) {
      this.log.warn(
        'No suitable network interface found for local streaming. '
        + 'Set "localAddress" in the plugin config to the IP the camera can reach.',
      );
      return '127.0.0.1';
    }

    if (candidates.length > 1) {
      this.log.warn(
        `Multiple network interfaces detected: ${candidates.map(c => `${c.name}=${c.address}`).join(', ')}. `
        + `Using ${candidates[0].address} (${candidates[0].name}). `
        + 'If this is wrong, set "localAddress" in the plugin config.',
      );
    }

    return candidates[0].address;
  }

  shutdown(): void {
    this.rtmpServer.stop();
  }
}
