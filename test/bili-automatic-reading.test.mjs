import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticReadingAttempts } from '../lib/bili/automatic-reading.js';

const bv = 'BV1234567890';
const request = { link: bv };
const overview = { video: { bvid: bv }, visual: { region: 'frame_grid', timestamps: [2, 5, 8, 11, 14, 17] }, evidence: { visualObserved: true } };
const crop = { x: 0.2, y: 0.2, width: 0.3, height: 0.3 };

test('successful overview allows one targeted refinement within the original total attempts', () => {
  const state = new AutomaticReadingAttempts();
  assert.equal(state.claimSearch(), true);
  assert.equal(state.claimSearch(), false);
  const first = state.claim(request, 2, true);
  assert.ok(first);
  state.complete(first, overview);
  assert.equal(state.claim(request, 2, true), undefined);
  const second = state.claim({ link: bv, visualAt: [8], visualCrop: crop }, 2, true);
  assert.equal(second.kind, 'refinement');
  state.complete(second, { ...overview, visual: { region: 'crop', timestamps: [8] } });
  assert.equal(state.claim({ link: bv, visualAt: [12] }, 2, true), undefined);
  assert.equal(state.claim({ link: 'BVabcdefghij' }, 2, true), undefined);
});

test('pending, failed, metadata-only and already-targeted first reads cannot unlock refinement', () => {
  const outcomes = [undefined, { ...overview, evidence: { visualObserved: false } }];
  for (const result of outcomes) {
    const state = new AutomaticReadingAttempts(),
      first = state.claim(request, 3, true);
    assert.equal(state.claim({ link: bv, visualAt: [12] }, 3, true), undefined);
    state.complete(first, result);
    assert.equal(state.claim({ link: bv, visualAt: [12] }, 3, true), undefined);
  }
  for (const patch of [{ visualAt: [2] }, { visualFocus: 'subtitles' }, { visualAt: [2], visualCrop: crop }]) {
    const state = new AutomaticReadingAttempts(),
      first = state.claim({ ...request, ...patch }, 3, true);
    state.complete(first, overview);
    assert.equal(state.claim({ link: bv, visualAt: [12] }, 3, true), undefined);
  }
});

test('same-frame repeats and malformed refinement do not dispatch or consume a valid remaining attempt', () => {
  const state = new AutomaticReadingAttempts();
  state.complete(state.claim(request, 3, true), overview);
  for (const patch of [
    {},
    { visualAt: [2, 5] },
    { visualAt: [2.0005] },
    { visualAt: [] },
    { visualAt: [NaN] },
    { visualAt: [12], visualFocus: 'unknown' },
    { visualAt: [12], visualCrop: { ...crop, width: 2 } },
    { visualAt: [12], visualFocus: 'subtitles', visualCrop: crop }
  ])
    assert.equal(state.claim({ ...request, ...patch }, 3, true), undefined);
  assert.equal(state.claim({ ...request, visualAt: [12] }, 3, true).kind, 'refinement');
  assert.ok(state.claim({ link: 'BVabcdefghij' }, 3, true));
});

test('one refinement attempt per BV includes failed and concurrent refinements', () => {
  const state = new AutomaticReadingAttempts();
  state.complete(state.claim(request, 3, true), overview);
  const second = state.claim({ ...request, visualAt: [12] }, 3, true);
  assert.equal(state.claim({ ...request, visualAt: [13] }, 3, true), undefined);
  state.complete(second);
  assert.equal(state.claim({ ...request, visualAt: [14], visualCrop: crop }, 3, true), undefined);
  assert.ok(state.claim({ link: 'BVabcdefghij' }, 3, true));
});

test('actual returned BV deduplicates aliases; short/av links cannot be used as refinement aliases', () => {
  for (const link of ['av123', 'https://b23.tv/abc']) {
    const state = new AutomaticReadingAttempts();
    state.complete(state.claim({ link }, 3, true), overview);
    assert.equal(state.claim({ link: `https://www.bilibili.com/video/${bv}` }, 3, true), undefined);
    assert.equal(state.claim({ link, visualAt: [12] }, 3, true), undefined);
    assert.equal(state.claim({ link: bv, visualAt: [12] }, 3, true).kind, 'refinement');
  }
  const state = new AutomaticReadingAttempts();
  state.claim({ link: 'av123' }, 3, true);
  assert.equal(state.claim({ link: 'https://www.bilibili.com/video/av123' }, 3, true), undefined);
});

test('no extra allowance for ordinary proactive turns, reduced budgets, or forged completion tickets', () => {
  const state = new AutomaticReadingAttempts(),
    first = state.claim(request, 3, true);
  state.complete({ ...first }, overview);
  assert.equal(state.claim({ ...request, visualAt: [12] }, 3, true), undefined);
  state.complete(first, overview);
  assert.equal(state.claim({ ...request, visualAt: [12] }, 3, false), undefined);
  assert.equal(state.claim({ ...request, visualAt: [12] }, 1, true), undefined);
  assert.ok(state.claim({ ...request, visualAt: [12] }, 2, true));
  const other = new AutomaticReadingAttempts();
  other.complete(first, overview);
  assert.equal(other.claim(request, 3, true).kind, 'overview');
});
