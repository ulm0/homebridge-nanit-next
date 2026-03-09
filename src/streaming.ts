import type {
  API,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  CameraRecordingOptions,
  CameraRecordingDelegate,
  Service,
} from 'homebridge';
import {
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  StreamRequestTypes,
} from 'homebridge';
import { createSocket, type Socket } from 'node:dgram';
import { pickPort } from 'pick-port';
import { FfmpegProcess, findFfmpeg, detectAacEncoder, captureSnapshot } from './utils.js';
import type { StreamResolver } from './stream/resolver.js';
import type { NanitWebSocketClient } from './nanit/websocket.js';
import type { NanitApiClient } from './nanit/api.js';
import type { NanitPlatformConfig } from './settings.js';

interface SessionInfo {
  address: string;
  ipv6: boolean;
  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: number;
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ActiveSession {
  mainProcess?: FfmpegProcess;
  returnProcess?: FfmpegProcess;
  timeout?: ReturnType<typeof setTimeout>;
  socket?: Socket;
}

export class NanitStreamingDelegate implements CameraStreamingDelegate {
  readonly controller: CameraController;
  private readonly videoProcessor: string;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ActiveSession>();
  private cachedSnapshot: Buffer | null = null;

  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private readonly maxFPS: number;
  private readonly maxBitrate: number;
  private readonly enableAudio: boolean;
  private readonly debug: boolean;

  /** Set to a function that returns true if the HKSV prebuffer is active */
  isPrebufferActive: (() => boolean) | undefined;

  constructor(
    private readonly log: Logging,
    private readonly hap: HAP,
    private readonly api: API,
    private readonly cameraName: string,
    private readonly babyUid: string,
    private readonly streamResolver: StreamResolver,
    private readonly wsClient: NanitWebSocketClient,
    private readonly nanitApi: NanitApiClient,
    config: NanitPlatformConfig,
    recordingOptions?: { options: CameraRecordingOptions; delegate: CameraRecordingDelegate; motionService: Service },
  ) {
    this.videoProcessor = findFfmpeg();
    this.maxWidth = config.videoConfig?.maxWidth ?? 1280;
    this.maxHeight = config.videoConfig?.maxHeight ?? 720;
    this.maxFPS = config.videoConfig?.maxFPS ?? 30;
    this.maxBitrate = config.videoConfig?.maxBitrate ?? 2000;
    this.enableAudio = config.videoConfig?.audio ?? true;
    this.debug = config.videoConfig?.debug ?? false;

    api.on(APIEvent.SHUTDOWN, () => {
      for (const sessionId of this.ongoingSessions.keys()) {
        this.stopStream(sessionId);
      }
    });

    const options: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15],
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: this.enableAudio,
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
          ],
        },
      },
      ...(recordingOptions && {
        recording: {
          options: recordingOptions.options,
          delegate: recordingOptions.delegate,
        },
        sensors: {
          motion: recordingOptions.motionService,
        },
      }),
    };

    this.controller = new hap.CameraController(options);
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    const width = request.width ?? this.maxWidth;
    const height = request.height ?? this.maxHeight;

    // 1. Try the Nanit REST snapshot endpoint
    try {
      const snapshot = await this.nanitApi.getSnapshot(this.babyUid);
      if (snapshot && snapshot.length > 0) {
        this.cachedSnapshot = snapshot;
        callback(undefined, snapshot);
        return;
      }
    } catch (err) {
      this.log.warn(`[${this.cameraName}] Failed to fetch REST snapshot:`, err);
    }

    // 2. Try capturing a frame from the live local RTMP stream
    const localPlayUrl = this.streamResolver.getActiveLocalPlayUrl(this.babyUid);
    if (localPlayUrl) {
      this.log.debug(`[${this.cameraName}] REST snapshot unavailable, capturing frame from local stream`);
      try {
        const frame = await captureSnapshot(this.videoProcessor, localPlayUrl, width, height);
        if (frame && frame.length > 0) {
          this.cachedSnapshot = frame;
          callback(undefined, frame);
          return;
        }
      } catch (err) {
        this.log.warn(`[${this.cameraName}] Failed to capture snapshot from local stream:`, err);
      }
    }

    // 3. Return the last cached snapshot if available
    if (this.cachedSnapshot) {
      this.log.debug(`[${this.cameraName}] Using cached snapshot`);
      callback(undefined, this.cachedSnapshot);
      return;
    }

    this.log.debug(`[${this.cameraName}] No snapshot available`);
    callback(new Error('No snapshot available'));
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const ipv6 = request.addressVersion === 'ipv6';
    const portOptions = { type: 'udp' as const, ip: ipv6 ? '::' : '0.0.0.0', reserveTimeout: 15 };

    const videoReturnPort = await pickPort(portOptions);
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
    const audioReturnPort = await pickPort(portOptions);
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      ipv6,
      videoPort: request.video.port,
      videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC,
      audioPort: request.audio.port,
      audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC,
    };

    const response: PrepareStreamResponse = {
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    this.pendingSessions.set(request.sessionID, sessionInfo);
    callback(undefined, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(`[${this.cameraName}] Reconfigure request (ignored)`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions.get(request.sessionID);
    if (!sessionInfo) {
      this.log.error(`[${this.cameraName}] No session info found`);
      callback(new Error('No session info'));
      return;
    }

    let streamInfo;
    try {
      streamInfo = await this.streamResolver.getStreamSource(this.babyUid, this.wsClient);
    } catch (err) {
      this.log.error(`[${this.cameraName}] Failed to get stream source:`, err);
      callback(err as Error);
      return;
    }

    const vcodec = 'libx264';
    const mtu = 1316;

    const width = Math.min(request.video.width, this.maxWidth);
    const height = Math.min(request.video.height, this.maxHeight);
    const fps = Math.min(request.video.fps, this.maxFPS);
    const videoBitrate = Math.min(request.video.max_bit_rate, this.maxBitrate);

    this.log.info(`[${this.cameraName}] Starting ${streamInfo.type} stream: ${width}x${height}@${fps}fps ${videoBitrate}kbps`);

    const isRtmp = streamInfo.url.startsWith('rtmp');

    const ffmpegArgs: string[] = [
      '-hide_banner',
      '-loglevel', `level${this.debug ? '+verbose' : '+warning'}`,
    ];

    if (isRtmp) {
      ffmpegArgs.push(
        '-analyzeduration', '5000000',
        '-probesize', '5000000',
        '-rw_timeout', '10000000',
      );
    }

    ffmpegArgs.push(
      '-i', streamInfo.url,
      '-map', '0:v:0',
      '-codec:v', vcodec,
      '-pix_fmt', 'yuv420p',
      '-color_range', 'mpeg',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-r', `${fps}`,
      '-vf', `scale=${width}:${height}`,
      '-b:v', `${videoBitrate}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-maxrate', `${videoBitrate}k`,
      '-payload_type', `${request.video.pt}`,
      '-ssrc', `${sessionInfo.videoSSRC}`,
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', sessionInfo.videoSRTP.toString('base64'),
      `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`,
    );

    if (this.enableAudio) {
      const aacEncoder = detectAacEncoder(this.videoProcessor, this.log);
      ffmpegArgs.push(
        '-map', '0:a:0?',
        '-codec:a', aacEncoder.codec,
        ...aacEncoder.profileArgs,
        '-flags', '+global_header',
        '-ar', `${request.audio.sample_rate}k`,
        '-b:a', `${request.audio.max_bit_rate}k`,
        '-ac', `${request.audio.channel}`,
        '-payload_type', `${request.audio.pt}`,
        '-ssrc', `${sessionInfo.audioSSRC}`,
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', sessionInfo.audioSRTP.toString('base64'),
        `srtp://${sessionInfo.address}:${sessionInfo.audioPort}?rtcpport=${sessionInfo.audioPort}&pkt_size=188`,
      );
    }

    ffmpegArgs.push('-progress', 'pipe:1');

    const activeSession: ActiveSession = {};

    // RTCP feedback socket for stream health monitoring
    activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
    activeSession.socket.on('error', (err) => {
      this.log.error(`[${this.cameraName}] Socket error: ${err.message}`);
      this.stopStream(request.sessionID);
    });
    activeSession.socket.on('message', () => {
      if (activeSession.timeout) clearTimeout(activeSession.timeout);
      activeSession.timeout = setTimeout(() => {
        this.log.info(`[${this.cameraName}] Stream inactive, stopping`);
        this.controller.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }, 30_000);
    });
    activeSession.socket.bind(sessionInfo.videoReturnPort);

    activeSession.timeout = setTimeout(() => {
      this.log.info(`[${this.cameraName}] Stream timeout, stopping`);
      this.controller.forceStopStreamingSession(request.sessionID);
      this.stopStream(request.sessionID);
    }, 30_000);

    const mainProcess = new FfmpegProcess(this.log, this.cameraName, this.videoProcessor, this.debug);
    mainProcess.start(ffmpegArgs, () => {
      // Stream ended
    });
    activeSession.mainProcess = mainProcess;

    // Two-way audio (return channel)
    if (this.enableAudio) {
      this.setupReturnAudio(request, sessionInfo, activeSession);
    }

    this.ongoingSessions.set(request.sessionID, activeSession);
    this.pendingSessions.delete(request.sessionID);
    callback();
  }

  private setupReturnAudio(
    _request: StartStreamRequest,
    _sessionInfo: SessionInfo,
    _activeSession: ActiveSession,
  ): void {
    // Two-way audio requires forwarding the HomeKit return audio stream
    // to the camera, which is not yet supported by the Nanit WebSocket
    // protocol. The microphone icon will still appear in HomeKit but
    // audio sent from the Home app will be silently discarded.
    this.log.debug(`[${this.cameraName}] Two-way audio return channel not yet implemented`);
  }

  private stopStream(sessionId: string): void {
    const session = this.ongoingSessions.get(sessionId);
    if (session) {
      if (session.timeout) clearTimeout(session.timeout);
      try { session.socket?.close(); } catch { /* ignore */ }
      try { session.mainProcess?.stop(); } catch { /* ignore */ }
      try { session.returnProcess?.stop(); } catch { /* ignore */ }
    }
    this.ongoingSessions.delete(sessionId);

    if (this.ongoingSessions.size === 0) {
      if (this.isPrebufferActive?.()) {
        this.log.debug(`[${this.cameraName}] Not stopping camera stream — prebuffer is still active`);
      } else {
        this.streamResolver.stopStream(this.wsClient).catch(() => {
          // Best effort
        });
      }
    }

    this.log.info(`[${this.cameraName}] Stream stopped`);
  }
}
