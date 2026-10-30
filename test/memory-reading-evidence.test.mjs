import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleRuntime } from '../lib/agent/modules.js';
import { memoryModule } from '../lib/modules/memory.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMemoryStore, experienceMemoryId } from '../lib/memory/store.js';
import { getChatArchive } from '../lib/history/store.js';

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'memory-reading-evidence-'));
  const previous = globalThis.__config, originalNow = Date.now, originalFetch = globalThis.fetch;
  const now = originalNow();
  let time = now;
  Date.now = () => time;
  globalThis.fetch = async () => { assert.fail('context assembly must not call a model or platform'); };
  globalThis.__config = { value: { 'alemonjs-agent-link': {
    workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), stateBackend: 'local', runtimeMode: 'chat-only',
    modules: { settings: { memory: { automatic: false } } }
  } } };
  const config = getDSHConfig();
  const store = getMemoryStore(config);
  const runtime = new ModuleRuntime(config, [memoryModule(config)]);
  const lease = await runtime.acquire();
  const context = { platform: 'onebot', channelId: 'private:viewer', botId: 'fish', userId: 'viewer', owner: false, private: true, userText: '你最近看了什么', signal: new AbortController().signal, capabilities: { chat: true, web: false, files: false, terminal: false } };
  const inject = async (changes = {}) => {
    const text = await lease.context({ ...context, ...changes });
    return { text, data: text ? JSON.parse(text.split('\n').at(-1)) : { recentExperience: [] } };
  };
  const source = (key, details, changes = {}) => {
    assert.equal(store.recordExperience(context, { key, subjectId: 'fish', text: JSON.stringify(details), tags: ['B站', '资料'], ...changes }), true);
    return experienceMemoryId(key);
  };
  const thought = (key, ids, text = '我看完视频了，它没有讲原理') => {
    assert.equal(store.recordDiary(context, { key, subjectId: 'fish', text: JSON.stringify({ thought: text }), tags: ['B站', '阅读感想'], sourceReadingIds: ids }), true);
  };
  try { await run({ store, archive: getChatArchive(config), context, inject, source, thought, now, at: value => { time = value; } }); }
  finally {
    await lease.release();
    await runtime.close();
    getChatArchive(config).close();
    store.close();
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
};

test('ordinary chat resolves older reading evidence even after its source leaves the recent 100 candidates', () => fixture(async f => {
  f.at(f.now - 48 * 3600000);
  const id = f.source('old-read', { bvid: 'BV1234567890', contentBasis: 'metadata', visualStatus: 'disabled', audioObserved: false });
  f.at(f.now - 47 * 3600000);
  for (let i = 0; i < 101; i++) f.source(`filler-${i}`, { contentBasis: 'metadata' });
  f.at(f.now);
  f.thought('recent-thought', [id]);
  assert.ok(!f.store.list(f.context, { subjectId: 'fish', limit: 100 }).some(item => item.id === id));
  const { text, data } = await f.inject();
  assert.equal(data.recentExperience.length, 1);
  const entry = data.recentExperience[0];
  assert.equal(entry.evidenceRole, 'reading_reference');
  assert.equal(entry.recordedAt, new Date(f.now).toISOString());
  assert.match(entry.text, /我看完视频了/); // Preserve the mistaken opinion, do not rewrite it as evidence.
  assert.deepEqual(entry.sourceEvidence, [{ id, availability: 'available', bvid: 'BV1234567890', contentBasis: 'metadata', visualScope: 'not_observed', sampledTimestamps: [], audioScope: 'not_observed' }]);
  assert.match(text, /不能把自己以前的误述当成新证据/);
  assert.match(text, /不证明照视频做过任何操作/);
  assert.match(text, /做过但不确定成功/);
  const autonomous = await f.inject({ autonomous: true });
  assert.deepEqual(autonomous.data.recentExperience[0].sourceEvidence, entry.sourceEvidence);
}));

test('ordinary chat retains separate subtitle excerpt and low-resolution storyboard scopes', () => fixture(async f => {
  f.at(f.now - 48 * 3600000);
  const first = f.source('subtitle-read', { contentBasis: 'subtitle_excerpt', visualStatus: 'disabled', audioObserved: false });
  const second = f.source('preview-read', { contentBasis: 'sampled_frames', visualStatus: 'available', visualSource: 'storyboard', sampledTimestamps: [4, 10, 18], audioObserved: false });
  f.at(f.now);
  f.thought('comparison', [first, second], '这两个视频都看过了');
  const { data } = await f.inject();
  const evidence = data.recentExperience[0].sourceEvidence;
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].contentBasis, 'subtitle_excerpt');
  assert.equal(evidence[1].visualSource, 'storyboard');
  assert.deepEqual(evidence[1].sampledTimestamps, [4, 10, 18]);
}));

test('ordinary chat keeps ASR and comment bounds beside an unchanged mistaken reflection', () => fixture(async f => {
  f.at(f.now - 36 * 3600000);
  const id = f.source('asr-read', { contentBasis: 'audio_excerpt', audioStatus: 'available', audioTranscribed: true, transcribedRange: [0, 8],
    visualStatus: 'disabled', audioObserved: false, audioExcerpt: '请带上蓝色笔记本，末尾词语可能误识别。', commentStatus: 'available', audienceCommentScope: 'empty_response' });
  f.at(f.now);
  f.thought('wrong-asr-thought', [id], '我听完整条了，没人评论，大家不感兴趣');
  const { text, data } = await f.inject();
  const entry = data.recentExperience[0];
  assert.match(entry.text, /我听完整条了/u);
  assert.deepEqual(entry.readingSupport.obtained, ['asr_excerpt_text']);
  assert.ok(entry.readingSupport.notEstablished.includes('direct_listening'));
  assert.ok(entry.readingSupport.notEstablished.includes('all_viewers_interest'));
  assert.equal(entry.sourceEvidence[0].audienceCommentScope, 'empty_response');
  assert.deepEqual(entry.sourceEvidence[0].transcribedRange, [0, 8]);
  assert.deepEqual(entry.sourceEvidence[0].excerpts, [{ kind: 'asr_text', text: '请带上蓝色笔记本，末尾词语可能误识别。' }]);
  assert.match(text, /不代表现实里从未发生/u);
  assert.match(text, /不能先断言再用不确定语气保留它/u);
}));

test('legacy, missing and wrong-subject reading links remain unknown without leaking another subject', () => fixture(async f => {
  f.at(f.now - 48 * 3600000);
  const wrong = f.source('someone-else', { bvid: 'BV1234567890', title: 'foreign-private-title', contentBasis: 'subtitles' }, { subjectId: 'other' });
  f.at(f.now);
  for (const [key, tags] of [['legacy', []], ['missing', ['reading:abcdef123456']], ['wrong', [`reading:${wrong}`]]]) {
    f.store.recordDiary(f.context, { key, subjectId: 'fish', text: JSON.stringify({ thought: key }), tags: ['B站', '阅读感想', ...tags] });
  }
  const { text, data } = await f.inject();
  assert.equal(data.recentExperience.length, 3);
  for (const entry of data.recentExperience) {
    assert.equal(entry.sourceEvidence[0].contentBasis, 'unknown');
    assert.equal(entry.sourceEvidence[0].audioScope, 'unknown');
    assert.equal(entry.sourceEvidence[0].availability, entry.text.includes('legacy') ? 'unlinked' : 'missing');
  }
  assert.ok(!text.includes('foreign-private-title'));
  assert.equal((await f.inject({ channelId: 'private:another' })).data.recentExperience.length, 0);
}));

test('deleting a source removes its linked thought from later chat context', () => fixture(async f => {
  f.at(f.now - 48 * 3600000);
  const id = f.source('forgotten', { contentBasis: 'metadata' });
  f.at(f.now);
  f.thought('linked', [id]);
  assert.equal((await f.inject()).data.recentExperience.length, 1);
  f.store.forget(f.context, id, 0);
  assert.equal((await f.inject()).data.recentExperience.length, 0);
}));

test('future experiences do not enter current chat and non-reading experiences keep their original meaning', () => fixture(async f => {
  f.source('ordinary', { action: 'read_weather', result: '晴' }, { tags: ['天气'] });
  f.at(f.now + 1000);
  f.source('future', { action: 'future' }, { tags: ['天气'] });
  f.at(f.now);
  const { data } = await f.inject();
  assert.equal(data.recentExperience.length, 1);
  assert.match(data.recentExperience[0].text, /晴/);
  assert.equal(data.recentExperience[0].origin, 'event');
  assert.equal(data.recentExperience[0].sourceEvidence, undefined);
  assert.equal(data.recentExperience[0].evidenceRole, undefined);
}));

test('rich chat memory fits its context budget without dropping reading evidence or misreporting omissions', () => fixture(async f => {
  f.at(f.now - 36 * 3600000);
  const ids = Array.from({ length: 3 }, (_, i) => f.source(`read-${i}`, { contentBasis: 'sampled_frames', visualStatus: 'available', visualSource: 'storyboard', sampledTimestamps: [4, 10, 18], audioObserved: false }));
  f.at(f.now);
  for (let i = 0; i < 3; i++) f.thought(`thought-${i}`, ids, `${i}读后想法` + '感'.repeat(740));
  for (let i = 0; i < 3; i++) {
    const userId = `user-${i}-${'u'.repeat(180)}`;
    f.archive.append(f.context, { id: userId, speakerId: 'viewer', speaker: '评测用户', role: 'user', text: '共同计划' + '问'.repeat(7990) });
    f.archive.append(f.context, { id: `reply-${i}-${'a'.repeat(180)}`, speakerId: 'fish', speaker: '评测肥鱼', role: 'assistant', sourceMessageId: userId, text: '答'.repeat(7990) });
  }
  for (let i = 0; i < 7; i++) f.archive.append(f.context, { id: `source-${i}`, speakerId: 'viewer', speaker: '评测用户', role: 'user', text: `计划来源${i}` });
  const sources = f.archive.dialogueBatch(f.context, 0, 30).sources.filter(row => row.speakerId === 'viewer').slice(0, 10);
  assert.equal(sources.length, 10);
  for (let i = 0; i < 5; i++) f.store.recordSharedThread(f.context, 'viewer', { text: `计划${i}` + '计'.repeat(790), state: 'agreed', sources });
  const { text, data } = await f.inject();
  assert.ok(text.length <= 16000);
  assert.equal(data.recentExperience.length, 3);
  assert.ok(data.recentExperience.every(entry => entry.sourceEvidence.length === 3 && entry.sourceEvidence.every(source => source.visualSource === 'storyboard')));
  assert.ok(data.contextOmissions.sharedDialogues > 0);
  assert.match(text, /省略不代表不存在/);
}));
