import type { DSHStreamEvent } from './client';

export const PRIVATE_OUTPUT_BLOCKED = '回复包含敏感信息，已阻止发送。';
const credential =
  /\bsk-[A-Za-z0-9_-]{12,}|\b(?:ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{16,}|\b[a-f0-9]{32}\.[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|secret|password|密码|密钥)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_./+~-]{12,}/iu;

/** Inspect supplied host configuration only; never open files or expose matches. */
export const containsPrivateOutput = (text: string, config?: unknown): boolean => {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '');

  if (credential.test(normalized)) return true;
  const seen = new Set<object>();
  const inspect = (value: unknown, sensitive = false): boolean => {
    if (typeof value === 'string') {
      return (
        sensitive &&
        value.length >= 8 &&
        (normalized.includes(value) || normalized.includes(encodeURIComponent(value)) || normalized.includes(Buffer.from(value).toString('base64')))
      );
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);

    return Object.entries(value).some(([key, child]) =>
      inspect(child, sensitive || /^(?:api[_-]?key|key|.*(?:secret|token|password|cookie|authorization)|private[_-]?key|encryption[_-]?key)$/i.test(key))
    );
  };

  return inspect(config);
};

export const privateSafeOutput = (text: string, config?: unknown): string => (containsPrivateOutput(text, config) ? PRIVATE_OUTPUT_BLOCKED : text);

/** Buffer before delivery: credentials can span arbitrary stream chunks. */
export const privateOutputEvents = (
  send: (event: DSHStreamEvent) => Promise<void>,
  config: unknown,
  limit: number
): ((event: DSHStreamEvent) => Promise<void>) => {
  let pending = '';

  return async event => {
    if (event.type === 'content') {
      pending += event.content;
      if (Buffer.byteLength(pending) > limit) {
        pending = '';
        throw new Error('回复超过安全检查长度限制。');
      }

      return;
    }
    if (event.type === 'done') {
      const content = privateSafeOutput(pending, config);

      pending = '';
      if (content) await send({ type: 'content', content });
    } else if (event.type === 'error') {
      pending = '';
      await send({ ...event, message: privateSafeOutput(event.message, config) });

      return;
    }
    await send(event);
  };
};
