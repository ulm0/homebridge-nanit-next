import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import bundledFfmpeg from 'ffmpeg-for-homebridge';
import { findFfmpeg, detectAacEncoder } from '../dist/utils.js';

test('bundled binary is the default and FFMPEG_PATH still takes precedence', () => {
  const original = process.env.FFMPEG_PATH;
  try {
    delete process.env.FFMPEG_PATH;
    assert.equal(findFfmpeg(), bundledFfmpeg || 'ffmpeg');
    process.env.FFMPEG_PATH = '/custom/ffmpeg';
    assert.equal(findFfmpeg(), '/custom/ffmpeg');
  } finally {
    if (original === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = original;
  }
});

test('incompatible system AAC encoders fail clearly instead of silently substituting LC', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nanit-audio-'));
  try {
    const binary = join(dir, 'ffmpeg');
    writeFileSync(binary, '#!/bin/sh\nprintf " A..... aac native\\n A..... aac_at AudioToolbox\\n"\n', { mode: 0o755 });
    assert.throws(() => detectAacEncoder(binary), /requires libfdk_aac/);
    assert.throws(() => detectAacEncoder(join(dir, 'missing')), /Could not query FFmpeg encoders/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('official FFmpeg actually encodes HomeKit AAC-ELD', { skip: !bundledFfmpeg }, () => {
  const encoder = detectAacEncoder(bundledFfmpeg);
  const args = ['-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=16000',
    '-t', '0.1', '-c:a', encoder.codec, ...encoder.profileArgs,
    '-flags', '+global_header', '-ar', '16000', '-b:a', '24k', '-ac', '1', '-f', 'null', '-'];
  // A generated tone exercises the real encoder; no camera audio is recorded.
  const result = spawnSync(bundledFfmpeg, args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Audio: aac \(ELD\)/);
});
