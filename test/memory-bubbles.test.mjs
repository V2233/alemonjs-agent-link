import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from 'alemonjs/testing';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMemoryStore } from '../lib/memory/store.js';

const fixture = async (isPrivate, run) => {
  const root = await mkdtemp(join(tmpdir(), 'memory-bubbles-'));
  const settings = { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), maxMessageLength: 500 };
  const config = getDSHConfig(settings);
  const store = getMemoryStore(config);
  const app = createTestApp({ config: { 'alemonjs-agent-link': settings } });
  const scope = { platform: 'qq-bot', botId: 'bot', channelId: isPrivate ? 'private:["qq-bot","u"]' : 'g' };
  store.observe(scope);
  const seed = (seq, text, sources) => {
    const refs = sources ?? [{ seq, text, speaker: '甲', speakerId: 'u', timestamp: Date.now() }];
    store.applyExtraction(scope, store.state(scope), [{ action: 'add', text, kind: 'fact', sourceSeqs: refs.map(s => s.seq), evidence: refs[0].text, tags: [], importance: 0.5, confidence: 0.9 }], refs, seq, false);
  };
  const command = async (key, args = [], overrides = {}) => {
    const handler = (await import(`../lib/response/${key === '记忆' ? 'agent-memory' : 'memory-tools'}/res.js`)).default;
    const event = app.events[isPrivate ? 'privateMessage' : 'groupMessage']({}, { Platform: 'qq-bot', BotId: 'bot', UserId: 'u', ChannelId: isPrivate ? undefined : 'g', IsPrivate: isPrivate, IsMaster: true,
      MessageText: `/${key} ${args.join(' ')}`, __route: { key, text: key, rawArgs: args, params: {}, parsedArgs: [] } });
    Object.assign(event, { Platform: 'qq-bot', BotId: 'bot', UserId: 'u', ChannelId: isPrivate ? undefined : 'g', ...overrides });
    const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    return { result, text: JSON.stringify(result.messages), payload: JSON.stringify(result.actions.map(a => a.request.payload?.params)) };
  };
  try { await run({ store, scope, seed, command }); }
  finally { await app.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
};

for (const isPrivate of [false, true]) {
  test(`${isPrivate ? 'private' : 'group'} memory lists expose all records through pagination`, () => fixture(isPrivate, async ({ seed, command, store, scope }) => {
    for (let i = 1; i <= 13; i++) seed(i, `偏好条目${i}`);
    const key = isPrivate ? '记忆' : '群记忆';
    const ids = store.list(scope).map(n => n.id);
    const seen = new Set();
    for (let page = 1; page <= 3; page++) {
      const response = await command(key, [String(page)]);
      assert.match(response.text, new RegExp(`第 ${page}/3 页`));
      for (const id of ids) if (response.payload.includes(`/记忆来源 ${id}`)) seen.add(id);
      assert.doesNotMatch(response.payload, /BT.group/);
      if (page < 3) assert.ok(response.payload.includes(`/${key} ${page + 1}`));
    }
    assert.equal(seen.size, 13);
    assert.match((await command(key, ['999'])).text, /第 3\/3 页/);
    assert.match((await command(key, ['错误'])).text, /查看记忆/);
  }));
}

test('full source details have Chinese status and every source remains reachable without truncation', () => fixture(false, async ({ seed, command, store, scope }) => {
  const refs = Array.from({ length: 4 }, (_, i) => ({ seq: i + 1, speaker: '甲', speakerId: 'u', timestamp: Date.now(), text: `来源${i + 1} ` + '完整原文🐟'.repeat(160) + `终点${i + 1}` }));
  seed(4, '喜欢鱼', refs);
  const id = store.list(scope)[0].id;
  for (let page = 1; page <= 4; page++) {
    const response = await command('记忆来源', [id, String(page)]);
    assert.match(response.text, /当前使用/);
    assert.match(response.text, new RegExp(`终点${5 - page}`));
    assert.doesNotMatch(response.text, /\[active\]|undefined/);
    assert.ok(response.result.messages.length > 1);
    const formats = response.result.actions.map(a => a.request.payload?.params).filter(p => p?.format);
    for (const params of formats.slice(0, -1)) assert.doesNotMatch(JSON.stringify(params), /返回记忆|下一条来源/);
    if (page < 4) assert.ok(response.payload.includes(`/记忆来源 ${id} ${page + 1}`));
  }
  assert.match((await command('记忆来源', [id, '999'])).text, /聊天来源 4\/4/);
  assert.match((await command('记忆来源', [])).text, /返回列表/);
  const stranger = await command('记忆来源', [id], { ChannelId: 'other' });
  assert.match(stranger.text, /没有找到/);
  assert.doesNotMatch(stranger.text, /喜欢鱼/);
}));

test('outdated pages and details expose restore only to authorized group managers', () => fixture(false, async ({ seed, command, store, scope }) => {
  for (let i = 1; i <= 11; i++) seed(i, `旧偏好${i}`);
  const old = store.list(scope);
  for (const [i, entry] of old.entries()) {
    const seq = 100 + i;
    const text = `新偏好${i}`;
    store.applyExtraction(scope, store.state(scope), [{ action: 'replace', targetId: entry.id, text, kind: 'fact', sourceSeqs: [seq], evidence: text, tags: [], importance: 0.5, confidence: 0.9 }], [{ seq, text, speaker: '甲', speakerId: 'u', timestamp: Date.now() }], seq, false);
  }
  assert.equal(store.list(scope, { status: 'outdated' }).length, 11);
  const last = await command('过时记忆', ['3']);
  assert.match(last.text, /第 3\/3 页/);
  assert.match(last.payload, /恢复记忆/);
  const member = { IsMaster: false, IsAdmin: false, Role: 'member' };
  const deniedList = await command('过时记忆', ['1'], member);
  assert.doesNotMatch(deniedList.payload, /\/恢复记忆|\/忘记群记忆/);
  const deniedDetail = await command('记忆来源', [old[0].id], member);
  assert.match(deniedDetail.text, /已过时/);
  assert.doesNotMatch(deniedDetail.payload, /\/恢复记忆/);
  assert.match((await command('记忆来源', [old[0].id])).payload, /\/恢复记忆/);
}));
