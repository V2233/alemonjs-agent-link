import { ffmpegAvailable, createFfmpegAvailability } from '../bili/ffmpeg';
import type { MessageMediaItem } from 'alemonjs';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractVideoFrames, videoSampleTimes } from '../bili/visual';
import { MediaError } from './config';

const run = promisify(execFile);

export const videoDecoderAvailable = createFfmpegAvailability(async () => {
  if (!(await ffmpegAvailable())) return false;
  try {
    const result = await run('ffprobe', ['-version'], { timeout: 3000, maxBuffer: 16 * 1024, killSignal: 'SIGKILL' });

    return /^ffprobe version\s/imu.test(String(result.stdout));
  } catch {
    return false;
  }
});

export const isVideoAttachment = (item: MessageMediaItem): boolean =>
  item.Type === 'video' || (item.Type === 'file' && (item.MimeType === 'video/mp4' || /\.mp4$/iu.test(item.FileName || '')));

/** Decode bounded MP4 attachments locally; never hand remote URLs to FFmpeg. */
export const sampleVideoAttachment = async (data: Buffer, signal: AbortSignal, execute = run, extract = extractVideoFrames) => {
  signal.throwIfAborted();
  if (data.length < 12 || data.length > 25 * 1024 * 1024 || data.subarray(4, 8).toString() !== 'ftyp')
    throw new MediaError('视频附件目前仅支持不超过 25 MiB 的 MP4。');
  const root = await mkdtemp(join(tmpdir(), 'agent-link-video-input-'));

  try {
    const input = join(root, 'input.mp4');

    await writeFile(input, data, { mode: 0o600 });
    const result = await execute(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'mov',
        '-enable_drefs',
        '0',
        '-use_absolute_path',
        '0',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        input
      ],
      {
        signal,
        timeout: 5000,
        maxBuffer: 32 * 1024,
        killSignal: 'SIGKILL'
      }
    );
    const metadata = JSON.parse(String(result.stdout));
    const duration = Number(metadata.format?.duration);

    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 600 ||
      !metadata.streams?.some((stream: { codec_type?: string }) => stream.codec_type === 'video')
    )
      throw new MediaError('视频需要包含有效画面，且时长不超过 10 分钟。');
    const frames = await extract(data, duration, signal, undefined, videoSampleTimes(duration));

    if (!frames.length) throw new MediaError('未能从视频解码出画面，请发送 MP4 或截图。');

    return { duration, frames };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof MediaError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaError('视频解码组件未安装，请安装 FFmpeg（含 ffprobe）。');
    throw new MediaError('视频解码失败，请发送完整的 MP4 或截图。');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
