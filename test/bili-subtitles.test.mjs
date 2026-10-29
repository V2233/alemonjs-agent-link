import test from 'node:test';
import assert from 'node:assert/strict';
import { subtitleExcerpt } from '../lib/bili/subtitles.js';

test('subtitle excerpts preserve actual timestamps without inventing missing or invalid timing', () => {
  const result = subtitleExcerpt([
    { from: 1.2, to: 3.4, content: '鲸鱼歌声' },
    { content: '没有时间' },
    { from: 6, to: 5, content: '无效时间' },
    { from: -1, to: 1, content: '负时间' }
  ]);
  assert.deepEqual(result.segments[0], { from: 1.2, to: 3.4, text: '鲸鱼歌声' });
  assert.ok(result.segments.slice(1).every(row => row.from === null && row.to === null));
  assert.equal(result.truncated, false);
  assert.equal(result.text, '鲸鱼歌声 没有时间 无效时间 负时间');
});

test('subtitle budgets expose truncation and never split a Unicode character', () => {
  const long = subtitleExcerpt([{ from: 0, to: 600, content: '🐟'.repeat(400) }]);
  assert.equal(Array.from(long.text).length, 300);
  assert.equal(long.truncated, true);
  const many = subtitleExcerpt(Array.from({ length: 500 }, (_, n) => ({ from: n, to: n + 1, content: '字幕' })));
  assert.equal(many.segments.length, 120);
  assert.equal(many.truncated, false);
  assert.equal(many.segmentsTruncated, true);
  assert.equal(many.text.split(' ').length, 500);
  const chars = subtitleExcerpt(Array.from({ length: 100 }, (_, n) => ({ from: n, to: n + 1, content: '字'.repeat(300) })));
  assert.ok(Array.from(chars.text).length <= 6000);
  assert.equal(chars.truncated, true);
  assert.deepEqual(subtitleExcerpt(null), { text: '', segments: [], truncated: false, segmentsTruncated: false });
});
