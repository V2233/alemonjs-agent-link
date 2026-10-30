import test from 'node:test';
import assert from 'node:assert/strict';
import { biliEvidence } from '../lib/bili/evidence.js';

test('comments never upgrade metadata-only reading into observed video content', () => {
  for (const status of ['unavailable', 'not_available', 'empty']) {
    const result = biliEvidence({ status, text: '' }, { status: 'available', items: [{ text: '观众说剧情精彩' }] });
    assert.equal(result.basis, 'metadata');
    assert.equal(result.hasSubtitleText, false);
    assert.equal(result.hasAudienceComments, true);
    assert.equal(result.visualObserved, false);
    assert.equal(result.audioObserved, false);
    assert.match(result.limitation, /不能补成视频事实/);
  }
});

test('evidence distinguishes returned subtitles from incomplete excerpts and empty responses', () => {
  const comments = { status: 'available', items: [] };
  assert.equal(biliEvidence({ status: 'available', text: '台词' }, comments).basis, 'subtitles');
  assert.equal(biliEvidence({ status: 'available', text: '片段', truncated: true }, comments).basis, 'subtitle_excerpt');
  assert.equal(biliEvidence({ status: 'available', text: ' ' }, comments).basis, 'metadata');
  assert.equal(biliEvidence({ status: 'available', text: '台词' }, comments).hasAudienceComments, false);
});

test('audience comment scope describes only returned text and never establishes zero comments', () => {
  for (const [comments, expected, hasText] of [
    [{ status: 'available', items: [] }, 'empty_response', false],
    [{ status: 'available', items: [{ text: '  ' }] }, 'empty_response', false],
    [{ status: 'available', items: [{ text: '我喜欢这条视频' }] }, 'returned_subset', true],
    [{ status: 'unavailable', items: [{ text: 'untrusted stale result' }] }, 'unavailable', false]
  ]) {
    const result = biliEvidence({ status: 'empty', text: '' }, comments);
    assert.equal(result.audienceCommentScope, expected);
    assert.equal(result.hasAudienceComments, hasText);
    assert.equal(result.basis, 'metadata');
    assert.match(result.limitation, /不证明原视频零评论/u);
  }
});
