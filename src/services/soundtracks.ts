import type { CharacteristicValue, Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

interface TrackDef {
  filename: string;
  displayName: string;
  subtype: string;
}

// Filenames captured from the iOS Nanit app on firmware 6.55.611. Display
// names match the app labels.
const TRACKS: TrackDef[] = [
  { filename: 'Birds.wav', displayName: 'Sound: Birds', subtype: 'nanit-track-birds' },
  { filename: 'Waves.wav', displayName: 'Sound: Waves', subtype: 'nanit-track-waves' },
  { filename: 'White Noise.wav', displayName: 'Sound: White Noise', subtype: 'nanit-track-white-noise' },
  { filename: 'Wind.wav', displayName: 'Sound: Wind', subtype: 'nanit-track-wind' },
];

export class SoundTrackServices {
  private readonly services = new Map<string, Service>();

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    for (const track of TRACKS) {
      const service = accessory.accessory.getService(track.displayName)
        || accessory.accessory.addService(Service.Switch, track.displayName, track.subtype);

      service.setCharacteristic(Characteristic.Name, track.displayName);
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addCharacteristic(Characteristic.ConfiguredName);
      }
      service.setCharacteristic(Characteristic.ConfiguredName, track.displayName);

      service.getCharacteristic(Characteristic.On)
        .onGet(() => this.isCurrentTrack(track.filename))
        .onSet(async (value: CharacteristicValue) => {
          const on = value as boolean;
          this.log.debug(`Setting track ${track.filename}: ${on}`);
          try {
            if (on) {
              await wsClient.startPlayback(track.filename);
            } else if (this.isCurrentTrack(track.filename)) {
              await wsClient.stopPlayback();
            }
          } catch (err) {
            this.log.error(`Failed to toggle track ${track.filename}:`, err);
            throw err;
          }
        });

      this.services.set(track.filename, service);
    }

    wsClient.onStateChange((state) => {
      if (state.soundPlaying === undefined && state.soundTrack === undefined) return;
      for (const track of TRACKS) {
        const svc = this.services.get(track.filename);
        if (!svc) continue;
        svc.updateCharacteristic(Characteristic.On, this.isCurrentTrack(track.filename));
      }
    });
  }

  private isCurrentTrack(filename: string): boolean {
    const state = this.wsClient.currentState;
    return state.soundPlaying === true && state.soundTrack === filename;
  }
}
