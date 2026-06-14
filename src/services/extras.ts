import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

type StateKey = 'nightVision' | 'sleepMode' | 'statusLightOn' | 'micMuteOn';

interface ToggleConfig {
  displayName: string;
  subtype: string;
  stateKey: StateKey;
  setter: (ws: NanitWebSocketClient, on: boolean) => Promise<void>;
  invert?: boolean;
}

const TOGGLES: ToggleConfig[] = [
  {
    displayName: 'Night Vision',
    subtype: 'nanit-night-vision',
    stateKey: 'nightVision',
    setter: (ws, on) => ws.setNightVision(on),
  },
  {
    displayName: 'Sleep Mode',
    subtype: 'nanit-sleep-mode',
    stateKey: 'sleepMode',
    setter: (ws, on) => ws.setSleepMode(on),
  },
  {
    displayName: 'Status Light',
    subtype: 'nanit-status-light',
    stateKey: 'statusLightOn',
    setter: (ws, on) => ws.setStatusLight(on),
  },
  // Camera microphone enable/disable. Backed by Settings.micMuteOn but
  // inverted so HomeKit "On" = mic enabled (intuitive); "Off" = camera
  // microphone muted (no audio reaches HomeKit OR the Nanit app).
  {
    displayName: 'Camera Microphone',
    subtype: 'nanit-camera-microphone',
    stateKey: 'micMuteOn',
    setter: (ws, on) => ws.setMicMute(!on),
    invert: true,
  },
];

export class CameraToggleServices {
  private readonly services = new Map<StateKey, { service: Service; current: boolean }>();

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
    enabled: { nightVision: boolean; sleepMode: boolean; statusLight: boolean; micMute: boolean },
  ) {
    const { Service, Characteristic } = accessory.platform;

    const enabledMap: Record<StateKey, boolean> = {
      nightVision: enabled.nightVision,
      sleepMode: enabled.sleepMode,
      statusLightOn: enabled.statusLight,
      micMuteOn: enabled.micMute,
    };

    // Remove legacy service names from earlier alphas so caches don't linger
    for (const legacy of ['Mic Mute']) {
      const stale = accessory.accessory.getService(legacy);
      if (stale) accessory.accessory.removeService(stale);
    }

    for (const toggle of TOGGLES) {
      if (!enabledMap[toggle.stateKey]) {
        // Remove cached service if it was previously registered then disabled
        const cached = accessory.accessory.getService(toggle.displayName);
        if (cached) accessory.accessory.removeService(cached);
        continue;
      }

      const service = accessory.accessory.getService(toggle.displayName)
        || accessory.accessory.addService(Service.Switch, toggle.displayName, toggle.subtype);

      service.setCharacteristic(Characteristic.Name, toggle.displayName);
      // ConfiguredName is what iOS 16+ Home app actually displays for
      // subservices on a multi-service accessory. Without it, all services
      // collapse to the accessory display name.
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addCharacteristic(Characteristic.ConfiguredName);
      }
      service.setCharacteristic(Characteristic.ConfiguredName, toggle.displayName);

      service.getCharacteristic(Characteristic.On)
        .onGet(() => this.services.get(toggle.stateKey)?.current ?? false)
        .onSet(async (value: CharacteristicValue) => {
          const on = value as boolean;
          this.log.debug(`Setting ${toggle.displayName}: ${on}`);
          try {
            await toggle.setter(wsClient, on);
            const entry = this.services.get(toggle.stateKey);
            if (entry) entry.current = on;
          } catch (err) {
            this.log.error(`Failed to set ${toggle.displayName}:`, err);
            throw err;
          }
        });

      this.services.set(toggle.stateKey, { service, current: false });
    }

    wsClient.onStateChange((state) => {
      for (const toggle of TOGGLES) {
        const value = state[toggle.stateKey];
        if (typeof value === 'boolean') {
          const entry = this.services.get(toggle.stateKey);
          if (entry) {
            const displayed = toggle.invert ? !value : value;
            entry.current = displayed;
            entry.service.updateCharacteristic(Characteristic.On, displayed);
          }
        }
      }
    });
  }
}
