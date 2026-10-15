import assert from 'node:assert/strict';
import { test } from 'node:test';
import protobuf from 'protobufjs';
import { loadProto, encodeMessage, decodeMessage } from '../dist/nanit/protobuf/index.js';
import { NanitWebSocketClient } from '../dist/nanit/websocket.js';

await loadProto();
const log = { debug() {}, info() {}, warn() {}, error(...args) { throw new Error(args.join(' ')); } };
function client() {
  return new NanitWebSocketClient(log, {}, {}, 'test-camera');
}
function response(sensorData, settings) {
  return encodeMessage({ type: 'RESPONSE', response: {
    requestId: 1, requestType: 'GET_SENSOR_DATA', statusCode: 200, sensorData, settings,
  } });
}

test('settings with an omitted sensorType do not discard sensor readings', () => {
  // Synthetic equivalent of the SensorSettings instance in the failure log.
  // Write wire bytes directly: fromObject/encode synthesizes required defaults.
  const settings = protobuf.Writer.create()
    .uint32(58).fork()
      .uint32(16).bool(false).uint32(24).bool(true).uint32(40).int32(70)
      .uint32(48).int32(0).uint32(56).int32(0)
    .ldelim().finish();
  const payload = protobuf.Writer.create()
    .uint32(8).int32(1).uint32(16).int32(12).uint32(24).int32(200)
    .uint32(50).bytes(settings)
    .uint32(74).bytes(Uint8Array.from([8, 2, 48, 204, 183, 1]))
    .uint32(74).bytes(Uint8Array.from([8, 3, 48, 238, 252, 2])).finish();
  const frame = protobuf.Writer.create().uint32(8).int32(2)
    .uint32(26).bytes(payload).finish();
  const decoded = decodeMessage(frame);
  assert.equal(Object.hasOwn(decoded.response.settings.sensors[0], 'sensorType'), false);
  const ws = client();
  ws.onMessage(frame);
  assert.deepEqual(ws.currentState.sensors, { temperature: 23.5, humidity: 48.75 });
});

test('id-only requests decode without inventing a type or sending an acknowledgement', () => {
  const frame = Uint8Array.from([0x08, 0x01, 0x12, 0x02, 0x08, 0x01]);
  assert.deepEqual(decodeMessage(frame), { type: 'REQUEST', request: { id: 1 } });
  const ws = client();
  ws.sendRaw = () => assert.fail('must not acknowledge an unknown request type');
  ws.onMessage(frame);
  assert.deepEqual(ws.currentState.sensors, {});
});

test('explicit zero values update readings while absent values preserve previous readings', () => {
  const ws = client();
  ws.onMessage(response([{ sensorType: 'TEMPERATURE', valueMilli: 21000 },
    { sensorType: 'HUMIDITY', valueMilli: 45000 }]));
  ws.onMessage(response([{ sensorType: 'TEMPERATURE', valueMilli: 0 },
    { sensorType: 'HUMIDITY' }]));
  assert.deepEqual(ws.currentState.sensors, { temperature: 0, humidity: 45 });
});

test('sensor data still requires a sensor type', () => {
  const frame = Uint8Array.from([8, 1, 18, 10, 8, 1, 16, 11, 106, 4, 48, 204, 183, 1]);
  assert.throws(() => decodeMessage(frame), /missing required 'sensorType'/);
});

test('truncated protobuf input is still rejected', () => {
  assert.throws(() => decodeMessage(Uint8Array.from([0x08, 0x02, 0x1a, 0xff])));
});

test('local connection requests sensors immediately without changing camera controls', async () => {
  const ws = client();
  ws.connectionMode = 'local';
  const requests = [];
  ws.sendRequest = async (type, data) => { requests.push({ type, data }); return {}; };
  await ws.requestInitialState();
  assert.deepEqual(requests, [{ type: 'GET_SENSOR_DATA', data: { getSensorData: { all: true } } }]);
});

test('local polling refreshes sensors every minute and is cleaned up on disconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ws = client();
  ws.connectionMode = 'local';
  const requests = [];
  ws.sendRequest = async (type) => { requests.push(type); return {}; };
  ws.startKeepalive();
  t.mock.timers.tick(60_000);
  assert.deepEqual(requests, ['GET_SENSOR_DATA']);
  ws.disconnect();
  t.mock.timers.tick(120_000);
  assert.deepEqual(requests, ['GET_SENSOR_DATA']);
});

test('sensor polling errors are contained and a subsequent poll can recover', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ws = client();
  ws.connectionMode = 'local';
  let requests = 0;
  ws.sendRequest = async () => { if (++requests === 1) throw new Error('timeout'); return {}; };
  ws.startKeepalive();
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.equal(requests, 2);
  ws.destroy();
});

test('cloud connections retain push updates without adding a polling timer', () => {
  const ws = client();
  ws.startKeepalive();
  assert.equal(ws.sensorPollTimer, null);
  ws.destroy();
});
