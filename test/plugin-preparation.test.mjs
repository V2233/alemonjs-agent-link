import test from 'node:test';
import assert from 'node:assert/strict';
import {PluginPreparation} from '../lib/dsh/plugin-preparation.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('plugin installation runs asynchronously and duplicate starts coalesce',async()=>{
  const preparation=new PluginPreparation();let calls=0,finish;
  const install=async()=>{calls++;await new Promise(resolve=>{finish=resolve;});};
  preparation.start('runtime-a',install);preparation.start('runtime-a',install);
  assert.equal(calls,0);assert.equal(preparation.status(),'preparing');
  await flush();assert.equal(calls,1);finish();await flush();assert.equal(preparation.status(),'ready');
  preparation.start('runtime-a',install);await flush();assert.equal(calls,1);
  await preparation.stop();assert.equal(preparation.status(),'idle');
});

test('reloading cancels the old installation and ignores its late completion',async()=>{
  const preparation=new PluginPreparation();let oldSignal,newSignal,finishOld,finishNew;
  preparation.start('old',async signal=>{oldSignal=signal;await new Promise(resolve=>{finishOld=resolve;});});
  await flush();
  preparation.start('new',async signal=>{newSignal=signal;await new Promise(resolve=>{finishNew=resolve;});});
  await flush();assert.equal(oldSignal.aborted,true);assert.equal(newSignal.aborted,false);
  finishOld();await flush();assert.equal(preparation.status(),'preparing');
  const stopped=preparation.stop();assert.equal(newSignal.aborted,true);finishNew();await stopped;
  assert.equal(preparation.status(),'idle');
});

test('failed preparation is contained and does not redownload on every message',async()=>{
  const preparation=new PluginPreparation();let calls=0;
  const fail=async()=>{calls++;throw new Error('fixture');};
  preparation.start('same',fail);await flush();assert.equal(preparation.status(),'failed');
  preparation.start('same',fail);await flush();assert.equal(calls,1);
  preparation.start('changed',async()=>{});await flush();assert.equal(preparation.status(),'ready');
  await preparation.stop();
});
