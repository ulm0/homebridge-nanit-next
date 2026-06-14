import type { Logging, Service } from 'homebridge';
import type { NanitWebSocketClient } from '../nanit/websocket.js';
import type { NanitCameraAccessory } from '../accessory.js';

export class SensorServices {
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private temperature = 0;
  private humidity = 0;

  constructor(
    private readonly accessory: NanitCameraAccessory,
    private readonly log: Logging,
    private readonly wsClient: NanitWebSocketClient,
  ) {
    const { Service, Characteristic } = accessory.platform;

    this.temperatureService = accessory.accessory.getService('Temperature')
      || accessory.accessory.addService(Service.TemperatureSensor, 'Temperature', 'nanit-temperature');

    this.temperatureService.setCharacteristic(Characteristic.Name, 'Temperature');
    if (!this.temperatureService.testCharacteristic(Characteristic.ConfiguredName)) {
      this.temperatureService.addCharacteristic(Characteristic.ConfiguredName);
    }
    this.temperatureService.setCharacteristic(Characteristic.ConfiguredName, 'Temperature');

    this.temperatureService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.temperature);

    this.humidityService = accessory.accessory.getService('Humidity')
      || accessory.accessory.addService(Service.HumiditySensor, 'Humidity', 'nanit-humidity');

    this.humidityService.setCharacteristic(Characteristic.Name, 'Humidity');
    if (!this.humidityService.testCharacteristic(Characteristic.ConfiguredName)) {
      this.humidityService.addCharacteristic(Characteristic.ConfiguredName);
    }
    this.humidityService.setCharacteristic(Characteristic.ConfiguredName, 'Humidity');

    this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.humidity);

    wsClient.onStateChange((state) => {
      if (state.sensors) {
        if (state.sensors.temperature !== undefined) {
          this.temperature = state.sensors.temperature;
          this.temperatureService.updateCharacteristic(
            Characteristic.CurrentTemperature,
            this.temperature,
          );
        }
        if (state.sensors.humidity !== undefined) {
          this.humidity = state.sensors.humidity;
          this.humidityService.updateCharacteristic(
            Characteristic.CurrentRelativeHumidity,
            this.humidity,
          );
        }
      }
    });
  }

  getTemperatureService(): Service {
    return this.temperatureService;
  }

  getHumidityService(): Service {
    return this.humidityService;
  }
}
