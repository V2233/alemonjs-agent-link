import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelPool } from '../lib/model-pool/config.js';
import { clearBalanceCache, fetchPoolBalances } from '../lib/model-pool/balance.js';

const defaults = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };

test('balance lookup supports DeepSeek native balance and a configured voucher template', async () => {
  clearBalanceCache();
  const pool = parseModelPool(
    {
      balanceUrl: 'https://voucher.example/api/query?key={key}',
      endpoints: [
        { id: 'deep', apiKey: 'sk-deep-000000', model: 'm' },
        { id: 'audio', apiKey: 'sk-audio-000000', model: 'm', provider: 'senseaudio', baseUrl: 'https://audio.example/v1' }
      ]
    },
    defaults
  );
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/user/balance')) {
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '20.94' }] });
    }
    return Response.json({ ok: true, data: { total_available: 12.34 } });
  };
  try {
    const balances = await fetchPoolBalances(pool);
    assert.equal(balances.get('deep').text, '¥20.94');
    assert.equal(balances.get('audio').text, '¥12.34');
  } finally {
    globalThis.fetch = original;
    clearBalanceCache();
  }
});

test('missing voucher records and SenseNova have clear fallback labels', async () => {
  clearBalanceCache();
  const pool = parseModelPool(
    {
      balanceUrl: 'https://voucher.example/api/query?key={key}',
      endpoints: [
        { id: 'audio', apiKey: 'sk-audio-000000', model: 'm', provider: 'senseaudio', baseUrl: 'https://audio.example/v1' },
        { id: 'nova', apiKey: 'sk-nova-000000', model: 'm', provider: 'sensenova', baseUrl: 'https://nova.example/v1' }
      ]
    },
    defaults
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    const balances = await fetchPoolBalances(pool);
    assert.equal(balances.get('audio').text, '未收录');
    assert.equal(balances.get('nova').text, '免费/限流');
  } finally {
    globalThis.fetch = original;
    clearBalanceCache();
  }
});

test('a per-endpoint balanceUrl overrides the pool default', async () => {
  clearBalanceCache();
  const pool = parseModelPool(
    {
      balanceUrl: 'https://pool.example/query?key={key}',
      endpoints: [
        { id: 'default', apiKey: 'sk-default-0000', model: 'm', provider: 'senseaudio', baseUrl: 'https://a.example/v1' },
        {
          id: 'custom',
          apiKey: 'sk-custom-00000',
          model: 'm',
          provider: 'senseaudio',
          baseUrl: 'https://b.example/v1',
          balanceUrl: 'https://vendor.example/query?key={key}'
        }
      ]
    },
    defaults
  );
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(String(url));
    const amount = String(url).includes('vendor.example') ? 34.56 : 12.34;
    return Response.json({ ok: true, data: { total_available: amount } });
  };
  try {
    const balances = await fetchPoolBalances(pool);
    assert.equal(balances.get('default').text, '¥12.34');
    assert.equal(balances.get('custom').text, '¥34.56');
    assert.ok(seen.some(url => url.startsWith('https://vendor.example/')));
  } finally {
    globalThis.fetch = original;
    clearBalanceCache();
  }
});

test('balanceUrl can map a template per provider', async () => {
  clearBalanceCache();
  const pool = parseModelPool(
    {
      balanceUrl: { senseaudio: 'https://vendor.example/query?key={key}' },
      endpoints: [
        { id: 'audio', apiKey: 'sk-audio-000000', model: 'm', provider: 'senseaudio', baseUrl: 'https://audio.example/v1' },
        { id: 'other', apiKey: 'sk-other-000000', model: 'm', provider: 'other', baseUrl: 'https://other.example/v1' }
      ]
    },
    defaults
  );
  assert.deepEqual(pool.balanceUrls, { senseaudio: 'https://vendor.example/query?key={key}' });
  assert.equal(pool.balanceUrl, undefined);
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(String(url));
    return Response.json({ ok: true, data: { total_available: 7.5 } });
  };
  try {
    const balances = await fetchPoolBalances(pool);
    assert.equal(balances.get('audio').text, '¥7.50');
    assert.equal(balances.get('other').text, '无余额接口');
    assert.equal(seen.length, 1);
    assert.match(seen[0], /vendor\.example/);
  } finally {
    globalThis.fetch = original;
    clearBalanceCache();
  }
});

test('re-parsing a normalized pool keeps the provider balance map', () => {
  const once = parseModelPool(
    {
      balanceUrl: { senseaudio: 'https://vendor.example/query?key={key}' },
      endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm', provider: 'senseaudio', baseUrl: 'https://audio.example/v1' }]
    },
    defaults
  );
  const twice = parseModelPool(once, defaults);
  assert.deepEqual(twice.balanceUrls, once.balanceUrls);
  assert.equal(twice.balanceUrl, undefined);
});

test('New API usage endpoint is shown as used amount', async () => {
  clearBalanceCache();
  const pool = parseModelPool(
    {
      endpoints: [
        {
          id: 'newapi',
          apiKey: 'sk-newapi-000000',
          model: 'm',
          provider: 'freetoken',
          baseUrl: 'https://free.example/v1',
          balanceStyle: 'newapi'
        }
      ]
    },
    defaults
  );
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /dashboard\/billing\/usage/);
    return Response.json({ object: 'list', total_usage: 35.55 });
  };
  try {
    const balances = await fetchPoolBalances(pool);
    assert.equal(balances.get('newapi').text, '已用 ¥0.36');
    assert.equal(balances.get('newapi').used, 0.3555);
  } finally {
    globalThis.fetch = original;
    clearBalanceCache();
  }
});

test('balance failure classification uses explicit freeze evidence and force refresh bypasses cache', async () => {
  const { balanceFailure } = await import('../lib/model-pool/balance.js');
  assert.equal((await balanceFailure(Response.json({error:{message:'account frozen'}},{status:403}))).status,'frozen');
  assert.equal((await balanceFailure(Response.json({},{status:403}))).status,'forbidden');
  assert.equal((await balanceFailure(Response.json({},{status:429}))).status,'rate-limited');
  assert.equal((await balanceFailure(Response.json({},{status:401}))).status,'invalid');
  assert.equal((await balanceFailure(Response.json({},{status:402}))).status,'exhausted');
  const pool = parseModelPool({endpoints:[{id:'test',apiKey:'test-secret-key',provider:'deepseek-official',model:'test'}]},defaults);
  const previous = globalThis.fetch;
  let count=0;
  globalThis.fetch=async()=>{count++;return Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:count}]});};
  clearBalanceCache();
  try {
    await fetchPoolBalances(pool);
    await fetchPoolBalances(pool);
    assert.equal(count,1);
    const fresh=await fetchPoolBalances(pool,true);
    assert.equal(count,2);
    assert.equal(fresh.get('test').amount,2);
  } finally {globalThis.fetch=previous;clearBalanceCache();}
});
