import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { ResultCode } from 'alemonjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../lib/response/private-chat/res.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

test('real private chat handler sends a safe replacement instead of a model credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-output-framework-'));
  const config = {
    apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local',
    workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), budget: { enabled: false },
    modules: { disabled: ['opinions'], settings: { memory: { automatic: false }, mood: { modelJudge: false }, expression: { automatic: false, socialPolish: false }, proactive: { autoSubscribe: false } } }
  };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const original = globalThis.fetch;
  const secret = 'sk-fixtureabcdefghijk123456';
  let runtimeConfig;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: `这是凭证：${secret}` } }] });
  app.actions.on('mention.get', () => [{ code: ResultCode.Ok, data: [] }]);
  app.actions.on('message.send', () => [{ code: ResultCode.Ok, data: { id: 'safe-receipt' } }]);
  try {
    const event = app.events.privateMessage({}, { Platform: 'qq', BotId: 'fish', UserId: 'human', UserKey: 'human', IsMaster: true, IsPrivate: true, MessageId: 'secret-output', MessageText: '你好' });
    const result = await app.runHandler(async () => { runtimeConfig = getDSHConfig(); await handler(); }, event, 'alemonjs-agent-link');
    assert.deepEqual(result.errors, []);
    const delivered = JSON.stringify(result.messages.map(message => message.nodes));
    assert.ok(!delivered.includes(secret));
    assert.match(delivered, /敏感信息/);
    assert.ok(result.actions.some(action => action.name === 'message.send' && action.results.some(receipt => receipt.code === ResultCode.Ok && receipt.data?.id === 'safe-receipt')));
  } finally {
    if (runtimeConfig) await (await getModuleRuntime(runtimeConfig)).close();
    await app.dispose();
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});
