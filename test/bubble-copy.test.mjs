import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultCode, withEventContext, getConfig } from 'alemonjs';
import { helpText } from '../lib/response/agent-help/res.js';
import { withToolUsePolicy } from '../lib/agent/tool-use-policy.js';
import { BudgetExceededError, withBudgetScope, replyGateExceededMessage } from '../lib/billing/budget.js';
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

const runCommand = async (module, { private: isPrivate = true, master = true, key = '帮助', args = [], formats = [] } = {}) => {
  const messages = [];
  const event = {
    name: isPrivate ? 'private.message.create' : 'message.create',
    IsPrivate: isPrivate,
    IsMaster: master,
    Platform: 'qq-bot',
    BotId: '900',
    UserId: '100',
    UserKey: 'user-100',
    ChannelId: isPrivate ? undefined : '200',
    MessageId: 'fixture',
    MessageText: `/${key} ${args.join(' ')}`,
    __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
  };
  await runtimeScope.run(
    {
      resources: new Map(),
      cleanups: new Set(),
      disposed: false,
      now: Date.now,
      action: async frame => {
        const format = frame.payload.params?.format || [];
        formats.push(format);
        messages.push(format.map(item => (typeof item.value === 'string' ? item.value : '')).join(''));
        return [{ code: ResultCode.Ok, data: { id: 'fixture', messageId: 'fixture' } }];
      }
    },
    () => {
      getConfig().saveValue(globalThis.__config?.value || {});
      return withEventContext(event, () => {}, module, { appName: 'alemonjs-agent-link' });
    }
  );
  return messages;
};

test('default help fits one bubble while detailed commands remain discoverable', async () => {
  for (const [isPrivate, owner] of [
    [false, false],
    [true, false],
    [true, true]
  ]) {
    assert.ok(Array.from(helpText(isPrivate, owner)).length <= 400);
  }
  const handler = (await import('../lib/response/agent-help/res.js')).default;
  const messages = await runCommand(handler);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /帮助 管理/);
  assert.match(helpText(true, true, '管理'), /关闭 原因/);
  assert.match(helpText(true, true, '全部'), /主动搭话/);
  assert.doesNotMatch(helpText(false, false, '全部'), /服务端日志取验证码/);
});

test('help and public configuration guidance use plain Text messages with copyable steps', async () => {
  const handler = (await import('../lib/response/agent-help/res.js')).default;
  for (const isPrivate of [true, false]) {
    const formats = [];
    const messages = await runCommand(handler, { private: isPrivate, master: false, args: ['额度'], formats });
    assert.equal(messages.length, 1);
    assert.ok(formats.flat().every(item => item.type === 'Text'));
    assert.doesNotMatch(messages[0], /`|\*\*|\|/);
    assert.match(messages[0], isPrivate ? /\n\/个人密钥 绑定 sk-你的Key\n/ : /\n\/群密钥 绑定 临时码 sk-你的Key\n/);
    if (!isPrivate) assert.match(messages[0], /由申请人私聊/);
  }
  const formats = [];
  const messages = await runCommand((await import('../lib/response/agent-bind/res.js')).default, { master: false, formats });
  assert.ok(formats.flat().every(item => item.type === 'Text'));
  assert.match(messages[0], /个人密钥 绑定/);
});

test('budget errors explain the correct private or group binding workflow without leaking credentials', () => {
  for (const isPrivate of [true, false]) {
    const error = withBudgetScope({ platform: 'test', userId: 'u', channelId: isPrivate ? 'private:["test","u"]' : 'g' }, () => new BudgetExceededError());
    assert.match(error.message, /额度不足/);
    assert.match(error.message, isPrivate ? /个人密钥 绑定 sk-你的Key/ : /群密钥 绑定 临时码 sk-你的Key/);
    assert.doesNotMatch(error.message, /`|\*\*|\|/);
    if (!isPrivate) assert.doesNotMatch(error.message, /个人密钥 绑定/);
  }
  assert.match(replyGateExceededMessage, /今天只提醒这一次/);
  assert.match(replyGateExceededMessage, /群密钥 绑定 临时码 sk-你的Key/);
});

test('persona list has one response; explicit help retains management actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bubble-copy-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  try {
    const handler = (await import('../lib/response/agent-persona/res.js')).default;
    const messages = await runCommand(handler, { key: '人格' });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /人格 帮助/);
    const detail = await runCommand(handler, { key: '人格', args: ['帮助'] });
    assert.equal(detail.length, 1);
    assert.match(detail[0], /追加/);
    assert.match(detail[0], /删除/);
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('short privacy and purge bubbles preserve scope, permanence and confirmation', async () => {
  const privacy = await runCommand((await import('../lib/response/agent-privacy/res.js')).default);
  assert.equal(privacy.length, 1);
  for (const fact of ['模型服务', '隔离', '分别删除', '30天']) assert.ok(privacy[0].includes(fact));
  const purge = await runCommand((await import('../lib/response/agent-purge/res.js')).default, { private: false, key: '清除群数据' });
  assert.equal(purge.length, 1);
  for (const fact of ['永久', '无法恢复', '记忆', '60秒', '/清除群数据 确认']) assert.ok(purge[0].includes(fact));
});

test('reply style is added once and preserves explicit requests for detail and uncertain outcomes', () => {
  const prompt = withToolUsePolicy('custom persona');
  assert.equal(withToolUsePolicy(prompt), prompt);
  assert.match(prompt, /先回答本次问题/);
  assert.match(prompt, /复杂任务结果时，按需展开/);
  assert.match(prompt, /结果不明/);
  assert.match(prompt, /不在新问题后反复附带之前失败的查询/);
});

test('owner status is one short bubble and platform diagnostics are opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bubble-status-'));
  const previous = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'fixture',
        model: 'fixture-model',
        aiEnabled: false,
        aiDisabledReason: 'maintenance',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home')
      }
    }
  };
  try {
    const handler = (await import('../lib/response/agent-status/res.js')).default;
    const messages = await runCommand(handler, { key: '状态' });
    assert.equal(messages.length, 1);
    assert.ok(messages[0].length <= 500);
    assert.match(messages[0], /maintenance/);
    assert.doesNotMatch(messages[0], /Node|Redis|DSH|API Key/);
    assert.doesNotMatch(messages[0], /平台：/);
    const details = await runCommand(handler, { key: '状态', args: ['详情'] });
    assert.equal(details.length, 1);
    assert.match(details[0], /平台：/);
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});
