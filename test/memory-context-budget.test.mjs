import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMemoryContext } from '../lib/memory/context-budget.js';

const data = changes => ({ currentPerson: 'viewer', profile: [], recalled: [], recentExperience: [], recentSources: [], sharedDialogues: [], sharedThreads: [], ...changes });
const payload = text => JSON.parse(text.split('\n').at(-1));

test('small memory contexts preserve exact records and do not add omission claims', () => {
  const input = data({ profile: [{ id: 'one', text: '喜欢茶' }], recentExperience: [{ id: 'read', sourceEvidence: [{ contentBasis: 'metadata' }] }] });
  const snapshot = JSON.stringify(input);
  const text = renderMemoryContext(['规则'], input);
  assert.deepEqual(payload(text), input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('budget removes fallback conversations before related threads or complete reading evidence', () => {
  const reading = { id: 'read', text: '主观感想', sourceEvidence: [{ id: 'source', contentBasis: 'metadata', audioScope: 'not_observed' }] };
  const thread = { id: 'plan', match: 'topic', text: '当前约定' };
  const source = { match: 'keyword', text: '与当前问题匹配的用户原文' };
  const input = data({ recentSources: [source], recentExperience: [reading], sharedThreads: [thread], sharedDialogues: [{ match: 'recent', userText: '甲'.repeat(2000), replyText: '乙'.repeat(2000) }] });
  const snapshot = JSON.stringify(input);
  const text = renderMemoryContext(['规则'], input, 1000), result = payload(text);
  assert.ok(text.length <= 1000);
  assert.deepEqual(result.recentExperience, [reading]);
  assert.deepEqual(result.sharedThreads, [thread]);
  assert.deepEqual(result.recentSources, [source]);
  assert.deepEqual(result.sharedDialogues, []);
  assert.deepEqual(result.contextOmissions, { sharedDialogues: 1 });
  assert.match(text, /省略不代表不存在/);
  assert.equal(JSON.stringify(input), snapshot);
});

test('oversized experiences are omitted atomically rather than separating opinions from evidence', () => {
  const reading = { id: 'read', text: '已设置好了', sourceEvidence: [{ contentBasis: 'sampled_frames', visualSource: 'storyboard', extra: '证据'.repeat(3000) }] };
  const text = renderMemoryContext(['规则'], data({ recentExperience: [reading] }), 1000);
  assert.ok(text.length <= 1000);
  assert.deepEqual(payload(text).recentExperience, []);
  assert.equal(payload(text).contextOmissions.recentExperience, 1);
  assert.ok(!text.includes('已设置好了'));
});

test('matching conversations outrank generic recent conversations and omission metadata fits the real serialized limit', () => {
  const text = renderMemoryContext(['规则'], data({ sharedDialogues: [
    { id: 'related', match: 'text', userText: '当前问题' },
    { id: 'fallback', match: 'recent', userText: '"\\\n🐟'.repeat(500) }
  ] }), 1000);
  assert.ok(text.length <= 1000);
  assert.deepEqual(payload(text).sharedDialogues.map(row => row.id), ['related']);
  assert.equal(payload(text).contextOmissions.sharedDialogues, 1);
});

test('invalid budgets and oversized instructions are rejected without truncating rules', () => {
  for (const limit of [0, -1, 1.5, Infinity]) assert.throws(() => renderMemoryContext(['规则'], data(), limit));
  assert.throws(() => renderMemoryContext(['规则'.repeat(1000)], data(), 100), /规则本身/);
});
