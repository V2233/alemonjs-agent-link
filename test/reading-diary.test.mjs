import test from 'node:test';
import assert from 'node:assert/strict';
import { readingDiary, formatReadingDiary, readingSupport, parseReadingReflection, readingContinuity } from '../lib/bili/diary.js';
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

test('reading support comes from valid source scope rather than a diary claiming sensory or audience facts', () => {
  const source = details => entry({ text: JSON.stringify({ contentBasis: 'audio_excerpt', audioStatus: 'available', audioTranscribed: true, transcribedRange: [0, 8], commentStatus: 'available', ...details }) });
  for (const value of ['empty_response', 'returned_subset']) {
    const evidence = readingDiary([source({ audienceCommentScope: value })], 24, now)[0].sourceEvidence;
    assert.equal(evidence[0].audienceCommentScope, value);
    const support = readingSupport(evidence);
    assert.deepEqual(support.obtained, ['asr_excerpt_text']);
    assert.ok(support.notEstablished.includes('direct_listening'));
    assert.ok(support.notEstablished.includes('full_video_viewing'));
    assert.ok(support.notEstablished.includes('comment_absence'));
  }
  for (const details of [{}, { audienceCommentScope: 'invented' }, { audienceCommentScope: 'unavailable', commentStatus: 'available' }, { audienceCommentScope: 'returned_subset', commentStatus: 'unavailable' }])
    assert.equal(readingDiary([source(details)], 24, now)[0].sourceEvidence[0].audienceCommentScope, undefined);
  assert.equal(readingDiary([source({ commentStatus: 'unavailable', audienceCommentScope: 'unavailable' })], 24, now)[0].sourceEvidence[0].audienceCommentScope, 'unavailable');
  const legacy = readingDiary([entry({ origin: 'diary', kind: 'diary', text: '我听完整条视频，下面没人留言' })], 24, now)[0].sourceEvidence;
  assert.deepEqual(readingSupport(legacy).obtained, []);
});

test('linked reading excerpts remain bounded, source-specific and unavailable when their observation is invalid', () => {
  const details = { contentBasis: 'audio_excerpt', audioStatus: 'available', audioTranscribed: true, transcribedRange: [0, 8], audioExcerpt: '音'.repeat(150),
    visualStatus: 'available', sampledTimestamps: [2], visualExcerpt: '图'.repeat(150), commentStatus: 'available', audienceCommentScope: 'returned_subset', commentExcerpt: '评论只是一条观点' };
  const source = entry({ id: 'abcdef123456', subjectId: 'fish', text: JSON.stringify(details) });
  const thought = entry({ id: 'thought', subjectId: 'fish', origin: 'diary', kind: 'diary', tags: ['B站', 'reading:abcdef123456'], text: '我看完了，所有人都喜欢' });
  const evidence = readingDiary([source, thought], 24, now).find(row => row.id === 'thought').sourceEvidence[0];
  assert.deepEqual(evidence.excerpts.map(row => [row.kind, row.text.length]), [['asr_text', 120], ['visual_description', 80]]);
  const invalid = readingDiary([entry({ text: JSON.stringify({ ...details, audioTranscribed: false, visualStatus: 'unavailable', commentStatus: 'unavailable' }) })], 24, now)[0].sourceEvidence[0];
  assert.equal(invalid.excerpts, undefined);
  for (const change of [{ subjectId: 'other' }, { createdAt: now + 1 }, { status: 'deleted' }]) {
    const missing = readingDiary([{ ...source, ...change }, thought], 24, now).find(row => row.id === 'thought').sourceEvidence[0];
    assert.equal(missing.excerpts, undefined);
  }
  assert.equal(source.text, JSON.stringify(details), 'source and mistaken reflection are never rewritten');
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

test('recent reflections resolve older source scope before the display window and continuity retains it', async () => {
  const { readingContinuity } = await import('../lib/bili/diary.js');
  const source = entry({ id: 'abcdef123456', subjectId: 'bot', createdAt: now - 48 * 3600000,
    text: JSON.stringify({ bvid: 'BV1234567890', contentBasis: 'metadata', visualStatus: 'disabled', audioObserved: false }) });
  const thought = entry({ id: 'thought', subjectId: 'bot', origin: 'diary', kind: 'diary', tags: ['B站', 'reading:abcdef123456'],
    text: JSON.stringify({ title: '鲸鱼', thought: '视频没有讲到机制' }) });
  const rows = readingDiary([thought, source], 24, now);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].sourceEvidence, [{ id: source.id, availability: 'available', bvid: 'BV1234567890', contentBasis: 'metadata', visualScope: 'not_observed', sampledTimestamps: [], audioScope: 'not_observed' }]);
  assert.deepEqual(readingContinuity([thought, source], '鲸鱼', now)[0].sourceEvidence, rows[0].sourceEvidence);
  assert.match(formatReadingDiary(rows, 24, 'UTC'), /仅元数据/);
});

test('missing, deleted, wrong-subject, future and reflection sources never certify old thoughts', () => {
  const thought = entry({ id: 'thought', subjectId: 'bot', origin: 'diary', kind: 'diary', tags: ['B站', 'reading:abcdef123456'],
    text: JSON.stringify({ contentBasis: 'subtitles', thought: '我看了全片' }) });
  for (const changes of [null, { status: 'outdated' }, { subjectId: 'other' }, { createdAt: now + 1 }, { createdAt: now - 1, origin: 'diary', kind: 'diary' }]) {
    const sources = changes ? [entry({ id: 'abcdef123456', subjectId: 'bot', text: '{"contentBasis":"subtitles"}', ...changes })] : [];
    const result = readingDiary([thought, ...sources], 24, now).find(item => item.id === 'thought').sourceEvidence[0];
    assert.equal(result.availability, 'missing');
    assert.equal(result.contentBasis, 'unknown');
    assert.equal(result.audioScope, 'unknown');
  }
  const legacy = readingDiary([entry({ origin: 'diary', kind: 'diary', text: '我看了全片' })], 24, now)[0];
  assert.equal(legacy.sourceEvidence[0].availability, 'unlinked');
  assert.equal(legacy.sourceEvidence[0].contentBasis, 'unknown');
});

test('comparative reflections retain distinct subtitle and cropped visual evidence', () => {
  const rows = readingDiary([
    entry({ id: 'abcdef123456', text: JSON.stringify({ contentBasis: 'subtitle_excerpt', visualStatus: 'disabled' }) }),
    entry({ id: '123456abcdef', text: JSON.stringify({ contentBasis: 'sampled_frames', visualStatus: 'available', visualRegion: 'bottom_band', sampledTimestamps: [1, 3, 5, 7] }) }),
    entry({ id: 'thought', origin: 'diary', kind: 'diary', tags: ['B站', 'reading:abcdef123456', 'reading:123456abcdef'] })
  ], 24, now);
  const evidence = rows.find(item => item.id === 'thought').sourceEvidence;
  assert.equal(evidence[0].contentBasis, 'subtitle_excerpt');
  assert.equal(evidence[1].visualScope, 'bottom_band');
  assert.deepEqual(evidence[1].sampledTimestamps, [1, 3, 5, 7]);
  assert.match(formatReadingDiary(rows, 24, 'UTC'), /仅底部字幕带/);
});

test('malformed and unavailable frame evidence never becomes observed video', () => {
  for (const timestamps of [[], [-1], [null], [1, 2, 3, 4], ['1']]) {
    const evidence = readingDiary([entry({ text: JSON.stringify({ contentBasis: 'sampled_frames', visualStatus: 'available', sampledTimestamps: timestamps }) })], 24, now)[0].sourceEvidence[0];
    assert.equal(evidence.contentBasis, 'unknown');
    assert.equal(evidence.visualScope, 'unknown');
    assert.deepEqual(evidence.sampledTimestamps, []);
  }
  for (const text of ['null', '[]', '{bad']) {
    assert.equal(readingDiary([entry({ text })], 24, now)[0].sourceEvidence[0].contentBasis, 'unknown');
  }
});


test('structured reading thoughts carry unresolved questions with their original evidence bounds', () => {
  const reflection = { learned: '只拿到介绍', changed: '', unresolved: '鲸鱼如何交流？' };
  assert.deepEqual(parseReadingReflection(JSON.stringify(reflection)), reflection);
  for (const raw of ['[]', '{}', '普通旧日记', '{"learned":1}', JSON.stringify({...reflection, changed:'字'.repeat(301)})]) {
    assert.equal(parseReadingReflection(raw), undefined);
  }
  const source = entry({ id:'abcdef123456', subjectId:'fish', text:JSON.stringify({title:'鲸鱼',contentBasis:'metadata',visualStatus:'disabled',audioObserved:false}) });
  const thought = entry({id:'note',subjectId:'fish',origin:'diary',kind:'diary',tags:['B站','reading:abcdef123456'],text:JSON.stringify({title:'鲸鱼',thought:'只拿到介绍，想知道鲸鱼如何交流',reflection})});
  const result = readingContinuity([source,thought], '鲸鱼', now);
  assert.deepEqual(result[0].reflection, reflection);
  assert.equal(result[0].sourceEvidence[0].contentBasis, 'metadata');
  assert.equal(result[0].sourceEvidence[0].audioScope, 'not_observed');
});
