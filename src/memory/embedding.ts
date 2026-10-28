import type { DSHBridgeConfig } from '../dsh/client';
import { readBounded } from '../media/providers';

export type EmbeddingSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  weight: number;
  maxItems: number;
  timeoutMs: number;
};
const MAX_DIMENSIONS = 4096;
const BATCH = 32;

/**
 * 可选的语义召回端点。配置缺失时保持原有 BM25 行为；配置错误或服务失败时
 * 调用方回退 BM25，不阻塞聊天。不把主模型 Key 自动发给另一个域名。
 */
export const embeddingSettings = (config: DSHBridgeConfig): EmbeddingSettings | undefined => {
  const raw = config.modules?.settings?.memory?.embedding;

  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('memory.embedding 配置无效。');
  }
  const value = raw as Record<string, unknown>;
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const weight = value.weight ?? 0.55;
  const maxItems = value.maxItems ?? 200;
  const timeoutMs = value.timeoutMs ?? 8000;
  let url: URL;

  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('memory.embedding.baseUrl 无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !apiKey ||
    !model ||
    typeof weight !== 'number' ||
    !Number.isFinite(weight) ||
    weight < 0 ||
    weight > 1 ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 100 ||
    maxItems > 2000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 30000
  ) {
    throw new Error('memory.embedding 需要 HTTPS baseUrl、独立 apiKey、model，且 weight 0–1。');
  }

  return { baseUrl: baseUrl.replace(/\/+$/u, ''), apiKey, model, weight: Number(weight), maxItems: Number(maxItems), timeoutMs: Number(timeoutMs) };
};

export class EmbeddingClient {
  constructor(private readonly settings: EmbeddingSettings) {}

  get model(): string {
    return this.settings.model;
  }

  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const values = texts.map(text => String(text).slice(0, 2000));
    const output: Float32Array[] = [];

    for (let offset = 0; offset < values.length; offset += BATCH) {
      signal.throwIfAborted();
      const batch = values.slice(offset, offset + BATCH);
      const response = await fetch(`${this.settings.baseUrl}/embeddings`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)]),
        headers: { Authorization: `Bearer ${this.settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.settings.model, input: batch })
      });
      const payload = JSON.parse((await readBounded(response, 4 * 1024 * 1024)).toString('utf8'));
      const rows = Array.isArray(payload?.data) ? payload.data : [];

      if (rows.length !== batch.length) {
        throw new Error('embedding 返回数量不一致。');
      }
      const sorted = [...rows].sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));

      for (const row of sorted) {
        const vector = Array.isArray(row?.embedding) ? row.embedding : [];

        if (!vector.length || vector.length > MAX_DIMENSIONS || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new Error('embedding 返回了无效向量。');
        }
        output.push(Float32Array.from(vector));
      }
    }
    if (!output.length || output.some(vector => vector.length !== output[0].length)) {
      throw new Error('embedding 维度不一致。');
    }

    return output;
  }
}

export const cosineSimilarity = (left: Float32Array, right: Float32Array): number => {
  if (!left.length || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
};
