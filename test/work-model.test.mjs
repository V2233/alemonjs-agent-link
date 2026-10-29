import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkModel } from '../lib/panel/work-model.js';

test('work model uses top-level defaults and rejects unsafe or unrelated fields', () => {
  const valid = {baseUrl:'https://example.com/v1/',apiKey:'test-secret',model:'test'};
  assert.equal(validateWorkModel(valid).baseUrl, 'https://example.com/v1');
  assert.throws(() => validateWorkModel(undefined));
  assert.equal(validateWorkModel({...valid, apiKey:''}).apiKey, '');
  assert.deepEqual(validateWorkModel({}), {apiKey:'', baseUrl:'https://api.deepseek.com', model:'deepseek-v4-flash', provider:'deepseek-official'});
  assert.throws(() => validateWorkModel({provider:'custom'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'http://example.com'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'https://user:pass@example.com'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'https://example.com?key=secret'}));
  assert.throws(() => validateWorkModel({...valid, modelPool:{}}));
});
