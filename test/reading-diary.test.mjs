import test from 'node:test';
import assert from 'node:assert/strict';
import { readingDiary, formatReadingDiary } from '../lib/bili/diary.js';
const now = Date.parse('2026-10-29T12:00:00+08:00');
const entry = changes => ({
  id: 'a',
  status: 'active',
  origin: 'event',
  kind: 'event',
  tags: ['B站'],
  createdAt: now,
  text: '我读取了 B 站视频资料：{"title":"鲸鱼歌声","bvid":"BV1234567890"}。',
  ...changes
});

test('diary separates readings, reflections and legacy thoughts without inventing activity', () => {
  const items = [
    entry({}),
    entry({ id: 'b', origin: 'diary', kind: 'diary', text: '阅读后生成的想法：{"title":"鲸鱼歌声","thought":"想继续了解"}' }),
    entry({ id: 'legacy', tags: ['B站', '阅读感想'], text: '旧版想法没有结构化字段' }),
    entry({ id: 'old', createdAt: now - 25 * 3600000 }),
    entry({ id: 'future', createdAt: now + 1 }),
    entry({ id: 'other', tags: ['其他'] }),
    entry({ id: 'outdated', status: 'outdated' })
  ];
  const rows = readingDiary(items, 24, now);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(item => item.id === 'b').type, 'reflection');
  assert.equal(rows.find(item => item.id === 'legacy').type, 'reflection');
  assert.equal(rows.find(item => item.id === 'a').bvid, 'BV1234567890');
  const text = formatReadingDiary(rows, 24, 'Asia/Shanghai');
  assert.match(text, /想继续了解/);
  assert.match(text, /不代表已发送/);
  assert.match(text, /2026/);
  assert.match(formatReadingDiary([], 24, 'UTC'), /不代表从未浏览/);
});

test('display is bounded and malformed metadata falls back to existing evidence', () => {
  const rows = readingDiary(
    Array.from({ length: 20 }, (_, id) => entry({ id: String(id), text: '格式不完整 {bad' })),
    24,
    now
  );
  const text = formatReadingDiary(rows, 24, 'UTC');
  assert.match(text, /5\/20/);
  assert.equal(text.match(/格式不完整/g).length, 5);
  assert.ok(!text.includes('undefined'));
});

test('keyword lookup finds older entries before display limits and preserves reading versus reflection', async () => {
  const { searchReadingDiary } = await import('../lib/bili/diary.js');
  const rows = Array.from({ length: 30 }, (_, n) => ({
    id: String(n),
    at: now - n,
    type: n === 29 ? 'reflection' : 'reading',
    title: n === 29 ? '鲸鱼歌声' : '普通记录',
    text: n === 29 ? '对歌声的想法' : '无关内容',
    bvid: n === 29 ? 'BV1234567890' : undefined
  }));
  assert.equal(searchReadingDiary(rows, '鲸鱼')[0].id, '29');
  assert.equal(searchReadingDiary(rows, '鲸鱼')[0].type, 'reflection');
  assert.equal(searchReadingDiary(rows, 'ｂｖ１２３４５６７８９０')[0].id, '29');
  assert.equal(searchReadingDiary(rows, '不存在').length, 0);
  assert.equal(searchReadingDiary(rows, '').length, 30);
});

test('reading continuity retrieves related past thoughts without treating reading facts as opinions', async () => {
  const { readingContinuity } = await import('../lib/bili/diary.js');
  const rows = [
    entry({
      id: 'thought',
      origin: 'diary',
      kind: 'diary',
      createdAt: now - 48 * 3600000,
      text: '想法：{"title":"鲸鱼歌声","thought":"还不清楚鲸鱼如何交流"}'
    }),
    entry({ id: 'unrelated', origin: 'diary', kind: 'diary', text: '想法：{"title":"游戏","thought":"想试试建造"}' }),
    entry({ id: 'reading' }),
    entry({ id: 'too-old', origin: 'diary', kind: 'diary', createdAt: now - 8 * 86400000 })
  ];
  const result = readingContinuity(rows, '鲸鱼', now);
  assert.deepEqual(
    result.map(item => item.id),
    ['thought']
  );
  assert.equal(result[0].thought, '还不清楚鲸鱼如何交流');
  assert.equal(result[0].recordedAt, new Date(now - 48 * 3600000).toISOString());
});

test('journal retains a validated source identifier when available', () => {
  const rows = readingDiary([entry({ origin: 'diary', kind: 'diary', tags: ['B站', 'reading:abcdef123456'] })], 24, now);
  assert.equal(rows[0].sourceReadingId, 'abcdef123456');
});

test('a comparative thought retains every source and remains searchable by either video', async () => {
  const { searchReadingDiary } = await import('../lib/bili/diary.js');
  const rows = readingDiary(
    [
      entry({
        origin: 'diary',
        kind: 'diary',
        tags: ['B站', 'reading:abcdef123456', 'reading:123456abcdef'],
        text: '想法：{"title":"综合想法","readings":[{"title":"鲸鱼歌声","bvid":"BV1234567890"},{"title":"海洋生态","bvid":"BVabcdefghij"}],"thought":"两条资料关注点不同"}'
      })
    ],
    24,
    now
  );
  assert.equal(rows[0].sourceReadingId, undefined);
  assert.equal(rows[0].sourceReadingIds.length, 2);
  assert.equal(searchReadingDiary(rows, '海洋生态').length, 1);
  assert.equal(searchReadingDiary(rows, 'BV1234567890').length, 1);
  assert.match(formatReadingDiary(rows, 24, 'UTC'), /BVabcdefghij/);
});
