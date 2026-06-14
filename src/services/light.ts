import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

export class NightLightService {
  private readonly service: Service;
  private isOn = false;
  private brightness = 100;

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    this.service = accessory.accessory.getService('Night Light')
      || accessory.accessory.addService(Service.Lightbulb, 'Night Light', 'nanit-night-light');

    this.service.setCharacteristic(Characteristic.Name, 'Night Light');
    if (!this.service.testCharacteristic(Characteristic.ConfiguredName)) {
      this.service.addCharacteristic(Characteristic.ConfiguredName);
    }
    this.service.setCharacteristic(Characteristic.ConfiguredName, 'Night Light');

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
      }
      if (state.nightLightBrightness !== undefined) {
        this.brightness = state.nightLightBrightness;
        this.service.updateCharacteristic(Characteristic.Brightness, this.brightness);
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
    this.log.debug(`Setting night light: ${on}`);
    try {
      await this.wsClient.setNightLight(on);
      this.isOn = on;
    } catch (err) {
      this.log.error('Failed to set night light:', err);
      throw err;
    }
  }

  private async getBrightness(): Promise<CharacteristicValue> {
    return this.brightness;
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const v = value as number;
    this.log.debug(`Setting night light brightness: ${v}`);
    try {
      await this.wsClient.setNightLightBrightness(v);
      this.brightness = v;
    } catch (err) {
      this.log.error('Failed to set night light brightness:', err);
      throw err;
    }
  }
}
