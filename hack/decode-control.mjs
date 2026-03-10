#!/usr/bin/env node
/**
 * Wire-level protobuf decoder for Nanit Control messages.
 *
 * Usage:
 *   node hack/decode-control.mjs <hex_string>
 *
 * Example — decode a raw Message bytes captured from the WebSocket:
 *   node hack/decode-control.mjs 0a020801120e...
 *
 * The script decodes the outer Message envelope, then does a schema-free
 * wire-level decode of the embedded Control payload so every field number
 * is visible, including ones not yet in nanit.proto.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const protobuf = require('protobufjs');
const { Reader } = protobuf;

// ── wire-type constants ────────────────────────────────────────────────────
const WIRE_VARINT = 0;
const WIRE_64BIT  = 1;
const WIRE_DELIM  = 2;
const WIRE_32BIT  = 5;

function decodeVarint(reader) {
  return reader.uint64(); // returns Long; call .toNumber() for display
}

/**
 * Decode a raw protobuf buffer without any schema.
 * Returns an array of { field, wireType, value } objects.
 */
function wireDecodeFull(buf) {
  const reader = Reader.create(buf);
  const fields = [];

  while (reader.pos < reader.len) {
    const tag    = reader.uint32();
    const field  = tag >>> 3;
    const wtype  = tag & 0x7;

    let value;
    switch (wtype) {
      case WIRE_VARINT: {
        const v = reader.int64();
        value = v.toNumber();
        break;
      }
      case WIRE_64BIT: {
        const lo = reader.fixed32();
        const hi = reader.fixed32();
        value = `0x${hi.toString(16).padStart(8,'0')}${lo.toString(16).padStart(8,'0')}`;
        break;
      }
      case WIRE_DELIM: {
        const bytes = reader.bytes();
        // Try to recursively decode as a sub-message.
        let sub;
        try {
          sub = wireDecodeFull(bytes);
        } catch {
          sub = null;
        }
        value = sub ?? Buffer.from(bytes).toString('hex');
        break;
      }
      case WIRE_32BIT: {
        value = reader.fixed32();
        break;
      }
      default:
        throw new Error(`Unknown wire type ${wtype} at pos ${reader.pos}`);
    }

    fields.push({ field, wireType: wtype, value });
  }

  return fields;
}

// ── known field names from nanit.proto ────────────────────────────────────
const MESSAGE_FIELDS = { 1: 'type', 2: 'request', 3: 'response' };
const REQUEST_FIELDS = { 1: 'id', 2: 'type', 4: 'streaming', 5: 'settings', 7: 'status', 8: 'getStatus', 12: 'getSensorData', 13: 'sensorData', 15: 'control', 16: 'playback', 18: 'getLogs', 19: 'getControl', 20: 'audioStreaming', 21: 'getAudioStreaming' };
const RESPONSE_FIELDS = { 1: 'requestId', 2: 'requestType', 3: 'statusCode', 4: 'statusMessage', 5: 'status', 6: 'settings', 9: 'sensorData', 15: 'control' };
const CONTROL_FIELDS  = { 3: 'nightLight (enum: 0=OFF 1=ON)', 4: 'sensorDataTransfer', 5: 'forceConnectToServer', 6: 'nightLightTimeout' };

function annotate(fields, knownMap) {
  return fields.map(f => ({
    ...f,
    name: knownMap[f.field] ?? `⚠ UNKNOWN field #${f.field}`,
  }));
}

function printFields(fields, knownMap, indent = '') {
  const annotated = annotate(fields, knownMap);
  for (const f of annotated) {
    const label = `${indent}field #${f.field} (${f.name})`;
    if (Array.isArray(f.value)) {
      console.log(`${label} → [sub-message]`);
      printFields(f.value, {}, indent + '  ');
    } else {
      console.log(`${label} → ${f.value}`);
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────
const hexArg = process.argv[2];
if (!hexArg) {
  console.error('Usage: node hack/decode-control.mjs <hex_bytes>');
  console.error('');
  console.error('Copy the hex from the Homebridge debug log line:');
  console.error('  [Nanit] Raw WS frame (hex): 0a020801...');
  process.exit(1);
}

const buf = Buffer.from(hexArg.replace(/\s+/g, ''), 'hex');

console.log(`\n=== Wire-level decode (${buf.length} bytes) ===\n`);
let topFields;
try {
  topFields = wireDecodeFull(buf);
} catch (err) {
  console.error('Failed to decode:', err.message);
  process.exit(1);
}

printFields(topFields, MESSAGE_FIELDS);

// Drill into request/response control payloads for readability.
for (const f of topFields) {
  if ((f.field === 2 || f.field === 3) && Array.isArray(f.value)) {
    const isResponse = f.field === 3;
    const envelope = isResponse ? RESPONSE_FIELDS : REQUEST_FIELDS;
    console.log(`\n=== ${isResponse ? 'Response' : 'Request'} fields ===\n`);
    const reqFields = annotate(f.value, envelope);
    printFields(f.value, envelope);

    // Find control sub-message (field 15).
    const controlRaw = f.value.find(x => x.field === 15);
    if (controlRaw && Array.isArray(controlRaw.value)) {
      console.log('\n=== Control sub-message (known fields + unknowns) ===\n');
      printFields(controlRaw.value, CONTROL_FIELDS);
    }
  }
}
