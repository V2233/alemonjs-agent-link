import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const downloadRuntime = async (
  url: string,
  sha256: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  maxBytes = 64 * 1024 * 1024
): Promise<Buffer> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let retry = true;

    try {
      const response = await fetcher(url, { signal });

      if (!response.ok) {
        retry = response.status === 408 || response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`Managed Python bootstrap download failed (HTTP ${response.status})`);
      }
      if (!response.body) {
        throw new Error('Managed Python bootstrap download failed (empty response)');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;

      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();

          if (part.done) {
            break;
          }
          size += part.value.byteLength;
          if (size > maxBytes) {
            retry = false;
            throw new Error('Managed Python bootstrap download failed (size limit)');
          }
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const bytes = Buffer.concat(chunks);

      if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        retry = false;
        throw new Error('Managed Python bootstrap checksum mismatch');
      }

      return bytes;
    } catch (error) {
      signal.throwIfAborted();
      if (!retry || attempt === 2) {
        throw error;
      }
      await delay(250 * (attempt + 1), undefined, { signal });
    }
  }
  throw new Error('Managed Python bootstrap download failed');
};
