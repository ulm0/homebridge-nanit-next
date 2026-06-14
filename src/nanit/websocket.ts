import WebSocket from 'ws';
import type { Logging } from 'homebridge';
import {
  NANIT_WS_CLOUD_BASE,
  NANIT_LOCAL_WS_PORT,
  WS_KEEPALIVE_INTERVAL_MS,
  WS_RECONNECT_DELAYS,
  LOCAL_CONNECT_TIMEOUT_MS,
} from '../settings.js';
import type { AuthManager } from './auth.js';
import type { NanitApiClient } from './api.js';
import { encodeMessage, decodeMessage, loadProto } from './protobuf/index.js';
import type { CameraState, CameraStateListener, SensorState } from './types.js';

interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NanitWebSocketClient {
  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectedAtMs = 0;
  private localRapidDisconnects = 0;
  private preferCloudUntilMs = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private stateListeners = new Set<CameraStateListener>();
  private motionListeners = new Set<(timestamp: number) => void>();
  private _isConnected = false;
  private destroyed = false;
  private connectionMode: 'cloud' | 'local' = 'cloud';

  private state: CameraState = {
    sensors: {},
    nightLightOn: false,
    nightLightBrightness: 100,
    soundPlaying: false,
    isStreaming: false,
    isConnected: false,
  };

  constructor(
    private readonly log: Logging,
    private readonly auth: AuthManager,
    private readonly api: NanitApiClient,
    private readonly cameraUid: string,
    private localIp?: string,
    private readonly debugProbe = false,
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  get currentState(): CameraState {
    return { ...this.state };
  }

  get cameraLocalIp(): string | undefined {
    return this.localIp;
  }

  setCameraLocalIp(ip: string): void {
    this.localIp = ip;
  }

  onStateChange(listener: CameraStateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  onMotionDetected(listener: (timestamp: number) => void): () => void {
    this.motionListeners.add(listener);
    return () => { this.motionListeners.delete(listener); };
  }

  private emitStateChange(partial: Partial<CameraState>): void {
    Object.assign(this.state, partial);
    for (const listener of this.stateListeners) {
      try {
        listener(partial);
      } catch (err) {
        this.log.error('State listener error:', err);
      }
    }
  }

  async connect(mode: 'cloud' | 'local' = 'cloud'): Promise<void> {
    if (this.destroyed) return;
    await loadProto();

    if (mode === 'local' && Date.now() < this.preferCloudUntilMs) {
      this.log.warn('Temporarily preferring cloud WebSocket after repeated local disconnects');
      mode = 'cloud';
    }

    if (mode === 'local' && !this.localIp) {
      this.log.warn('Local WebSocket requested but no localIp configured — falling back to cloud');
      mode = 'cloud';
    }

    this.connectionMode = mode;
    this.disconnect();

    try {
      if (mode === 'local') {
        await this.connectLocal();
      } else {
        await this.connectCloud();
      }
    } catch (err) {
      this.log.error(`WebSocket ${mode} connection failed:`, err);
      this.scheduleReconnect();
      throw err;
    }
  }

  async connectAuto(): Promise<void> {
    if (Date.now() < this.preferCloudUntilMs) {
      await this.connect('cloud');
      return;
    }

    if (this.localIp) {
      try {
        await this.connect('local');
        await this.sendRequest('GET_STATUS', { getStatus: { all: true } }, 5_000);
        this.log.info('Validated local WebSocket with status round-trip');
        return;
      } catch (err) {
        this.log.info('Local connection validation failed, falling back to cloud');
        this.disconnect();
        this.log.debug('Local validation error:', err);
      }
    } else {
      this.log.debug('No localIp configured, skipping local WebSocket validation');
    }
    try {
      await this.connect('cloud');
    } catch (err) {
      this.scheduleReconnect();
      throw err;
    }
  }

  private async connectCloud(): Promise<void> {
    const token = await this.auth.ensureValidToken();
    const url = `${NANIT_WS_CLOUD_BASE}/${this.cameraUid}/user_connect`;

    this.log.info(`Connecting to Nanit cloud WebSocket for camera ${this.cameraUid}...`);

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      this.ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        reject(new Error('Cloud WebSocket connection timeout'));
        this.ws?.close();
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.applyTcpKeepalive();
        this.onConnected();
        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.onDisconnected(code, reason.toString());
      });

      this.ws.on('message', (data: ArrayBuffer | Buffer) => {
        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        this.onMessage(buffer);
      });
    });
  }

  private async connectLocal(): Promise<void> {
    if (!this.localIp) throw new Error('No local IP configured');

    let ucToken: string;
    try {
      ucToken = await this.api.getUcToken(this.cameraUid);
    } catch (err) {
      throw new Error(`Failed to get UC token: ${err}`);
    }

    const url = `wss://${this.localIp}:${NANIT_LOCAL_WS_PORT}`;
    this.log.info(`Connecting to Nanit local WebSocket at ${url}...`);
    this.log.warn(
      'Local WebSocket uses rejectUnauthorized=false (camera uses a self-signed certificate). '
      + 'This disables TLS verification and is susceptible to MITM attacks on the local network.',
    );

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Local WebSocket connection timeout after ${LOCAL_CONNECT_TIMEOUT_MS}ms`));
        this.ws?.close();
      }, LOCAL_CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `token ${ucToken}` },
        rejectUnauthorized: false,
      });

      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.applyTcpKeepalive();
        this.onConnected();
        resolve();
      });

      this.ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Local WebSocket closed before open (code=${code}, reason=${reason.toString()})`));
          return;
        }
        this.onDisconnected(code, reason.toString());
      });

      this.ws.on('message', (data: ArrayBuffer | Buffer) => {
        const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
        this.onMessage(buffer);
      });
    });
  }

  private applyTcpKeepalive(): void {
    const sock = (this.ws as unknown as { _socket?: { setKeepAlive?: (enable: boolean, ms: number) => void; setNoDelay?: (n: boolean) => void } })._socket;
    try {
      sock?.setKeepAlive?.(true, 5_000);
      sock?.setNoDelay?.(true);
    } catch (err) {
      this.log.debug('Failed to apply TCP keepalive:', err);
    }
  }

  private onConnected(): void {
    this._isConnected = true;
    this.connectedAtMs = Date.now();
    this.reconnectAttempt = 0;
    if (this.connectionMode === 'cloud') {
      this.localRapidDisconnects = 0;
    }
    this.log.info(`Nanit WebSocket connected (${this.connectionMode})`);
    this.emitStateChange({ isConnected: true });
    this.startKeepalive();
    this.requestInitialState().then(() => {
      if (this.debugProbe && this.connectionMode === 'cloud') {
        setTimeout(() => {
          if (this._isConnected) {
            this.runProbeSweep().catch(err => this.log.debug('[probe] sweep error:', err));
          } else {
            this.log.info('[probe] skipping sweep — WS no longer connected');
          }
        }, 2_000);
      } else if (this.debugProbe) {
        this.log.info('[probe] skipping sweep on local WS — local channel drops too fast; cloud-only');
      }
    });
  }

  private onDisconnected(code: number, reason: string): void {
    const connectedForMs = this.connectedAtMs > 0 ? Date.now() - this.connectedAtMs : 0;
    if (this.connectionMode === 'local' && code === 1006 && connectedForMs > 0 && connectedForMs < 5_000) {
      this.localRapidDisconnects++;
      if (this.localRapidDisconnects >= 3) {
        // Session-lifetime preference. Local WS is unusable for sustained
        // control on this firmware; resets only on plugin restart.
        this.preferCloudUntilMs = Number.POSITIVE_INFINITY;
        this.connectionMode = 'cloud';
        this.log.warn(
          'Local WebSocket drops repeatedly; using cloud WebSocket for the rest of this session.',
        );
      }
    } else if (this.connectionMode === 'local' && code !== 1006) {
      this.localRapidDisconnects = 0;
    }

    this._isConnected = false;
    this.stopKeepalive();
    this.emitStateChange({ isConnected: false });

    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('WebSocket disconnected'));
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
    }

    if (!this.destroyed) {
      this.log.warn(`Nanit WebSocket disconnected (code=${code}, reason=${reason}). Reconnecting...`);
      this.scheduleReconnect();
    }
  }

  private onMessage(data: Uint8Array): void {
    try {
      const msg = decodeMessage(data);
      const type = msg.type as string;

      if (this.debugProbe && type !== 'KEEPALIVE') {
        this.logFrame('IN', data, msg);
      }

      if (type === 'KEEPALIVE') return;

      if (type === 'RESPONSE') {
        this.handleResponse(msg.response as Record<string, unknown>);
      }

      if (type === 'REQUEST') {
        this.handleIncomingRequest(msg.request as Record<string, unknown>);
      }
    } catch (err) {
      this.log.error('Failed to decode WebSocket message:', err);
    }
  }

  private logFrame(direction: 'IN' | 'OUT', data: Uint8Array, decoded: Record<string, unknown>): void {
    const hex = Buffer.from(data).toString('hex');
    const redacted = this.redactForLog(decoded);
    this.log.info(
      `[probe ${direction}] (${data.length}B) ${JSON.stringify(redacted)} | hex=${hex}`,
    );
  }

  private redactForLog(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(v => this.redactForLog(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === 'rtmpUrl' && typeof v === 'string') {
          out[k] = v.replace(/(\.\w{8})\w+$/, '$1...<redacted>');
        } else if (/token|secret|key/i.test(k) && typeof v === 'string') {
          out[k] = `<redacted:${v.length}b>`;
        } else {
          out[k] = this.redactForLog(v);
        }
      }
      return out;
    }
    return value;
  }

  private async runProbeSweep(): Promise<void> {
    const probes: Array<{ type: string; data: Record<string, unknown> }> = [
      { type: 'GET_SETTINGS', data: {} },
      { type: 'GET_SOUNDTRACKS', data: {} },
      { type: 'GET_CONTROL', data: { getControl: { all: true } } },
      { type: 'GET_STATUS', data: { getStatus: { all: true } } },
      { type: 'GET_AUDIO_STREAMING', data: { getAudioStreaming: { all: true } } },
      { type: 'GET_LIST_NETWORKS', data: {} },
      { type: 'GET_STATUS_NETWORK', data: {} },
      { type: 'GET_FIRMWARE', data: {} },
      { type: 'GET_BANDWIDTH', data: {} },
      { type: 'GET_UOM', data: {} },
      { type: 'GET_UOM_URI', data: {} },
      { type: 'GET_AUTH_KEY', data: {} },
      { type: 'GET_STING_STATUS', data: {} },
      { type: 'GET_STING_START', data: {} },
      { type: 'GET_LOGS_URI', data: {} },
      { type: 'GET_PLAYBACK', data: {} },
      { type: 'GET_WIFI_SETUP', data: {} },
    ];

    this.log.info(`[probe] starting sweep of ${probes.length} GET_* requests on ${this.connectionMode} WS`);
    for (const probe of probes) {
      try {
        const response = await this.sendRequest(probe.type, probe.data, 5_000);
        this.log.info(
          `[probe RESULT] ${probe.type} -> OK ${JSON.stringify(this.redactForLog(response))}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.info(`[probe RESULT] ${probe.type} -> ERR ${msg}`);
      }
    }
    this.log.info('[probe] sweep complete');
  }

  private handleResponse(response: Record<string, unknown>): void {
    const requestId = response.requestId as number;
    const pending = this.pendingRequests.get(requestId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);

      const statusCode = response.statusCode as number;
      if (statusCode === 200) {
        pending.resolve(response);
      } else {
        pending.reject(new Error(
          `Request failed: ${statusCode} ${response.statusMessage ?? ''}`,
        ));
      }
    }


    if (response.sensorData) {
      this.processSensorData(response.sensorData as Array<Record<string, unknown>>);
    }

    if (response.settings) {
      this.processSettings(response.settings as Record<string, unknown>);
    }

    if (response.status) {
      this.processStatus(response.status as Record<string, unknown>);
    }

    if (response.control) {
      this.processControl(response.control as Record<string, unknown>);
    }
  }

  private handleIncomingRequest(request: Record<string, unknown>): void {
    const rawType = request.type;
    const type = typeof rawType === 'string' ? rawType : '';
    const requestId = request.id as number | undefined;

    if (typeof requestId === 'number' && rawType !== undefined && rawType !== null) {
      const isGet = type.startsWith('GET_');
      this.sendRaw({
        type: 'RESPONSE',
        response: {
          requestId,
          requestType: rawType,
          statusCode: isGet ? 404 : 200,
          statusMessage: isGet ? 'Not Found' : '',
        },
      });
    }

    if (type === 'PUT_SENSOR_DATA' && request.sensorData) {
      this.processSensorData(request.sensorData as Array<Record<string, unknown>>);
    }

    if (type === 'PUT_STREAMING' && request.streaming) {
      const streaming = request.streaming as Record<string, unknown>;
      const status = streaming.status as string;
      this.emitStateChange({ isStreaming: status === 'STARTED' });
    }

    if (type === 'PUT_CONTROL' && request.control) {
      this.processControl(request.control as Record<string, unknown>);
    }

    if (type === 'PUT_SETTINGS' && request.settings) {
      this.processSettings(request.settings as Record<string, unknown>);
    }

    if (type === 'PUT_STATUS' && request.status) {
      this.processStatus(request.status as Record<string, unknown>);
    }

    if (type === 'PUT_PLAYBACK' && request.playback) {
      this.processPlayback(request.playback as Record<string, unknown>);
    }
  }

  private processPlayback(playback: Record<string, unknown>): void {
    const partial: Partial<CameraState> = {};
    if (playback.status === 'STARTED' || playback.status === 0) {
      partial.soundPlaying = true;
    } else if (playback.status === 'STOPPED' || playback.status === 1) {
      partial.soundPlaying = false;
    }
    const track = playback.track as Record<string, unknown> | undefined;
    if (track && typeof track.filename === 'string') {
      partial.soundTrack = track.filename;
    }
    if (playback.sessionId !== undefined) {
      partial.soundSessionId = String(playback.sessionId);
    }
    if (Object.keys(partial).length > 0) {
      this.emitStateChange(partial);
    }
  }

  private processSensorData(sensorData: Array<Record<string, unknown>>): void {
    const sensors: Partial<SensorState> = {};

    for (const sd of sensorData) {
      const sensorType = sd.sensorType as string;
      const valueMilli = sd.valueMilli as number | undefined;
      const value = sd.value as number | undefined;
      const timestamp = sd.timestamp as number | undefined;

      switch (sensorType) {
        case 'TEMPERATURE':
          if (valueMilli !== undefined) sensors.temperature = valueMilli / 1000;
          break;
        case 'HUMIDITY':
          if (valueMilli !== undefined) sensors.humidity = valueMilli / 1000;
          break;
        case 'LIGHT':
          if (value !== undefined) sensors.light = value;
          break;
        case 'NIGHT':
          sensors.isNight = value === 1;
          break;
        case 'SOUND':
          if (timestamp !== undefined) sensors.soundTimestamp = timestamp;
          break;
        case 'MOTION':
          if (timestamp !== undefined) {
            sensors.motionTimestamp = timestamp;
            if (timestamp > 0) {
              for (const listener of this.motionListeners) {
                try { listener(timestamp); } catch { /* ignore */ }
              }
            }
          }
          break;
      }
    }

    this.state.sensors = { ...this.state.sensors, ...sensors };
    this.emitStateChange({ sensors: this.state.sensors });
  }

  private processSettings(settings: Record<string, unknown>): void {
    const partial: Partial<CameraState> = {};
    if (typeof settings.volume === 'number') partial.volume = settings.volume;
    // nightVision is an enum string after the proto fix. Treat NV_ON as "on"
    // for HomeKit; NV_AUTO and NV_OFF are both reflected as "off" (HomeKit
    // can't represent the auto state).
    if (typeof settings.nightVision === 'string') {
      partial.nightVision = settings.nightVision === 'NV_ON';
    } else if (typeof settings.nightVision === 'number') {
      partial.nightVision = settings.nightVision === 2;
    }
    if (typeof settings.sleepMode === 'boolean') partial.sleepMode = settings.sleepMode;
    if (typeof settings.statusLightOn === 'boolean') partial.statusLightOn = settings.statusLightOn;
    if (typeof settings.micMuteOn === 'boolean') partial.micMuteOn = settings.micMuteOn;
    if (typeof settings.nightLightBrightness === 'number') {
      partial.nightLightBrightness = settings.nightLightBrightness;
    }
    if (Object.keys(partial).length > 0) {
      this.emitStateChange(partial);
    }
  }

  private processControl(control: Record<string, unknown>): void {
    if (control.nightLight !== undefined) {
      this.emitStateChange({
        nightLightOn: control.nightLight === 'LIGHT_ON',
      });
    }
  }

  private processStatus(status: Record<string, unknown>): void {
    if (status.currentVersion) {
      this.emitStateChange({ firmwareVersion: status.currentVersion as string });
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepAliveTimer = setInterval(() => {
      this.sendRaw({ type: 'KEEPALIVE' });
    }, WS_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    const delay = WS_RECONNECT_DELAYS[
      Math.min(this.reconnectAttempt, WS_RECONNECT_DELAYS.length - 1)
    ];
    this.reconnectAttempt++;

    this.log.debug(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(this.connectionMode);
      } catch {
        // onDisconnected will schedule next reconnect
      }
    }, delay);
  }

  private async requestInitialState(): Promise<void> {
    // On local WS, the camera blasts a full state burst on connect, then drops
    // the channel ~1s later (firmware behavior — cloud is the master control
    // channel). Don't initiate any GETs locally; just consume the burst.
    if (this.connectionMode === 'local') {
      this.log.debug('Local WS: skipping initial GETs (passive observer only)');
      return;
    }

    try {
      await this.sendRequest('GET_SENSOR_DATA', {
        getSensorData: { all: true },
      });
    } catch (err) {
      this.log.debug('Failed to get initial sensor data:', err);
    }

    try {
      this.sendRaw({
        type: 'REQUEST',
        request: {
          id: ++this.requestId,
          type: 'GET_CONTROL',
          getControl: { all: true },
        },
      });
    } catch (err) {
      this.log.debug('Failed to request initial control state:', err);
    }

    try {
      await this.sendRequest('GET_STATUS', {
        getStatus: { all: true },
      });
    } catch (err) {
      this.log.debug('Failed to get initial status:', err);
    }

    try {
      await this.enableSensorPush();
    } catch (err) {
      this.log.debug('Failed to enable sensor push:', err);
    }
  }

  private async enableSensorPush(): Promise<void> {
    await this.sendRequest('PUT_CONTROL', {
      control: {
        sensorDataTransfer: {
          temperature: true,
          humidity: true,
          light: true,
          night: true,
          sound: true,
          motion: true,
        },
      },
    });
  }

  sendRaw(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const encoded = encodeMessage(obj);
      if (this.debugProbe && obj.type !== 'KEEPALIVE') {
        this.logFrame('OUT', encoded, obj);
      }
      this.ws.send(encoded);
    } catch (err) {
      this.log.error('Failed to send WebSocket message:', err);
    }
  }

  sendRequest(
    type: string,
    data: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = ++this.requestId;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.sendRaw({
        type: 'REQUEST',
        request: {
          id,
          type,
          ...data,
        },
      });
    });
  }

  async startStreaming(rtmpUrl: string): Promise<void> {
    const redactedUrl = rtmpUrl.replace(/(\.\w{8})\w+$/, '$1...<redacted>');
    this.log.info(`Requesting camera to stream to ${redactedUrl}`);
    await this.sendRequest('PUT_STREAMING', {
      streaming: {
        id: 'MOBILE',
        status: 'STARTED',
        rtmpUrl,
      },
    }, 20_000);
    this.emitStateChange({ isStreaming: true });
  }

  async stopStreaming(): Promise<void> {
    this.log.info('Requesting camera to stop streaming');
    try {
      await this.sendRequest('PUT_STREAMING', {
        streaming: {
          id: 'MOBILE',
          status: 'STOPPED',
          rtmpUrl: '',
        },
      });
    } catch {
      // Best effort
    }
    this.emitStateChange({ isStreaming: false });
  }


  async setNightLight(on: boolean): Promise<void> {
    await this.sendRequest('PUT_CONTROL', {
      control: {
        nightLight: on ? 'LIGHT_ON' : 'LIGHT_OFF',
      },
    });
    this.emitStateChange({ nightLightOn: on });
  }

  async startPlayback(track?: string): Promise<void> {
    // Camera expects a Playback frame with sessionId + track { filename }.
    // Reverse engineered from a frame the iOS app emits when starting the
    // sound machine. Filename is the last-observed track on the camera, or
    // a known default (camera ships with several .wav files).
    const filename = track ?? this.state.soundTrack ?? 'Birds.wav';
    await this.sendRequest('PUT_PLAYBACK', {
      playback: {
        status: 'STARTED',
        // Sentinel observed in capture: max uint64. Likely "session forever"
        // marker. protobufjs encodes Long; pass as a string to be explicit.
        sessionId: '18446744073709551615',
        track: { mode: 0, filename },
      },
    });
    this.emitStateChange({ soundPlaying: true, soundTrack: filename });
  }

  async stopPlayback(): Promise<void> {
    await this.sendRequest('PUT_PLAYBACK', {
      playback: { status: 'STOPPED' },
    });
    this.emitStateChange({ soundPlaying: false });
  }

  async setVolume(volume: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    await this.sendRequest('PUT_SETTINGS', { settings: { volume: v } });
    this.emitStateChange({ volume: v });
  }

  async setNightLightBrightness(brightness: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(brightness)));
    await this.sendRequest('PUT_SETTINGS', { settings: { nightLightBrightness: v } });
    this.emitStateChange({ nightLightBrightness: v });
  }

  async setNightVision(on: boolean): Promise<void> {
    // Three-state: NV_OFF=0, NV_AUTO=1, NV_ON=2. HomeKit Switch maps
    // On -> NV_ON (force IR on), Off -> NV_OFF (force IR off). Auto is
    // unreachable from HomeKit but remains settable in the Nanit app.
    await this.sendRequest('PUT_SETTINGS', {
      settings: { nightVision: on ? 'NV_ON' : 'NV_OFF' },
    });
    this.emitStateChange({ nightVision: on });
  }

  async setSleepMode(on: boolean): Promise<void> {
    await this.sendRequest('PUT_SETTINGS', { settings: { sleepMode: on } });
    this.emitStateChange({ sleepMode: on });
  }

  async setStatusLight(on: boolean): Promise<void> {
    await this.sendRequest('PUT_SETTINGS', { settings: { statusLightOn: on } });
    this.emitStateChange({ statusLightOn: on });
  }

  async setMicMute(on: boolean): Promise<void> {
    await this.sendRequest('PUT_SETTINGS', { settings: { micMuteOn: on } });
    this.emitStateChange({ micMuteOn: on });
  }

  disconnect(): void {
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this._isConnected = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.stateListeners.clear();
    this.motionListeners.clear();
  }
}
