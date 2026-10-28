import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioFormat, imageMime } from '../media/download';

// Only the administrator's configured shared cache may be read, not arbitrary gateway paths.
const readMediaFile = async (root: string | undefined, location: string, limit: number, valid: (data: Buffer) => boolean): Promise<Buffer> => {
  if (!root || !isAbsolute(root) || typeof location !== 'string' || location.length > 4096 || /[\0\r\n]/u.test(location))
    throw new Error('语音缓存目录未配置。');
  const candidate = location.startsWith('file:') ? fileURLToPath(location) : location;

  if (!isAbsolute(candidate)) throw new Error('语音缓存路径无效。');
  const [base, path] = await Promise.all([realpath(root), realpath(candidate)]);
  const rel = relative(base, path);

  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('语音不在配置的缓存目录内。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('语音文件无效或过大。');
    const chunks: Buffer[] = [];
    let size = 0;

    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);

      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error('语音文件过大。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const data = Buffer.concat(chunks);

    if (!valid(data)) throw new Error('媒体文件格式无效。');

    return data;
  } finally {
    await handle.close();
  }
};

export const readRecordFile = (root: string | undefined, location: string, limit = 10 * 1024 * 1024): Promise<Buffer> =>
  readMediaFile(root, location, limit, data => audioFormat(data)?.extension === 'wav');

export const readImageFile = (root: string | undefined, location: string, limit = 10 * 1024 * 1024): Promise<Buffer> =>
  readMediaFile(root, location, limit, data => Boolean(imageMime(data)));
