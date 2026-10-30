import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultCode, withEventContext, getConfig, markdownToPlainText } from 'alemonjs';
import { helpFormat, helpText } from '../lib/response/agent-help/res.js';
import { withToolUsePolicy } from '../lib/agent/tool-use-policy.js';
import { BudgetExceededError, withBudgetScope, replyGateExceededMessage } from '../lib/billing/budget.js';
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

const runCommand = async (module, { private: isPrivate = true, master = true, userId = '100', platform = 'qq-bot', key = '帮助', args = [], formats = [], next = () => {} } = {}) => {
  const messages = [];
  const event = {
    name: isPrivate ? 'private.message.create' : 'message.create',
    IsPrivate: isPrivate,
    IsMaster: master,
    Platform: platform,
    BotId: '900',
    UserId: userId,
    UserKey: `user-${userId}`,
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
        messages.push(
          format.map(item => (item.type === 'Markdown' ? markdownToPlainText(item.value) : typeof item.value === 'string' ? item.value : '')).join('')
        );
        return [{ code: ResultCode.Ok, data: { id: 'fixture', messageId: 'fixture' } }];
      }
    },
    () => {
      getConfig().saveValue(globalThis.__config?.value || {});
      return withEventContext(event, next, module, { appName: 'alemonjs-agent-link' });
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
    assert.ok(Array.from(helpText(isPrivate, owner)).length <= 1100);
  }
  const handler = (await import('../lib/response/agent-help/res.js')).default;
  const messages = await runCommand(handler);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /管理说明/);
  assert.match(helpText(true, true, '管理'), /关闭 原因/);
  assert.match(helpText(true, true, '全部'), /主动搭话/);
  assert.doesNotMatch(helpText(false, false, '全部'), /服务端日志取验证码/);
});

test('help only consumes supported topics and passes unknown arguments through', async () => {
  const handler = (await import('../lib/response/agent-help/res.js')).default;
  for (const topic of ['', '聊天', '记忆', '人格', '群设置', '媒体', '数据', '管理', '额度', '密钥', '全部', '未知', '聊天 多余', 'toString']) {
    let forwarded = 0;
    const messages = await runCommand(handler, {
      args: topic ? topic.split(' ') : [],
      next: () => {
        forwarded++;
      }
    });
    const unknown = ['未知', '聊天 多余', 'toString'].includes(topic);
    assert.equal(forwarded, !topic || unknown ? 1 : 0, topic);
    assert.equal(messages.length > 0, !unknown, topic);
  }
});

test('help and configuration guidance use structured Markdown with readable steps', async () => {
  const handler = (await import('../lib/response/agent-help/res.js')).default;
  for (const isPrivate of [true, false]) {
    const formats = [];
    const messages = await runCommand(handler, { private: isPrivate, master: false, args: ['额度'], formats });
    assert.equal(messages.length, 1);
    const items = formats.flat();

    assert.ok(
      items.every(item => item.type === 'Markdown' || item.type === 'BT.group'),
      'help cards are Markdown plus an optional keyboard group'
    );
    assert.ok(!items.some(item => item.type === 'BT.group'), 'detailed help keeps one inline next step, not a duplicate keyboard');

    assert.match(messages[0], isPrivate ? /添加到私聊/ : /添加到群聊/);
    if (!isPrivate) assert.match(messages[0], /选择要授权的钥匙/);
  }
  const formats = [];
  const messages = await runCommand((await import('../lib/response/agent-bind/res.js')).default, { master: false, formats });
  const bindItems = formats.flat();

  assert.ok(
    bindItems.every(item => item.type === 'Markdown' || item.type === 'BT.group'),
    'key guidance is Markdown plus an optional keyboard group'
  );
  assert.match(messages[0], /直接发送真实 Key/);
});

test('budget errors explain the correct private or group binding workflow without leaking credentials', () => {
  for (const isPrivate of [true, false]) {
    const error = withBudgetScope({ platform: 'test', userId: 'u', channelId: isPrivate ? 'private:["test","u"]' : 'g' }, () => new BudgetExceededError());
    assert.match(error.message, /额度不足/);
    assert.match(error.message, isPrivate ? /添加到私聊/ : /添加到群聊/);
    assert.doesNotMatch(error.message, /`|\*\*|\|/);
    if (!isPrivate) assert.doesNotMatch(error.message, /我的钥匙 私聊/);
  }
  assert.match(replyGateExceededMessage, /今天只提醒这一次/);
  assert.match(replyGateExceededMessage, /添加到群聊/);
});

test('budget errors show the shortfall above the binding guidance', () => {
  const error = withBudgetScope(
    { platform: 'test', userId: 'u', channelId: 'g' },
    () => new BudgetExceededError({ availableYuan: 0.1032, requiredYuan: 0.1328 })
  );

  assert.match(error.message, /本次请求预计需要 0\.13 元，当前可用约 0\.10 元/);
  assert.match(error.message, /添加到群聊/);
  assert.doesNotMatch(error.message, /`|\*\*|\|/);
  assert.equal(error.requiredYuan, 0.1328);
  assert.equal(error.availableYuan, 0.1032);

  const unknown = withBudgetScope({ platform: 'test', userId: 'u', channelId: 'g' }, () => new BudgetExceededError());
  assert.doesNotMatch(unknown.message, /本次请求预计需要/);

  const global = withBudgetScope(
    { platform: 'test', userId: 'u', channelId: 'g' },
    () => new BudgetExceededError({ availableYuan: 0.5, requiredYuan: 0.13, globalBlocked: true })
  );
  assert.match(global.message, /今日全局每日上限也已用满/);
});

test('persona list has one response; explicit help retains management actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bubble-copy-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  try {
    const handler = (await import('../lib/response/agent-persona/res.js')).default;
    const messages = await runCommand(handler, { key: '人格' });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /人格帮助/);
    const ownerFormats = [];
    const detail = await runCommand(handler, { key: '人格', args: ['帮助'], formats: ownerFormats });
    assert.equal(detail.length, 1);
    assert.match(detail[0], /追加/);
    assert.match(detail[0], /删除/);
    assert.match(detail[0], /换一种性格/);
    assert.match(detail[0], /改称呼和习惯/);
    assert.match(detail[0], /管理模板/);
    assert.match(detail[0], /你与机器人的私聊/);
    assert.match(detail[0], /点击对应入口，再发送指令/);
    assert.doesNotMatch(detail[0], /活跃\|个性|名称\|提示词|\/人格 保存/);
    const { createMarkdownText } = await import(new URL('./format.js', import.meta.resolve('@alemonjs/qq-bot')));
    const wireText = ownerFormats.flat().filter(item => item.type === 'Markdown').map(item => createMarkdownText(item.value, 'c2c')).join('');
    for (const command of ['/人格', '/人设', '/人格 程度', '/人格 管理', '/智能程度']) {
      assert.ok(wireText.includes(`text="${command}"`), `missing inline entry: ${command}`);
    }
    assert.doesNotMatch(wireText, /人设管理|名称\|提示词|\/人格 删除 编号/);
    assert.ok(ownerFormats.flat().every(item => item.type !== 'BT.group'));
    const plain = await runCommand(handler, { key: '人格', args: ['帮助'], platform: 'onebot' });
    assert.match(plain.join(''), /复制对应指令发送/);
    assert.match(plain.join(''), /挑选人格：\/人格/);
    assert.doesNotMatch(plain.join(''), /点击|qqbot-cmd|\*\*|\\\n/);
    const formats = [];
    // Member-role lookups also use the action hook; retain only message payloads.
    const groupHelp = (await runCommand(handler, { private: false, master: false, key: '人格', args: ['帮助'], formats })).filter(Boolean);
    assert.equal(groupHelp.length, 1);
    assert.match(groupHelp[0], /群内成员都会受到影响/);
    assert.match(groupHelp[0], /当前身份不能切换/);
    assert.match(groupHelp[0], /由群管理员修改/);
    assert.doesNotMatch(groupHelp[0], /挑选人格|管理共享模板|全局默认|活跃\|个性/);
    assert.ok(formats.flat().every(item => item.type !== 'BT.group'));
    const modes = await runCommand(handler, {key:'人格',args:['程度']});
    assert.match(modes.join(''), /直接说重点/);
    assert.match(modes.join(''), /选这个/);
    const management = await runCommand(handler, {key:'人格',args:['管理']});
    assert.match(management.join(''), /补充设定/);
    assert.match(management.join(''), /返回帮助/);
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
  for (const fact of ['永久', '无法恢复', '记忆', '60秒', '相同群编号', '钥匙授权保留', '确认清除']) assert.ok(purge[0].includes(fact));
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

test('bubble copy stays inside its length budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bubble-budget-'));
  const previous = globalThis.__config;

  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { stickerRoot: join(root, 'stickers') } } } };
  try {
    const flatten = format =>
      format.map(item => (item.type === 'Markdown' ? markdownToPlainText(item.value) : typeof item.value === 'string' ? item.value : '')).join('');
    const measure = text => Array.from(text).length;
    const budgets = [];

    for (const [topic, budget] of [
      ['', 420],
      ['聊天', 180],
      ['记忆', 215],
      ['人格', 250],
      ['媒体', 235],
      ['数据', 205],
      ['管理', 380]
    ]) {
      assert.ok(measure(flatten(helpFormat(true, true, topic).value)) <= budget, `帮助${topic || '目录'} 超长`);
      budgets.push([`帮助${topic || '目录'}`, budget]);
    }

    const cards = [
      ['隐私说明', '../lib/response/agent-privacy/res.js', 425, { private: false, master: false, key: '隐私说明' }],
      ['清除群数据', '../lib/response/agent-purge/res.js', 220, { private: false, master: true, key: '清除群数据' }],
      ['人格列表', '../lib/response/agent-persona/res.js', 170, { key: '人格' }],
      ['状态', '../lib/response/agent-status/res.js', 185, { key: '状态' }],
      ['记忆', '../lib/response/agent-memory/res.js', 130, { key: '记忆' }],
      ['表情', '../lib/response/agent-sticker/res.js', 65, { private: false, master: false, key: '表情' }]
    ];
    for (const [name, path, budget, options] of cards) {
      const messages = await runCommand((await import(path)).default, options);

      for (const message of messages) assert.ok(measure(message) <= budget, `${name} 超长：${measure(message)} > ${budget}`);
    }
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('reading diary command returns own persisted evidence without a model request and isolates users', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-diary-command-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  globalThis.fetch = () => assert.fail('reading a diary must not call a model or external service');
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getMemoryStore } = await import('../lib/memory/store.js');
  const { proactiveChannel } = await import('../lib/proactive/control.js');
  const config = getDSHConfig();
  const store = getMemoryStore(config);
  const scope = { platform: 'qq-bot', botId: '900', channelId: proactiveChannel({ platform: 'qq-bot', botId: '900', userId: '100' }) };
  store.recordExperience(scope, {
    key: 'reading',
    subjectId: '900',
    tags: ['B站'],
    text: '我读取了 B 站视频资料：{"title":"鲸鱼歌声","bvid":"BV1234567890"}。'
  });
  try {
    const handler = (await import('../lib/response/agent-proactive/res.js')).default;
    const replies = await runCommand(handler, { key: '主动搭话', args: ['阅读', '日记'] });
    assert.match(replies.join(''), /鲸鱼歌声/);
    assert.match(replies.join(''), /BV1234567890/);
    const queried = await runCommand(handler, { key: '主动搭话', args: ['阅读', '日记', '7', '鲸鱼'] });
    assert.match(queried.join(''), /关键词：鲸鱼/);
    assert.match(queried.join(''), /BV1234567890/);
    const miss = await runCommand(handler, { key: '主动搭话', args: ['阅读', '日记', '7', '未出现的关键词'] });
    assert.ok(!miss.join('').includes('BV1234567890'));
    const ownMember = await runCommand(handler, { key: '主动搭话', args: ['阅读', '日记'], master: false });
    assert.match(ownMember.join(''), /鲸鱼歌声/);
    const forbidden = await runCommand(handler, { key: '主动搭话', args: ['阅读', '日记'], master: false, userId: '200' });
    assert.ok(!forbidden.join('').includes('鲸鱼歌声'));
    globalThis.__config.value['alemonjs-agent-link'].modules = {
      settings: { bili: { dailyBrowseTopics: ['恐怖游戏', '海洋'], dailyBrowseExclude: ['恐怖'] } }
    };
    const prefs = await runCommand(handler, { key: '主动搭话', args: ['阅读', '偏好'] });
    assert.match(prefs.join(''), /多看：海洋/);
    assert.match(prefs.join(''), /避开：恐怖/);
    assert.ok(!prefs.join('').includes('恐怖游戏'));
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__config = previous;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});


test('reading settings start with choices and show one example only when editing the time window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-menu-'));
  const previous = globalThis.__config;
  globalThis.__config = {value:{'alemonjs-agent-link':{stateBackend:'local',workspaceRoot:join(root,'work'),dshHomeRoot:join(root,'home')}}};
  try {
    const handler = (await import('../lib/response/agent-proactive/res.js')).default;
    const menu = await runCommand(handler,{key:'主动搭话',args:['阅读']});
    assert.equal(menu.length,1);
    assert.match(menu[0],/阅读时段/);
    assert.match(menu[0],/阅读日记/);
    assert.match(menu[0],/阅读偏好/);
    assert.doesNotMatch(menu[0],/开启\|关闭|\[1-7\]/);
    const edit = await runCommand(handler,{key:'主动搭话',args:['阅读','作息']});
    assert.match(edit.join(''),/18 22/);
    assert.match(edit.join(''),/返回阅读设置/);
    const invalid = await runCommand(handler,{key:'主动搭话',args:['阅读','不知道']});
    assert.match(invalid.join(''),/返回阅读设置/);
  } finally {globalThis.__config=previous;await rm(root,{recursive:true,force:true});}
});

test('sticker help is available without running a chat task and hides owner operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-sticker-help-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  try {
    const handler = (await import('../lib/response/agent-sticker/res.js')).default;
    for (const master of [false, true]) {
      const formats = [];
      const messages = await runCommand(handler, { private: false, master, key: '表情', args: ['帮助'], formats });
      assert.equal(messages.length, 1);
      assert.match(messages[0], /发送表情/);
      if (master) assert.match(messages[0], /删除素材/);
      else assert.doesNotMatch(messages[0], /删除素材|导入|同步/);
      assert.doesNotMatch(messages[0], /导入收藏|同步收藏/); // QQ official transport cannot use OneBot favorites.
      assert.ok(formats.flat().every(item => item.type !== 'BT.group'));
    }
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('persona input mistakes return a relevant menu instead of another syntax list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-persona-guidance-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  try {
    const handler = (await import('../lib/response/agent-persona/res.js')).default;
    const unknown = await runCommand(handler, { key: '人格', args: ['使用'] });
    assert.match(unknown.join(''), /查看人格/);
    assert.match(unknown.join(''), /人格帮助/);
    assert.doesNotMatch(unknown.join(''), /用法：/);
    const extra = await runCommand(handler, { key: '人格', args: ['使用', 'assistant', '多余'] });
    assert.match(extra.join(''), /一次只能选择一个/);
    assert.doesNotMatch(extra.join(''), /需要机器人主人/);
    const group = await runCommand(handler, { private: false, master: false, key: '人格', args: ['追加', 'assistant', 'test'] });
    assert.match(group.join(''), /人设细节/);
    assert.doesNotMatch(group.join(''), /人设 查看；清空|只有一个输入位/);
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('shared template editing guides incomplete input, preserves content, and returns to saved details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-edit-flow-'));
  const previous = globalThis.__config;
  const settings = { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') };
  globalThis.__config = { value: { 'alemonjs-agent-link': settings } };
  const { getPersonaStore } = await import('../lib/companion/personas.js');
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const store = getPersonaStore(getDSHConfig(settings));
  try {
    await store.save({ id: 'flow-test', name: '原模板', prompt: '保留原来的内容' });
    const handler = (await import('../lib/response/agent-persona/res.js')).default;
    for (const body of [[], ['缺少分隔'], ['|没有名称'], ['名称|']]) {
      const guide = await runCommand(handler, { key: '人格', args: ['保存', 'flow-test', ...body] });
      assert.match(guide.join(''), /完整设定/);
      assert.match(guide.join(''), /替换这个模板/);
      assert.match(guide.join(''), /返回模板/);
      assert.equal((await store.read('flow-test')).prompt, '保留原来的内容');
    }
    const saved = await runCommand(handler, { key: '人格', args: ['保存', 'flow-test', '新模板|先说结论'] });
    assert.match(saved.join(''), /新模板.*已保存/);
    assert.match(saved.join(''), /查看设定/);
    assert.equal((await store.read('flow-test')).prompt, '先说结论');
    const extra = await runCommand(handler, { key: '人格', args: ['删除', 'flow-test', '多余'] });
    assert.match(extra.join(''), /不需要附加内容/);
    assert.equal((await store.read('flow-test')).name, '新模板');
    const missing = await runCommand(handler, { key: '人格', args: ['查看', 'missing-test'] });
    assert.match(missing.join(''), /未能确认完成/);
    assert.match(missing.join(''), /模板列表/);
    assert.doesNotMatch(missing.join(''), /已保存|没能完成修改/);
  } finally { store.close(); globalThis.__config = previous; await rm(root, { recursive: true, force: true }); }
});

test('shared template removal requires a fresh confirmation and supports cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-confirm-flow-'));
  const previous = globalThis.__config;
  const settings = { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') };
  globalThis.__config = { value: { 'alemonjs-agent-link': settings } };
  const { getPersonaStore } = await import('../lib/companion/personas.js');
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const store = getPersonaStore(getDSHConfig(settings));
  const handler = (await import('../lib/response/agent-persona/res.js')).default;
  const run = (action, ...rest) => runCommand(handler, { key: '人格', args: [action, 'confirm-test', ...rest] });
  try {
    await store.save({ id: 'confirm-test', name: '确认模板', prompt: '原始设定' });
    store.append('confirm-test', '补充内容');
    assert.match((await run('清空追加', '确认')).join(''), /确认已失效/);
    assert.equal(store.additions('confirm-test'), '补充内容');
    assert.match((await run('清空追加')).join(''), /所有会话都会受影响/);
    await run('清空追加', '取消');
    await run('清空追加', '确认');
    assert.equal(store.additions('confirm-test'), '补充内容');
    await run('清空追加');
    store.append('confirm-test', '新补充');
    assert.match((await run('清空追加', '确认')).join(''), /内容已变化/);
    assert.ok(store.additions('confirm-test').includes('新补充'));
    await run('清空追加');
    assert.match((await run('清空追加', '确认')).join(''), /已清空/);
    assert.equal(store.additions('confirm-test'), '');
    await run('删除');
    assert.equal((await store.read('confirm-test')).name, '确认模板');
    assert.match((await run('删除', '确认')).join(''), /已删除/);
    await assert.rejects(store.read('confirm-test'));
  } finally { store.close(); globalThis.__config = previous; await rm(root, { recursive: true, force: true }); }
});

test('privacy actions follow current conversation and role without exposing destructive member entries', async () => {
  const handler = (await import('../lib/response/agent-privacy/res.js')).default;
  for (const isPrivate of [false, true]) for (const master of [false, true]) {
    const formats = [];
    const replies = await runCommand(handler, { private: isPrivate, master, key: '隐私说明', formats });
    const wire = JSON.stringify(formats);
    assert.equal(replies.filter(Boolean).length, 1);
    assert.ok(wire.includes(isPrivate ? '/记忆' : '/群记忆'));
    assert.equal(wire.includes('/清除聊天记录'), isPrivate || master);
    assert.equal(wire.includes('/清除群数据'), !isPrivate && master);
    assert.doesNotMatch(wire, /BT.group|清除群数据 确认|清除聊天记录 确认/);
    assert.doesNotMatch(replies.join(''), /\/记忆来源 编号/);
  }
  const plain = await runCommand(handler, { key: '隐私说明', platform: 'onebot' });
  assert.match(plain.join(''), /复制对应指令发送/);
  assert.doesNotMatch(plain.join(''), /点击入口/);
});
