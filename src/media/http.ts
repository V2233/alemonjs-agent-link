import { MediaError, type MediaProvider } from './config';

export type VisionTransport = (provider: MediaProvider, path: string, body: FormData | string, signal: AbortSignal, maxBytes: number) => Promise<Buffer>;

export class MediaHttpError extends MediaError {
  constructor(readonly status: number) {
    super(`媒体服务返回 HTTP ${status}。`);
  }
}

export const readBounded = async (response: Response, maxBytes: number): Promise<Buffer> => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new MediaHttpError(response.status);
  }
  if (!response.body) {
    throw new MediaError('媒体服务返回空内容。');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const part = await reader.read();

      if (part.done) {
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        throw new MediaError('媒体服务响应超过限制。');
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }

  return Buffer.concat(chunks);
};
