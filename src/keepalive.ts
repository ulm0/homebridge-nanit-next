import type { Logging } from 'homebridge';
import type { StreamResolver } from './stream/resolver.js';
import type { NanitWebSocketClient } from './nanit/websocket.js';

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const WATCHDOG_INTERVAL_MS = 30_000;
// Long enough for the camera's initial settings burst (which carries
// sleepMode) to arrive after the WebSocket connects.
const RECONNECT_DELAY_MS = 3_000;
const PUBLISH_ENDED_DELAY_MS = 2_000;

/**
 * Keeps the camera pushing its stream to the local RTMP server continuously.
 *
 * Live view (and snapshots) then attach to an already-publishing stream:
 * node-media-server's GOP cache hands a new reader the most recent keyframe
 * immediately, so there is no camera negotiation and no wait for a keyframe.
 *
 * Nothing is transcoded while nobody is watching; this only keeps the
 * camera → Homebridge RTMP push alive. It never uses the cloud stream.
 *
 * While the camera is switched off (Nanit "sleep mode"), the keep-alive
 * pauses: it stops the push and never asks a switched-off camera to stream.
 */
export class NanitStreamKeepAlive {
  private active = false;
  private inFlight = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly log: Logging,
    private readonly cameraName: string,
    private readonly babyUid: string,
    private readonly streamResolver: StreamResolver,
    private readonly wsClient: NanitWebSocketClient,
    /**
     * True while a HomeKit live view or the HKSV prebuffer runs on the cloud
     * stream, or a live view is still starting and may end up there.
     */
    private readonly hasCloudOrStartingLiveView: () => boolean = () => false,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  private get isCameraOff(): boolean {
    return this.wsClient.currentState.sleepMode === true;
  }

  /**
   * True when the camera's current push is one this keep-alive wants kept:
   * the keep-alive runs and the camera publishes to the local RTMP server.
   * A cloud push (auto mode, local negotiation failed) is not kept.
   */
  get keepsCameraStreaming(): boolean {
    return this.active && this.streamResolver.getActiveLocalPlayUrl(this.babyUid) !== null;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.log.info(`[${this.cameraName}] Keep-alive: keeping the local stream warm`);

    // Camera stopped pushing (Wi-Fi blip, camera reboot, …): re-request soon.
    this.unsubscribers.push(this.streamResolver.onLocalStreamEnded((babyUid) => {
      if (babyUid !== this.babyUid || !this.active) return;
      this.log.warn(`[${this.cameraName}] Keep-alive: camera stopped publishing, re-requesting stream`);
      this.schedule(PUBLISH_ENDED_DELAY_MS);
    }));

    this.unsubscribers.push(this.wsClient.onStateChange((state) => {
      if (!this.active) return;

      // Camera switched off: stop the push and stay idle until it is back on.
      if (state.sleepMode === true) {
        this.log.info(`[${this.cameraName}] Keep-alive: camera is off, pausing`);
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.attempt = 0;
        if (this.streamResolver.getActiveLocalPlayUrl(this.babyUid)) {
          this.streamResolver.stopStream(this.wsClient).catch(() => { /* best effort */ });
        }
        return;
      }
      if (state.sleepMode === false) {
        this.log.info(`[${this.cameraName}] Keep-alive: camera is on, resuming`);
        this.schedule(RECONNECT_DELAY_MS);
        return;
      }

      // WebSocket (re)connected: that is when a stream request can succeed.
      if (state.isConnected === true) {
        this.schedule(RECONNECT_DELAY_MS);
      }
    }));

    // Belt and braces for anything the events above miss. A pending retry
    // timer owns the next attempt, so the watchdog never cuts a backoff short.
    this.watchdogTimer = setInterval(() => {
      if (this.retryTimer) return;
      void this.ensure();
    }, WATCHDOG_INTERVAL_MS);

    void this.ensure();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    this.log.info(`[${this.cameraName}] Keep-alive: stopped`);
  }

  private schedule(delayMs: number): void {
    if (this.retryTimer || !this.active) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensure();
    }, delayMs);
  }

  private async ensure(): Promise<void> {
    if (!this.active || this.inFlight) return;

    // Never ask a switched-off camera to stream.
    if (this.isCameraOff) return;

    if (this.streamResolver.getActiveLocalPlayUrl(this.babyUid)) {
      this.attempt = 0;
      return;
    }

    // No WebSocket: nothing to ask. The state-change listener retries on connect.
    if (!this.wsClient.isConnected) return;

    // A live view or the HKSV prebuffer runs on the cloud stream (auto mode),
    // or a live view is still starting and may end up there: negotiating now
    // would stop it. The watchdog tries again after it ends. A local view
    // whose publisher dropped is not affected and recovers here.
    if (this.hasCloudOrStartingLiveView()) return;

    this.inFlight = true;
    try {
      // Serialized with live-view negotiation inside the resolver, so this
      // never races a concurrent stop/start sequence. The abort check runs
      // before every request to the camera, so a camera switched off, or a
      // live view that started on the cloud stream, while this request waited
      // in the queue is left alone.
      await this.streamResolver.ensureLocalStream(
        this.babyUid,
        this.wsClient,
        () => !this.active || this.isCameraOff || this.hasCloudOrStartingLiveView(),
      );
      if (this.attempt > 0) {
        this.log.info(`[${this.cameraName}] Keep-alive: local stream is up again`);
      } else {
        this.log.debug(`[${this.cameraName}] Keep-alive: local stream is up`);
      }
      this.attempt = 0;
    } catch (err) {
      if (!this.active || this.isCameraOff) {
        this.log.debug(`[${this.cameraName}] Keep-alive: negotiation cancelled, camera is off`);
        return;
      }
      if (this.hasCloudOrStartingLiveView()) {
        this.log.debug(`[${this.cameraName}] Keep-alive: negotiation cancelled, a cloud stream consumer owns the camera`);
        return;
      }
      const delayMs = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)];
      this.attempt++;
      this.log.warn(
        `[${this.cameraName}] Keep-alive: could not start local stream, retrying in ${delayMs / 1000}s:`,
        err,
      );
      this.schedule(delayMs);
    } finally {
      this.inFlight = false;
    }
  }
}
