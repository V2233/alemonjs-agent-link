import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginTokenUsage, usageDay } from '../lib/billing/token-usage.js';
import handler from '../lib/response/agent-token-usage/res.js';

test('usage commands protect global totals and support all calendar periods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-command-'));
  const app = createTestApp({
    config: { 'alemonjs-agent-link': { dshHomeRoot: join(root, 'homes'), workspaceRoot: join(root, 'workspaces'), stateBackend: 'local' } }
  });
  const run = async (privateChat, master, args = []) => {
    const event = (privateChat ? app.events.privateMessage : app.events.groupMessage)(
      {},
      {
        Platform: 'qq-bot',
        UserId: 'u',
        ChannelId: privateChat ? undefined : 'g',
        IsMaster: master,
        IsAdmin: true,
        MessageText: `/用量 ${args.join(' ')}`,
        __route: { key: '用量', text: '用量', rawArgs: args, parsedArgs: [], params: {} }
      }
    );
    const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    assert.doesNotMatch(JSON.stringify(result.actions), /BT.group/);
    return JSON.stringify(result.messages);
  };
  try {
    beginTokenUsage(root, 'secret-key-id')({ prompt_tokens: 1234, completion_tokens: 56, prompt_cache_hit_tokens: 12 });
    beginTokenUsage(root, 'secret-key-id');
    for (const [priv, master] of [
      [false, true],
      [false, false],
      [true, false]
    ]) {
      const text = await run(priv, master);
      assert.match(text, /仅机器人主人私聊/);
      assert.doesNotMatch(text, /1234|secret-key-id/);
    }
    const day = usageDay();
    for (const args of [[], ['今日'], ['本月'], ['本年'], ['累计'], [day], [day.slice(0, 7)], [day.slice(0, 4)]]) {
      const text = await run(true, true, args);
      assert.match(text, /1234/);
      assert.match(text, /1290/);
      assert.match(text, /未知 1 次/);
      assert.doesNotMatch(text, /secret-key-id/);
    }
    const empty = await run(true, true, ['2000-01-01']);
    assert.match(empty, /暂无调用记录/);
    const help = await run(true, true, ['帮助']);
    assert.match(help, /怎样查看用量/);
    assert.match(help, /按天.*按月.*按年/);
    assert.doesNotMatch(help, /今日\|本月/);
    assert.match(await run(true, true, ['2026-02-30']), /查询失败/);
    assert.match(await run(true, true, ['今日', '群', 'other']), /YYYY/);
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
