import { budgetedFetch } from '../billing/budget';
import { readCompletionStream } from './completion-stream';
import { type ChatInput, inputText, modelContent, MAX_IMAGE_REQUEST_BYTES } from './input';
import { SessionRegistry, type PrivateHistoryContext } from '@src/state/registry';
import type { DSHBridgeConfig, DSHStreamEvent } from './client';
import type { DSHCredentials } from './credentials';

// Deliberately no SDK, tool dispatch, or local process execution in this path.
export const directChat = async (
  config: DSHBridgeConfig,
  credentials: DSHCredentials | null,
  message: ChatInput,
  signal: AbortSignal,
  onEvent: (event: DSHStreamEvent) => Promise<void>,
  privateHistory?: PrivateHistoryContext,
  onCompleted?: (signal: AbortSignal) => Promise<void>
): Promise<void> => {
  if (!credentials) {
    throw new Error('纯聊天需要配置模型 API Key。');
  }
  const base = credentials.baseUrl || (config.provider === 'deepseek-official' ? 'https://api.deepseek.com' : '');
  const url = new URL(`${base.replace(/\/+$/, '')}/chat/completions`);

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('模型服务需要有效的 HTTPS 地址。');
  }
  if (config.inputBlockedKeywords.some(word => word && inputText(message).includes(word))) {
    throw new Error('请求被输入策略拒绝。');
  }
  const registry = privateHistory ? new SessionRegistry(config) : undefined;
  const history = privateHistory ? await registry.privateHistory(privateHistory) : [];
  const body = JSON.stringify({
    model: credentials.model || config.model,
    stream: !config.outputBlockedKeywords.length,
    messages: [
      { role: 'system', content: `${config.defaultSystemPrompt}\n当前为纯聊天降级模式，没有网页、文件或终端工具。不要声称已执行工具或读取本地文件。` },
      ...(privateHistory?.memoryContext ? [{ role: 'user', content: privateHistory.memoryContext }] : []),
      ...history,
      { role: 'user', content: modelContent(message) }
    ]
  });

  if (Buffer.byteLength(body) > (typeof message === 'string' ? config.maxRequestBytes : MAX_IMAGE_REQUEST_BYTES)) {
    throw new Error('请求超过大小限制。');
  }
  const response = await budgetedFetch(config, url, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
    body
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`模型服务返回 HTTP ${response.status}。`);
  }
  if (!response.body) {
    throw new Error('模型响应为空。');
  }
  let answer: string;
  const streamed = !config.outputBlockedKeywords.length && response.headers.get('content-type')?.includes('text/event-stream');

  if (streamed) {
    const result = await readCompletionStream(response, config.maxRequestBytes, signal, async content => {
      await onEvent({ type: 'content', content });
    });

    answer = result.content || '';
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > config.maxRequestBytes) {
          throw new Error('模型响应超过大小限制。');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let payload;

    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('模型响应不是有效 JSON。');
    }
    answer = payload?.choices?.[0]?.message?.content;
  }
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error('模型未返回文本回复。');
  }
  signal.throwIfAborted();
  const content = config.outputBlockedKeywords.some(word => word && answer.includes(word)) ? '回复因内容安全策略未发送。' : answer;

  if (!streamed) {
    await onEvent({ type: 'content', content });
  }
  await onEvent({ type: 'done' });
  signal.throwIfAborted();
  await onCompleted?.(signal);
  signal.throwIfAborted();
  if (privateHistory) {
    await registry.appendPrivateTurn(privateHistory, inputText(message) + (typeof message === 'string' ? '' : '\n[本轮包含图片]'), content);
  }
};
