import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from 'alemonjs/testing';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'policy-bubbles-'));
  const settings = { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), groupChat: { boundKeyElevation: false } };
  const config = resolveDSHConfig(settings);
  const app = createTestApp({ config: { 'alemonjs-agent-link': settings } });
  const command = async (module, key, args = [], { private: privateChat = false, master = true } = {}) => {
    const handler = (await import(`../lib/response/${module}/res.js`)).default;
    const event = app.events[privateChat ? 'privateMessage' : 'groupMessage']({}, {
      Platform: 'qq-bot', BotId: 'b', UserId: 'u', ChannelId: 'g', IsMaster: master,
      MessageText: `/${key} ${args.join(' ')}`, __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
    });
    Object.assign(event, { ChannelId: 'g', UserId: 'u', IsPrivate: privateChat, IsMaster: master });
    const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    const text = JSON.stringify(result.messages);
    const payload = JSON.stringify(result.actions.map(a => a.request.payload?.params));
    assert.doesNotMatch(payload, /BT.group/);
    return { text, payload };
  };
  try { await run(command, config); } finally { await app.dispose(); await rm(root, { recursive: true, force: true }); }
};

test('tool policy rejects malformed changes and terminal requests without changing stored permissions', () => fixture(async (command, config) => {
  const registry = new SessionRegistry(config);
  const before = await registry.policy('g');
  for (const args of [['网页', '开启', '多余'], ['状态', '多余'], ['网页'], ['文件', '也许'], ['终端', '开启']]) {
    const result = await command('agent-policy', '工具策略', args);
    assert.match(result.payload, /\/工具策略 状态/);
    assert.doesNotMatch(result.text, /已开始新话题/);
    assert.deepEqual(await registry.policy('g'), before);
  }
  const denied = await command('agent-policy', '工具策略', [], { master: false });
  assert.match(denied.text, /机器人主人管理/);
  assert.match(denied.payload, /\/我的权限/);
  assert.doesNotMatch(denied.payload, /\/工具策略 网页/);
  const wrongScope = await command('agent-policy', '工具策略', [], { private: true });
  assert.match(wrongScope.text, /目标群/);
  const status = await command('agent-policy', '工具策略');
  for (const [key, name] of [['chat', '聊天'], ['web', '网页'], ['files', '文件']]) {
    assert.ok(status.payload.includes(`/工具策略 ${name} ${before[key] ? '关闭' : '开启'}`));
    assert.ok(!status.payload.includes(`/工具策略 ${name} ${before[key] ? '开启' : '关闭'}`));
  }
}));

test('module status explains role and scope, rejects malformed pages and clamps oversized pages', () => fixture(async (command, config) => {
  for (const scope of [{ private: false }, { private: true, master: false }]) {
    const denied = await command('agent-modules', '模块状态', [], scope);
    assert.match(denied.text, /机器人主人私聊/);
    assert.match(denied.payload, /\/状态/);
  }
  for (const args of [['1.5'], ['-1'], ['1', '多余'], ['0']]) {
    const invalid = await command('agent-modules', '模块状态', args, { private: true });
    assert.match(invalid.text, /没有识别出页码/);
    assert.match(invalid.payload, /\/模块状态/);
  }
  try {
    const first = await command('agent-modules', '模块状态', [], { private: true });
    assert.match(first.text, /第 1\//);
    const last = await command('agent-modules', '模块状态', ['99999'], { private: true });
    assert.match(last.payload, /上一页/);
    assert.doesNotMatch(last.payload, /下一页|99999/);
  } finally { await (await getModuleRuntime(config)).close(); }
}));
