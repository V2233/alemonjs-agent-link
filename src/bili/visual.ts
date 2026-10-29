import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

export type VideoFrame = { seconds: number; data: Buffer };
export type VideoVisual = {
  status: 'disabled' | 'unconfigured' | 'unavailable' | 'available';
  timestamps: number[];
  description: string;
  failedAt?: 'playback' | 'download' | 'decode' | 'vision';
};
const run = promisify(execFile);

export const videoSampleTimes = (duration: number): number[] => {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error('视频时长无效。');

  return [...new Set([0.15, 0.5, 0.85].map(ratio => Math.round(duration * ratio * 1000) / 1000))];
};

/** Decode only a local MP4, never hand a remote URL or shell expression to ffmpeg. */
export const extractVideoFrames = async (data: Buffer, duration: number, signal: AbortSignal, execute = run): Promise<VideoFrame[]> => {
  signal.throwIfAborted();
  if (data.length > 32 * 1024 * 1024 || data.length < 12 || data.subarray(4, 8).toString() !== 'ftyp') throw new Error('视频不是受支持的有限大小 MP4。');
  const times = videoSampleTimes(duration);
  const root = await mkdtemp(join(tmpdir(), 'agent-link-video-'));

  try {
    const input = join(root, 'input.mp4');

    await writeFile(input, data, { mode: 0o600 });
    const frames: VideoFrame[] = [];

    for (const [index, seconds] of times.entries()) {
      signal.throwIfAborted();
      const output = join(root, `${index}.png`);

      await execute(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-threads',
          '1',
          '-protocol_whitelist',
          'file,pipe',
          '-ss',
          String(seconds),
          '-f',
          'mov',
          '-i',
          input,
          '-an',
          '-sn',
          '-dn',
          '-frames:v',
          '1',
          '-vf',
          'scale=640:640:force_original_aspect_ratio=decrease',
          '-threads',
          '1',
          '-y',
          output
        ],
        { signal, timeout: 10000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
      );
      signal.throwIfAborted();
      const bytes = await readFile(output);

      if (bytes.length > 2 * 1024 * 1024) throw new Error('视频帧超过限制。');
      const image = await sharp(bytes, { limitInputPixels: 640 * 640 })
        .png()
        .toBuffer();

      frames.push({ seconds, data: image });
    }

    return frames;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const videoDownloadUrl = (value: unknown): URL => {
  const url = new URL(typeof value === 'string' ? value : '');

  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'bilivideo.com' || url.hostname.endsWith('.bilivideo.com')))
    throw new Error('视频下载来源不受支持。');

  return url;
};
