import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultCode } from 'alemonjs';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { SessionRegistry } from '../lib/state/registry.js';

test('context failure describes the known stage and stays silent for unsolicited group replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-failure-bubbles-'));
  const previous = { config: globalThis.__config, fetch: globalThis.fetch, ready: SessionRegistry.prototype.ready };
  globalThis.__config = { value: { 'alemonjs-agent-link': { apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  globalThis.fetch = async () => assert.fail('context failure must not start model work');
  SessionRegistry.prototype.ready = async () => { throw new Error('fixture storage unavailable'); };
  const messages = [];
  const transport = { message: { send: async params => { messages.push(params.format.value); return [{ code: ResultCode.Ok, data: { id: 'fixture' } }]; } }, media: { send: async () => assert.fail('no media') } };
  const event = { Platform: 'qq-bot', BotId: 'bot', ChannelId: 'g', UserId: 'u', UserKey: 'u', MessageText: '你好', MessageId: 'fixture' };
  try {
    await runDSHChat(event, '你好', { transport, referencesPrepared: true });
    assert.equal(messages.length, 1);
    const text = JSON.stringify(messages);
    assert.match(text, /无法读取会话信息/);
    assert.match(text, /回答未开始/);
    assert.match(text, /\/提问|\/状态/);
    assert.doesNotMatch(text, /网线断了|fixture storage|BT.group/);
    messages.length = 0;
    await runDSHChat({ ...event, ChannelId: 'silent' }, '你好', { transport, referencesPrepared: true, allowSilence: true });
    assert.equal(messages.length, 0);
  } finally {
    SessionRegistry.prototype.ready = previous.ready;
    globalThis.fetch = previous.fetch;
    globalThis.__config = previous.config;
    await rm(root, { recursive: true, force: true });
  }
});
