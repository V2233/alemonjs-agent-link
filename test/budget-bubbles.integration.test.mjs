import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import YAML from 'yaml';
import { createTestApp } from 'alemonjs/testing';
import handler from '../lib/response/agent-budget/res.js';

test('actual budget bubbles preserve scope across query, adjustment, history and daily mute', { skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'budget-bubbles-'));
  const connection = YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG, 'utf8')).db.redis;
  const redis = new Redis({ ...connection, keyPrefix: `budget-bubbles:${randomUUID()}:`, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  await redis.ping();
  const previousRedis = globalThis.ioRedis;
  const previousKeyFile = process.env.AGENT_LINK_PERSONAL_KEY_FILE;
  globalThis.ioRedis = redis;
  process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(root, 'master.key');
  const app = createTestApp({ config: { 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), budget: { enabled: true } } } });
  let index = 0;
  const run = async (privateChat, master, args = []) => {
    const event = app.events[privateChat ? 'privateMessage' : 'groupMessage']({}, {
      Platform: 'qq-bot', UserId: 'u', UserKey: 'u', ChannelId: 'g', BotId: 'b', IsMaster: master,
      MessageText: `/额度 ${args.join(' ')}`, MessageId: `budget-bubble-${++index}`,
      __route: { key: '额度', text: '额度', rawArgs: args, parsedArgs: [], params: {} }
    });
    Object.assign(event, { Platform: 'qq-bot', UserId: 'u', ChannelId: 'g', IsPrivate: privateChat, IsMaster: master });
    const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    const text = JSON.stringify(result.messages);
    const wire = JSON.stringify(result.actions.map(a => a.request.payload?.params));
    assert.doesNotMatch(wire, /BT.group|\| ---/);
    return { text, wire };
  };
  try {
    const privateQuery = await run(true, true);
    assert.match(privateQuery.text, /本人私聊/);
    assert.match(privateQuery.text, /私聊充值/);
    assert.match(privateQuery.text, /个人免费/);
    const groupQuery = await run(false, true);
    assert.match(groupQuery.text, /本群/);
    assert.match(groupQuery.text, /群感知/);
    assert.match(groupQuery.text, /群充值/);
    const added = await run(true, true, ['增加', '2']);
    assert.match(added.text, /调整结果/);
    assert.match(added.text, /0.00.*2.00/);
    const history = await run(true, true, ['记录']);
    assert.match(history.text, /增加 2.00 元/);
    const denied = await run(true, false, ['增加', '9']);
    assert.doesNotMatch(denied.text, /调整结果/);
    assert.match(denied.text, /机器人主人/);
    const invalid = await run(true, true, ['设置', 'bad']);
    assert.doesNotMatch(invalid.text, /调整结果/);
    assert.match(invalid.wire, /\/额度 帮助/);
    const muted = await run(false, true, ['今日不再提醒']);
    assert.match(muted.text, /本群今日不再自动提醒/);
    assert.match(muted.text, /北京时间零点恢复/);
    assert.match(muted.wire, /\/额度/);
    const remote = await run(true, true, ['增加', '群', 'remote-group', '3']);
    assert.match(remote.text, /群 remote-group/);
    assert.match(remote.wire, /\/额度 查询 群 remote-group/);
    assert.match(remote.wire, /\/额度 记录 群 remote-group/);
    const remoteHistory = await run(true, true, ['记录', '群', 'remote-group']);
    assert.match(remoteHistory.text, /群 remote-group/);
    assert.match(remoteHistory.wire, /\/额度 查询 群 remote-group/);
    const remotePrivate = await run(false, true, ['查询', '私聊', 'other-user']);
    assert.match(remotePrivate.text, /私聊 other-user/);
    assert.match(remotePrivate.wire, /\/额度 查询 私聊 other-user/);
    const original = redis.hgetall;
    redis.hgetall = async () => { throw new Error('fixture-secret-storage-diagnostic'); };
    try {
      const failed = await run(true, true);
      assert.doesNotMatch(failed.text, /调整结果|fixture-secret-storage-diagnostic/);
      assert.match(failed.wire, /\/额度 帮助/);
      const partiallyRead = await run(true, true, ['增加', '群', 'partial-group', '4']);
      assert.match(partiallyRead.text, /调整已保存/);
      assert.match(partiallyRead.text, /不要重复增加/);
      assert.match(partiallyRead.wire, /\/额度 查询 群 partial-group/);

    } finally { redis.hgetall = original; }
    const verified = await run(true, true, ['查询', '群', 'partial-group']);
    assert.match(verified.text, /群充值/);
    assert.match(verified.text, /4.00/);


  } finally {
    await app.dispose();
    globalThis.ioRedis = previousRedis;
    if (previousKeyFile === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
    else process.env.AGENT_LINK_PERSONAL_KEY_FILE = previousKeyFile;
    await redis.quit();
    await rm(root, { recursive: true, force: true });
  }
});
