export type CompletionMessage = {
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
};

// Parse incrementally, including frames split across UTF-8/network boundaries.
export const readCompletionStream = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onContent: (text: string) => Promise<void>
): Promise<CompletionMessage> => {
  if (!response.body) {
    throw new Error('模型响应为空。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    bytes = 0,
    finished = false;
  const message: CompletionMessage = { content: '' };
  const calls: NonNullable<CompletionMessage['tool_calls']> = [];
  const frame = async (data: string): Promise<void> => {
    if (!data || finished) {
      return;
    }
    if (data === '[DONE]') {
      finished = true;

      return;
    }
    const payload = JSON.parse(data);

    if (payload.error) {
      throw new Error('模型流返回错误。');
    }
    const choice = payload.choices?.[0];
    const delta = choice?.delta;

    if (!delta) {
      return;
    }
    if (typeof delta.content === 'string' && delta.content) {
      message.content += delta.content;
      await onContent(delta.content);
    }
    if (typeof delta.reasoning_content === 'string') {
      message.reasoning_content = (message.reasoning_content || '') + delta.reasoning_content;
    }
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index > 7) {
        throw new Error('工具流索引无效。');
      }
      const call = (calls[part.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });

      call.id += part.id || '';
      call.function.name += part.function?.name || '';
      call.function.arguments += part.function?.arguments || '';
    }
  };

  try {
    while (true) {
      if (finished) {
        break;
      }
      signal.throwIfAborted();
      const { value, done } = await reader.read();

      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error('模型响应超过大小限制。');
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;

      while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
        const raw = buffer.slice(0, boundary.index);

        buffer = buffer.slice(boundary.index + boundary[0].length);
        await frame(
          raw
            .split(/\r?\n/u)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n')
        );
      }
    }
    signal.throwIfAborted();
    if (!finished) {
      throw new Error('模型流未完整结束。');
    }
    if (calls.length) {
      message.tool_calls = calls;
    }

    return message;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};
