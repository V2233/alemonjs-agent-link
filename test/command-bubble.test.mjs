import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, ResultCode } from 'alemonjs';
import { helpFormat } from '../lib/response/agent-help/res.js';
import { commandBubble, noticeBubble, sectionBubble, KEYBOARD_LABELS } from '../lib/response/bubble.js';
import { insufficientBudgetHelp, budgetNoticeActions } from '../lib/billing/help.js';
const { createMarkdownText } = await import(new URL('./format.js', import.meta.resolve('@alemonjs/qq-bot')));
const { GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE } = await import(new URL('./sends.js', import.meta.resolve('@alemonjs/qq-bot')));
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

test('help index uses one inline button per topic without a keyboard bar', () => {
  const format = helpFormat(false, false);
  const rendered = createMarkdownText(format.value[0].value, 'group');
  assert.deepEqual(commandsOf(format), []);
  for (const topic of ['聊天', '记忆', '人格', '群设置', '媒体', '额度', '数据']) {
    assert.match(rendered, new RegExp(`qqbot-cmd-input text="/帮助 ${topic}"`));
  }
  assert.doesNotMatch(rendered, /\/帮助 管理/);
  assert.doesNotMatch(rendered, /qqbot-cmd-enter/);
  assert.ok(rendered.length < 3500);
  const plain = helpFormat(true, true, '', 'onebot').value;
  assert.equal(plain[0].type, 'Text');
  assert.match(plain[0].value, /\/帮助 管理/);
  assert.doesNotMatch(plain[0].value, /\/帮助 群设置/);
});

test('help topic details link back to the feature and the help index', () => {
  const chat = createMarkdownText(helpFormat(false, false, '聊天').value[0].value, 'group');
  assert.match(chat, /qqbot-cmd-input text="\/提问"/);
  assert.match(chat, /qqbot-cmd-input text="\/新会话"/);
  assert.match(chat, /qqbot-cmd-input text="\/帮助"/);

  const quota = createMarkdownText(helpFormat(true, true, '额度').value[0].value, 'group');
  assert.match(quota, /qqbot-cmd-input text="\/我的钥匙"/);
  assert.match(quota, /qqbot-cmd-input text="\/个人登录"/);

  const settings = createMarkdownText(helpFormat(false, false, '群设置').value[0].value, 'group');
  assert.match(settings, /qqbot-cmd-input text="\/群设置"/);

  const media = createMarkdownText(helpFormat(false, false, '媒体').value[0].value, 'group');
  assert.match(media, /qqbot-cmd-input text="\/语音"/);
  assert.match(media, /qqbot-cmd-input text="\/表情"/);
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
  for (const topic of ['聊天', '记忆', '人格', '群设置', '媒体', '额度', '数据']) {
    assert.match(rendered, new RegExp(`qqbot-cmd-input text="/帮助 ${topic}"`));
  }
  assert.doesNotMatch(rendered, /\/帮助 管理/);
});

test('command cards always use inline Markdown; only link or choice keeps the keyboard', () => {
  const inlineCard = commandBubble('第一行\n第二行', '标题', { platform: 'qq-bot', actions: [{ label: '额度', command: '/额度' }] });

  assert.equal(inlineCard.value[0].type, 'Markdown');
  assert.deepEqual(commandsOf(inlineCard), [], 'a command never creates a keyboard bar');
  assert.match(createMarkdownText(inlineCard.value[0].value, 'group'), /qqbot-cmd-input text="\/额度"/);

  const explicitKeyboard = commandBubble('第一行\n第二行', '标题', {
    platform: 'qq-bot',
    layout: 'keyboard',
    actions: [{ label: '额度', command: '/额度' }]
  });

  assert.deepEqual(commandsOf(explicitKeyboard), [], 'legacy keyboard layout is downgraded for commands');
  assert.match(createMarkdownText(explicitKeyboard.value[0].value, 'group'), /qqbot-cmd-input text="\/额度"/);

  const menuCard = commandBubble('第一行\n第二行', '标题', {
    platform: 'qq-bot',
    actions: [
      { label: '额度', command: '/额度' },
      { label: '状态', command: '/状态' },
      { label: '帮助', command: '/帮助' },
      { label: '新会话', command: '/新会话' }
    ]
  });

  assert.deepEqual(commandsOf(menuCard), [], 'multi-entry command menu is inline too');
  const menuMarkdown = createMarkdownText(menuCard.value[0].value, 'group');
  for (const command of ['/额度', '/状态', '/帮助', '/新会话']) assert.ok(menuMarkdown.includes(`qqbot-cmd-input text="${command}"`));

  const linkCard = commandBubble('第一行\n第二行', '标题', {
    platform: 'qq-bot',
    actions: [{ label: '打开官网', url: 'https://example.com' }]
  });
  assert.deepEqual(commandsOf(linkCard), []);
  assert.match(createMarkdownText(linkCard.value[0].value, 'group'), /https:\/\/example.com/);
  assert.doesNotMatch(createMarkdownText(linkCard.value[0].value, 'group'), /qqbot-cmd-input/);

  const choiceCard = commandBubble('第一行\n第二行', '标题', {
    platform: 'qq-bot',
    actions: [
      { label: '确认', command: '/确认', choice: 'binary' },
      { label: '取消', command: '/取消', choice: 'binary' }
    ]
  });
  assert.deepEqual(commandsOf(choiceCard), []);
  assert.match(createMarkdownText(choiceCard.value[0].value, 'group'), /qqbot-cmd-input/);

  const plain = commandBubble('第一行\n第二行', '标题', { platform: 'onebot', actions: [{ label: '额度', command: '/额度' }] });

  assert.equal(plain.value.length, 1, 'OneBot keeps a single text card without keyboard payloads');
  assert.equal(plain.value[0].type, 'Markdown');
  assert.doesNotMatch(createMarkdownText(plain.value[0].value, 'group'), /qqbot-cmd-input/);
  assert.equal(commandBubble('已取消。', '状态').value[0].type, 'Text');
});

test('declared command actions are deduplicated and inline-capped', () => {
  const card = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
    actions: [
      { label: '人格', command: '/人格' },
      { label: '使用编辑器', command: '/人格 使用 编辑器' },
      { label: '重复', command: '/人格 使用 编辑器' }
    ]
  });
  const rendered = createMarkdownText(card.value[0].value, 'group');

  assert.match(rendered, /qqbot-cmd-input text="\/人格"/);
  assert.match(rendered, /qqbot-cmd-input text="\/人格 使用 编辑器"/);
  assert.equal((rendered.match(/qqbot-cmd-input text="\/人格 使用 编辑器"/gu) || []).length, 1, 'exact duplicate is dropped');

  const capped = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
    actions: Array.from({ length: 14 }, (_, index) => ({ label: `项目${index}`, command: `/记忆检索 关键词${index}` }))
  });
  assert.equal((createMarkdownText(capped.value[0].value, 'group').match(/qqbot-cmd-input/gu) || []).length, 10, 'inline commands are capped at 10');

  const links = commandBubble('说明\n更多', '标题', {
    platform: 'qq-bot',
    actions: Array.from({ length: 14 }, (_, index) => ({ label: `链接${index}`, url: `https://example.com/${index}` }))
  });
  assert.equal(commandsOf(links).length, 0);
  assert.equal((createMarkdownText(links.value[0].value, 'group').match(/https:\/\/example.com/gu)||[]).length, 10);
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
    assert.ok(rendered.includes(`qqbot-cmd-input text="${isPrivate ? '/我的钥匙 私聊' : '/我的钥匙'}"`), 'the first step is one tap away');
  }

  const plain = noticeBubble(insufficientBudgetHelp(false), { platform: 'onebot', title: '额度不足', actions: budgetNoticeActions(false) });

  assert.equal(plain.value.length, 1);
  assert.equal(plain.value[0].type, 'Markdown', 'OneBot still gets the guidance without keyboard payloads');
  assert.doesNotMatch(createMarkdownText(plain.value[0].value, 'group'), /qqbot-cmd-input/);
});

test('section cards inline commands but keep link and choice keyboards', () => {
  const inline = sectionBubble(
    '标题',
    '说明',
    [
      { title: '第一项', text: '', actions: [{ label: '额度', command: '/额度' }] },
      { title: '第二项', text: '', actions: [{ label: '状态', command: '/状态' }] }
    ],
    { platform: 'qq-bot' }
  );

  assert.deepEqual(commandsOf(inline), []);
  const rendered = createMarkdownText(inline.value[0].value, 'group');
  assert.match(rendered, /qqbot-cmd-input text="\/额度"/);
  assert.match(rendered, /qqbot-cmd-input text="\/状态"/);

  const link = sectionBubble('标题', '说明', [{ title: '第一项', text: '', actions: [{ label: '打开官网', url: 'https://example.com' }] }], {
    platform: 'qq-bot'
  });
  assert.deepEqual(commandsOf(link), []);
  assert.doesNotMatch(createMarkdownText(link.value[0].value, 'group'), /qqbot-cmd-input/);
});

test('mixed links and commands stay with their own item, without any keyboard bar', () => {
  const card = sectionBubble('列表','',[
    {title:'第一项',text:'第一项说明',actions:[{label:'详情',command:'/详情 一'},{label:'官网',url:'https://example.com/one'}]},
    {title:'第二项',text:'第二项说明',actions:[{label:'编辑',command:'/编辑 二',choice:'binary'}]}
  ],{platform:'qq-bot',actions:[{label:'返回',command:'/帮助'}]});
  const output=createMarkdownText(card.value[0].value,'group');
  assert.deepEqual(keyboardOf(card),[]);
  assert.ok(output.indexOf('/详情 一') < output.indexOf('第二项说明'));
  assert.ok(output.indexOf('example.com/one') < output.indexOf('第二项说明'));
  assert.ok(output.indexOf('/编辑 二') > output.indexOf('第二项说明'));
  assert.ok(output.indexOf('/帮助') > output.indexOf('/编辑 二'));
});

test('plain platforms retain copyable actions and paginated lists keep all items reachable', () => {
  const sections=Array.from({length:12},(_,i)=>({title:`条目${i+1}`,text:'内容',actions:[{label:'详情',command:`/详情 ${i+1}`}]}));
  const card=sectionBubble('列表','',sections,{platform:'onebot',page:{current:2,size:5,command:'/列表'}});
  const output=createMarkdownText(card.value[0].value,'group');
  assert.match(output,/第 2\/3 页/);
  assert.match(output,/详情：\/详情 6/);
  assert.match(output,/上一页：\/列表 1/);
  assert.match(output,/下一页：\/列表 3/);
  assert.doesNotMatch(output,/条目11|qqbot-cmd-input/);
  assert.deepEqual(keyboardOf(card),[]);
  const last=sectionBubble('列表','',sections,{platform:'qq-bot',page:{current:999,size:5,command:'/列表'}});
  assert.match(createMarkdownText(last.value[0].value,'group'),/条目12/);
});

test('every help topic uses readable sections and respects private owner boundaries', () => {
  for (const isPrivate of [false, true]) {
    for (const owner of [false, true]) {
      for (const topic of ['聊天', '记忆', '人格', '群设置', '媒体', '数据', '管理']) {
        const format = helpFormat(isPrivate, owner, topic);
        const markdown = createMarkdownText(format.value[0].value, isPrivate ? 'private' : 'group');
        assert.equal(format.value.length, 1);
        assert.ok(markdown.length < 4000, `${topic} must fit a readable topic card`);
        assert.doesNotMatch(markdown, /开启\|关闭|名称\|提示词|\[页码\]|编号等字样/);
        assert.match(markdown, /qqbot-cmd-input text="\/帮助"/);
        assert.deepEqual(keyboardOf(format), []);
        if (!owner) assert.doesNotMatch(markdown, /\/语音引擎|\/表情 帮助|\/清除群数据/);
        if (!(isPrivate && owner)) assert.doesNotMatch(markdown, /\/主动搭话|\/额度轮转/);
        const plain = helpFormat(isPrivate, owner, topic, 'onebot').value;
        assert.equal(plain[0].type, 'Text');
        assert.doesNotMatch(plain[0].value, /开启\|关闭|名称\|提示词|\[页码\]/);
      }
    }
  }
});
