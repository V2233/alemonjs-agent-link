import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomaticReadingAttempts } from '../lib/bili/automatic-reading.js';
import { biliModule } from '../lib/modules/bili.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';

const bv = 'BV1234567890';
const overview = { video: { bvid: bv }, visual: { region: 'frame_grid', timestamps: [2, 8] }, evidence: { visualObserved: true } };

test('budget snapshots distinguish pending, refinable and exhausted attempts without changing admission', () => {
  const state = new AutomaticReadingAttempts();
  const first = state.claim({ link: bv }, 2, true);
  assert.deepEqual(state.snapshot(2, true), { attemptsUsed: 1, remainingAttempts: 1, refinableVideos: [] });
  state.complete(first, overview);
  assert.deepEqual(state.snapshot(2, true), { attemptsUsed: 1, remainingAttempts: 1, refinableVideos: [bv] });
  assert.deepEqual(state.snapshot(1, true), { attemptsUsed: 1, remainingAttempts: 0, refinableVideos: [] });
  assert.deepEqual(state.snapshot(2, false), { attemptsUsed: 1, remainingAttempts: 1, refinableVideos: [] });
  assert.equal(state.claim({ link: bv, visualAt: [2] }, 2, true), undefined);
  assert.equal(state.rejectionReason({ link: bv, visualAt: [2] }, 2, true), 'already_sampled_points');
  assert.equal(state.snapshot(2, true).remainingAttempts, 1);
  assert.ok(state.claim({ link: bv, visualAt: [5] }, 2, true));
  assert.deepEqual(state.snapshot(2, true), { attemptsUsed: 2, remainingAttempts: 0, refinableVideos: [] });
  assert.equal(state.rejectionReason({ link: bv, visualAt: [6] }, 2, true), 'attempt_limit');
});

test('rejection reasons distinguish an absent overview, invalid parameters and a spent refinement', () => {
  const state = new AutomaticReadingAttempts();
  const first = state.claim({ link: bv }, 3, true);
  assert.equal(state.rejectionReason({ link: bv, visualAt: [5] }, 3, true), 'overview_required');
  state.complete(first, overview);
  assert.equal(state.rejectionReason({ link: bv }, 3, true), 'explicit_times_required');
  assert.equal(state.rejectionReason({ link: bv, visualAt: [NaN] }, 3, true), 'invalid_refinement_request');
  assert.equal(state.rejectionReason({ link: bv, visualAt: [5] }, 3, false), 'refinement_disabled');
  state.complete(state.claim({ link: bv, visualAt: [5] }, 3, true));
  assert.equal(state.rejectionReason({ link: bv, visualAt: [6] }, 3, true), 'refinement_already_attempted');
});

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'bili-reading-budget-')),
    oldConfig = globalThis.__config,
    oldFetch = globalThis.fetch;
  const settings = { allowProactiveBrowse: true, visualRead: true, dailyBrowseMaxReads: 2 };
  const raw = {
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    stateBackend: 'local',
    budget: { enabled: false },
    modules: { disabled: ['memory'], settings: { bili: settings } }
  };
  globalThis.__config = { value: { 'alemonjs-agent-link': raw } };
  let views = 0;
  globalThis.fetch = async url => {
    const ok = data => Response.json({ code: 0, data });
    if (url.endsWith('/nav'))
      return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
    if (url.includes('/wbi/view')) {
      views++;
      return ok({ bvid: new URL(url).searchParams.get('bvid'), aid: 1, cid: 2, title: 'fixture', duration: 20 });
    }
    if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [] } });
    if (url.includes('/reply/')) return ok({ replies: [] });
    assert.fail('metadata-only fixture must not download images or call a model');
  };
  const tools = [],
    config = getDSHConfig();
  biliModule(config).setup({ settings, tool: tool => tools.push(tool), on() {} });
  const context = {
    platform: 'onebot',
    channelId: 'private:viewer',
    userId: 'viewer',
    botId: 'fish',
    private: true,
    owner: true,
    autonomous: true,
    independentReading: true,
    userText: '',
    signal: new AbortController().signal
  };
  try {
    await run({ tool: tools.find(tool => tool.name === 'bili_watch'), context, raw, views: () => views, root });
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
};

test('actual tool returns remaining attempts for metadata-only results and duplicate rejection', () =>
  fixture(async ({ tool, context, views }) => {
    const first = await tool.execute({ link: bv }, context);
    assert.equal(first.evidence.visualObserved, false);
    assert.deepEqual(first.automaticReading, { attemptsUsed: 1, remainingAttempts: 1, refinableVideos: [] });
    const denied = await tool.execute({ link: bv, visualAt: [5] }, context);
    assert.equal(denied.ok, false);
    assert.equal(denied.automaticReading.rejectionReason, 'overview_required');
    assert.equal(denied.automaticReading.remainingAttempts, 1);
    assert.equal(views(), 1);
    const next = await tool.execute({ link: 'BVabcdefghij' }, context);
    assert.equal(next.automaticReading.remainingAttempts, 0);
    assert.equal(views(), 2);
  }));

test('budget results recheck live shutdown and directory changes instead of reporting stale permission', () =>
  fixture(async ({ tool, context, raw, root, views }) => {
    await tool.execute({ link: bv }, context);
    for (const patch of [{ aiEnabled: false }, { dshHomeRoot: join(root, 'other-home') }]) {
      const previous = { ...raw };
      Object.assign(raw, patch);
      const result = await tool.execute({ link: 'BVabcdefghij' }, context);
      assert.equal(result.ok, false);
      assert.equal(result.automaticReading.remainingAttempts, 0);
      assert.equal(result.automaticReading.rejectionReason, 'browsing_disabled');
      assert.equal(views(), 1);
      Object.keys(raw).forEach(key => delete raw[key]);
      Object.assign(raw, previous);
    }
  }));
