import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { visualCropRequest, type VideoCrop } from './crop';

export type VideoFrame = {
  seconds: number;
  data: Buffer;
  positions?: number[];
  region?: 'bottom_band' | 'frame_grid' | 'crop';
  crop?: VideoCrop;
  source?: 'storyboard';
};
export type VideoVisual = {
  status: 'disabled' | 'unconfigured' | 'unavailable' | 'available';
  timestamps: number[];
  description: string;
  region?: 'bottom_band' | 'frame_grid' | 'crop';
  crop?: VideoCrop;
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

export const videoSampleTimes = (duration: number, requestedTimes?: readonly number[], count: 3 | 9 = 3): number[] => {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error('视频时长无效。');
  const requested = visualSampleRequest(requestedTimes);

  if (requested) {
    if (requested.some(time => time >= duration)) throw new Error('B 站画面采样位置超出当前分P时长。');

    return requested;
  }

  const ratios = count === 9 ? Array.from({ length: 9 }, (_, index) => (index + 0.5) / 9) : [0.15, 0.5, 0.85];

  return [...new Set(ratios.map(ratio => Math.min(duration * 0.999999, Math.round(duration * ratio * 1000) / 1000)))];
};

/** Pick within each time segment so a burst of cuts cannot consume the whole image budget. */
export const videoSceneSampleTimes = (duration: number, diagnostic: string, count: 3 | 9 = 3): number[] => {
  const fallback = videoSampleTimes(duration, undefined, count);
  const candidates = [...diagnostic.slice(0, 128 * 1024).matchAll(/\bpts_time:([0-9]+(?:\.[0-9]+)?)\b/gu)]
    .map(match => Number(match[1]))
    .filter(time => Number.isFinite(time) && time > 0 && time < duration);

  return [
    ...new Set(
      fallback.map((target, index) => {
        const start = (index * duration) / count;
        const end = ((index + 1) * duration) / count;
        const eligible = candidates.filter(time => time >= start && time < end);
        const selected = eligible.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];

        // Move just past a detected cut, keeping the point within this segment.
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
  requestedTimes?: readonly number[],
  cropRequest?: VideoCrop
): Promise<VideoFrame[]> => {
  signal.throwIfAborted();
  const crop = visualCropRequest(cropRequest);

  if (crop && !visualSampleRequest(requestedTimes)) throw new Error('局部画面读取需要1–3个指定采样位置。');
  if (data.length > 32 * 1024 * 1024 || data.length < 12 || data.subarray(4, 8).toString() !== 'ftyp') throw new Error('视频不是受支持的有限大小 MP4。');
  let times = videoSampleTimes(duration, requestedTimes, 9);
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
            '-enable_drefs',
            '0',
            '-use_absolute_path',
            '0',
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

        times = videoSceneSampleTimes(duration, String(probe?.stderr || ''), 9);
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
          '-enable_drefs',
          '0',
          '-use_absolute_path',
          '0',
          '-i',
          input,
          '-an',
          '-sn',
          '-dn',
          '-frames:v',
          '1',
          '-vf',
          `${crop ? `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` : ''}scale=640:640:force_original_aspect_ratio=decrease`,
          '-threads',
          '1',
          '-y',
          output
        ],
        { signal, timeout: 10000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' }
      );
      signal.throwIfAborted();
      let bytes: Buffer;

      try {
        bytes = await readFile(output);
      } catch (error) {
        // A low-frame-rate clip may have no decoded frame at a late seek.
        // Only successful output contributes a sampled timestamp.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      if (bytes.length > 2 * 1024 * 1024) throw new Error('视频帧超过限制。');
      const image = await sharp(bytes, { limitInputPixels: 640 * 640 })
        .png()
        .toBuffer();

      frames.push({ seconds, data: image, ...(crop ? { region: 'crop' as const, crop } : {}) });
    }

    return frames;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Keep every full frame and its timestamp, with at most three images per vision request. */
export const packVideoFrames = async (frames: VideoFrame[], signal: AbortSignal): Promise<VideoFrame[]> => {
  signal.throwIfAborted();
  if (frames.length < 1 || frames.length > 9 || frames.some(frame => frame.positions || frame.region || !Number.isFinite(frame.seconds) || frame.seconds < 0))
    throw new Error('完整画面采样无效。');
  if (frames.some((frame, index) => index > 0 && frame.seconds <= frames[index - 1].seconds)) throw new Error('画面采样顺序无效。');
  if (frames.length <= 3) return frames;
  const boards: VideoFrame[] = [];

  for (let index = 0; index < frames.length; index += 3) {
    const rows = frames.slice(index, index + 3);

    if (rows.some(row => row.source !== rows[0].source)) throw new Error('画面来源不能混合。');
    const compose = async (size: number): Promise<Buffer> => {
      let top = 0;
      const layers = [];
      let width = 0;

      for (const row of rows) {
        signal.throwIfAborted();
        if (row.data.length > 2 * 1024 * 1024) throw new Error('视频帧超过限制。');
        const { data, info } = await sharp(row.data, { limitInputPixels: 640 * 640 })
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .removeAlpha()
          .png()
          .toBuffer({ resolveWithObject: true });

        layers.push({ input: data, left: 0, top });
        width = Math.max(width, info.width);
        top += info.height + 4;
      }

      const composed = await sharp({ create: { width, height: top - 4, channels: 3, background: 'black' } })
        .composite(layers)
        .png()
        .toBuffer();

      // Composite introduces an opaque alpha channel. Remove it after the
      // composite has rendered so the bounded RGB fallback really fits.
      return sharp(composed, { limitInputPixels: 640 * 1928 })
        .removeAlpha()
        .png()
        .toBuffer();
    };
    let data = await compose(640);

    // Dense portrait frames can exceed the byte cap when stacked. Keep all
    // observations at a smaller resolution rather than silently losing rows.
    if (data.length > 2 * 1024 * 1024) data = await compose(480);
    signal.throwIfAborted();
    if (data.length > 2 * 1024 * 1024) throw new Error('画面拼图超过限制。');
    boards.push({
      seconds: rows[0].seconds,
      positions: rows.map(row => row.seconds),
      region: 'frame_grid',
      data,
      ...(rows[0].source ? { source: rows[0].source } : {})
    });
  }

  return boards;
};

export const videoDownloadUrl = (value: unknown): URL => {
  const url = new URL(typeof value === 'string' ? value : '');

  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'bilivideo.com' || url.hostname.endsWith('.bilivideo.com')))
    throw new Error('视频下载来源不受支持。');

  return url;
};
