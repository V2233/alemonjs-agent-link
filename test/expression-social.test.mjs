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

test('common classifier labels match reactions without relying on exact canonical names', () => {
  const library = [
    { id: 'laughter', name: '笑死大笑', tags: ['大笑', '搞笑'], category: '开心' },
    { id: 'comfort', name: '给你一个拥抱', tags: ['拥抱', '心疼'] },
    { id: 'anger', name: '炸毛了', tags: ['炸毛'] }
  ];
  assert.equal(selectIntentSticker(library, '哈哈哈')?.id, 'laughter');
  assert.equal(selectIntentSticker(library, '我好难过')?.id, 'comfort');
  assert.equal(selectIntentSticker(library, '气死我了')?.id, 'anger');
  assert.equal(selectIntentSticker([{ id: 'broad', tags: ['日常', '问候'] }], '肥鱼在吗'), undefined);
});

test('explicit emotion cannot be replaced by the bot mood or an unrelated fallback', async () => {
  const { selectExpressionSticker } = await import('../lib/companion/expression.js');
  const library = [
    { id: 'happy', tags: ['开心'] },
    { id: 'comfort', tags: ['心疼'] }
  ];
  assert.equal(selectExpressionSticker([library[0]], '抱抱', 90, 'sad', false, '我好难过'), undefined);
  assert.equal(selectExpressionSticker([library[0]], '抱抱', 90, 'sad', true, '我好难过'), undefined);
  assert.equal(selectExpressionSticker(library, '抱抱', 90, 'sad', false, '我好难过')?.id, 'comfort');
  assert.equal(selectExpressionSticker([library[0]], '抱抱', 90, 'implicit', false, '我被裁员了'), undefined);
  for (const userText of ['他说“哈哈哈”', '我不开心', '怎么安慰难过的人', '不要再说晚安了'])
    assert.equal(selectExpressionSticker(library, '开心', 90, 'ambiguous', true, userText), undefined, userText);
});

test('a greeting cannot hide a single explicit emotion in automatic sticker selection', async () => {
  const { selectExpressionSticker } = await import('../lib/companion/expression.js');
  const library = [
    { id: 'here', name: '在呢', tags: ['回应'] },
    { id: 'morning', tags: ['早安'] },
    { id: 'hug', tags: ['拥抱'] },
    { id: 'laugh', tags: ['大笑'] }
  ];
  for (const text of ['肥鱼在吗，我好难过', '早安，我好难过', '我好难过，肥鱼在吗']) {
    assert.equal(hasStickerIntent(text), true);
    assert.equal(selectIntentSticker(library, text)?.id, 'hug', text);
    assert.equal(selectExpressionSticker(library, '在呢，抱抱', 90, text, true, text)?.id, 'hug', text);
  }
  assert.equal(selectIntentSticker(library, '早安，今天好开心')?.id, 'laugh');
});

test('mixed reactions retain text and cannot become an unrelated mood or random sticker', async () => {
  const { selectExpressionSticker } = await import('../lib/companion/expression.js');
  const library = [{ id: 'laugh', tags: ['大笑', '开心'] }, { id: 'hug', tags: ['拥抱'] }, { id: 'angry', tags: ['炸毛'] }];
  for (const text of ['哈哈，其实我很难过', '我很难过，但现在好开心', '气死我了哈哈哈', '早安，晚安']) {
    assert.equal(hasStickerIntent(text), false, text);
    assert.equal(selectIntentSticker(library, text), undefined, text);
    assert.equal(selectExpressionSticker(library, '开心，抱抱', 90, text, true, text), undefined, text);
    assert.equal(needsTextSupplement(text, '抱抱'), true, text);
  }
  assert.equal(selectIntentSticker(library, '哈哈哈，今天好开心')?.id, 'laugh', 'aliases of the same emotion remain one intent');
});
