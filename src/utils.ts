import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type { Logging } from 'homebridge';
import bundledFfmpeg from 'ffmpeg-for-homebridge';

export class FfmpegProcess {
  private process: ChildProcess | null = null;
  private _killed = false;

  constructor(
    private readonly log: Logging,
    private readonly name: string,
    private readonly videoProcessor: string,
    private readonly debug: boolean,
  ) {}

  start(args: string[], onClose?: (code: number | null) => void): ChildProcess {
    const redacted = args.map((a, i) => {
      if (args[i - 1] === '-srtp_out_params') return '<redacted>';
      if (args[i - 1] === '-i' && /^rtmps?:\/\//.test(a)) return a.replace(/(\.\w{8})\w+$/, '$1...<redacted>');
      return a;
    });
    this.log.debug(`[${this.name}] ffmpeg ${redacted.join(' ')}`);

    this.process = spawn(this.videoProcessor, args, {
      env: process.env,
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter((l: string) => l.length > 0);
      for (const line of lines) {
        if (this.debug) {
          this.log.debug(`[${this.name}] ${line}`);
        } else if (line.includes('Error') || line.includes('error') || line.includes('Invalid')) {
          // Suppress known non-fatal AAC-ELD sync errors from libfdk_aac when decoding HomeKit audio
          if (line.includes('aacDecoder_DecodeFrame') || line.includes('Error submitting packet to decoder')) {
            continue;
          }
          this.log.warn(`[${this.name}] ${line}`);
        }
      }
    });

    this.process.on('error', (err) => {
      this.log.error(`[${this.name}] ffmpeg error: ${err.message}`);
    });

    this.process.on('close', (code) => {
      if (!this._killed && code !== 0) {
        this.log.warn(`[${this.name}] ffmpeg exited with code ${code}`);
      }
      onClose?.(code);
    });

    return this.process;
  }

  get stdin() {
    return this.process?.stdin ?? null;
  }

  get stdout() {
    return this.process?.stdout ?? null;
  }

  stop(): void {
    if (this.process && !this._killed) {
      this._killed = true;
      const proc = this.process;
      this.process = null;
      proc.kill('SIGTERM');
      const forceKillTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 3_000);
      proc.once('close', () => clearTimeout(forceKillTimer));
    }
  }

  get killed(): boolean {
    return this._killed;
  }
}

export function findFfmpeg(): string {
  return process.env.FFMPEG_PATH || bundledFfmpeg || 'ffmpeg';
}

/**
 * Capture a single JPEG frame from an RTMP stream using FFmpeg.
 * Resolves with the JPEG buffer, or null if capture fails.
 */
export function captureSnapshot(
  ffmpegPath: string,
  rtmpUrl: string,
  width: number,
  height: number,
  timeoutMs = 10_000,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-analyzeduration', '2000000',
      '-probesize', '2000000',
      '-rw_timeout', '5000000',
      '-i', rtmpUrl,
      '-vframes', '1',
      '-vf', `scale=${width}:${height}`,
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);

    const proc = spawn(ffmpegPath, args);

    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export interface AacEncoder {
  codec: string;
  profileArgs: string[];
}

const cachedAacEncoders = new Map<string, AacEncoder>();

export function detectAacEncoder(ffmpegPath: string, log?: Logging): AacEncoder {
  const cached = cachedAacEncoders.get(ffmpegPath);
  if (cached) return cached;

  let encoderList: string;
  try {
    encoderList = execFileSync(ffmpegPath, ['-encoders', '-hide_banner'], {
      timeout: 5000,
    }).toString();
  } catch {
    throw new Error('Could not query FFmpeg encoders. Install ffmpeg-for-homebridge or check FFMPEG_PATH.');
  }

  // Live HomeKit audio negotiates AAC-ELD. Native AAC defaults to LC, and
  // AudioToolbox ELD did not produce audible HomeKit playback in testing.
  if (!/^\s*\S+\s+libfdk_aac(?:\s|$)/m.test(encoderList)) {
    throw new Error('HomeKit live audio requires libfdk_aac (AAC-ELD). '
      + 'Install ffmpeg-for-homebridge or set FFMPEG_PATH to a build with libfdk_aac.');
  }

  const encoder = { codec: 'libfdk_aac', profileArgs: ['-profile:a', 'aac_eld'] };
  log?.info('Using AAC encoder: libfdk_aac');
  cachedAacEncoders.set(ffmpegPath, encoder);
  return encoder;
}
