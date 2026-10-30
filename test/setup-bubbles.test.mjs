import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from 'alemonjs/testing';
import { masterVerification } from '../lib/state/master-verification.js';

const fixture = async (run, extra = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'setup-bubbles-'));
  const settings = { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), ...extra };
  const app = createTestApp({ config: { 'alemonjs-agent-link': settings } });
  const command = async (module, key, args = [], overrides = {}) => {
    const handler = (await import(`../lib/response/${module}/res.js`)).default;
    const event = app.events[overrides.IsPrivate === false ? 'groupMessage' : 'privateMessage']({}, { Platform: 'qq-bot', BotId: 'bot', UserId: 'u', IsMaster: false,
      MessageText: `/${key} ${args.join(' ')}`, __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} } });
    Object.assign(event, { Platform: 'qq-bot', BotId: 'bot', UserId: 'u', ...overrides });
    const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    const text = JSON.stringify(result.messages);
    const payload = JSON.stringify(result.actions.map(a => a.request.payload?.params));
    assert.doesNotMatch(payload, /BT.group/);
    return { text, payload };
  };
  try { await run(command, settings); } finally { await app.dispose(); await rm(root, { recursive: true, force: true }); }
};

test('master verification presents the action for its current phase and rejects codes on the issue command', () => fixture(async command => {
  const owner = await command('master', '我是主人', [], { IsMaster: true });
  assert.match(owner.payload, /\/我的权限|\/帮助 管理/);
  assert.doesNotMatch(owner.payload, /获取验证码/);
  const invalid = await command('master', '我的主人', ['六位验证码']);
  assert.match(invalid.payload, /填写验证码/);
  assert.doesNotMatch(invalid.payload, /\/帮助 管理/);
  const identity = JSON.stringify(['qq-bot', 'u']);
  const code = masterVerification.issue(identity);
  const wrongCommand = await command('master', '我是主人', [code]);
  assert.doesNotMatch(wrongCommand.text, /验证通过/);
  assert.equal(masterVerification.verify(identity, code), true, 'malformed issue command must not consume the code');
  const nextCode = masterVerification.issue(identity);
  const success = await command('master', '我的主人', [nextCode]);
  assert.match(success.text, /验证通过/);
  assert.match(success.payload, /\/我的权限/);
  assert.doesNotMatch(success.payload, /获取验证码/);
}));

test('personal login invalid input and idle cancel do not claim authentication or removal', () => fixture(async command => {
  const invalid = await command('personal-login', '个人登录', ['验证码']);
  assert.match(invalid.text, /二维码/);
  assert.match(invalid.payload, /\/个人登录 状态/);
  assert.doesNotMatch(invalid.text, /已移除|已登录/);
  const idle = await command('personal-login', '个人登录', ['取消']);
  assert.match(idle.text, /没有正在进行的登录/);
  assert.match(idle.text, /不会退出/);
}));

test('speech status and invalid input work without a model or a queued task', () => fixture(async command => {
  const denied = await command('agent-speech', '语音引擎');
  assert.match(denied.text, /仅限主人/);
  assert.doesNotMatch(denied.payload, /\/语音引擎 安装/);
  const state = await command('agent-speech', '语音引擎', ['状态'], { IsMaster: true });
  assert.match(state.text, /自动选择/);
  assert.match(state.payload, /\/语音引擎 试听 你好/);
  assert.match(state.text, /实际可用性请试听确认/);
  assert.doesNotMatch(state.text, /模型未配置|请求排队/);
  const invalid = await command('agent-speech', '语音引擎', ['安装', '多余'], { IsMaster: true });
  assert.match(invalid.text, /没有识别/);
  assert.doesNotMatch(invalid.text, /正在安装/);
}));

test('disabled speech links to module status without offering installation', () => fixture(async command => {
  const state = await command('agent-speech', '语音引擎', ['状态'], { IsMaster: true });
  assert.match(state.text, /已停用/);
  assert.match(state.payload, /\/模块状态/);
  assert.doesNotMatch(state.payload, /\/语音引擎 安装/);
}, { modules: { disabled: ['voice'] } }));

test('current model separates read-only status, configuration guidance and invalid input', () => fixture(async command => {
  const denied = await command('agent-model', '当前模型');
  assert.match(denied.payload, /\/我的权限/);
  assert.doesNotMatch(denied.payload, /\/帮助 管理/);
  const state = await command('agent-model', '当前模型', [], { IsMaster: true });
  assert.match(state.text, /当前模型/);
  assert.match(state.text, /单个密钥/);
  assert.doesNotMatch(state.text, /\| ---|\| 端点/);
  const guide = await command('agent-model', '当前模型', ['test-model'], { IsMaster: true });
  assert.match(guide.text, /尚未修改模型/);
  assert.match(guide.text, /test-model/);
  const invalid = await command('agent-model', '当前模型', ['test-model', 'extra'], { IsMaster: true });
  assert.match(invalid.text, /一次只能指定一个/);
  assert.doesNotMatch(invalid.text, /保存后生效/);
}));

test('AI switch rejection never uses a success title or exposes owner-only recovery to members', () => fixture(async command => {
  for (const key of ['开启', '关闭']) {
    const denied = await command('ai-switch', key);
    assert.match(denied.text, /只有机器人主人/);
    assert.doesNotMatch(denied.text, /AI 已开启|AI 已关闭/);
    assert.match(denied.payload, /\/我的权限/);
    assert.doesNotMatch(denied.payload, /\/开启|\/帮助 管理/);
  }
  const invalid = await command('ai-switch', '开启', ['多余'], { IsMaster: true });
  assert.match(invalid.text, /不需要填写内容/);
  assert.doesNotMatch(invalid.text, /AI 已开启/);
  assert.match(invalid.payload, /\/开启/);
  const tooLong = await command('ai-switch', '关闭', ['长'.repeat(501)], { IsMaster: true });
  assert.match(tooLong.text, /最多 500/);
  assert.doesNotMatch(tooLong.text, /AI 已关闭/);
}));

test('new topic rejects attached questions instead of discarding them during a reset', () => fixture(async command => {
  const invalid = await command('agent-new', '新会话', ['帮我查天气'], { IsMaster: true });
  assert.match(invalid.text, /收到成功提示后再发送新问题/);
  assert.doesNotMatch(invalid.text, /已开始新话题|换个话题聊/);
  assert.match(invalid.payload, /\/新会话/);
}));

test('cancel refuses extra input without aborting work and distinguishes running from empty', () => fixture(async (command, settings) => {
  const { enqueueChat, conversationQueueScope } = await import('../lib/dsh/orchestrator.js');
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const scope = conversationQueueScope(getDSHConfig(settings), { platform: 'qq-bot', botId: 'bot' });
  let activeSignal, release;
  const completion = enqueueChat('private:["qq-bot","u"]', 2, 'cancel-user', async signal => {
    activeSignal = signal;
    await new Promise(resolve => { release = resolve; });
  }, undefined, undefined, scope);
  try {
    while (!activeSignal) await new Promise(resolve => setImmediate(resolve));
    const invalid = await command('agent-cancel', '取消', ['清除'], { IsMaster: true, UserKey: 'cancel-user' });
    assert.match(invalid.text, /不需要附加内容/);
    assert.equal(activeSignal.aborted, false);
    const cancelled = await command('agent-cancel', '取消', [], { IsMaster: true, UserKey: 'cancel-user' });
    assert.match(cancelled.text, /不继续写/);
    assert.equal(activeSignal.aborted, true);
  } finally { release?.(); await completion; }
  const empty = await command('agent-cancel', '取消', [], { IsMaster: true });
  assert.match(empty.text, /没有待处理/);
  assert.match(empty.payload, /\/提问/);
  const missing = await command('agent-cancel', '取消', [], { UserId: '', UserKey: '' });
  assert.match(missing.text, /无法识别/);
}));

test('public key guidance makes no false mutation claims and directs personal owners to their own keys', () => fixture(async command => {
  for (const [module, key] of [['agent-bind', '密钥配置'], ['agent-unbind', '移除密钥']]) {
    const owner = await command(module, key, ['secret-not-to-echo'], { IsMaster: true });
    assert.match(owner.text, /这里只提供/);
    assert.match(owner.text, /尚未/);
    assert.doesNotMatch(owner.payload, /secret-not-to-echo/);
    assert.match(owner.payload, /\/当前模型/);
    const member = await command(module, key);
    assert.match(member.payload, /\/我的钥匙 私聊/);
    const group = await command(module, key, [], { IsPrivate: false, ChannelId: 'g', IsMaster: true });
    assert.match(group.text, /私聊查看指引/);
    assert.match(group.text, /请勿发送真实密钥/);
  }
}));

test('model list rejects noninteger and extra input before requesting a provider', () => fixture(async command => {
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('must not request'); };
  try {
    for (const args of [['1.5'], ['1abc'], ['-1'], ['0'], ['1', 'extra'], ['999999999999999999999']]) {
      const invalid = await command('agent-models', '模型列表', args, { IsMaster: true });
      assert.match(invalid.text, /没有识别出页码/);
      assert.match(invalid.payload, /\/模型列表/);
    }
    assert.equal(requests, 0);
    const member = await command('agent-models', '模型列表');
    assert.match(member.payload, /\/我的权限/);
  } finally { globalThis.fetch = oldFetch; }
}));

test('status rejects unknown arguments and restricts details before runtime initialization', () => fixture(async command => {
  for (const args of [['详情', '多余'], ['未知'], ['1']]) {
    const invalid = await command('agent-status', '状态', args, { IsMaster: true });
    assert.match(invalid.text, /没有识别出/);
    assert.match(invalid.payload, /\/状态/);
    assert.doesNotMatch(invalid.text, /媒体|正在准备|密钥已配置/);
  }
  const member = await command('agent-status', '状态', ['详情']);
  assert.match(member.text, /主人.*私聊查看/);
  const group = await command('agent-status', '状态', ['详情'], { IsMaster: true, IsPrivate: false, ChannelId: 'g' });
  assert.match(group.text, /主人.*私聊查看/);
}));

test('model list handler paginates actual provider results and distinguishes empty from failed queries', () => fixture(async command => {
  const oldFetch = globalThis.fetch;
  let mode = 'list';
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://models.example/v1/models');
    if (mode === 'failure') return new Response('private provider diagnostic', { status: 403 });
    if (mode === 'malformed') return Response.json({ data: {} });
    return Response.json({ data: mode === 'empty' ? [] : Array.from({ length: 17 }, (_, i) => ({ id: `model-${String(i).padStart(2, '0')}` })) });
  };
  try {
    const first = await command('agent-models', '模型列表', [], { IsMaster: true });
    assert.match(first.text, /第 1\/3 页/);
    assert.match(first.text, /model-07/);
    assert.doesNotMatch(first.text, /model-08/);
    assert.match(first.payload, /\/模型列表 2/);
    const middle = await command('agent-models', '模型列表', ['2'], { IsMaster: true });
    assert.match(middle.text, /model-08/);
    assert.match(middle.text, /model-15/);
    assert.match(middle.payload, /上一页.*下一页/);
    const last = await command('agent-models', '模型列表', ['999'], { IsMaster: true });
    assert.match(last.text, /第 3\/3 页/);
    assert.match(last.text, /model-16/);
    assert.doesNotMatch(last.payload, /下一页/);
    mode = 'empty';
    const empty = await command('agent-models', '模型列表', [], { IsMaster: true });
    assert.match(empty.text, /未返回可列出的模型/);
    assert.match(empty.text, /不代表当前模型不可用/);
    assert.match(empty.payload, /\/当前模型/);
    for (mode of ['failure', 'malformed']) {
      const failed = await command('agent-models', '模型列表', [], { IsMaster: true });
      assert.match(failed.text, /读取失败/);
      assert.match(failed.payload, /\/密钥配置/);
      assert.doesNotMatch(failed.payload, /private provider diagnostic|fixture-model-secret/);
    }
  } finally { globalThis.fetch = oldFetch; }
}, { apiKey: 'fixture-model-secret', baseUrl: 'https://models.example/v1', model: 'model-00' }));

test('intelligence explains levels and keeps permission queries read-only with explicit guidance', () => fixture(async command => {
  const query = await command('agent-intelligence', '我的权限', ['专研'], { IsMaster: true });
  assert.match(query.text, /不会改变设置/);
  assert.match(query.payload, /\/智能程度/);
  const invalid = await command('agent-intelligence', '智能程度', ['深度', '多余'], { IsMaster: true });
  assert.match(invalid.text, /没有识别出这个档位/);
  const menu = await command('agent-intelligence', '智能程度', [], { IsMaster: true });
  assert.match(menu.text, /轻快.*标准.*深度.*专研/);
  assert.match(menu.text, /耗时和消耗/);
  const missing = await command('agent-intelligence', '我的权限', [], { UserId: '', UserKey: '' });
  assert.match(missing.text, /无法确认完成/);
  assert.doesNotMatch(missing.text, /identity unavailable/);
}));

test('budget help works with protection disabled and offers owner adjustments only to owners', () => fixture(async command => {
  const member = await command('agent-budget', '额度', ['帮助']);
  assert.match(member.text, /未开启每日额度保护/);
  assert.match(member.text, /充值余额跨天保留/);
  assert.doesNotMatch(member.payload, /填写增加金额|填写设置金额|调整记录/);
  const owner = await command('agent-budget', '额度', ['帮助'], { IsMaster: true });
  assert.match(owner.text, /不涉及实际付款/);
  assert.match(owner.payload, /\/额度 增加/);
  assert.match(owner.payload, /\/额度 设置/);
  assert.doesNotMatch(owner.text, /\| ---|增加 2（或 充值）/);
}));

test('invalid runtime configuration still yields a usable budget error bubble', () => fixture(async command => {
  const result = await command('agent-budget', '额度');
  assert.match(result.text, /额度配置暂不可用/);
  assert.match(result.payload, /\/状态/);
  assert.doesNotMatch(result.text, /must|requestTimeoutMs/);
}, { requestTimeoutMs: -1 }));

test('proactive pause rejects zero and resume does not claim to reopen a closed subscription', () => fixture(async command => {
  const owner = { IsMaster: true };
  const missing = await command('agent-proactive', '主动搭话', ['恢复'], owner);
  assert.match(missing.text, /尚未.*(?:订阅|聊天记录)/);
  assert.match(missing.payload, /\/主动搭话 开启/);
  await command('agent-proactive', '主动搭话', ['开启'], owner);
  for (const amount of ['0', '10081']) {
    const invalid = await command('agent-proactive', '主动搭话', ['暂停', amount], owner);
    assert.match(invalid.text, /1–10080/);
    assert.doesNotMatch(invalid.text, /已暂停/);
  }
  const paused = await command('agent-proactive', '主动搭话', ['暂停', '60'], owner);
  assert.match(paused.text, /本私聊已暂停 60 分钟/);
  const resumed = await command('agent-proactive', '主动搭话', ['恢复'], owner);
  assert.match(resumed.text, /已解除暂停/);
  await command('agent-proactive', '主动搭话', ['关闭'], owner);
  const closed = await command('agent-proactive', '主动搭话', ['恢复'], owner);
  assert.match(closed.text, /(?:订阅|主动聊天)已关闭/);
  assert.doesNotMatch(closed.text, /已恢复|已解除暂停/);
  const member = await command('agent-proactive', '主动搭话');
  assert.match(member.text, /每个人均可在自己的私聊管理/);
  const bot = await command('agent-proactive', '主动搭话', [], {IsBot:true});
  assert.match(bot.payload, /\/我的权限/);
}, { modules: { settings: { proactive: { enabled: true, autoSubscribe: false } } } }));

test('group settings reject trailing input before writes and keep member persona views read-only', () => fixture(async (command, settings) => {
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const store = getGroupSettingsStore(getDSHConfig(settings));
  const owner = { IsPrivate: false, ChannelId: 'g', IsMaster: true };
  await command('agent-group-settings', '群设置', ['语音', '关闭'], owner);
  const before = store.get('qq-bot', 'g');
  try {
    for (const args of [['语音','开启','多余'],['安静','多余'],['重置','多余'],['唤醒词','清空','多余'],['人设','清空','多余'],['每小时','2','多余'],['查看','多余']]) {
      const invalid = await command('agent-group-settings', '群设置', args, owner);
      assert.match(invalid.text, /多余内容.*尚未修改/);
      assert.match(invalid.payload, /\/群设置 查看/);
      assert.deepEqual(store.get('qq-bot', 'g'), before);
    }
    const member = await command('agent-group-settings', '群设置', ['人设','查看'], { ...owner, IsMaster: false, IsAdmin: false, Role: 'member' });
    assert.doesNotMatch(member.payload, /填写补充|清空人设/);
    assert.match(member.text, /群管理员可编辑/);
    const unknown = await command('agent-group-settings', '群设置', ['未知'], owner);
    assert.match(unknown.payload, /设置菜单/);
    assert.doesNotMatch(unknown.text, /常写的几条/);
  } finally { store.close(); }
}));

test('group voice settings distinguish permission from synthesis and inactive automatic permission', () => fixture(async command => {
  const owner = { IsPrivate: false, ChannelId: 'g', IsMaster: true };
  const guide = await command('agent-group-settings', '群设置', ['语音'], owner);
  assert.match(guide.text, /成功合成还需要语音服务可用/);
  assert.match(guide.payload, /只在要求时/);
  await command('agent-group-settings', '群设置', ['语音', '关闭'], owner);
  const enabledAuto = await command('agent-group-settings', '群设置', ['语音', '自动开启'], owner);
  assert.match(enabledAuto.text, /总开关关闭时暂不生效/);
  const status = await command('agent-group-settings', '群设置', ['语音', '查看'], owner);
  assert.match(status.text, /总开关关闭，暂不生效/);
  assert.doesNotMatch(status.text, /跟随全局|语音：可用/);
  const reopened = await command('agent-group-settings', '群设置', ['语音', '开启'], owner);
  assert.match(reopened.text, /实际合成取决于语音服务/);
  assert.doesNotMatch(reopened.payload, /恢复默认/);
}));

test('group reset requires actor-bound fresh preview and cancels stale confirmations', () => fixture(async (command, settings) => {
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const store = getGroupSettingsStore(getDSHConfig(settings));
  const owner = { IsPrivate: false, ChannelId: 'g', IsMaster: true };
  const reset = (...args) => command('agent-group-settings', '群设置', ['重置', ...args], owner);
  try {
    await command('agent-group-settings', '群设置', ['语音', '关闭'], owner);
    const before = store.get('qq-bot', 'g');
    assert.match((await reset('确认')).text, /确认已失效/);
    const preview = await reset();
    assert.match(preview.text, /聊天记录与记忆保留/);
    assert.deepEqual(store.get('qq-bot', 'g'), before);
    const foreign = await command('agent-group-settings', '群设置', ['重置', '确认'], { ...owner, UserId: 'other-owner' });
    assert.match(foreign.text, /确认已失效/);
    await reset('取消');
    assert.match((await reset('确认')).text, /确认已失效/);
    await reset();
    await command('agent-group-settings', '群设置', ['语音', '自动关闭'], owner);
    assert.match((await reset('确认')).text, /设置已变化/);
    assert.equal(store.get('qq-bot', 'g').voiceEnabled, false);
    await reset();
    assert.match((await reset('确认')).text, /已恢复群设置默认值/);
    assert.deepEqual(store.get('qq-bot', 'g'), {});
    assert.match((await reset('确认')).text, /确认已失效/);
  } finally { store.close(); }
}));

test('group persona clear previews scope and refuses cancelled or changed-content confirmation', () => fixture(async (command, settings) => {
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getPersonaStore } = await import('../lib/companion/personas.js');
  const store = getPersonaStore(getDSHConfig(settings));
  const owner = { IsPrivate: false, ChannelId: 'g', IsMaster: true };
  const scope = { platform: 'qq-bot', channelId: 'g' };
  const clear = (...args) => command('agent-group-settings', '群设置', ['人设','清空',...args], owner);
  try {
    store.setScopeAdditions(scope, '喜欢喝茶', 'u');
    assert.match((await clear('确认')).text, /确认已失效/);
    const preview = await clear();
    assert.match(preview.text, /专属人设细节和共享模板保留/);
    assert.equal(store.scopeAdditions(scope), '喜欢喝茶');
    await clear('取消');
    assert.match((await clear('确认')).text, /确认已失效/);
    await clear();
    store.setScopeAdditions(scope, '改为喜欢咖啡', 'another');
    assert.match((await clear('确认')).text, /补充已变化/);
    assert.equal(store.scopeAdditions(scope), '改为喜欢咖啡');
    await clear();
    assert.match((await clear('确认')).text, /已清空本群人设补充/);
    assert.equal(store.scopeAdditions(scope), '');
    assert.match((await clear()).text, /无需清空/);
  } finally { store.close(); }
}));

test('group word lists paginate with per-word actions and keep ordinary members read-only', () => fixture(async (command, settings) => {
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const store = getGroupSettingsStore(getDSHConfig(settings));
  const owner = { IsPrivate: false, ChannelId: 'g', IsMaster: true };
  const words = Array.from({ length: 12 }, (_, i) => `词${String(i).padStart(2,'0')}`);
  try {
    store.update('qq-bot','g','u',{wakeNames:words,bannedWords:words});
    for (const field of ['唤醒词','禁语']) {
      const first = await command('agent-group-settings','群设置',[field,'查看'],owner);
      assert.match(first.text,/第 1\/3 页/);
      assert.match(first.text,/词04/);
      assert.doesNotMatch(first.text,/词05/);
      assert.match(first.payload,new RegExp(`/群设置 ${field} 删 词00`));
      const last = await command('agent-group-settings','群设置',[field,'查看','999'],owner);
      assert.match(last.text,/第 3\/3 页/);
      assert.match(last.text,/词11/);
      assert.doesNotMatch(last.payload,/下一页/);
      const member = await command('agent-group-settings','群设置',[field,'查看'],{...owner,IsMaster:false,IsAdmin:false,Role:'member'});
      assert.doesNotMatch(member.payload,/删除此词|填写新词|清空唤醒词|清空禁语/);
      const invalid = await command('agent-group-settings','群设置',[field,'查看','1.5'],owner);
      assert.match(invalid.text,/尚未修改设置/);
    }
    await command('agent-group-settings','群设置',['唤醒词','删','词00'],owner);
    assert.deepEqual(store.get('qq-bot','g').wakeNames,words.slice(1));
    assert.deepEqual(store.get('qq-bot','g').bannedWords,words);
  } finally { store.close(); }
}));

test('word editing guides incomplete input and returns to the affected list page', () => fixture(async (command, settings) => {
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const store = getGroupSettingsStore(getDSHConfig(settings));
  const owner = { IsPrivate: false, ChannelId: 'g', IsMaster: true };
  const words = Array.from({length:11},(_,i)=>`词${i}`);
  try {
    store.update('qq-bot','g','u',{wakeNames:words});
    const guide = await command('agent-group-settings','群设置',['唤醒词','加'],owner);
    assert.match(guide.text,/会合并到已有词表/);
    assert.deepEqual(store.get('qq-bot','g').wakeNames,words);
    const removed = await command('agent-group-settings','群设置',['唤醒词','删','词10'],owner);
    assert.match(removed.payload,/\/群设置 唤醒词 查看 2/);
    const missing = await command('agent-group-settings','群设置',['唤醒词','删','missing'],owner);
    assert.match(missing.payload,/\/群设置 唤醒词 查看/);
    const added = await command('agent-group-settings','群设置',['唤醒词','加','新词'],owner);
    assert.match(added.payload,/返回词表/);
    assert.ok(store.get('qq-bot','g').wakeNames.includes('新词'));
  } finally {store.close();}
}));

test('configuration failures do not spam ambient group chat or misdirect private users to quota controls', () => fixture(async command => {
  const ambient = await command('dsh', '普通消息', [], { IsPrivate: false, ChannelId: 'g', MessageText: '今天吃什么', MessageMentions: [], IsMaster: false });
  assert.equal(ambient.text, '[]');
  const privateFailure = await command('private-chat', '普通消息', [], { MessageText: '你好', IsMaster: false });
  assert.match(privateFailure.payload, /\/状态/);
  assert.match(privateFailure.payload, /\/帮助 聊天/);
  assert.doesNotMatch(privateFailure.payload, /\/密钥配置|\/额度 今日不再提醒|\/我的钥匙/);
  const ownerFailure = await command('private-chat', '普通消息', [], { MessageText: '你好', IsMaster: true });
  assert.match(ownerFailure.payload, /\/密钥配置/);
}, { requestTimeoutMs: -1 }));

test('explicit group mention receives configuration failure feedback instead of an uncaught error', () => fixture(async command => {
  const result = await command('dsh', '普通消息', [], { IsPrivate: false, ChannelId: 'g', IsAtMe: true, MessageText: '帮我看一下这个问题', MessageMentions: [], IsMaster: false });
  assert.notEqual(result.text, '[]');
  assert.match(result.payload, /\/状态/);
  assert.match(result.payload, /\/帮助 聊天/);
  assert.doesNotMatch(result.payload, /\/密钥配置|\/额度 今日不再提醒|requestTimeoutMs/);
}, { requestTimeoutMs: -1 }));

test('mood query rejects mutations and explains unavailable private access', () => fixture(async command => {
  const invalid = await command('agent-mood','心情',['100'],{IsMaster:true});
  assert.match(invalid.text,/仅供查看/);
  assert.match(invalid.payload,/\/心情/);
  const denied = await command('agent-mood','心情');
  assert.match(denied.text,/未开放此私聊/);
  assert.match(denied.payload,/\/帮助 额度/);
  const owner = await command('agent-mood','心情',[],{IsMaster:true});
  assert.match(owner.text,/本人私聊/);
}, {privateChatAccess:'owner'}));

test('mood disabled and invalid configuration yield useful feedback', async () => {
  await fixture(async command=>{
    const disabled=await command('agent-mood','心情',[],{IsMaster:true});
    assert.match(disabled.text,/没有开启/);
    assert.doesNotMatch(disabled.text,/暂时没有心情变化/);
  },{modules:{disabled:['mood']}});
  await fixture(async command=>{
    const failed=await command('agent-mood','心情',[],{IsMaster:true});
    assert.match(failed.text,/暂时无法读取/);
    assert.match(failed.payload,/\/状态/);
  },{requestTimeoutMs:-1});
});

test('group topic menu describes current capability and exposes editing only to managers', () => fixture(async command => {
  const owner={IsPrivate:false,ChannelId:'g',IsMaster:true};
  const view=await command('agent-group-settings','群设置',['话题','查看'],owner);
  assert.match(view.text,/自动采集与发送尚未接入/);
  assert.match(view.payload,/编辑定位|编辑标签/);
  assert.match(view.payload,/\/群设置 话题 候选/);
  const guide=await command('agent-group-settings','群设置',['话题','定位'],owner);
  assert.match(guide.text,/发送后替换本群定位/);
  assert.match(guide.payload,/填写内容/);
  const saved=await command('agent-group-settings','群设置',['话题','定位','修仙交流'],owner);
  assert.match(saved.text,/修仙交流/);
  const invalid=await command('agent-group-settings','群设置',['话题','查看','多余'],owner);
  assert.match(invalid.text,/不需要附加内容/);
  const member=await command('agent-group-settings','群设置',['话题','查看'],{...owner,IsMaster:false,IsAdmin:false,Role:'member'});
  assert.doesNotMatch(member.payload,/编辑定位|编辑标签|按标签采集|查看候选/);
}));

test('topic candidates expose every matched item through pages and preserve full details', () => fixture(async (command, settings) => {
  const {getDSHConfig}=await import('../lib/dsh/client.js');
  const {getGroupTopicStore,groupTopicId}=await import('../lib/group-topics/store.js');
  const {newsCandidate}=await import('../lib/group-topics/news.js');
  const store=getGroupTopicStore(getDSHConfig(settings));
  const id=groupTopicId('qq-bot','bot','g');
  const owner={IsPrivate:false,ChannelId:'g',IsMaster:true};
  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  try {
    store.saveProfile({id,platform:'qq-bot',botId:'bot',channelId:'g',positioning:'游戏群',tags:['游戏'],blockedTags:[],enabled:true,shareOut:false,receiveShared:true});
    const topics=[];
    for(let i=0;i<5;i++) {
      const topic=newsCandidate(`https://example.com/article-${i}`,day,['游戏'],`新闻${i} `+'完整正文'.repeat(200)+`终点${i}`);
      topics.push(topic);store.addTopic(topic);
    }
    const first=await command('agent-group-settings','群设置',['话题','候选'],owner);
    assert.match(first.text,/第 1\/2 页/);
    assert.match(first.payload,/\/群设置 话题 候选 2/);
    assert.match(first.payload,/查看来源/);
    assert.doesNotMatch(first.text,/终点/);
    const last=await command('agent-group-settings','群设置',['话题','候选','999'],owner);
    assert.match(last.text,/第 2\/2 页/);
    assert.doesNotMatch(last.payload,/下一页/);
    const full=await command('agent-group-settings','群设置',['话题','候选详情',topics[0].id],owner);
    assert.match(full.text,/终点0/);
    const missing=await command('agent-group-settings','群设置',['话题','候选详情','missing'],owner);
    assert.match(missing.text,/已过期.*不再匹配/);
    const help=await command('agent-group-settings','群设置',['话题','新闻'],owner);
    assert.match(help.text,/最多1200字/);
    assert.match(help.payload,/填写新闻/);
  } finally {store.close();}
}));

test('destructive confirmation expiry and bot/workspace isolation preserve the original data', () => fixture(async (command, settings) => {
  const {getDSHConfig}=await import('../lib/dsh/client.js');
  const {getPersonaStore}=await import('../lib/companion/personas.js');
  const {getGroupSettingsStore}=await import('../lib/social/group-settings.js');
  const seed=async config=>{
    const persona=getPersonaStore(config),groups=getGroupSettingsStore(config);
    await persona.save({id:'isolation-test',name:'确认隔离',prompt:'保留模板'});
    persona.append('isolation-test','保留共享补充');
    persona.setScopeAdditions({platform:'qq-bot',channelId:'g'},'保留群补充','u');
    groups.update('qq-bot','g','u',{voiceEnabled:false});
    return {persona,groups};
  };
  const state=await seed(getDSHConfig(settings));
  const cases=[
    ['agent-persona','人格',['删除','isolation-test'],{IsMaster:true}],
    ['agent-persona','人格',['清空追加','isolation-test'],{IsMaster:true}],
    ['agent-group-settings','群设置',['重置'],{IsMaster:true,IsPrivate:false,ChannelId:'g'}],
    ['agent-group-settings','群设置',['人设','清空'],{IsMaster:true,IsPrivate:false,ChannelId:'g'}]
  ];
  const unchanged=async target=>{
    assert.equal((await target.persona.read('isolation-test')).prompt,'保留模板');
    assert.equal(target.persona.additions('isolation-test'),'保留共享补充');
    assert.equal(target.persona.scopeAdditions({platform:'qq-bot',channelId:'g'}),'保留群补充');
    assert.equal(target.groups.get('qq-bot','g').voiceEnabled,false);
  };
  try {
    for(const [module,key,args,identity] of cases){
      await command(module,key,args,identity);
      const wrongBot=await command(module,key,[...args,'确认'],{...identity,BotId:'other-bot'});
      assert.match(wrongBot.text,/确认已失效/);
      const originalNow=Date.now;
      Date.now=()=>originalNow()+61000;
      try {assert.match((await command(module,key,[...args,'确认'],identity)).text,/确认已失效/);} finally {Date.now=originalNow;}
      await unchanged(state);
      await command(module,key,args,identity);
    }
    await fixture(async (otherCommand,otherSettings)=>{
      const other=await seed(getDSHConfig(otherSettings));
      try {
        for(const [module,key,args,identity] of cases){
          assert.match((await otherCommand(module,key,[...args,'确认'],identity)).text,/确认已失效/);
          await unchanged(other);
        }
      } finally {other.persona.close();other.groups.close();}
    });
    await unchanged(state);
  } finally {state.persona.close();state.groups.close();}
}));

test('pool rejects malformed pages and members receive public recovery actions', () => fixture(async command => {
  for(const args of [['1.5'],['2abc'],['0'],['1','多余']]) {
    const invalid=await command('agent-pool','额度轮转',args,{IsMaster:true});
    assert.match(invalid.text,/没有识别出页码/);
    assert.match(invalid.payload,/\/额度轮转 1/);
  }
  const member=await command('agent-pool','额度轮转');
  assert.match(member.text,/仅限机器人主人/);
  assert.match(member.payload,/\/我的权限/);
  assert.doesNotMatch(member.payload,/\/额度轮转 1/);
}));

test('chat and voice entry bubbles explain empty questions and missing identity without requests', () => fixture(async command => {
  for(const [module,key] of [['agent-chat','提问'],['agent-voice','语音']]){
    const empty=await command(module,key,[],{IsMaster:true});
    assert.match(empty.text,key==='语音'?/用文字回答/:/想问什么/);
    const missing=await command(module,key,[],{IsPrivate:false,ChannelId:'',UserId:''});
    assert.match(missing.text,/无法识别提问者或当前会话/);
    assert.doesNotMatch(missing.text,/已排队|正在回答/);
  }
  const member=await command('agent-chat','提问',[],{IsPrivate:false,ChannelId:'g',IsMaster:false,IsAdmin:false,Role:'member'});
  assert.doesNotMatch(member.payload,/\/新会话/);
  const admin=await command('agent-chat','提问',[],{IsPrivate:false,ChannelId:'g',IsMaster:false,IsAdmin:true,Role:'admin'});
  assert.match(admin.payload,/\/新会话/);
}));

test('group voice configuration failure produces feedback before scheduling', () => fixture(async command => {
  const result=await command('agent-voice','语音',['你好'],{IsPrivate:false,ChannelId:'g'});
  assert.match(result.text,/暂时无法处理/);
  assert.match(result.payload,/\/状态/);
}, {requestTimeoutMs:-1}));
