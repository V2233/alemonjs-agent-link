import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelPool} from '../lib/model-pool/config.js';
test('array order overrides legacy explicit priority',()=>{
 const defaults={provider:'test',baseUrl:'https://example.com',apiKey:'test-api-key',model:'test'};
 const endpoints=[{id:'a',priority:99,apiKey:'test-api-key'},{id:'b',priority:0,apiKey:'test-api-key'}];
 const first=parseModelPool({endpoints},defaults);
 assert.deepEqual(first.endpoints.map(e=>[e.id,e.priority]),[['a',0],['b',1]]);
 const second=parseModelPool({endpoints:[...endpoints].reverse()},defaults);
 assert.deepEqual(second.endpoints.map(e=>[e.id,e.priority]),[['b',0],['a',1]]);
});
