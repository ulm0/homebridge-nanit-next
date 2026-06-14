import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  private readonly wsClientsByBabyUid = new Map<string, NanitWebSocketClient>();
  private readonly pluginConfig: NanitPlatformConfig;
  private readonly discoveredCameraIpsPath: string;
  private discoveredCameraIps: Record<string, string> = {};

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
    this.discoveredCameraIpsPath = join(api.user.storagePath(), 'nanit-cameras.json');

    const streamMode: StreamMode = this.pluginConfig.streamMode ?? 'auto';
    this.streamResolver = new StreamResolver(
      log,
      this.nanitApi,
      streamMode,
      (babyUid, ip) => {
        this.onCameraIpDiscovered(babyUid, ip).catch(err => {
          this.log.debug('Failed to persist discovered camera IP:', err);
        });
      },
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
    await this.loadDiscoveredCameraIps();

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

    const unmatchedConfigs = new Set(
      (this.pluginConfig.cameras ?? []).filter(c => !c.babyUid),
    );

    for (const baby of babies) {
      let cameraConfig = this.pluginConfig.cameras?.find(c => c.babyUid === baby.uid);

      if (!cameraConfig && unmatchedConfigs.size > 0) {
        // Try matching by persisted IP: if a config entry has a localIp that
        // matches what we previously discovered for this baby, bind them.
        const persistedIp = this.discoveredCameraIps[baby.uid];
        if (persistedIp) {
          for (const candidate of unmatchedConfigs) {
            if (candidate.localIp === persistedIp) {
              cameraConfig = candidate;
              unmatchedConfigs.delete(candidate);
              break;
            }
          }
        }

        // Last resort: if there's exactly one unmatched config entry, use it.
        if (!cameraConfig && unmatchedConfigs.size === 1) {
          cameraConfig = [...unmatchedConfigs][0];
          unmatchedConfigs.delete(cameraConfig);
        }

        if (cameraConfig) {
          this.log.info(
            `Auto-associated camera config (localIp=${cameraConfig.localIp ?? 'none'}) `
            + `with baby "${baby.name ?? baby.uid}" (babyUid: ${baby.uid}). `
            + 'Set babyUid in config to make this explicit.',
          );
        }
      }

      const displayName = cameraConfig?.name ?? baby.name ?? `Nanit ${baby.uid.slice(0, 6)}`;
      let localIp = cameraConfig?.localIp ?? this.discoveredCameraIps[baby.uid];

      if (!localIp) {
        const hints = await this.nanitApi.getCameraLocalIpHints(baby.camera_uid);
        if (hints.length > 0) {
          localIp = hints[0];
          this.log.info(`Cloud provided local IP hint for ${displayName}: ${localIp}`);
          await this.onCameraIpDiscovered(baby.uid, localIp);
        }
      } else {
        this.log.debug(`Using persisted/configured local IP for ${displayName}: ${localIp}`);
      }

      const cameraInfo: CameraInfo = {
        babyUid: baby.uid,
        cameraUid: baby.camera_uid,
        babyName: displayName,
        localIp,
      };

      if (localIp) {
        this.streamResolver.addAllowedCameraIp(localIp);
      }

      const uuid = this.api.hap.uuid.generate(baby.camera_uid);
      this.discoveredUUIDs.push(uuid);

      const wsClient = new NanitWebSocketClient(
        this.log,
        this.auth,
        this.nanitApi,
        baby.camera_uid,
        localIp,
        this.pluginConfig.debug?.probe ?? false,
      );
      this.wsClients.set(baby.camera_uid, wsClient);
      this.wsClientsByBabyUid.set(baby.uid, wsClient);

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

  private async loadDiscoveredCameraIps(): Promise<void> {
    try {
      const data = await readFile(this.discoveredCameraIpsPath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, string>;
      this.discoveredCameraIps = parsed ?? {};
      const count = Object.keys(this.discoveredCameraIps).length;
      if (count > 0) {
        this.log.info(`Loaded ${count} persisted camera local IP mapping(s)`);
      }
    } catch {
      this.discoveredCameraIps = {};
    }
  }

  private async saveDiscoveredCameraIps(): Promise<void> {
    await mkdir(this.api.user.storagePath(), { recursive: true });
    await writeFile(this.discoveredCameraIpsPath, JSON.stringify(this.discoveredCameraIps, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  private async onCameraIpDiscovered(babyUid: string, ip: string): Promise<void> {
    const prev = this.discoveredCameraIps[babyUid];
    if (prev === ip) return;

    this.discoveredCameraIps[babyUid] = ip;
    this.streamResolver.addAllowedCameraIp(ip);
    await this.saveDiscoveredCameraIps();

    this.log.info(`Discovered camera local IP for ${babyUid}: ${ip}`);

    const wsClient = this.wsClientsByBabyUid.get(babyUid);
    const streamMode: StreamMode = this.pluginConfig.streamMode ?? 'auto';
    if (wsClient) {
      wsClient.setCameraLocalIp(ip);
      // In auto mode, prefer switching to local WS once the camera IP is known.
      if (streamMode === 'auto') {
        wsClient.connectAuto().catch(err => {
          this.log.debug('Failed to re-negotiate local WebSocket after IP discovery:', err);
        });
      }
    }
  }
}
