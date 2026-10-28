import { imageMime } from './download';

export type ImageInfo = { mime: string; width: number; height: number; animated: boolean };

const jpegSize = (data: Buffer): { width: number; height: number } | undefined => {
  let offset = 2;

  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1];

    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    // Entropy-coded scan data follows; dimensions were already available in the frame header.
    if (marker === 0xda) break;
    const length = data.readUInt16BE(offset + 2);

    if (length < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > data.length) break;

      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }

  return undefined;
};

const webpSize = (data: Buffer): { width: number; height: number; animated: boolean } | undefined => {
  if (data.length < 30) return undefined;
  const chunk = data.subarray(12, 16).toString('ascii');

  if (chunk === 'VP8X') {
    return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1, animated: Boolean(data[20] & 0x02) };
  }
  if (chunk === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);

    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
  }
  if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, animated: false };
  }

  return undefined;
};

/**
 * Read intrinsic dimensions without decoding pixels. Used to reject decompression bombs before
 * handing an untrusted image to the SVG rasterizer.
 */
export const imageInfo = (data: Buffer): ImageInfo | undefined => {
  const mime = imageMime(data);

  if (!mime) return undefined;

  if (mime === 'image/png') {
    if (data.length < 24 || data.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;

    return { mime, width: data.readUInt32BE(16), height: data.readUInt32BE(20), animated: false };
  }
  if (mime === 'image/jpeg') {
    const size = jpegSize(data);

    return size ? { mime, ...size, animated: false } : undefined;
  }
  if (mime === 'image/gif') {
    if (data.length < 10) return undefined;

    return {
      mime,
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
      animated: data.includes(Buffer.from('NETSCAPE2.0')) || data.includes(Buffer.from('ANIMEXTS1.0'))
    };
  }
  const size = webpSize(data);

  return size ? { mime, ...size } : undefined;
};
