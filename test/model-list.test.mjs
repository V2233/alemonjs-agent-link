import test from 'node:test';
import assert from 'node:assert/strict';
import {listEndpointModels} from '../lib/panel/model-list.js';
test('models queried from selected base URL, deduplicated and sorted', async t=>{
 t.mock.method(globalThis,'fetch',async (url,options)=>{assert.equal(url,'https://example.com/v1/models');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test');return new Response(JSON.stringify({data:[{id:'b'},{id:'a'},{id:'b'},{id:3}]}));});
 assert.deepEqual(await listEndpointModels({baseUrl:'https://example.com/v1/',apiKey:'test'}),['a','b']);
});
test('invalid URLs rejected and upstream failures do not expose bodies',async t=>{
 await assert.rejects(listEndpointModels({baseUrl:'http://example.com',apiKey:'test'}));
 t.mock.method(globalThis,'fetch',async()=>new Response('secret upstream body',{status:401}));
 await assert.rejects(listEndpointModels({baseUrl:'https://example.com',apiKey:'test'}),error=>/401/.test(error.message)&&!error.message.includes('secret'));
});
