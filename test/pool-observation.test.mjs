import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointObservation } from '../lib/panel/pool-observation.js';

test('newest actual request supplies connectivity, independent of quota or manual probe',()=>{
 assert.equal(endpointObservation({lastRequest:{at:20,ok:true,status:200,reason:'success'},lastProbeAt:10,probeReachable:false}).reachability,true);
 assert.equal(endpointObservation({lastRequest:{at:20,ok:false,status:402,reason:'exhausted'}}).reachability,true);
 assert.equal(endpointObservation({lastRequest:{at:20,ok:false,reason:'timeout'},lastProbeAt:10,probeReachable:true}).reachability,false);
 assert.equal(endpointObservation({lastRequest:{at:10,ok:true,status:200,reason:'success'},lastProbeAt:20,probeReachable:false}).reachability,false);
 const local=endpointObservation({lastRequest:{at:30,ok:false,reason:'local-budget'},lastNetworkRequest:{at:20,ok:true,status:200,reason:'success'}});
 assert.equal(local.reachability,true);
 assert.equal(local.observedAt,20);
 assert.equal(local.observationSource,'call');
});
