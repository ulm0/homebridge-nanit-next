import type { CameraRecordingOptions } from 'homebridge';

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

export const HKSV_PREBUFFER_MS = 8_000;
export const HKSV_FRAGMENT_LENGTH_MS = 4_000;
export const HKSV_MOTION_COOLDOWN_MS = 10_000;

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
  enableHksv?: boolean;
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

// Numeric literals for const enum values from hap-nodejs (inlined at compile time).
// MediaContainerType.FRAGMENTED_MP4 = 0
// VideoCodecType.H264 = 0
// H264Profile: BASELINE=0, MAIN=1, HIGH=2
// H264Level: LEVEL3_1=0, LEVEL3_2=1, LEVEL4_0=2
// AudioRecordingCodecType: AAC_LC=0
// AudioRecordingSamplerate: KHZ_16=1, KHZ_24=2
export const HKSV_RECORDING_OPTIONS: CameraRecordingOptions = {
  prebufferLength: HKSV_PREBUFFER_MS,
  mediaContainerConfiguration: {
    type: 0, // MediaContainerType.FRAGMENTED_MP4
    fragmentLength: HKSV_FRAGMENT_LENGTH_MS,
  },
  video: {
    type: 0, // VideoCodecType.H264
    parameters: {
      profiles: [0, 1, 2], // H264Profile: BASELINE, MAIN, HIGH
      levels: [0, 1, 2],   // H264Level: LEVEL3_1, LEVEL3_2, LEVEL4_0
    },
    resolutions: [
      [1920, 1080, 30],
      [1920, 1080, 15],
      [1280, 720, 30],
      [1280, 720, 15],
      [640, 360, 30],
      [640, 360, 15],
    ],
  },
  audio: {
    codecs: [
      {
        type: 0, // AudioRecordingCodecType.AAC_LC
        samplerate: [2, 1], // AudioRecordingSamplerate: KHZ_24, KHZ_16
        audioChannels: 1,
      },
    ],
  },
};
