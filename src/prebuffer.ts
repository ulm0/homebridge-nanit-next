import { spawn, type ChildProcess } from 'node:child_process';
import type { Logging } from 'homebridge';
import type { CameraRecordingConfiguration } from 'homebridge';
import type { StreamResolver } from './stream/resolver.js';
import type { NanitWebSocketClient } from './nanit/websocket.js';
import { findFfmpeg } from './utils.js';
import { HKSV_PREBUFFER_MS } from './settings.js';

export interface FMp4Segment {
  data: Buffer;
  timestamp: number;
}

const RESTART_DELAYS_MS = [10_000, 30_000, 60_000, 120_000];
const WS_WAIT_POLL_MS = 2_000;
const WS_WAIT_MAX_MS = 30_000;

/**
 * Reads an fMP4 stream from FFmpeg stdout and splits it into ISO BMFF boxes.
 * Emits `moov` (initialization segment) and `moof+mdat` pairs (media fragments).
 */
export class NanitPrebuffer {
  private ffmpeg: ChildProcess | null = null;
  private moovBox: Buffer | null = null;
  private segments: FMp4Segment[] = [];
  private streamConsumers: Set<(segment: FMp4Segment) => void> = new Set();
  private active = false;
  private destroyed = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private config: CameraRecordingConfiguration | undefined;

  private readonly videoProcessor: string;

  constructor(
    private readonly log: Logging,
    private readonly cameraName: string,
    private readonly babyUid: string,
    private readonly streamResolver: StreamResolver,
    private readonly wsClient: NanitWebSocketClient,
    private readonly debug: boolean = false,
  ) {
    this.videoProcessor = findFfmpeg();
  }

  setRecordingConfiguration(config: CameraRecordingConfiguration | undefined): void {
    this.config = config;
  }

  get isActive(): boolean {
    return this.active;
  }

  get moov(): Buffer | null {
    return this.moovBox;
  }

  /**
   * Returns prebuffered segments from the last `sinceMs` milliseconds.
   */
  getRecentSegments(sinceMs: number = HKSV_PREBUFFER_MS): FMp4Segment[] {
    const cutoff = Date.now() - sinceMs;
    return this.segments.filter(s => s.timestamp >= cutoff);
  }

  /**
   * Subscribe to live segment events as they arrive from FFmpeg.
   * Returns an unsubscribe function.
   */
  onSegment(handler: (segment: FMp4Segment) => void): () => void {
    this.streamConsumers.add(handler);
    return () => { this.streamConsumers.delete(handler); };
  }

  async start(): Promise<void> {
    if (this.active || this.destroyed) return;
    this.active = true;
    this.restartAttempt = 0;
    this.log.debug(`[${this.cameraName}] Starting HKSV prebuffer`);
    this.launchFfmpeg().catch(err => {
      this.log.error(`[${this.cameraName}] Prebuffer unexpected error:`, err);
    });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.log.debug(`[${this.cameraName}] Stopping HKSV prebuffer`);
    this.killFfmpeg();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.streamConsumers.clear();
  }

  private async launchFfmpeg(): Promise<void> {
    if (this.destroyed || !this.active) return;

    // Wait for the WebSocket to be connected before attempting stream negotiation.
    // This avoids the first-launch race where the WS is still connecting.
    const wsReady = await this.waitForWsConnection();
    if (!wsReady || this.destroyed || !this.active) return;

    let streamUrl: string;
    try {
      streamUrl = await this.resolveStreamUrl();
    } catch (err) {
      this.log.warn(`[${this.cameraName}] Prebuffer: failed to get stream source, will retry:`, err);
      this.scheduleRestart();
      return;
    }

    const res = this.config?.videoCodec.resolution;
    const width = res ? res[0] : 1280;
    const height = res ? res[1] : 720;
    const fps = res ? res[2] : 15;
    const bitrate = this.config?.videoCodec.parameters.bitRate ?? 2000;
    const iFrameInterval = this.config?.videoCodec.parameters.iFrameInterval ?? 4000;
    const iFrameIntervalFrames = Math.round((iFrameInterval / 1000) * fps);

    const samplerate = this.config?.audioCodec.samplerate ?? 1; // 1 = 16kHz
    const samplerateHz = samplerateEnumToHz(samplerate);

    const isRtmp = streamUrl.startsWith('rtmp');

    const args: string[] = [
      '-hide_banner',
      '-loglevel', `level${this.debug ? '+verbose' : '+warning'}`,
    ];

    if (isRtmp) {
      args.push(
        '-analyzeduration', '5000000',
        '-probesize', '5000000',
        '-rw_timeout', '10000000',
      );
    }

    args.push(
      '-i', streamUrl,
      // Video
      '-map', '0:v:0',
      '-codec:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-vf', `scale=${width}:${height}`,
      '-r', `${fps}`,
      '-b:v', `${bitrate}k`,
      '-bufsize', `${bitrate * 2}k`,
      '-maxrate', `${bitrate}k`,
      '-g', `${iFrameIntervalFrames}`,
      '-keyint_min', `${iFrameIntervalFrames}`,
      '-force_key_frames', `expr:gte(t,n_forced*${iFrameInterval / 1000})`,
      // Audio
      '-map', '0:a:0?',
      '-codec:a', 'aac',
      '-ar', `${samplerateHz}`,
      '-ac', '1',
      '-b:a', '32k',
      // fMP4 output to stdout
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      'pipe:1',
    );

    this.log.debug(`[${this.cameraName}] Prebuffer FFmpeg args: ${args.filter((_, i) => args[i - 1] !== '-i').join(' ')}`);

    const proc = spawn(this.videoProcessor, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = proc;

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        if (this.debug) {
          this.log.debug(`[${this.cameraName}][prebuffer] ${line}`);
        } else if (line.includes('Error') || line.includes('error') || line.includes('Invalid')) {
          this.log.warn(`[${this.cameraName}][prebuffer] ${line}`);
        }
      }
    });

    proc.on('error', (err) => {
      this.log.error(`[${this.cameraName}] Prebuffer FFmpeg error:`, err);
    });

    proc.on('close', (code) => {
      if (this.ffmpeg === proc) {
        this.ffmpeg = null;
      }
      if (this.active && !this.destroyed) {
        this.log.warn(`[${this.cameraName}] Prebuffer FFmpeg exited (code=${code}), restarting...`);
        this.scheduleRestart();
      }
    });

    // FFmpeg spawned successfully — reset the backoff counter
    this.restartAttempt = 0;
    this.parseFMp4Stream(proc);
  }

  /**
   * Resolves the stream URL for the prebuffer.
   *
   * Strategy:
   * 1. If a local RTMP stream is already active, reuse it directly.
   * 2. If a negotiation is in-flight (live HomeKit stream is negotiating),
   *    wait for the RTMP stream to become active rather than competing.
   * 3. Otherwise, trigger a new negotiation through the serialized lock.
   */
  private async resolveStreamUrl(): Promise<string> {
    // Case 1: stream is already publishing
    const activeUrl = this.streamResolver.getActiveStreamUrl(this.babyUid);
    if (activeUrl) {
      this.log.debug(`[${this.cameraName}] Prebuffer: reusing existing active stream`);
      return activeUrl;
    }

    // Case 2: a live stream negotiation is in-flight — wait for the RTMP stream
    // to start publishing instead of issuing a competing stop/start.
    if (this.streamResolver.isNegotiating) {
      this.log.debug(`[${this.cameraName}] Prebuffer: stream negotiation in progress, waiting for RTMP stream`);
      const url = await this.streamResolver.waitForActiveStream(this.babyUid, 30_000);
      if (url) return url;
      throw new Error('Timed out waiting for active stream during negotiation');
    }

    // Case 3: trigger a new negotiation
    const info = await this.streamResolver.getStreamSource(this.babyUid, this.wsClient);
    return info.url;
  }

  /**
   * Waits up to WS_WAIT_MAX_MS for the WebSocket client to be connected.
   * Returns true if connected, false if timed out.
   */
  private waitForWsConnection(): Promise<boolean> {
    if (this.wsClient.isConnected) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + WS_WAIT_MAX_MS;
      const poll = () => {
        if (this.destroyed || !this.active) { resolve(false); return; }
        if (this.wsClient.isConnected) { resolve(true); return; }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(poll, WS_WAIT_POLL_MS);
      };
      setTimeout(poll, WS_WAIT_POLL_MS);
    });
  }

  private parseFMp4Stream(proc: ChildProcess): void {
    let buf = Buffer.alloc(0);
    let moovReceived = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      while (buf.length >= 8) {
        // ISO BMFF box: [4 bytes size][4 bytes type]...
        const boxSize = buf.readUInt32BE(0);

        if (boxSize < 8) {
          // Malformed or zero-size box — discard buffered data
          buf = Buffer.alloc(0);
          break;
        }

        if (buf.length < boxSize) {
          // Wait for more data
          break;
        }

        const boxType = buf.toString('ascii', 4, 8);
        const boxData = buf.subarray(0, boxSize);
        buf = buf.subarray(boxSize);

        if (boxType === 'ftyp' || boxType === 'moov') {
          // Accumulate until we have the full initialization segment
          if (!moovReceived) {
            if (!this.moovBox) {
              this.moovBox = boxData;
            } else {
              this.moovBox = Buffer.concat([this.moovBox, boxData]);
            }
            if (boxType === 'moov') {
              moovReceived = true;
            }
          }
        } else if (boxType === 'moof') {
          // moof must be followed by mdat; buffer moof and wait for mdat
          if (buf.length >= 8) {
            const nextSize = buf.readUInt32BE(0);
            const nextType = buf.toString('ascii', 4, 8);

            if (nextType === 'mdat' && buf.length >= nextSize) {
              const mdatData = buf.subarray(0, nextSize);
              buf = buf.subarray(nextSize);
              const fragment = Buffer.concat([boxData, mdatData]);
              this.pushSegment(fragment);
            }
            // If mdat hasn't arrived yet, put moof back and wait
            else {
              buf = Buffer.concat([boxData, buf]);
              break;
            }
          } else {
            // Not enough data for next box header — put moof back and wait
            buf = Buffer.concat([boxData, buf]);
            break;
          }
        }
        // skip other top-level boxes (styp, etc.)
      }
    });
  }

  private pushSegment(data: Buffer): void {
    const segment: FMp4Segment = { data, timestamp: Date.now() };

    // Keep only the last HKSV_PREBUFFER_MS worth of segments
    const cutoff = Date.now() - HKSV_PREBUFFER_MS;
    this.segments = this.segments.filter(s => s.timestamp >= cutoff);
    this.segments.push(segment);

    for (const consumer of this.streamConsumers) {
      try {
        consumer(segment);
      } catch {
        // ignore consumer errors
      }
    }
  }

  private killFfmpeg(): void {
    if (this.ffmpeg) {
      const proc = this.ffmpeg;
      this.ffmpeg = null;
      proc.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3_000);
      proc.once('close', () => clearTimeout(forceKill));
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.destroyed || !this.active) return;

    const delayMs = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)];
    this.restartAttempt++;

    this.log.debug(`[${this.cameraName}] Prebuffer: scheduling restart in ${delayMs / 1000}s (attempt ${this.restartAttempt})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Reset moov and segment buffer so consumers get a fresh initialization segment
      this.moovBox = null;
      this.segments = [];
      this.launchFfmpeg().catch(err => {
        this.log.error(`[${this.cameraName}] Prebuffer unexpected error on restart:`, err);
      });
    }, delayMs);
  }
}

function samplerateEnumToHz(samplerate: number): number {
  // AudioRecordingSamplerate enum values: 0=8kHz 1=16kHz 2=24kHz 3=32kHz 4=44.1kHz 5=48kHz
  const map: Record<number, number> = { 0: 8000, 1: 16000, 2: 24000, 3: 32000, 4: 44100, 5: 48000 };
  return map[samplerate] ?? 16000;
}
