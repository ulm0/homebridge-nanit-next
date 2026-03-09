import type { Logging } from 'homebridge';
import { pickPort } from 'pick-port';

export class LocalRtmpServer {
  private _port = 0;
  private _isRunning = false;
  private nms: InstanceType<typeof import('node-media-server').default> | null = null;
  private activeStreams = new Set<string>();
  private streamWaiters = new Map<string, Array<() => void>>();
  /** Maps stream path → publisher IP (extracted from the RTMP session remote address) */
  private publisherIps = new Map<string, string>();

  constructor(
    private readonly log: Logging,
    private readonly preferredPort?: number,
  ) {}

  get port(): number {
    return this._port;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  async start(): Promise<number> {
    if (this._isRunning) return this._port;

    const NodeMediaServer = (await import('node-media-server')).default;

    this._port = this.preferredPort ?? await pickPort({ type: 'tcp', reserveTimeout: 5 });

    const config = {
      logType: 0,
      rtmp: {
        port: this._port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
    };

    this.nms = new NodeMediaServer(config);

    this.nms.on('prePublish', (...args: unknown[]) => {
      // node-media-server v4: event passes a session object with a streamPath property.
      // v2 legacy: (id, streamPath, params) — kept as fallback.
      const session = args[0] as Record<string, unknown>;
      const streamPath = (typeof session?.streamPath === 'string' ? session.streamPath : args[1]) as string;
      if (!streamPath) return;
      if (this.activeStreams.has(streamPath)) {
        this.log.debug(`RTMP stream already tracked, ignoring duplicate prePublish: ${streamPath}`);
        return;
      }
      this.log.debug(`RTMP stream publishing: ${streamPath}`);
      this.activeStreams.add(streamPath);

      // Extract and store the publisher's IP so callers can discover the camera's address
      const socket = session?.socket as Record<string, unknown> | undefined;
      const remoteAddress = socket?.remoteAddress as string | undefined;
      if (remoteAddress) {
        // Strip IPv4-mapped IPv6 prefix (::ffff:x.x.x.x → x.x.x.x)
        const ip = remoteAddress.replace(/^::ffff:/, '');
        this.publisherIps.set(streamPath, ip);
      }

      const waiters = this.streamWaiters.get(streamPath);
      if (waiters) {
        for (const resolve of waiters) resolve();
        this.streamWaiters.delete(streamPath);
      }
    });

    this.nms.on('donePublish', (...args: unknown[]) => {
      const session = args[0] as Record<string, unknown>;
      const streamPath = (typeof session?.streamPath === 'string' ? session.streamPath : args[1]) as string;
      if (!streamPath) return;
      this.log.debug(`RTMP stream ended: ${streamPath}`);
      this.activeStreams.delete(streamPath);
      this.publisherIps.delete(streamPath);
    });

    this.nms.run();
    this._isRunning = true;
    this.log.info(`Local RTMP server started on port ${this._port}`);

    return this._port;
  }

  isStreamActive(streamKey: string): boolean {
    return this.activeStreams.has(`/live/${streamKey}`);
  }

  /**
   * Returns the IP address of the RTMP publisher for the given stream key,
   * or null if the stream is not active or the IP could not be determined.
   */
  getPublisherIp(streamKey: string): string | null {
    return this.publisherIps.get(`/live/${streamKey}`) ?? null;
  }

  waitForStream(streamKey: string, timeoutMs = 15_000): Promise<boolean> {
    const streamPath = `/live/${streamKey}`;

    if (this.activeStreams.has(streamPath)) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const waiters = this.streamWaiters.get(streamPath);
        if (waiters) {
          const idx = waiters.indexOf(onReady);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) this.streamWaiters.delete(streamPath);
        }
        resolve(false);
      }, timeoutMs);

      const onReady = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(true);
      };

      let waiters = this.streamWaiters.get(streamPath);
      if (!waiters) {
        waiters = [];
        this.streamWaiters.set(streamPath, waiters);
      }
      waiters.push(onReady);
    });
  }

  getLocalRtmpUrl(streamKey: string, localAddress: string): string {
    return `rtmp://${localAddress}:${this._port}/live/${streamKey}`;
  }

  getLocalPlayUrl(streamKey: string): string {
    return `rtmp://127.0.0.1:${this._port}/live/${streamKey}`;
  }

  stop(): void {
    if (this.nms) {
      this.nms.stop();
      this.nms = null;
    }
    this.activeStreams.clear();
    this.publisherIps.clear();
    for (const waiters of this.streamWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.streamWaiters.clear();
    this._isRunning = false;
    this.log.info('Local RTMP server stopped');
  }
}
