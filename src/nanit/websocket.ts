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
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private stateListeners = new Set<CameraStateListener>();
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
    private readonly localIp?: string,
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  get currentState(): CameraState {
    return { ...this.state };
  }

  onStateChange(listener: CameraStateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
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

    this.connectionMode = mode;
    this.disconnect();

    try {
      if (mode === 'local' && this.localIp) {
        await this.connectLocal();
      } else {
        await this.connectCloud();
      }
    } catch (err) {
      this.log.error(`WebSocket ${mode} connection failed:`, err);
      this.scheduleReconnect();
    }
  }

  async connectAuto(): Promise<void> {
    if (this.localIp) {
      try {
        await this.connect('local');
        return;
      } catch {
        this.log.info('Local connection failed, falling back to cloud');
      }
    }
    await this.connect('cloud');
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

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Local WebSocket connection timeout'));
        this.ws?.close();
      }, LOCAL_CONNECT_TIMEOUT_MS);

      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `token ${ucToken}` },
        rejectUnauthorized: false,
      });

      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        clearTimeout(timeout);
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

  private onConnected(): void {
    this._isConnected = true;
    this.reconnectAttempt = 0;
    this.log.info(`Nanit WebSocket connected (${this.connectionMode})`);
    this.emitStateChange({ isConnected: true });
    this.startKeepalive();
    this.requestInitialState();
  }

  private onDisconnected(code: number, reason: string): void {
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
  }

  private handleIncomingRequest(request: Record<string, unknown>): void {
    const type = request.type as string;

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
          if (timestamp !== undefined) sensors.motionTimestamp = timestamp;
          break;
      }
    }

    this.state.sensors = { ...this.state.sensors, ...sensors };
    this.emitStateChange({ sensors: this.state.sensors });
  }

  private processSettings(settings: Record<string, unknown>): void {
    if (settings.volume !== undefined) {
      const volume = settings.volume as number;
      this.emitStateChange({
        nightLightBrightness: Math.round((volume / 100) * 100),
      });
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
    try {
      await this.sendRequest('GET_SENSOR_DATA', {
        getSensorData: { all: true },
      });
    } catch (err) {
      this.log.debug('Failed to get initial sensor data:', err);
    }

    try {
      await this.sendRequest('GET_CONTROL', {});
    } catch (err) {
      this.log.debug('Failed to get initial control state:', err);
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
    this.log.info(`Requesting camera to stream to ${rtmpUrl}`);
    await this.sendRequest('PUT_STREAMING', {
      streaming: {
        id: 'MOBILE',
        status: 'STARTED',
        rtmpUrl,
      },
    });
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

  async startPlayback(): Promise<void> {
    await this.sendRequest('PUT_PLAYBACK', {
      playback: { status: 'STARTED' },
    });
    this.emitStateChange({ soundPlaying: true });
  }

  async stopPlayback(): Promise<void> {
    await this.sendRequest('PUT_PLAYBACK', {
      playback: { status: 'STOPPED' },
    });
    this.emitStateChange({ soundPlaying: false });
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
  }
}
