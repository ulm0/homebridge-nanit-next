export interface NanitTokens {
  accessToken: string;
  refreshToken: string;
  authTime: number;
}

export interface NanitMfaChallenge {
  mfaToken: string;
  phoneSuffix?: string;
  channel?: string;
}

export interface Baby {
  uid: string;
  name: string;
  camera_uid: string;
}

export interface BabiesResponse {
  babies: Baby[];
}

export interface CameraInfo {
  babyUid: string;
  cameraUid: string;
  babyName: string;
  localIp?: string;
}

export interface SensorState {
  temperature?: number;
  humidity?: number;
  light?: number;
  isNight?: boolean;
  soundTimestamp?: number;
  motionTimestamp?: number;
}

export interface CameraState {
  sensors: SensorState;
  nightLightOn: boolean;
  nightLightBrightness: number;
  soundPlaying: boolean;
  soundTrack?: string;
  soundSessionId?: string;
  isStreaming: boolean;
  isConnected: boolean;
  firmwareVersion?: string;
  volume?: number;
  nightVision?: boolean;
  sleepMode?: boolean;
  statusLightOn?: boolean;
  micMuteOn?: boolean;
}

export type CameraStateListener = (state: Partial<CameraState>) => void;

export interface StreamInfo {
  url: string;
  type: 'local' | 'cloud';
}
