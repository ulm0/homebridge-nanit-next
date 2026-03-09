import type { Logging } from 'homebridge';
import { pickPort } from 'pick-port';

export class LocalRtmpServer {
  private _port = 0;
  private _isRunning = false;
  private nms: InstanceType<typeof import('node-media-server').default> | null = null;
  private activeStreams = new Set<string>();
  private streamWaiters = new Map<string, Array<() => void>>();

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
      const streamPath = args[1] as string;
      this.log.debug(`RTMP stream publishing: ${streamPath}`);
      this.activeStreams.add(streamPath);
      const waiters = this.streamWaiters.get(streamPath);
      if (waiters) {
        for (const resolve of waiters) resolve();
        this.streamWaiters.delete(streamPath);
      }
    });

    this.nms.on('donePublish', (...args: unknown[]) => {
      const streamPath = args[1] as string;
      this.log.debug(`RTMP stream ended: ${streamPath}`);
      this.activeStreams.delete(streamPath);
    });

    this.nms.run();
    this._isRunning = true;
    this.log.info(`Local RTMP server started on port ${this._port}`);

    return this._port;
  }

  isStreamActive(streamKey: string): boolean {
    return this.activeStreams.has(`/live/${streamKey}`);
  }

  waitForStream(streamKey: string, timeoutMs = 15_000): Promise<boolean> {
    const streamPath = `/live/${streamKey}`;

    if (this.activeStreams.has(streamPath)) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.streamWaiters.get(streamPath);
        if (waiters) {
          const idx = waiters.indexOf(onReady);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) this.streamWaiters.delete(streamPath);
        }
        resolve(false);
      }, timeoutMs);

      const onReady = () => {
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
    for (const waiters of this.streamWaiters.values()) {
      for (const resolve of waiters) resolve();
    }
    this.streamWaiters.clear();
    this._isRunning = false;
    this.log.debug('Local RTMP server stopped');
  }
}
