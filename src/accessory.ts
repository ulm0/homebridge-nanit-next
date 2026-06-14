import type { Logging, PlatformAccessory, Service } from 'homebridge';
import type { NanitPlatform } from './platform.js';
import type { NanitWebSocketClient } from './nanit/websocket.js';
import type { NanitApiClient } from './nanit/api.js';
import type { StreamResolver } from './stream/resolver.js';
import type { CameraInfo } from './nanit/types.js';
import type { NanitPlatformConfig } from './settings.js';
import { HKSV_RECORDING_OPTIONS } from './settings.js';
import { NanitStreamingDelegate } from './streaming.js';
import { NightLightService } from './services/light.js';
import { SoundMachineService } from './services/sound.js';
import { SensorServices } from './services/sensors.js';
import { CameraToggleServices } from './services/extras.js';
import { SoundTrackServices } from './services/soundtracks.js';
import { NanitPrebuffer } from './prebuffer.js';
import { NanitRecordingDelegate } from './recording.js';

export class NanitCameraAccessory {
  private streamingDelegate: NanitStreamingDelegate;
  private nightLightService?: NightLightService;
  private soundMachineService?: SoundMachineService;
  private soundTrackServices?: SoundTrackServices;
  private sensorServices?: SensorServices;
  private cameraToggles?: CameraToggleServices;
  private prebuffer?: NanitPrebuffer;
  private recordingDelegate?: NanitRecordingDelegate;

  constructor(
    public readonly platform: NanitPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly log: Logging,
    private readonly cameraInfo: CameraInfo,
    private readonly wsClient: NanitWebSocketClient,
    private readonly nanitApi: NanitApiClient,
    private readonly streamResolver: StreamResolver,
    private readonly config: NanitPlatformConfig,
  ) {
    const { Characteristic, Service } = platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Nanit')
      .setCharacteristic(Characteristic.Model, 'Nanit Camera')
      .setCharacteristic(Characteristic.SerialNumber, cameraInfo.cameraUid);

    const enableHksv = config.enableHksv !== false;
    const debug = config.videoConfig?.debug ?? false;

    let recordingOptions: { options: typeof HKSV_RECORDING_OPTIONS; delegate: NanitRecordingDelegate; motionService: Service } | undefined;

    if (enableHksv) {
      // Create a MotionSensor service manually so we can reference it before
      // configureController (which creates it internally via sensors.motion).
      // We pass the service instance so CameraController attaches HKSV triggers
      // to the existing service rather than creating a duplicate.
      const motionService = (
        this.accessory.getService(Service.MotionSensor)
        ?? this.accessory.addService(Service.MotionSensor, cameraInfo.babyName)
      );

      this.prebuffer = new NanitPrebuffer(
        log,
        cameraInfo.babyName,
        cameraInfo.babyUid,
        streamResolver,
        wsClient,
        debug,
      );

      this.recordingDelegate = new NanitRecordingDelegate(
        log,
        cameraInfo.babyName,
        this.prebuffer,
        motionService,
        platform.Characteristic,
      );

      wsClient.onMotionDetected((ts) => {
        this.recordingDelegate!.handleMotionDetected(ts);
      });

      recordingOptions = {
        options: HKSV_RECORDING_OPTIONS,
        delegate: this.recordingDelegate,
        motionService,
      };
    }

    this.streamingDelegate = new NanitStreamingDelegate(
      log,
      platform.api.hap,
      platform.api,
      cameraInfo.babyName,
      cameraInfo.babyUid,
      streamResolver,
      wsClient,
      nanitApi,
      config,
      recordingOptions,
    );

    if (this.prebuffer) {
      const prebuf = this.prebuffer;
      this.streamingDelegate.isPrebufferActive = () => prebuf.isActive;
    }

    this.accessory.configureController(this.streamingDelegate.controller);

    const cameraConfig = config.cameras?.find(c => c.babyUid === cameraInfo.babyUid);
    const enableLight = cameraConfig?.enableLight ?? true;
    const enableSound = cameraConfig?.enableSound ?? true;
    const enableSensors = cameraConfig?.enableSensors ?? true;

    if (enableLight) {
      this.nightLightService = new NightLightService(this, log, wsClient);
    }

    if (enableSound) {
      this.soundMachineService = new SoundMachineService(this, log, wsClient);
      const enableTrackSwitches = cameraConfig?.enableSoundTracks ?? true;
      if (enableTrackSwitches) {
        this.soundTrackServices = new SoundTrackServices(this, log, wsClient);
      }
    } else {
      // If sound disabled, also strip any cached track switches
      for (const name of ['Sound: Birds', 'Sound: Waves', 'Sound: White Noise', 'Sound: Wind']) {
        const stale = accessory.getService(name);
        if (stale) accessory.removeService(stale);
      }
    }

    if (enableSensors) {
      this.sensorServices = new SensorServices(this, log, wsClient);
    }

    this.cameraToggles = new CameraToggleServices(this, log, wsClient, {
      nightVision: cameraConfig?.enableNightVision ?? true,
      sleepMode: cameraConfig?.enableSleepMode ?? true,
      statusLight: cameraConfig?.enableStatusLight ?? true,
      micMute: cameraConfig?.enableMicMute ?? true,
    });

    wsClient.onStateChange((state) => {
      if (state.firmwareVersion) {
        this.accessory.getService(Service.AccessoryInformation)!
          .updateCharacteristic(Characteristic.FirmwareRevision, state.firmwareVersion);
      }
    });
  }

  destroy(): void {
    this.prebuffer?.destroy();
  }
}
