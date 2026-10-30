import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import router from '../lib/router.js';

// AlemonJS normalizes inbound text before routing, so a stray leading space must
// never turn a slash command into group chatter (or into a silent drop). The router
// also disables the framework fallback, which used to add a bogus "我猜你想用的是"
// line on top of every command that carries arguments.
const mountRouter = async () => {
  const app = createTestApp({ config: {}, failOnError: false });

  await app.mount({ response: router });

  return app;
};

const groupEvent = (MessageText, index) => ({
  name: 'message.create',
  Platform: 'qq-bot',
  IsPrivate: false,
  IsMaster: true,
  IsAdmin: true,
  IsBot: false,
  ChannelId: 'group-leading-space',
  GuildId: 'group-leading-space',
  UserId: `owner-${index}`,
  UserName: '柠檬冲水',
  MessageId: `group-leading-space-${index}`,
  MessageText
});

const privateEvent = (MessageText, index) => ({
  name: 'private.message.create',
  Platform: 'qq-bot',
  IsPrivate: true,
  IsMaster: true,
  IsBot: false,
  UserId: `owner-private-${index}`,
  UserName: '柠檬冲水',
  MessageId: `private-leading-space-${index}`,
  MessageText
});

const texts = result => result.messages.map(message => message.text);

test('a leading space never changes how a group slash command is routed', async () => {
  const app = await mountRouter();

  try {
    const variants = ['/帮助 管理', ' /帮助 管理', '\u3000/帮助 管理', '\t/帮助 管理', '\n/帮助 管理 ', '  /帮助 管理  '];
    const replies = [];

    for (const [index, MessageText] of variants.entries()) {
      replies.push(texts(await app.dispatch(groupEvent(MessageText, index))));
    }

    const [first, ...rest] = replies;

    for (const reply of rest) {
      assert.deepEqual(reply, first, 'leading whitespace must not change the reply set');
    }
    assert.equal(first.length, 1, `a routed command answers exactly once, got: ${JSON.stringify(first)}`);
    assert.ok(first[0].includes('请机器人主人私聊查看管理说明。'), `group reply must include the owner-private hint, got: ${JSON.stringify(first)}`);
  } finally {
    await app.unmount('main');
  }
});

test('a leading space still unlocks the owner help topics in private chat', async () => {
  const app = await mountRouter();

  try {
    for (const [index, MessageText] of ['/帮助 管理', ' /帮助 管理', '\u3000/帮助 管理'].entries()) {
      const reply = texts(await app.dispatch(privateEvent(MessageText, index)));

      assert.equal(reply.length, 1, `${JSON.stringify(MessageText)} must answer exactly once, got: ${JSON.stringify(reply)}`);
      assert.ok(reply[0].includes('/关闭 原因'), `${JSON.stringify(MessageText)} must reach the owner topic, got: ${JSON.stringify(reply)}`);
      assert.ok(!reply[0].includes('管理说明请主人私聊'), 'private owner help must not fall back to the group hint');
    }
  } finally {
    await app.unmount('main');
  }
});

test('a routed command with arguments never gets a "did you mean" suggestion', async () => {
  const app = await mountRouter();

  try {
    for (const [index, MessageText] of ['/帮助 管理', '/帮助 全部', '/人格 使用 1'].entries()) {
      const reply = texts(await app.dispatch(groupEvent(MessageText, index + 10)));

      assert.ok(reply.length > 0, `${JSON.stringify(MessageText)} must be answered`);
      for (const text of reply) assert.ok(!text.includes('我猜你想用的是'), `${JSON.stringify(MessageText)} must not add a suggestion, got: ${JSON.stringify(reply)}`);
    }
  } finally {
    await app.unmount('main');
  }
});

test('text without a command prefix stays out of the command router even when padded', async () => {
  const app = await mountRouter();

  try {
    for (const [index, MessageText] of ['帮助 管理', ' 帮助 管理', '　帮助 管理'].entries()) {
      const reply = texts(await app.dispatch(groupEvent(MessageText, index + 20)));

      assert.ok(
        !reply.some(text => text.includes('管理说明请主人私聊发送')),
        `${JSON.stringify(MessageText)} must not run the help command, got: ${JSON.stringify(reply)}`
      );
    }
  } finally {
    await app.unmount('main');
  }
});

test('module commands in a group reach the private-owner guidance instead of falling through', async () => {
  const app = await mountRouter();
  try {
    for (const command of ['/模块状态', '/agentmodules']) {
      const result = await app.dispatch(groupEvent(command, command));
      assert.equal(result.errors.length, 0);
      const replies = texts(result);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /模块管理仅限机器人主人私聊/);
    }
  } finally { await app.dispose(); }
});

test('public key guidance aliases in groups explain the private entry', async () => {
  const app = await mountRouter();
  try {
    for (const key of ['密钥配置', '移除密钥', 'agentbind', 'agentunbind']) {
      const result = await app.dispatch(groupEvent(`/${key}`, key));
      assert.equal(result.errors.length, 0);
      assert.equal(result.messages.length, 1);
      assert.match(texts(result).join(''), /私聊查看指引/);
    }
  } finally { await app.dispose(); }
});
