import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import type { Logging } from 'homebridge';

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
    const redacted = args.map((a, i) => (args[i - 1] === '-srtp_out_params' ? '<redacted>' : a));
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
  return process.env.FFMPEG_PATH || 'ffmpeg';
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

const AAC_CANDIDATES: Array<{ codec: string; profileArgs: string[] }> = [
  { codec: 'libfdk_aac', profileArgs: ['-profile:a', 'aac_eld'] },
  { codec: 'aac_at', profileArgs: ['-aac_at_mode', 'cvbr'] },
  { codec: 'aac', profileArgs: [] },
];

let cachedAacEncoder: AacEncoder | null = null;

export function detectAacEncoder(ffmpegPath: string, log?: Logging): AacEncoder {
  if (cachedAacEncoder) return cachedAacEncoder;

  let encoderList = '';
  try {
    encoderList = execFileSync(ffmpegPath, ['-encoders', '-hide_banner'], {
      timeout: 5000,
    }).toString();
  } catch {
    log?.warn('Could not query ffmpeg encoders, defaulting to built-in aac');
    cachedAacEncoder = { codec: 'aac', profileArgs: [] };
    return cachedAacEncoder;
  }

  for (const candidate of AAC_CANDIDATES) {
    if (encoderList.includes(` ${candidate.codec} `) || encoderList.includes(` ${candidate.codec}\n`)) {
      log?.info(`Using AAC encoder: ${candidate.codec}`);
      cachedAacEncoder = candidate;
      return cachedAacEncoder;
    }
  }

  log?.warn('No known AAC encoder found, defaulting to built-in aac');
  cachedAacEncoder = { codec: 'aac', profileArgs: [] };
  return cachedAacEncoder;
}
