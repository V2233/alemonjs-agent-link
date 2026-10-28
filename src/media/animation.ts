import sharp from 'sharp';
import { imageInfo } from './image-info';

export type AnimationFrame = { mimeType: 'image/jpeg'; data: string; index: number; totalPages: number };
const MAX_FRAMES = 3;
const MAX_SIDE = 768;
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * QQ 的 animation 段经常只被模型当成第一帧。这里把 GIF 中间隔取 1–3 帧压成 JPEG，
 * 交给现有原生图片输入，让模型至少能看到“动过”的几个关键画面。
 * 解码失败、超大或非 GIF 动图返回空数组，由调用方回退为原始图片。
 */
export const animationFrames = async (data: Buffer, maxFrames = MAX_FRAMES): Promise<AnimationFrame[]> => {
  const info = imageInfo(data);

  if (info?.mime !== 'image/gif') {
    return [];
  }
  const metadata = await sharp(data, { animated: true, limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const totalPages = Math.max(1, Math.min(Number(metadata.pages) || 1, 1000));

  if (totalPages < 2) {
    return [];
  }
  const count = Math.max(1, Math.min(Math.trunc(maxFrames) || 1, MAX_FRAMES, totalPages));
  const indices =
    count === 1
      ? [0]
      : Array.from({ length: count }, (_, index) => Math.round((index * (totalPages - 1)) / (count - 1))).filter(
          (index, position, all) => all.indexOf(index) === position
        );
  const frames: AnimationFrame[] = [];

  for (const index of indices) {
    const output = await sharp(data, { animated: true, page: index, limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    if (!output.length || output.length > MAX_FRAME_BYTES) {
      continue;
    }
    frames.push({ mimeType: 'image/jpeg', data: output.toString('base64'), index, totalPages });
  }

  return frames;
};
