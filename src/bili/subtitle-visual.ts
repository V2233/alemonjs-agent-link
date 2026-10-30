import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { videoSampleTimes, type VideoFrame } from './visual';

const run = promisify(execFile);

/** Twelve bottom-band samples, grouped into at most three images, never a transcript. */
export const extractSubtitleStrips = async (
  data: Buffer,
  duration: number,
  signal: AbortSignal,
  execute = run,
  requestedTimes?: readonly number[]
): Promise<VideoFrame[]> => {
  signal.throwIfAborted();
  videoSampleTimes(duration);
  if (data.length > 32 * 1024 * 1024 || data.length < 12 || data.subarray(4, 8).toString() !== 'ftyp') throw new Error('视频不是受支持的有限大小 MP4。');
  const times =
    requestedTimes === undefined
      ? [...new Set(Array.from({ length: 12 }, (_, index) => Math.min(duration * 0.999999, Math.round((((index + 0.5) * duration) / 12) * 1000) / 1000)))]
      : videoSampleTimes(duration, requestedTimes);
  const root = await mkdtemp(join(tmpdir(), 'agent-link-subtitle-'));

  try {
    const input = join(root, 'input.mp4');

    await writeFile(input, data, { mode: 0o600 });
    const strips: { seconds: number; data: Buffer; width: number; height: number }[] = [];

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
          'crop=iw:ih*0.25:0:ih*0.75,scale=1280:256:force_original_aspect_ratio=decrease',
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
        // Low-frame-rate videos can end before the final seek target. A
        // successful decoder with no output contributes no observation.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (bytes.length > 2 * 1024 * 1024) throw new Error('字幕采样超过限制。');
      const { data: image, info } = await sharp(bytes, { limitInputPixels: 1280 * 256 })
        .png()
        .toBuffer({ resolveWithObject: true });

      if (info.width > 1280 || info.height > 256) throw new Error('字幕采样尺寸无效。');
      strips.push({ seconds, data: image, width: info.width, height: info.height });
    }
    const boards: VideoFrame[] = [];

    for (let index = 0; index < strips.length; index += 4) {
      signal.throwIfAborted();
      const rows = strips.slice(index, index + 4);
      let top = 0;
      const layers = rows.map(row => {
        const layer = { input: row.data, top, left: 0 };

        top += row.height + 2;

        return layer;
      });
      const image = await sharp({ create: { width: Math.max(...rows.map(row => row.width)), height: top - 2, channels: 3, background: 'black' } })
        .composite(layers)
        .png()
        .toBuffer();

      signal.throwIfAborted();
      if (image.length > 2 * 1024 * 1024) throw new Error('字幕拼图超过限制。');
      boards.push({ seconds: rows[0].seconds, positions: rows.map(row => row.seconds), region: 'bottom_band', data: image });
    }

    return boards;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
