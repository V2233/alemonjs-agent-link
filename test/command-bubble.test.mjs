import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, ResultCode } from 'alemonjs';
import { helpFormat } from '../lib/response/agent-help/res.js';
import { commandBubble, noticeBubble, KEYBOARD_LABELS } from '../lib/response/bubble.js';
import { insufficientBudgetHelp, budgetNoticeActions } from '../lib/billing/help.js';
const { createMarkdownText } = await import(new URL('./format.js', import.meta.resolve('@alemonjs/qq-bot')));
const { GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE } = await import(new URL('./sends.js', import.meta.resolve('@alemonjs/qq-bot')));
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

test('help index uses one inline button per topic without a keyboard bar', () => {
  const format = helpFormat(false, false);
  const rendered = createMarkdownText(format.value[0].value, 'group');
  assert.deepEqual(commandsOf(format), []);
  for (const topic of ['聊天', '记忆', '人格', '媒体', '额度', '数据']) {
    assert.match(rendered, new RegExp(`qqbot-cmd-input text="/帮助 ${topic}"`));
  }
  assert.doesNotMatch(rendered, /\/帮助 管理/);
  assert.doesNotMatch(rendered, /qqbot-cmd-enter/);
  assert.ok(rendered.length < 3500);
  const plain = helpFormat(true, true, '', 'onebot').value;
  assert.equal(plain[0].type, 'Text');
  assert.match(plain[0].value, /\/帮助 管理/);
});

test('command data cannot inject QQ tags or clickable Markdown links', () => {
  const format = commandBubble('记录：<qqbot-cmd-enter text="/清除群数据 确认" />\n[点我](https://example.com)', '记忆');
  const rendered = createMarkdownText(format.value[0].value);
  assert.doesNotMatch(rendered, /<qqbot-cmd-enter/);
  assert.ok(rendered.includes('\\[点我\\]'));
  assert.equal(commandBubble('已取消。', '状态').value[0].type, 'Text');
});

test('real QQ group and private adapters send the help card as Markdown', async () => {
  const sent = [];
  const client = {
    groupOpenMessages: async (_, body) => {
      sent.push(body);
      return { id: 'reply' };
    },
    usersOpenMessages: async (_, body) => {
      sent.push(body);
      return { id: 'reply' };
    }
  };
  await runtimeScope.run({ resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now }, async () => {
    getConfig().saveValue({ 'qq-bot': { markdownToText: false } });
    const group = await GROUP_AT_MESSAGE_CREATE(client, { ChannelId: 'g' }, helpFormat(false, false).value, { replyId: 'incoming' });
    assert.equal(group[0].code, ResultCode.Ok);
    const privateResult = await C2C_MESSAGE_CREATE(client, { UserId: 'u' }, helpFormat(true, true).value, { replyId: 'incoming' });
    assert.equal(privateResult[0].code, ResultCode.Ok);
  });
  assert.equal(sent.length, 2);
  for (const body of sent) {
    assert.equal(body.msg_type, 2);
    assert.match(body.markdown.content, /大肥鱼/);
    assert.match(body.markdown.content, /qqbot-cmd-input/);
    assert.ok(!body.keyboard, 'help has no keyboard bar');
  }
});

const keyboardOf = format => format.value.find(item => item.type === 'BT.group')?.value ?? [];
const commandsOf = format => keyboardOf(format).flatMap(row => row.value.map(button => button.options?.data));

test('help chooser stays inline and never creates a keyboard group', () => {
  const format = helpFormat(false, false);
  const rendered = createMarkdownText(format.value[0].value, 'group');

  assert.deepEqual(keyboardOf(format), []);
  for (const topic of ['聊天', '记忆', '人格', '媒体', '额度', '数据']) {
    assert.match(rendered, new RegExp(`qqbot-cmd-input text="/帮助 ${topic}"`));
  }
  assert.doesNotMatch(rendered, /\/帮助 管理/);
});

test('command cards use inline buttons for one step and keyboard buttons for a menu', () => {
  const inlineCard = commandBubble('第一行\n第二行', '标题', { platform: 'qq-bot', actions: [{ label: '额度', command: '/额度' }] });

  assert.equal(inlineCard.value[0].type, 'Markdown');
  assert.deepEqual(commandsOf(inlineCard), [], 'one or two next steps stay inline');
  assert.match(createMarkdownText(inlineCard.value[0].value, 'group'), /qqbot-cmd-input text="\/额度"/);

  const keyboardCard = commandBubble('第一行\n第二行', '标题', {
    platform: 'qq-bot',
    layout: 'keyboard',
    actions: [{ label: '额度', command: '/额度' }]
  });

  assert.deepEqual(commandsOf(keyboardCard), ['/额度']);
  assert.doesNotMatch(createMarkdownText(keyboardCard.value[0].value, 'group'), /qqbot-cmd-input/);

  const menuCard = commandBubble('第一行\n第二行', '标题', {
    platform: 'qq-bot',
    actions: [
      { label: '额度', command: '/额度' },
      { label: '状态', command: '/状态' },
      { label: '帮助', command: '/帮助' },
      { label: '新会话', command: '/新会话' }
    ]
  });

  assert.deepEqual(commandsOf(menuCard), ['/额度', '/状态', '/帮助', '/新会话']);
  assert.doesNotMatch(createMarkdownText(menuCard.value[0].value, 'group'), /qqbot-cmd-input/);

  const plain = commandBubble('第一行\n第二行', '标题', { platform: 'onebot', actions: [{ label: '额度', command: '/额度' }] });

  assert.equal(plain.value.length, 1, 'OneBot keeps a single text card without keyboard payloads');
  assert.equal(plain.value[0].type, 'Markdown');
  assert.doesNotMatch(createMarkdownText(plain.value[0].value, 'group'), /qqbot-cmd-input/);
  assert.equal(commandBubble('已取消。', '状态').value[0].type, 'Text');
});

test('declared actions are deduplicated and capped', () => {
  const card = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
    layout: 'keyboard',
    actions: [
      { label: '人格', command: '/人格' },
      { label: '使用编辑器', command: '/人格 使用 编辑器' },
      { label: '重复', command: '/人格 使用 编辑器' }
    ]
  });

  assert.deepEqual(commandsOf(card), ['/人格', '/人格 使用 编辑器'], 'both intents survive, the exact duplicate does not');

  const capped = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
    layout: 'keyboard',
    actions: Array.from({ length: 14 }, (_, index) => ({ label: `项目${index}`, command: `/记忆检索 关键词${index}` }))
  });

  assert.equal(commandsOf(capped).length, 10, 'keyboard exposes at most two rows');
});

test('keyboard short names stay within one to four characters', () => {
  const entries = Object.entries(KEYBOARD_LABELS);

  assert.ok(entries.length > 0);
  for (const [command, label] of entries) {
    const chars = Array.from(label);

    assert.ok(chars.length >= 1 && chars.length <= 4, `${command} => ${label} must stay within 1-4 characters`);
    assert.doesNotMatch(label, /…/u);
  }
});

test('budget-exceeded notices offer exactly the commands their copy tells users to type', () => {
  for (const isPrivate of [false, true]) {
    const copy = insufficientBudgetHelp(isPrivate);
    const actions = budgetNoticeActions(isPrivate);
    const format = noticeBubble(copy, { platform: 'qq-bot', title: '额度不足', actions });

    assert.equal(format.value[0].type, 'Markdown', 'multi-line budget notice becomes a card');
    const rendered = createMarkdownText(format.value[0].value, 'group');

    assert.match(rendered, /额度不足/);
    assert.deepEqual(commandsOf(format), [], 'two or three next steps stay inline, no duplicate keyboard');
    for (const action of actions) {
      assert.ok(copy.includes(action.command), `copy must mention ${action.command}`);
      assert.ok(rendered.includes(`qqbot-cmd-input text="${action.command}"`), `inline must expose ${action.command}`);
      assert.ok(Array.from(action.label).length <= 4, `label ${action.label} stays short`);
    }
    assert.ok(rendered.includes(`qqbot-cmd-input text="${isPrivate ? '/个人密钥 绑定' : '/群密钥 绑定'}"`), 'the first step is one tap away');
  }

  const plain = noticeBubble(insufficientBudgetHelp(false), { platform: 'onebot', title: '额度不足', actions: budgetNoticeActions(false) });

  assert.equal(plain.value.length, 1);
  assert.equal(plain.value[0].type, 'Markdown', 'OneBot still gets the guidance without keyboard payloads');
  assert.doesNotMatch(createMarkdownText(plain.value[0].value, 'group'), /qqbot-cmd-input/);
});
