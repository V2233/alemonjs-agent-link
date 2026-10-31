import test from 'node:test';
import assert from 'node:assert/strict';
import { containsPrivateOutput, privateSafeOutput, privateOutputEvents, PRIVATE_OUTPUT_BLOCKED } from '../lib/dsh/private-output.js';
import { executeTool } from '../lib/agent/modules.js';
import { directChat } from '../lib/dsh/direct-chat.js';
import { renderSpeech } from '../lib/media/speech.js';

test('private output rejects credential formats and configured secrets without exposing them', () => {
  const config = { media: { apiKey: 'fixture-secret-without-provider-prefix' } };
  for (const text of ['sk-fixtureabcdefghijk123456', 'Bearer abcdefghijklmnopq123', config.media.apiKey, Buffer.from(config.media.apiKey).toString('base64')]) {
    assert.equal(privateSafeOutput(text, config), PRIVATE_OUTPUT_BLOCKED);
  }
  assert.equal(containsPrivateOutput('请在后台配置 API Key，不要发到群里。', config), false);
});

test('split credentials never reach the send callback before final review', async () => {
  const delivered = [];
  const output = privateOutputEvents(async event => delivered.push(event), {}, 4096);
  await output({ type: 'content', content: 'sk-fixture' });
  await output({ type: 'content', content: 'abcdefghijk123456' });
  assert.deepEqual(delivered, []);
  await output({ type: 'done' });
  assert.deepEqual(delivered, [{ type: 'content', content: PRIVATE_OUTPUT_BLOCKED }, { type: 'done' }]);
});

test('errors discard pending output and oversized output fails without sending', async () => {
  const delivered = [];
  const output = privateOutputEvents(async event => delivered.push(event), {}, 30);
  await output({ type: 'content', content: 'partial' });
  await output({ type: 'error', message: 'sk-fixtureabcdefghijk123456' });
  assert.equal(delivered[0].message, PRIVATE_OUTPUT_BLOCKED);
  await assert.rejects(output({ type: 'content', content: 'x'.repeat(31) }), /安全检查/);
  assert.equal(delivered.length, 1);
});

test('tool credential arguments are rejected before effects and results before model delivery', async () => {
  let calls = 0;
  const tool = {
    name: 'fixture',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async () => { calls++; return { text: 'sk-fixtureabcdefghijk123456' }; }
  };
  const context = { signal: new AbortController().signal };
  await assert.rejects(executeTool(tool, { text: 'sk-fixtureabcdefghijk123456' }, context), /参数包含敏感/);
  assert.equal(calls, 0);
  await assert.rejects(executeTool(tool, { text: 'ordinary text' }, context), /结果包含敏感/);
  assert.equal(calls, 1);
});

test('credentials in chat input are blocked before any model network request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected request'); };
  try {
    await assert.rejects(directChat({ maxRequestBytes: 4096 }, { apiKey: 'fixture-model-key' }, 'sk-fixtureabcdefghijk123456', new AbortController().signal, async () => {}), /阻止提交给模型/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('credential text is rejected before speech synthesis', async () => {
  await assert.rejects(renderSpeech('sk-fixtureabcdefghijk123456', { ttsMaxChars: 100 }, new AbortController().signal, {}), /敏感信息/);
});
