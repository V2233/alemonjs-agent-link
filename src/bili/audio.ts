import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type VideoAudioTranscript = {
  status: 'disabled' | 'unconfigured' | 'unavailable' | 'not_needed' | 'available';
  text: string;
  startSeconds?: number;
  endSeconds?: number;
  truncated?: boolean;
  failedAt?: 'configuration' | 'selection' | 'decode' | 'download' | 'transcription';
};
const run = promisify(execFile);

export const pcmAudioSeconds = (bytes: Buffer): number => {
  if (bytes.length < 44 || bytes.length > 2000000 || bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WAVE')
    throw new Error('音频片段格式无效。');
  let format = false;

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.subarray(offset, offset + 4).toString();
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (body + size > bytes.length) throw new Error('音频片段不完整。');
    if (kind === 'fmt ' && size >= 16)
      format =
        bytes.readUInt16LE(body) === 1 &&
        bytes.readUInt16LE(body + 2) === 1 &&
        bytes.readUInt32LE(body + 4) === 16000 &&
        bytes.readUInt32LE(body + 8) === 32000 &&
        bytes.readUInt16LE(body + 14) === 16;
    if (kind === 'data') {
      if (!format || size < 2 || size % 2 || size > 1920000) throw new Error('音频片段没有有效的有界PCM数据。');

      return size / 32000;
    }
    offset = body + size + (size % 2);
  }
  throw new Error('音频片段没有PCM数据。');
};
export const extractAudioExcerpt = async (
  data: Buffer,
  start: number,
  seconds: number,
  signal: AbortSignal,
  execute = run
): Promise<{ data: Buffer; seconds: number }> => {
  signal.throwIfAborted();
  if (
    data.length < 12 ||
    data.length > 32 * 1024 * 1024 ||
    data.subarray(4, 8).toString() !== 'ftyp' ||
    !Number.isFinite(start) ||
    start < 0 ||
    start > 86400 ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 60
  )
    throw new Error('视频音频片段无效。');
  const root = await mkdtemp(join(tmpdir(), 'agent-link-video-audio-'));

  try {
    const input = join(root, 'input.mp4');
    const output = join(root, 'audio.wav');

    await writeFile(input, data, { mode: 0o600 });
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
        String(start),
        '-f',
        'mov',
        '-i',
        input,
        '-t',
        String(seconds),
        '-vn',
        '-sn',
        '-dn',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-fs',
        '2000000',
        '-f',
        'wav',
        output
      ],
      { signal, timeout: 10000, maxBuffer: 16384, killSignal: 'SIGKILL' }
    );
    const bytes = await readFile(output);

    const actualSeconds = pcmAudioSeconds(bytes);

    if (actualSeconds > seconds + 0.001) throw new Error('音频片段超出请求范围。');

    return { data: bytes, seconds: Math.min(actualSeconds, seconds) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
