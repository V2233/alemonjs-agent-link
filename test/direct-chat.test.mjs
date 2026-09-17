import test from 'node:test';
import assert from 'node:assert/strict';
import { directChat } from '../lib/dsh/direct-chat.js';
import { DSHSupervisor } from '../lib/dsh/supervisor.js';

const config = {
  runtimeMode: 'chat-only',
  provider: 'deepseek-official',
  model: 'test',
  defaultSystemPrompt: 'hello',
  inputBlockedKeywords: [],
  outputBlockedKeywords: ['secret'],
  maxRequestBytes: 4096
};
test('direct chat sends no tools, filters the full answer, rejects tool-only responses', async () => {
  const original = globalThis.fetch;
  let toolOnly = false;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.equal(options.redirect, 'error');
    return Response.json({ choices: [{ message: toolOnly ? { tool_calls: [{ name: 'bash' }] } : { content: 'a secret' } }] });
  };
  try {
    const events = [];
    await directChat(config, { apiKey: 'test' }, 'hi', new AbortController().signal, async e => events.push(e));
    assert.equal(events[0].content, '回复因内容安全策略未发送。');
    toolOnly = true;
    await assert.rejects(
      directChat(config, { apiKey: 'test' }, 'hi', new AbortController().signal, async () => {}),
      /文本回复/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('chat-only starts without Python and keeps a stable degraded status', async () => {
  const supervisor = new DSHSupervisor(config, { apiKey: 'test' }, 'test');
  await supervisor.start();
  assert.equal(supervisor.status().phase, 'degraded');
  await supervisor.start();
  assert.equal(supervisor.status().phase, 'degraded');
  supervisor.stop();
});
