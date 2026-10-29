import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../lib/memory/store.js';

test('trace prioritizes version evidence over tentative tag matches and bounds output', () => {
  const item = (id, extra = {}) => ({id, subjectId:'u', text:id, tags:['旅行'], sourceRefs:[], supersedes:[], updatedAt:1, createdAt:1, status:'active', ...extra});
  const root = item('root', {supersedes:['old'], sourceRefs:[{seq:1}]});
  const all = [root, item('tag'), item('old'), item('next',{supersedes:['root']}), item('source',{sourceRefs:[{seq:1}]})];
  const fake = { get: () => root, list: (_scope, options) => {assert.equal(options.subjectId,'u'); return all;} };
  const result = MemoryStore.prototype.trace.call(fake, {}, 'root', 3);
  assert.deepEqual(result.links.map(link => link.relation), ['previous_version','next_version','shared_evidence']);
  assert.equal(result.truncated,true);
  const full = MemoryStore.prototype.trace.call(fake, {}, 'root', 20);
  assert.equal(full.links.at(-1).relation,'possibly_related');
  assert.deepEqual(full.links.at(-1).sharedTags,['旅行']);
});

test('missing memory cannot expose other nodes', () => {
  const result = MemoryStore.prototype.trace.call({get:()=>undefined,list:()=>{throw Error('unexpected');}}, {}, 'missing');
  assert.equal(result.ok,false);
});
