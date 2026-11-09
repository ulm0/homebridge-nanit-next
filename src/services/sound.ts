import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

// How long a "sound machine on" write waits for a switched-off camera to
// switch on before the playback request is sent anyway. HAP-NodeJS answers
// a write with a timeout error after 9 s (3 s warning + 6 s), so this has to
// stay well below that.
const CAMERA_ON_WAIT_MS = 5_000;

export class SoundMachineService {
  private readonly service: Service;
  private isPlaying = false;
  private volume = 50;
  /** Counts On/Off writes, so a write that waited for the camera knows when a newer one has overtaken it. */
  private lastSetRequest = 0;

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
    const request = ++this.lastSetRequest;
    this.log.debug(`Setting sound machine: ${on}`);
    try {
      if (on) {
        await this.waitForCameraOn();
        // A newer On/Off write arrived while this one waited: that write is
        // the current wish, so this one does nothing more.
        if (request !== this.lastSetRequest) return;
        await this.wsClient.startPlayback();
      } else {
        await this.wsClient.stopPlayback();
      }
      if (request !== this.lastSetRequest) return;
      this.isPlaying = on;
    } catch (err) {
      this.log.error('Failed to set sound machine:', err);
      throw err;
    }
  }

  /**
   * Resolves once the camera is switched on, or after CAMERA_ON_WAIT_MS.
   *
   * A switched-off camera (Nanit "sleep mode") rejects a playback request
   * with "400 Bad Request: Can't start playback because camera is sleeping".
   * A HomeKit scene that turns the sound machine on and sleep mode off
   * writes both characteristics in one request, and HAP-NodeJS dispatches
   * the writes concurrently, so the playback request usually reaches the
   * camera before the sleep mode change does. The scene then fails on its
   * first run and succeeds on the second, when the camera is already on.
   *
   * If the camera is still off when the wait ends, the playback request is
   * sent anyway and the camera's rejection reaches HomeKit as before.
   */
  private waitForCameraOn(): Promise<void> {
    if (this.wsClient.currentState.sleepMode !== true) {
      return Promise.resolve();
    }
    this.log.debug('Sound machine: camera is off, waiting for it to switch on');
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(done, CAMERA_ON_WAIT_MS);
      const unsubscribe = this.wsClient.onStateChange((state) => {
        if (state.sleepMode === false) done();
      });
    });
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
