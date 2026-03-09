import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { NanitPlatformConfig, StreamMode } from './settings.js';
import { AuthManager } from './nanit/auth.js';
import { NanitApiClient } from './nanit/api.js';
import { NanitWebSocketClient } from './nanit/websocket.js';
import { StreamResolver } from './stream/resolver.js';
import { NanitCameraAccessory } from './accessory.js';
import { loadProto } from './nanit/protobuf/index.js';
import type { CameraInfo } from './nanit/types.js';

export class NanitPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly cameraAccessories: NanitCameraAccessory[] = [];
  private readonly discoveredUUIDs: string[] = [];

  private readonly auth: AuthManager;
  private readonly nanitApi: NanitApiClient;
  private readonly streamResolver: StreamResolver;
  private readonly wsClients = new Map<string, NanitWebSocketClient>();
  private readonly pluginConfig: NanitPlatformConfig;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pluginConfig = config as unknown as NanitPlatformConfig;

    this.auth = new AuthManager(log, api.user.storagePath());
    this.nanitApi = new NanitApiClient(log, this.auth);

    const streamMode: StreamMode = this.pluginConfig.streamMode ?? 'auto';
    this.streamResolver = new StreamResolver(
      log,
      this.nanitApi,
      streamMode,
      this.pluginConfig.rtmpListenPort,
      this.pluginConfig.localAddress,
    );

    this.log.info('Nanit platform initialized');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) => {
        this.log.error('Failed to discover Nanit cameras:', err);
      });
    });

    this.api.on('shutdown', () => {
      for (const ws of this.wsClients.values()) {
        ws.destroy();
      }
      for (const cam of this.cameraAccessories) {
        cam.destroy();
      }
      this.streamResolver.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading cached accessory:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    this.log.info('Nanit: starting device discovery...');

    try {
      await loadProto();
    } catch (err) {
      this.log.error('Nanit: failed to load protobuf schema:', err);
      return;
    }
    this.log.info('Nanit: protobuf schema loaded');

    const refreshToken = this.pluginConfig.auth?.refreshToken;
    this.log.info(`Nanit: initializing auth (refreshToken in config: ${refreshToken ? 'yes' : 'no'})`);
    await this.auth.initialize(refreshToken);

    if (!this.auth.refreshToken) {
      this.log.error(
        'Nanit: no credentials found. Authenticate via the plugin settings UI or add a refreshToken to the config.',
      );
      return;
    }

    this.log.info('Nanit: authenticating...');
    try {
      await this.auth.ensureValidToken();
    } catch (err) {
      this.log.error('Nanit: authentication failed:', err);
      return;
    }
    this.log.info('Nanit: authenticated successfully');

    this.log.info('Nanit: fetching babies/cameras...');
    let babies;
    try {
      babies = await this.nanitApi.getBabies();
    } catch (err) {
      this.log.error('Nanit: failed to fetch babies:', err);
      return;
    }

    if (babies.length === 0) {
      this.log.warn('Nanit: no babies/cameras found in your account');
      return;
    }

    this.log.info(`Nanit: found ${babies.length} camera(s)`);

    await this.streamResolver.initialize();

    for (const baby of babies) {
      const cameraConfig = this.pluginConfig.cameras?.find(c => c.babyUid === baby.uid);
      const displayName = cameraConfig?.name ?? baby.name ?? `Nanit ${baby.uid.slice(0, 6)}`;
      const localIp = cameraConfig?.localIp;

      const cameraInfo: CameraInfo = {
        babyUid: baby.uid,
        cameraUid: baby.camera_uid,
        babyName: displayName,
        localIp,
      };

      const uuid = this.api.hap.uuid.generate(baby.camera_uid);
      this.discoveredUUIDs.push(uuid);

      const wsClient = new NanitWebSocketClient(
        this.log,
        this.auth,
        this.nanitApi,
        baby.camera_uid,
        localIp,
      );
      this.wsClients.set(baby.camera_uid, wsClient);

      const streamMode = this.pluginConfig.streamMode ?? 'auto';
      if (streamMode === 'auto') {
        wsClient.connectAuto().catch(err => this.log.error(`WebSocket connect failed for ${displayName}:`, err));
      } else {
        wsClient.connect(streamMode === 'local' ? 'local' : 'cloud')
          .catch(err => this.log.error(`WebSocket connect failed for ${displayName}:`, err));
      }

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring cached accessory:', existingAccessory.displayName);
        existingAccessory.context.cameraInfo = cameraInfo;
        this.cameraAccessories.push(new NanitCameraAccessory(
          this, existingAccessory, this.log, cameraInfo,
          wsClient, this.nanitApi, this.streamResolver, this.pluginConfig,
        ));
      } else {
        this.log.info('Adding new accessory:', displayName);
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.category = this.api.hap.Categories.CAMERA;
        accessory.context.cameraInfo = cameraInfo;

        this.cameraAccessories.push(new NanitCameraAccessory(
          this, accessory, this.log, cameraInfo,
          wsClient, this.nanitApi, this.streamResolver, this.pluginConfig,
        ));

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredUUIDs.includes(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
