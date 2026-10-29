import test from 'node:test';
import assert from 'node:assert/strict';
import { hasStickerIntent, selectIntentSticker, needsTextSupplement } from '../lib/companion/expression.js';
const stickers = [
  { id: 'morning', name: '早', tags: ['早安'] },
  { id: 'laugh', name: '笑出眼泪', tags: ['笑'] },
  { id: 'hug', name: '抱一下', tags: ['安慰'] },
  { id: 'here', name: '在呢', tags: ['招呼'] },
  { id: 'generic', name: '无关表情', tags: ['日常'] }
];

test('short natural social turns can be completed by a relevant sticker without redundant text', () => {
  for (const [input, reply, expected] of [
    ['早安', '早呀', 'morning'],
    ['哈哈哈', '笑死', 'laugh'],
    ['我好难过', '抱抱', 'hug'],
    ['肥鱼在吗', '在呢', 'here']
  ]) {
    assert.equal(hasStickerIntent(input), true, input);
    assert.equal(selectIntentSticker(stickers, input)?.id, expected, input);
    assert.equal(needsTextSupplement(input, reply), false, input);
  }
});

test('a matching mood or greeting cannot suppress substantive information or respond to quoted events', () => {
  for (const input of ['他说“早安”', '不要再说晚安了', '怎么安慰难过的人', '我不难过']) assert.equal(hasStickerIntent(input), false, input);
  assert.equal(selectIntentSticker([stickers.at(-1)], '哈哈哈'), undefined);
  assert.equal(needsTextSupplement('肥鱼在吗，帮我看报错', '需要补充日志'), true);
  assert.equal(needsTextSupplement('肥鱼在吗', '服务器已经恢复了'), true);
  assert.equal(needsTextSupplement('哈哈哈', '因为配置错误，需要重启'), true);
  assert.equal(needsTextSupplement('今天配置终于成功了，好耶', '下一步检查连接'), true);
});

test('automatic stickers avoid the last three successful images within a conversation for 30 minutes', async () => {
  const { recordExpressionSticker, freshExpressionStickers } = await import('../lib/companion/expression.js');
  const scope = 'test-recent-stickers';
  const now = 1000;
  recordExpressionSticker(scope, 'morning', now);
  assert.equal(selectIntentSticker(freshExpressionStickers(stickers, scope, now), '早安'), undefined);
  assert.equal(selectIntentSticker(freshExpressionStickers(stickers, 'another-conversation', now), '早安')?.id, 'morning');
  assert.equal(selectIntentSticker(freshExpressionStickers(stickers, scope, now + 30 * 60_000), '早安')?.id, 'morning');
  for (const id of ['morning', 'laugh', 'hug', 'here']) recordExpressionSticker(scope, id, now);
  assert.deepEqual(
    freshExpressionStickers(stickers, scope, now).map(item => item.id),
    ['morning', 'generic']
  );
});
