import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

// The Nanit camera protocol only supports binary on/off for the night light.
// Brightness is stored locally and used to give HomeKit a meaningful slider
// position — 0 % turns the light off, 1–100 % turns it on.
const DEFAULT_BRIGHTNESS = 100;

export class NightLightService {
  private readonly service: Service;
  private isOn = false;
  private brightness = DEFAULT_BRIGHTNESS;

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    this.service = accessory.accessory.getService('Night Light')
      || accessory.accessory.addService(Service.Lightbulb, 'Night Light', 'nanit-night-light');

    this.service.setCharacteristic(Characteristic.Name, 'Night Light');

    this.service.getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    this.service.getCharacteristic(Characteristic.Brightness)
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));

    wsClient.onStateChange((state) => {
      if (state.nightLightOn !== undefined) {
        this.isOn = state.nightLightOn;
        this.service.updateCharacteristic(Characteristic.On, this.isOn);

        // When the light is turned off externally, reflect brightness as 0 in
        // HomeKit without overwriting the stored value so we can restore it.
        if (!this.isOn) {
          this.service.updateCharacteristic(Characteristic.Brightness, 0);
        } else {
          this.service.updateCharacteristic(Characteristic.Brightness, this.brightness);
        }
      }
    });
  }

  getService(): Service {
    return this.service;
  }

  private async getOn(): Promise<CharacteristicValue> {
    return this.isOn;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.log.debug(`Setting night light on: ${on}`);
    try {
      await this.wsClient.setNightLight(on);
      this.isOn = on;

      // Keep the brightness slider consistent with the on/off state.
      const { Characteristic } = this.accessory.platform;
      if (on) {
        this.service.updateCharacteristic(Characteristic.Brightness, this.brightness);
      } else {
        this.service.updateCharacteristic(Characteristic.Brightness, 0);
      }
    } catch (err) {
      this.log.error('Failed to set night light:', err);
      throw err;
    }
  }

  private async getBrightness(): Promise<CharacteristicValue> {
    return this.isOn ? this.brightness : 0;
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const level = value as number;
    this.log.debug(`Setting night light brightness: ${level}%`);

    const shouldBeOn = level > 0;

    // Persist a non-zero brightness so it is restored on the next power-on.
    if (level > 0) {
      this.brightness = level;
    }

    try {
      if (shouldBeOn !== this.isOn) {
        await this.wsClient.setNightLight(shouldBeOn);
        this.isOn = shouldBeOn;

        const { Characteristic } = this.accessory.platform;
        this.service.updateCharacteristic(Characteristic.On, this.isOn);
      }
    } catch (err) {
      this.log.error('Failed to set night light brightness:', err);
      throw err;
    }
  }
}
