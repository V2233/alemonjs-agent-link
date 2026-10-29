import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { comparisonTemplate, summarizeComparison } from '../scripts/compare-companion.mjs';
const corpus = JSON.parse(await readFile(new URL('../benchmarks/companion-scenarios.json', import.meta.url), 'utf8'));
const reviewed = () => {
  const value = comparisonTemplate(corpus);
  Object.assign(value, { subject: 'synthetic-test', model: 'test', settings: 'unit-test', generationEvidence: 'synthetic fixture, no actual product sampled' });
  for (const row of value.responses)
    Object.assign(row, {
      kind: 'text',
      response: '测试样本',
      latencyMs: 100,
      reviewer: 'unit-test',
      reviewNote: 'synthetic rating only',
      scores: { naturalness: 4, continuity: 3, grounding: 5 }
    });
  return value;
};
test('empty templates remain pending without fabricated quality or latency scores', () => {
  const result = summarizeComparison(corpus, comparisonTemplate(corpus));
  assert.equal(result.status, 'pending');
  assert.equal(result.reviewed, 0);
  assert.equal(result.pending.length, corpus.cases.length);
  assert.equal(result.scores.naturalness, null);
  assert.ok(result.pendingMetadata.includes('model'));
  assert.equal(result.latency.p50Ms, null);
  assert.ok(!JSON.stringify(result).includes('测试样本'));
});
test('summary retains dimensions, coverage and sample count without publishing responses', () => {
  const result = summarizeComparison(corpus, reviewed());
  assert.equal(result.status, 'reviewed');
  assert.deepEqual(result.scores, { naturalness: 4, continuity: 3, grounding: 5 });
  assert.equal(result.latency.samples, corpus.cases.length);
  assert.equal(result.latency.p95Ms, 100);
  assert.ok(!JSON.stringify(result).includes('测试样本'));
  const partial = reviewed();
  partial.responses.pop();
  assert.equal(summarizeComparison(corpus, partial).status, 'pending');
});
test('mismatched corpus, duplicate cases, invalid scores and fake silence are rejected', () => {
  const mutations = [
    value => {
      value.corpusHash = 'old';
    },
    value => {
      value.responses.push(value.responses[0]);
    },
    value => {
      value.responses[0].scores.grounding = 6;
    },
    value => {
      value.responses[0].kind = 'silence';
    },
    value => {
      value.responses[0].latencyMs = -1;
    }
  ];
  for (const mutate of mutations) {
    const value = reviewed();
    mutate(value);
    assert.throws(() => summarizeComparison(corpus, value));
  }
  const silence = reviewed();
  Object.assign(silence.responses[0], { kind: 'silence', response: '', latencyMs: null });
  assert.equal(summarizeComparison(corpus, silence).status, 'reviewed');
});
