import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkModel } from '../lib/panel/work-model.js';

test('work model requires explicit credentials and rejects unsafe or unrelated fields', () => {
  const valid = {baseUrl:'https://example.com/v1/',apiKey:'test-secret',model:'test'};
  assert.equal(validateWorkModel(valid).baseUrl, 'https://example.com/v1');
  assert.throws(() => validateWorkModel(undefined));
  assert.throws(() => validateWorkModel({...valid, apiKey:''}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'http://example.com'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'https://user:pass@example.com'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'https://example.com?key=secret'}));
  assert.throws(() => validateWorkModel({...valid, modelPool:{}}));
});
