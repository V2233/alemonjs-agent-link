import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { ResultCode } from 'alemonjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import capture from '../lib/response/history-capture/res.js';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { getChatArchive } from '../lib/history/store.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

test('real capture and chat handlers settle only confirmed sends and keep failed requests pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-ledger-framework-'));
  const config = {
    apiKey: 'test',
    model: 'test',
    runtimeMode: 'chat-only',
    stateBackend: 'local',
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    modules: {
      disabled: ['opinions'],
      settings: {
        memory: { automatic: false },
        mood: { modelJudge: false },
        expression: { automatic: false, socialPolish: false },
        proactive: { autoSubscribe: false }
      }
    }
  };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '这条接到了。' } }] });
  const scope = { platform: 'qq', botId: 'fish', channelId: 'private:["qq","human"]' };
  let archive;
  let runtimeConfig;
  let fail = false;
  app.actions.on('mention.get', () => [{ code: ResultCode.Ok, data: [] }]);
  app.actions.on('message.send', () => {
    if (fail) {
      fail = false;
      return [{ code: ResultCode.Fail }];
    }
    return [{ code: ResultCode.Ok, data: { id: 'receipt-' + Math.random() } }];
  });
  const event = id =>
    app.events.privateMessage(
      {},
      { Platform: 'qq', BotId: 'fish', UserId: 'human', UserKey: 'human', IsMaster: true, IsPrivate: true, MessageId: id, MessageText: '肥鱼，看这条消息' }
    );
  try {
    const first = event('one');
    const captured = await app.runHandler(
      async () => {
        runtimeConfig = getDSHConfig();
        archive = getChatArchive(runtimeConfig);
        await capture();
      },
      first,
      'alemonjs-agent-link'
    );
    assert.equal(captured.nextCalls.length, 1);
    assert.equal(archive.pendingReplies(scope)[0].state, 'pending');
    await app.runHandler(capture, event('two'), 'alemonjs-agent-link');
    const result = await app.runHandler(e => runDSHChat(e, e.MessageText), first, 'alemonjs-agent-link');
    assert.deepEqual(result.errors, []);
    assert.ok(result.messages.some(message => message.nodes.length > 0));
    assert.ok(
      result.actions.some(action => action.name === 'message.send' && action.results.some(receipt => receipt.code === ResultCode.Ok && receipt.data?.id))
    );
    assert.deepEqual(
      archive.pendingReplies(scope).map(row => row.messageId),
      ['two']
    );
    fail = true;
    const failed = await app.runHandler(e => runDSHChat(e, e.MessageText), event('two'), 'alemonjs-agent-link');
    assert.ok(failed.actions.some(action => action.name === 'message.send' && action.results.some(receipt => receipt.code === ResultCode.Fail)));
    assert.equal(archive.pendingReplies(scope).find(row => row.messageId === 'two')?.state, 'failed');
  } finally {
    if (runtimeConfig) await (await getModuleRuntime(runtimeConfig)).close();
    globalThis.fetch = oldFetch;
    await app.dispose();
    archive?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
