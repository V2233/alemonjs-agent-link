import sharp from 'sharp';
import { attachmentUrl, downloadAttachment } from '../media/download';
import type { MediaConfig } from '../media/config';
import { videoSampleTimes, type VideoFrame } from './visual';

const maxPixels = 32 * 1024 * 1024;

export const storyboardUrl = (source: unknown): URL => {
  if (typeof source !== 'string' || source.length > 4096) throw new Error('预览图地址无效。');
  const url = attachmentUrl(source.startsWith('//') ? `https:${source}` : source, []);

  if (url.hostname !== 'hdslb.com' && !url.hostname.endsWith('.hdslb.com')) throw new Error('预览图来源不受支持。');

  return url;
};

/** Read only indexed preview tiles. Never invent timestamps or use the whole sheet as one frame. */
export const extractStoryboardFrames = async (
  data: unknown,
  duration: number,
  media: MediaConfig,
  signal: AbortSignal,
  download = downloadAttachment,
  requestedTimes?: readonly number[]
): Promise<VideoFrame[]> => {
  signal.throwIfAborted();
  videoSampleTimes(duration);
  const requested = requestedTimes === undefined ? undefined : videoSampleTimes(duration, requestedTimes);

  if (!data || typeof data !== 'object') throw new Error('预览图索引无效。');
  const snapshot = data as Record<string, unknown>;
  const dimension = (value: unknown, max: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('预览图尺寸无效。');

    return value;
  };
  const columns = dimension(snapshot.img_x_len, 20),
    rows = dimension(snapshot.img_y_len, 20);
  const width = dimension(snapshot.img_x_size, 1920),
    height = dimension(snapshot.img_y_size, 1080);

  if (columns * width * rows * height > maxPixels) throw new Error('预览拼图像素超限。');
  if (!Array.isArray(snapshot.image) || !snapshot.image.length || snapshot.image.length > 200) throw new Error('预览图列表无效。');
  const images = snapshot.image.map(storyboardUrl);
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
  const fetchBytes = async (url: URL, maxBytes: number): Promise<Buffer> => {
    signal.throwIfAborted();
    const bytes = await download(url.toString(), { ...media, allowedHosts: [url.hostname], maxBytes: Math.min(media.maxBytes, maxBytes) }, signal, headers);

    signal.throwIfAborted();
    if (bytes.length > Math.min(media.maxBytes, maxBytes)) throw new Error('预览图下载超限。');

    return bytes;
  };
  let indices: unknown[] = [];

  if (snapshot.index !== undefined && !Array.isArray(snapshot.index)) throw new Error('预览时间索引无效。');
  if (Array.isArray(snapshot.index)) indices = snapshot.index;
  if (!indices.length) {
    const bytes = await fetchBytes(storyboardUrl(snapshot.pvdata), 40000);

    if (!bytes.length || bytes.length % 2) throw new Error('预览时间索引无效。');
    indices = Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readUInt16BE(index * 2));
  }
  if (!indices.length || indices.length > 20000 || indices.length > images.length * columns * rows) throw new Error('预览时间索引超限。');
  const raw = indices.map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>).timestamp : item));

  if (raw.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0)) throw new Error('预览时间索引无效。');
  const values = raw as number[];
  const scale = Math.max(...values) > duration * 1.5 ? 1000 : 1;
  const entries = values.map((time, index) => ({ seconds: time / scale, index }));

  if (entries.some((entry, index) => entry.seconds > duration || (index > 0 && entry.seconds < entries[index - 1].seconds)))
    throw new Error('预览时间范围无效。');
  const end = entries.at(-1).seconds;
  const selected = new Map<number, (typeof entries)[number]>();

  for (const target of requested || (end > 0 ? videoSampleTimes(end) : [0])) {
    const closest = entries.reduce((best, entry) => (Math.abs(entry.seconds - target) < Math.abs(best.seconds - target) ? entry : best));

    selected.set(closest.seconds, closest);
  }
  const sheets = new Map<number, Buffer>();
  const frames: VideoFrame[] = [];

  for (const entry of [...selected.values()].sort((a, b) => a.seconds - b.seconds)) {
    signal.throwIfAborted();
    const capacity = columns * rows;
    const sheetIndex = Math.floor(entry.index / capacity);
    let sheet = sheets.get(sheetIndex);

    if (!sheet) {
      sheet = await fetchBytes(images[sheetIndex], 4 * 1024 * 1024);
      // Raster formats only: no SVG rendering or animated input.
      const jpeg = sheet[0] === 0xff && sheet[1] === 0xd8;
      const png = sheet.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const webp = sheet.subarray(0, 4).toString() === 'RIFF' && sheet.subarray(8, 12).toString() === 'WEBP';

      if (!jpeg && !png && !webp) throw new Error('预览图格式不受支持。');
      const info = await sharp(sheet, { limitInputPixels: maxPixels }).metadata();

      signal.throwIfAborted();
      if (info.width !== columns * width || info.height !== rows * height || (info.pages || 1) !== 1) throw new Error('预览拼图与索引尺寸不符。');
      sheets.set(sheetIndex, sheet);
    }
    const tile = entry.index % capacity;
    const bytes = await sharp(sheet, { limitInputPixels: maxPixels })
      .extract({ left: (tile % columns) * width, top: Math.floor(tile / columns) * height, width, height })
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    signal.throwIfAborted();
    if (bytes.length > 2 * 1024 * 1024) throw new Error('预览帧超限。');
    frames.push({ seconds: entry.seconds, data: bytes, source: 'storyboard' });
  }

  return frames;
};
