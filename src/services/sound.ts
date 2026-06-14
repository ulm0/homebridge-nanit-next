import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

export class SoundMachineService {
  private readonly service: Service;
  private isPlaying = false;
  private volume = 50;

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    // Lightbulb so HomeKit gives us a Brightness slider for camera speaker
    // volume. iOS Home app shows this as a "light" but the slider is the
    // best HomeKit primitive for a 0-100 volume control on a toggleable item.
    // Remove any pre-existing Switch-typed service (older plugin versions
    // registered Sound Machine as a Switch).
    const existing = accessory.accessory.getService('Sound Machine');
    if (existing && existing.UUID !== Service.Lightbulb.UUID) {
      accessory.accessory.removeService(existing);
    }
    this.service = accessory.accessory.getService('Sound Machine')
      || accessory.accessory.addService(Service.Lightbulb, 'Sound Machine', 'nanit-sound-machine');

    this.service.setCharacteristic(Characteristic.Name, 'Sound Machine');
    if (!this.service.testCharacteristic(Characteristic.ConfiguredName)) {
      this.service.addCharacteristic(Characteristic.ConfiguredName);
    }
    this.service.setCharacteristic(Characteristic.ConfiguredName, 'Sound Machine');

    this.service.getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    this.service.getCharacteristic(Characteristic.Brightness)
      .onGet(this.getVolume.bind(this))
      .onSet(this.setVolume.bind(this));

    wsClient.onStateChange((state) => {
      if (state.soundPlaying !== undefined) {
        this.isPlaying = state.soundPlaying;
        this.service.updateCharacteristic(Characteristic.On, this.isPlaying);
      }
      if (state.volume !== undefined) {
        this.volume = state.volume;
        this.service.updateCharacteristic(Characteristic.Brightness, this.volume);
      }
    });
  }

  getService(): Service {
    return this.service;
  }

  private async getOn(): Promise<CharacteristicValue> {
    return this.isPlaying;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.log.debug(`Setting sound machine: ${on}`);
    try {
      if (on) {
        await this.wsClient.startPlayback();
      } else {
        await this.wsClient.stopPlayback();
      }
      this.isPlaying = on;
    } catch (err) {
      this.log.error('Failed to set sound machine:', err);
      throw err;
    }
  }

  private async getVolume(): Promise<CharacteristicValue> {
    return this.volume;
  }

  private async setVolume(value: CharacteristicValue): Promise<void> {
    const v = value as number;
    this.log.debug(`Setting camera volume: ${v}`);
    try {
      await this.wsClient.setVolume(v);
      this.volume = v;
    } catch (err) {
      this.log.error('Failed to set camera volume:', err);
      throw err;
    }
  }
}
