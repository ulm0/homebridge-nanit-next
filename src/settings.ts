export const PLATFORM_NAME = 'NanitCamera';
export const PLUGIN_NAME = 'homebridge-nanit';

export const NANIT_API_BASE = 'https://api.nanit.com';
export const NANIT_API_VERSION = '1';
export const NANIT_MEDIA_HOST = 'media-secured.nanit.com';
export const NANIT_WS_CLOUD_BASE = 'wss://api.nanit.com/focus/cameras';
export const NANIT_LOCAL_WS_PORT = 442;

export const AUTH_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
export const WS_KEEPALIVE_INTERVAL_MS = 20_000;
export const WS_RECONNECT_DELAYS = [5_000, 30_000, 120_000, 900_000];
export const LOCAL_CONNECT_TIMEOUT_MS = 3_000;

export type StreamMode = 'local' | 'cloud' | 'auto';

export interface NanitPlatformConfig {
  name: string;
  auth?: {
    email?: string;
    password?: string;
    refreshToken?: string;
  };
  streamMode?: StreamMode;
  rtmpListenPort?: number;
  localAddress?: string;
  cameras?: Array<{
    babyUid?: string;
    name?: string;
    localIp?: string;
    enableLight?: boolean;
    enableSound?: boolean;
    enableSensors?: boolean;
  }>;
  videoConfig?: {
    maxWidth?: number;
    maxHeight?: number;
    maxFPS?: number;
    maxBitrate?: number;
    audio?: boolean;
    debug?: boolean;
  };
}
