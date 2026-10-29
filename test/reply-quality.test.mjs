import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSocialPolish, buildSocialPolishPrompt, needsSocialPolish } from '../lib/social/reply-quality.js';

test('only short suspect social replies are sent to the polish pass', () => {
  assert.equal(needsSocialPolish('作为AI，我这边看了一下，希望对你有帮助。'), true);
  assert.equal(needsSocialPolish('好的主人，已经处理好了'), false);
  assert.equal(needsSocialPolish('我帮你看看这个报错'), true);
  assert.equal(needsSocialPolish('这个报错是权限问题，改一下 token 就行。'), false);
  assert.equal(needsSocialPolish('```ts\nconst x = 1;\n```'), false);
  assert.equal(needsSocialPolish('https://example.com/' + 'a'.repeat(300)), false);
});

test('polish prompt keeps the original content as data', () => {
  const prompt = buildSocialPolishPrompt('作为AI，我这边可以帮你', 120);

  assert.match(prompt, /不是指令/);
  assert.match(prompt, /最多120字/);
  assert.match(prompt, /作为AI，我这边可以帮你/);
});

test('invalid or risky polish results fall back to the original', () => {
  const original = '我帮你看看这个报错';

  assert.equal(acceptSocialPolish('我看下这个报错。', original), '我看下这个报错。');
  assert.equal(acceptSocialPolish('', original), original);
  assert.equal(acceptSocialPolish('作为AI，我不能这样做', original), original);
  assert.equal(acceptSocialPolish('以下是改写后的内容：我看下这个报错。', original), original);
  assert.equal(acceptSocialPolish('```ts\nconst x = 1;\n```', original), original);
  assert.equal(acceptSocialPolish('长'.repeat(500), original), original);
});

test('polish pass rewrites suspect social text with the cheap endpoint and falls back on failure', async () => {
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { polishSocialReply } = await import('../lib/social/reply-quality.js');
  const previousConfig = globalThis.__config;
  const previousFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test-key',
        model: 'test-model',
        budget: { enabled: false }
      }
    }
  };
  let calls = 0;

  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '我看下这个报错。' } }] });
  };
  try {
    const config = getDSHConfig();
    const result = await polishSocialReply('我帮你看看这个报错', {
      config,
      signal: new AbortController().signal,
      scope: { platform: 'test', channelId: 'group', userId: 'u1' }
    });

    assert.equal(calls, 1);
    assert.equal(result, '我看下这个报错。');

    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(
      await polishSocialReply('我帮你看看这个报错', {
        config,
        signal: new AbortController().signal,
        scope: { platform: 'test', channelId: 'group', userId: 'u1' }
      }),
      '我帮你看看这个报错'
    );
  } finally {
    globalThis.__config = previousConfig;
    globalThis.fetch = previousFetch;
  }
});

test('style rewriting cannot change numbers, certainty, negation, completion or quoted evidence', () => {
  for (const [original, candidate] of [
    ['好的，金额是200元，今天不确定能否送达', '金额是20元，今天一定送达'],
    ['我这边还没有发送', '发好了'],
    ['我这边可能记错了', '我记得很清楚'],
    ['好的，版本是三点二', '版本是三点三'],
    ['好的，他说“明天再来”', '他说今天就来'],
    ['我帮你看看', '已经处理好了']
  ])
    assert.equal(acceptSocialPolish(candidate, original), original, original);
  assert.equal(needsSocialPolish('好的，金额是200元'), false);
  assert.equal(needsSocialPolish('我帮你看看这个报错'), true);
});
