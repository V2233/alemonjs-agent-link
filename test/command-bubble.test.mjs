import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, ResultCode } from 'alemonjs';
import { helpFormat } from '../lib/response/agent-help/res.js';
import { commandBubble, noticeBubble, KEYBOARD_LABELS } from '../lib/response/bubble.js';
import { insufficientBudgetHelp, budgetNoticeActions } from '../lib/billing/help.js';
const { createMarkdownText } = await import(new URL('./format.js', import.meta.resolve('@alemonjs/qq-bot')));
const { GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE } = await import(new URL('./sends.js', import.meta.resolve('@alemonjs/qq-bot')));
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

test('help actions stay with their sections and only fill commands, never auto-submit', () => {
  const format = helpFormat(false, false);
  const rendered = createMarkdownText(format.value[0].value, 'group');
  assert.match(rendered, /> .*聊天用法.*qqbot-cmd-input|> .*qqbot-cmd-input.*聊天用法/);
  assert.doesNotMatch(rendered, /qqbot-cmd-enter/);
  assert.match(rendered, /text="\/帮助 记忆"/);
  assert.doesNotMatch(rendered, /\/帮助 管理/);
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
    const rows = body.keyboard?.content?.rows ?? [];

    assert.ok(rows.length > 0 && rows.length <= 5, 'the adapter receives a compact keyboard group');
    assert.deepEqual(body.keyboard.content.style, { font_size: 'small' });
    for (const row of rows) {
      assert.ok(row.buttons.length <= 5);
      for (const button of row.buttons) {
        assert.equal(button.action.type, 2);
        assert.equal(button.action.enter, false);
        assert.match(button.action.data, /^\//);
        assert.ok(Array.from(button.render_data.label).length <= 4, `keyboard label stays within 1-4 characters: ${button.render_data.label}`);
      }
    }
  }
});

const keyboardOf = format => format.value.find(item => item.type === 'BT.group')?.value ?? [];
const commandsOf = format => keyboardOf(format).flatMap(row => row.value.map(button => button.options?.data));

test('every bubble pairs inline command buttons with a compact keyboard group', () => {
  const format = helpFormat(false, false);
  const group = keyboardOf(format);

  assert.ok(group.length > 0 && group.length <= 5, 'keyboard rows stay inside the client limit');
  for (const row of group) {
    assert.ok(row.value.length > 0 && row.value.length <= 5, 'buttons per row stay inside the client limit');
    for (const button of row.value) {
      const chars = Array.from(button.value);

      assert.ok(chars.length >= 1 && chars.length <= 4, `keyboard labels stay within 1-4 characters, got: ${button.value}`);
      assert.doesNotMatch(button.value, /…/u, 'keyboard labels are never truncated mid-word');
      assert.match(button.options.data, /^\//, 'keyboard buttons only fill commands');
      assert.equal(button.options.type, 'command');
      assert.equal(button.options.autoEnter, false, 'keyboard buttons never auto-submit');
    }
  }
  assert.match(createMarkdownText(format.value[0].value, 'group'), /qqbot-cmd-input/);
  const duplicate = commandsOf(format).filter((command, index, all) => all.indexOf(command) !== index);

  assert.deepEqual(duplicate, [], 'keyboard commands are deduplicated');
});

test('command cards attach buttons only where the caller declares them', () => {
  const card = commandBubble('第一行\n第二行', '标题', { platform: 'qq-bot', actions: [{ label: '额度', command: '/额度' }] });

  assert.equal(card.value[0].type, 'Markdown');
  assert.deepEqual(commandsOf(card), ['/额度']);
  assert.match(createMarkdownText(card.value[0].value, 'group'), /qqbot-cmd-input text="\/额度"/);

  const plain = commandBubble('第一行\n第二行', '标题', { platform: 'onebot', actions: [{ label: '额度', command: '/额度' }] });

  assert.equal(plain.value.length, 1, 'OneBot keeps a single text card without keyboard payloads');
  assert.equal(plain.value[0].type, 'Markdown');
  assert.doesNotMatch(createMarkdownText(plain.value[0].value, 'group'), /qqbot-cmd-input/);
  assert.equal(commandBubble('已取消。', '状态').value[0].type, 'Text');
});

test('declared actions are deduplicated and capped', () => {
  const card = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
    actions: [
      { label: '人格', command: '/人格' },
      { label: '使用编辑器', command: '/人格 使用 编辑器' },
      { label: '重复', command: '/人格 使用 编辑器' }
    ]
  });

  assert.deepEqual(commandsOf(card), ['/人格', '/人格 使用 编辑器'], 'both intents survive, the exact duplicate does not');

  const capped = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
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
    assert.match(rendered, /qqbot-cmd-input/);
    for (const action of actions) {
      assert.ok(copy.includes(action.command), `copy must mention ${action.command}`);
      assert.ok(commandsOf(format).includes(action.command), `keyboard must expose ${action.command}`);
      assert.ok(Array.from(action.label).length <= 4, `label ${action.label} stays short`);
    }
    assert.ok(commandsOf(format).includes(isPrivate ? '/个人密钥 绑定' : '/群密钥 绑定'), 'the first step is one tap away');
  }

  const plain = noticeBubble(insufficientBudgetHelp(false), { platform: 'onebot', title: '额度不足', actions: budgetNoticeActions(false) });

  assert.equal(plain.value.length, 1);
  assert.equal(plain.value[0].type, 'Markdown', 'OneBot still gets the guidance without keyboard payloads');
});
