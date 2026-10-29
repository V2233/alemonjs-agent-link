import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPerceptionContext } from '../lib/social/perception-context.js';

test('busy chat retains bot anchor within a larger bounded window', () => {
  const now = 1000000;
  const bot = { at: now - 10000, speaker: '__bot__', text: '你想去哪座城市？' };
  const recent = Array.from({ length: 100 }, (_, i) => ({ at: now - 1000 + i, speaker: 'other', text: `群聊${i}` }));
  const result = selectPerceptionContext(recent, bot, new Set(['群聊99']), now);
  assert.equal(result.length, 40);
  assert.deepEqual(result[0], bot);
  assert.equal(result.at(-1).text, '群聊98');
});

test('expired bot reply is not resurrected and duplicate anchors are omitted', () => {
  const now = 1000000;
  const bot = { at: now - 1000, speaker: '__bot__', text: '长'.repeat(1000) };
  assert.equal(selectPerceptionContext([bot], bot, new Set(), now).length, 1);
  assert.equal(selectPerceptionContext([bot], bot, new Set(), now)[0].text.length, 400);
  assert.deepEqual(selectPerceptionContext([], { ...bot, at: now - 1800000 }, new Set(), now), []);
});

test('character budget preserves bot anchor and bounds selected text', () => {
  const bot = { at: 10, speaker: '__bot__', text: 'a'.repeat(800) };
  const lines = Array.from({ length: 50 }, (_, i) => ({ at: i + 20, speaker: 'user', text: 'b'.repeat(400) }));
  const result = selectPerceptionContext(lines, bot, new Set(), 100, { maxMessages: 40, windowSeconds: 1800, maxChars: 1000 });
  assert.equal(
    result.reduce((sum, item) => sum + item.text.length, 0),
    1000
  );
  assert.equal(result[0].speaker, '__bot__');
});
