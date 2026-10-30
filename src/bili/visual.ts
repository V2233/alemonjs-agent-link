import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

export type VideoFrame = { seconds: number; data: Buffer; positions?: number[]; region?: 'bottom_band'; source?: 'storyboard' };
export type VideoVisual = {
  status: 'disabled' | 'unconfigured' | 'unavailable' | 'available';
  timestamps: number[];
  description: string;
  region?: 'bottom_band';
  source?: 'storyboard';
  requestedTimestamps?: number[];
  requestedWindow?: { start: number; end: number };
  samplingReason?: 'question_window';
  message?: string;
  failedAt?: 'selection' | 'playback' | 'download' | 'decode' | 'vision';
};
const run = promisify(execFile);

export const visualSampleRequest = (value: unknown): number[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    value.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > 86400)
  ) {
    throw new Error('B 站画面采样位置需要1–3个0–86400秒的有限数值。');
  }

  return [...new Set(value as number[])].sort((a, b) => a - b);
};

export const videoSampleTimes = (duration: number, requestedTimes?: readonly number[]): number[] => {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error('视频时长无效。');
  const requested = visualSampleRequest(requestedTimes);

  if (requested) {
    if (requested.some(time => time >= duration)) throw new Error('B 站画面采样位置超出当前分P时长。');

    return requested;
  }

  return [...new Set([0.15, 0.5, 0.85].map(ratio => Math.round(duration * ratio * 1000) / 1000))];
};

/** Pick within each third so a burst of cuts cannot consume the whole image budget. */
export const videoSceneSampleTimes = (duration: number, diagnostic: string): number[] => {
  const fallback = videoSampleTimes(duration);
  const candidates = [...diagnostic.slice(0, 128 * 1024).matchAll(/\bpts_time:([0-9]+(?:\.[0-9]+)?)\b/gu)]
    .map(match => Number(match[1]))
    .filter(time => Number.isFinite(time) && time > 0 && time < duration);

  return [
    ...new Set(
      fallback.map((target, index) => {
        const start = (index * duration) / 3;
        const end = ((index + 1) * duration) / 3;
        const eligible = candidates.filter(time => time >= start && time < end);
        const selected = eligible.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];

        // Move just past a detected cut, keeping the point within this third.
        if (selected === undefined) return target;
        const rounded = Math.round(Math.min(selected + 0.1, selected + (end - selected) / 2) * 1000) / 1000;

        return rounded >= end || rounded < start ? selected : rounded;
      })
    )
  ].sort((a, b) => a - b);
};

/** Decode only a local MP4, never hand a remote URL or shell expression to ffmpeg. */
export const extractVideoFrames = async (
  data: Buffer,
  duration: number,
  signal: AbortSignal,
  execute = run,
  requestedTimes?: readonly number[]
): Promise<VideoFrame[]> => {
  signal.throwIfAborted();
  if (data.length > 32 * 1024 * 1024 || data.length < 12 || data.subarray(4, 8).toString() !== 'ftyp') throw new Error('视频不是受支持的有限大小 MP4。');
  let times = videoSampleTimes(duration, requestedTimes);
  const root = await mkdtemp(join(tmpdir(), 'agent-link-video-'));

  try {
    const input = join(root, 'input.mp4');

    await writeFile(input, data, { mode: 0o600 });
    if (requestedTimes === undefined) {
      try {
        // This is a coarse scene probe, not a complete frame-by-frame analysis.
        // A slow/unsupported probe falls back without increasing vision requests.
        const probe = await execute(
          'ffmpeg',
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'info',
            '-threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-f',
            'mov',
            '-i',
            input,
            '-an',
            '-sn',
            '-dn',
            '-filter_threads',
            '1',
            '-vf',
            'fps=2,scale=160:160:force_original_aspect_ratio=decrease,select=gt(scene\\,0.25),showinfo',
            '-f',
            'null',
            '-'
          ],
          { signal, timeout: 5000, maxBuffer: 128 * 1024, killSignal: 'SIGKILL' }
        );

        times = videoSceneSampleTimes(duration, String(probe?.stderr || ''));
      } catch {
        signal.throwIfAborted();
      }
    }
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
