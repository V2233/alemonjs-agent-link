import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecognizedEndpoint } from '../lib/panel/endpoint-recognition.js';

test('recognition accepts fenced JSON, filters fields and does not fabricate missing credentials', () => {
  const result = parseRecognizedEndpoint('```json\n{"model":" example ","capabilities":["chat","shell","chat"],"enabled":true,"id":"existing"}\n```');
  assert.equal(result.model, 'example');
  assert.deepEqual(result.capabilities, ['chat']);
  assert.equal(result.apiKey, undefined);
  assert.equal(result.enabled, undefined);
  assert.match(result.id, /^import-/);
  assert.throws(() => parseRecognizedEndpoint('[]'));
  assert.throws(() => parseRecognizedEndpoint('not json'));
});
