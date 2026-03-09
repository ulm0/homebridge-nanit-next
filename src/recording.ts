import type {
  CameraRecordingDelegate,
  CameraRecordingConfiguration,
  RecordingPacket,
  Logging,
  Service,
  Characteristic,
  HDSProtocolSpecificErrorReason,
} from 'homebridge';
import type { NanitPrebuffer, FMp4Segment } from './prebuffer.js';
import { HKSV_MOTION_COOLDOWN_MS } from './settings.js';

export class NanitRecordingDelegate implements CameraRecordingDelegate {
  private config: CameraRecordingConfiguration | undefined;

  /**
   * Map from streamId → abort controller used to signal the recording generator
   * to stop yielding new segments.
   */
  private activeStreams = new Map<number, AbortController>();

  /**
   * Tracks whether HKSV recording is enabled by HomeKit.
   */
  private recordingActive = false;

  /**
   * Tracks the last motion timestamp seen via WebSocket, used to detect new
   * motion events even when the value is not a boolean.
   */
  private lastMotionTimestamp = 0;

  /**
   * Timer that resets the motion sensor after HKSV_MOTION_COOLDOWN_MS of
   * no new motion events.
   */
  private motionCooldownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly log: Logging,
    private readonly cameraName: string,
    private readonly prebuffer: NanitPrebuffer,
    private readonly motionService: Service,
    private readonly characteristic: typeof Characteristic,
  ) {}

  // ---- CameraRecordingDelegate ----

  updateRecordingActive(active: boolean): void {
    this.log.info(`[${this.cameraName}] HKSV recording ${active ? 'enabled' : 'disabled'}`);
    this.recordingActive = active;

    if (active) {
      this.prebuffer.start().catch(err => {
        this.log.error(`[${this.cameraName}] Failed to start prebuffer:`, err);
      });
    } else {
      this.prebuffer.stop();
      this.clearMotionCooldown();
    }
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.config = configuration;
    this.prebuffer.setRecordingConfiguration(configuration);

    if (!configuration) {
      this.log.debug(`[${this.cameraName}] HKSV recording configuration cleared`);
      return;
    }

    const { resolution, parameters } = configuration.videoCodec;
    this.log.debug(
      `[${this.cameraName}] HKSV config: ${resolution[0]}x${resolution[1]}@${resolution[2]}fps `
      + `${parameters.bitRate}kbps i-frame=${parameters.iFrameInterval}ms`,
    );
  }

  async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
    this.log.info(`[${this.cameraName}] HKSV recording stream requested (id=${streamId})`);

    const abort = new AbortController();
    this.activeStreams.set(streamId, abort);

    try {
      // Wait for moov box to be available (prebuffer may have just started)
      const moov = await this.waitForMoov(abort.signal);
      if (!moov) {
        this.log.warn(`[${this.cameraName}] HKSV: moov box not available, aborting stream ${streamId}`);
        return;
      }

      // Yield initialization segment (moov)
      yield { data: moov, isLast: false };

      // Yield prebuffered segments (the ~8s before the trigger)
      const prebuffered = this.prebuffer.getRecentSegments();
      this.log.debug(`[${this.cameraName}] HKSV: yielding ${prebuffered.length} prebuffered segments`);

      for (const segment of prebuffered) {
        if (abort.signal.aborted) return;
        yield { data: segment.data, isLast: false };
      }

      // Yield live segments until HomeKit closes the stream
      yield* this.yieldLiveSegments(streamId, abort.signal);
    } finally {
      this.activeStreams.delete(streamId);
    }
  }

  acknowledgeStream(streamId: number): void {
    this.log.debug(`[${this.cameraName}] HKSV stream acknowledged (id=${streamId})`);
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    this.log.info(
      `[${this.cameraName}] HKSV recording stream closed `
      + `(id=${streamId}, reason=${reason ?? 'connection closed'})`,
    );
    const abort = this.activeStreams.get(streamId);
    if (abort) {
      abort.abort();
      this.activeStreams.delete(streamId);
    }
  }

  // ---- Motion handling ----

  /**
   * Called externally (from NanitWebSocketClient callbacks) when a new
   * motionTimestamp is received. Triggers the HomeKit motion sensor.
   */
  handleMotionDetected(motionTimestamp: number): void {
    if (motionTimestamp === 0 || motionTimestamp === this.lastMotionTimestamp) return;

    this.lastMotionTimestamp = motionTimestamp;
    this.log.debug(`[${this.cameraName}] Motion detected (ts=${motionTimestamp})`);

    this.setMotion(true);
    this.resetMotionCooldown();
  }

  private setMotion(detected: boolean): void {
    this.motionService.updateCharacteristic(
      this.characteristic.MotionDetected,
      detected,
    );
  }

  private resetMotionCooldown(): void {
    this.clearMotionCooldown();
    this.motionCooldownTimer = setTimeout(() => {
      this.motionCooldownTimer = null;
      this.log.debug(`[${this.cameraName}] Motion cooldown expired, clearing motion sensor`);
      this.setMotion(false);
    }, HKSV_MOTION_COOLDOWN_MS);
  }

  private clearMotionCooldown(): void {
    if (this.motionCooldownTimer) {
      clearTimeout(this.motionCooldownTimer);
      this.motionCooldownTimer = null;
    }
  }

  // ---- Helpers ----

  private async waitForMoov(signal: AbortSignal, timeoutMs = 15_000): Promise<Buffer | null> {
    const moov = this.prebuffer.moov;
    if (moov) return moov;

    return new Promise<Buffer | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      const done = (result: Buffer | null) => {
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        resolve(result);
      };

      signal.addEventListener('abort', () => done(null), { once: true });

      // Poll the prebuffer for the moov box using a segment subscription
      unsubscribe = this.prebuffer.onSegment(() => {
        const m = this.prebuffer.moov;
        if (m) done(m);
      });

      timer = setTimeout(() => done(null), timeoutMs);
    });
  }

  private async *yieldLiveSegments(
    streamId: number,
    signal: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    // Use a queue + promise to bridge the segment event callback into an async generator
    const queue: FMp4Segment[] = [];
    let notify: (() => void) | null = null;

    const unsubscribe = this.prebuffer.onSegment((segment) => {
      queue.push(segment);
      notify?.();
      notify = null;
    });

    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          // Wait for the next segment or abort
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            notify = resolve;
            const onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }

        while (queue.length > 0 && !signal.aborted) {
          const segment = queue.shift()!;
          yield { data: segment.data, isLast: false };
        }
      }
    } finally {
      unsubscribe();
    }

    // Signal end of stream on the last yielded packet
    this.log.debug(`[${this.cameraName}] HKSV: finishing stream ${streamId}`);
    const lastSegment = this.prebuffer.getRecentSegments(1000);
    if (lastSegment.length > 0) {
      yield { data: lastSegment[lastSegment.length - 1].data, isLast: true };
    }
  }
}
