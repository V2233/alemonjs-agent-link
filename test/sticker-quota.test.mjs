import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { StickerCollectionQuota, getStickerCollectionQuota } from '../lib/media/sticker-quota.js';
import { AutoStickerCollector } from '../lib/media/sticker-auto.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMediaConfig } from '../lib/media/config.js';

const now = 1800000000000;
const claim = (quota, event, user = 'user', at = now, maxPerHour = 60) => quota.claim({ eventKey: event, userKey: user, now: at, maxPerHour });
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-quota-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('rolling global 60 and same-user 20 limits survive closing and reopening the store', () => fixture(async root => {
  let quota = new StickerCollectionQuota(root);
  try {
    for (let i = 0; i < 20; i++) assert.equal(claim(quota, `first-${i}`), true);
    quota.close(); quota = new StickerCollectionQuota(root);
    assert.equal(claim(quota, 'same-user-excess'), false);
    for (const user of ['second', 'third']) for (let i = 0; i < 20; i++) assert.equal(claim(quota, `${user}-${i}`, user), true);
    assert.equal(claim(quota, 'global-excess', 'fourth'), false);
    quota.close(); quota = new StickerCollectionQuota(root);
    assert.equal(claim(quota, 'global-after-reopen', 'fourth'), false);
    assert.equal(claim(quota, 'at-59-minutes', 'fourth', now + 3599999), false);
    assert.equal(claim(quota, 'at-hour-boundary', 'user', now + 3600000), true);
  } finally { quota.close(); }
}));

test('deduplication is durable, does not spend duplicate quota, and lower configuration limits still apply', () => fixture(async root => {
  let quota = new StickerCollectionQuota(root);
  try {
    assert.equal(claim(quota, 'same-event', 'private-user-id', now, 3), true);
    quota.close(); quota = new StickerCollectionQuota(root);
    assert.equal(claim(quota, 'same-event', 'private-user-id', now, 3), false);
    assert.equal(claim(quota, 'other-event', 'other', now, 1), false);
    assert.equal(claim(quota, 'other-event', 'other', now, 3), true);
    assert.equal(claim(quota, 'third-event', 'third', now, 3), true);
    assert.equal(claim(quota, 'fourth-event', 'fourth', now, 3), false);
  } finally { quota.close(); }
  const bytes = await readFile(join(root, 'sticker-auto-quota.sqlite'));
  assert.ok(!bytes.includes(Buffer.from('private-user-id')));
  assert.ok(!bytes.includes(Buffer.from('same-event')));
}));

test('backwards wall clocks do not create new capacity and malformed claims do not consume quota', () => fixture(async root => {
  const quota = new StickerCollectionQuota(root);
  try {
    assert.equal(claim(quota, 'first', 'user', now, 1), true);
    assert.equal(claim(quota, 'clock-rollback', 'other', now - 10000, 1), false);
    assert.equal(claim(quota, 'before-expiry', 'other', now + 3599999, 1), false);
    assert.equal(claim(quota, 'after-expiry', 'other', now + 3600000, 1), true);
    for (const invalid of [{ maxPerHour: 0 }, { now: NaN }, { eventKey: '' }, { userKey: '' }]) assert.throws(() => quota.claim({ eventKey: 'invalid', userKey: 'user', maxPerHour: 60, now, ...invalid }));
    assert.equal(claim(quota, 'valid-after-invalid', 'user', now + 3600000, 2), true);
  } finally { quota.close(); }
}));

test('concurrent workers sharing a data directory cannot exceed the global or per-user quotas', () => fixture(async root => {
  const seed = new StickerCollectionQuota(root); seed.close();
  const moduleUrl = new URL('../lib/media/sticker-quota.js', import.meta.url).href;
  const code = `import {parentPort,workerData} from 'node:worker_threads';
    import {StickerCollectionQuota} from ${JSON.stringify(moduleUrl)};
    const quota=new StickerCollectionQuota(workerData.root);let accepted=0;
    try {for(let i=0;i<25;i++) if(quota.claim({eventKey:workerData.id+':'+i,userKey:'user:'+workerData.id,maxPerHour:60,now:workerData.now})) accepted++;}
    finally {quota.close();} parentPort.postMessage(accepted);`;
  const counts = await Promise.all(Array.from({ length: 4 }, (_, id) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), { workerData: { root, id, now } });
    let count;
    worker.on('message', value => { count = value; });
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(count) : reject(new Error(`worker exited ${code}`)));
  })));
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 60);
  assert.ok(counts.every(count => count <= 20));
  const quota = new StickerCollectionQuota(root);
  try { assert.equal(claim(quota, 'parent-excess', 'new-user'), false); } finally { quota.close(); }
}));

test('recreated collectors share user quota across private/groups and fail closed if persistence is unavailable', () => fixture(async root => {
  let quota = new StickerCollectionQuota(root), saved = 0, failures = 0;
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { stickers: { autoLabel: false, autoQQSync: false } } } });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const make = () => new AutoStickerCollector({ config: () => config, media: () => ({ ...getMediaConfig({}), stickerRoot: '/configured' }), download: async () => png,
    collect: async () => ({ id: String(++saved), existing: false }), claimQuota: (_config, input) => quota.claim(input), failed: () => { failures++; } });
  const event = (i, changes = {}) => ({ Platform: 'onebot', UserId: 'member', ChannelId: `group-${i}`, MessageId: `message-${i}`, IsPrivate: i % 2 === 0, IsMaster: false, MessageMedia: [{ Type: 'sticker', Url: 'https://cdn.test/a' }], ...changes });
  let collector = make();
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(collector.enqueue(event(i)), 1);
      for (let wait = 0; wait < 100 && saved !== i + 1; wait++) await sleep(5);
      assert.equal(saved, i + 1);
    }
    collector.reset(); quota.close(); quota = new StickerCollectionQuota(root); collector = make();
    assert.equal(collector.enqueue(event(20)), 0);
    assert.equal(collector.enqueue(event(21, { IsPrivate: false })), 0);
    assert.equal(collector.enqueue(event(0)), 0);
    quota.close();
    assert.equal(collector.enqueue(event(22, { UserId: 'different-member' })), 0);
    assert.equal(failures, 1);
    assert.equal(saved, 20);
  } finally { collector.reset(); try { quota.close(); } catch { /* Already closed for failure test. */ } }
}));

test('runtime quota stores follow the configured data directory without discarding a healthy store on path failure', () => fixture(async root => {
  const config = workspaceRoot => getDSHConfig({ workspaceRoot, dshHomeRoot: join(root, 'home') });
  const original = globalThis.__agentLinkStickerQuota__;
  delete globalThis.__agentLinkStickerQuota__;
  try {
    const firstConfig = config(join(root, 'first', 'work'));
    const first = getStickerCollectionQuota(firstConfig);
    assert.equal(claim(first, 'first-event', 'user', now, 1), true);
    assert.equal(getStickerCollectionQuota(config(join(root, 'first', 'other-work'))), first);
    const next = getStickerCollectionQuota(config(join(root, 'second', 'work')));
    assert.equal(claim(next, 'second-event', 'user', now, 1), true);
    const reopened = getStickerCollectionQuota(firstConfig);
    assert.equal(claim(reopened, 'over-first-limit', 'other', now, 1), false);
    await writeFile(join(root, 'blocked'), 'not a directory');
    assert.throws(() => getStickerCollectionQuota(config(join(root, 'blocked', 'work'))));
    assert.equal(getStickerCollectionQuota(firstConfig), reopened);
    assert.equal(claim(reopened, 'still-over-limit', 'other', now, 1), false);
  } finally {
    globalThis.__agentLinkStickerQuota__?.store.close();
    if (original) globalThis.__agentLinkStickerQuota__ = original;
    else delete globalThis.__agentLinkStickerQuota__;
  }
}));
