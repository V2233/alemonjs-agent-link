import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVoiceTag } from '../lib/dsh/reply-format.js';
import { expressionOptions } from '../lib/companion/expression.js';

test('voice tag is removed from visible text and marks the reply for speech', () => {
  assert.deepEqual(extractVoiceTag('好呀<voice>那我用语音说</voice>'), { text: '好呀那我用语音说', voice: true });
  assert.deepEqual(extractVoiceTag('<voice>一句</voice><voice>两句</voice>'), { text: '一句两句', voice: true });
  assert.deepEqual(extractVoiceTag('只有文字'), { text: '只有文字', voice: false });
  assert.deepEqual(extractVoiceTag('<voice>未闭合'), { text: '未闭合', voice: false });
});

test('modelVoice is an explicit boolean opt-in', () => {
  assert.equal(expressionOptions({ modules: { settings: { expression: { modelVoice: true } } } }).modelVoice, true);
  assert.equal(expressionOptions({}).modelVoice, false);
  assert.throws(() => expressionOptions({ modules: { settings: { expression: { modelVoice: 'yes' } } } }), /expression 设置无效/);
});
