import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import sharp from 'sharp';
import { videoSampleTimes, visualSampleRequest, extractVideoFrames } from '../lib/bili/visual.js';
import { extractSubtitleStrips } from '../lib/bili/subtitle-visual.js';
import { extractStoryboardFrames } from '../lib/bili/storyboard.js';
import { createBiliClient } from '../lib/bili/client.js';
import { getMediaConfig } from '../lib/media/config.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { biliModule } from '../lib/modules/bili.js';
import { getMemoryStore, experienceMemoryId } from '../lib/memory/store.js';
import { questionTimeWindow, windowSampleTimes } from '../lib/bili/time-window.js';

let previous;
beforeEach(() => {
  previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { vision: { baseUrl: 'https://vision.example/v1', apiKey: 'fixture', model: 'fixture' } } } } };
});
afterEach(() => { globalThis.__config = previous; });
const signal = () => new AbortController().signal;
const mp4 = Buffer.from([0, 0, 0, 12, ...Buffer.from('ftypisom')]);
const png = () => sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer();
const snapshot = () => ({ img_x_len: 2, img_y_len: 2, img_x_size: 8, img_y_size: 8, image: ['https://bimp.hdslb.com/1.png'], index: [0, 5, 10, 15] });
const ok = data => Response.json({ code: 0, data });
const fetcher = counts => async url => {
  if (url.endsWith('/nav')) return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
  if (url.includes('/wbi/view')) { counts.views++; return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, duration: 120, pages: [{ duration: 20 }] }); }
  if (url.includes('/playurl')) { counts.play++; return ok({ durl: [{ url: 'https://v.bilivideo.com/a.mp4' }] }); }
  if (url.includes('/videoshot')) { counts.preview++; return ok(snapshot()); }
  if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [] } });
  if (url.includes('/reply/')) return ok({ replies: [] });
  throw new Error('unexpected API');
};
const counts = () => ({ views: 0, play: 0, preview: 0, downloads: 0 });

test('explicit question windows select the requested interval without guessing ambiguous or negative requests', () => {
  assert.deepEqual(questionTimeWindow('最后10秒展示什么？'), { edge: 'end', seconds: 10 });
  assert.deepEqual(windowSampleTimes(157, questionTimeWindow('最后10秒展示什么？')), { start: 147, end: 157, timestamps: [148, 152, 156] });
  assert.deepEqual(windowSampleTimes(20, questionTimeWindow('开头10秒')), { start: 0, end: 10, timestamps: [1, 5, 9] });
  assert.deepEqual(windowSampleTimes(20, questionTimeWindow('10秒到20秒是什么')), { start: 10, end: 20, timestamps: [11, 15, 19] });
  assert.deepEqual(windowSampleTimes(5, questionTimeWindow('最后10秒')).timestamps, [0.5, 2.5, 4.5]);
  for (const text of ['不要看最后10秒', '不是最后10秒', '例如最后10秒', '最后0秒', '最后999999秒', '前10秒和最后10秒', '20到10秒', '-10到20秒', '最后10秒到20秒', '最后10秒之前', '第30秒和最后10秒', '最后几秒', '最后十秒', '看整体', '前10秒'.repeat(2000)]) assert.equal(questionTimeWindow(text), undefined, text.slice(0, 30));
  assert.throws(() => windowSampleTimes(20, { edge: 'range', start: 10, end: 21 }));
  assert.throws(() => windowSampleTimes(0, { edge: 'end', seconds: 10 }));
});

for (const mode of ['frames', 'subtitles', 'storyboard']) {
  test(`question window targets the first ${mode} read with the same bounded request count`, async () => {
    const calls = counts();
    const extract = async (_bytes, duration, _signal, _execute, at) => {
      assert.equal(duration, 20); assert.deepEqual(at, [11, 15, 19]);
      return mode === 'subtitles' ? [{ seconds: at[0], positions: at, region: 'bottom_band', data: await png() }] : at.map(seconds => ({ seconds, data: Buffer.alloc(0) }));
    };
    const client = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: true }, fetcher(calls), async () => { calls.downloads++; return mode === 'storyboard' ? png() : mp4; }, {
      canDecode: async () => mode !== 'storyboard', extract, extractSubtitles: extract, describe: async () => '仅采样范围。'
    });
    const result = await client.watch('BV1234567890', signal(), mode === 'subtitles' ? 'subtitles' : 'frames', undefined, { edge: 'end', seconds: 10 });
    assert.equal(result.visual.status, 'available');
    assert.deepEqual(result.visual.requestedWindow, { start: 10, end: 20 });
    assert.equal(result.visual.samplingReason, 'question_window');
    assert.deepEqual(result.visual.requestedTimestamps, [11, 15, 19]);
    assert.deepEqual(result.visual.timestamps, mode === 'storyboard' ? [10, 15] : [11, 15, 19]);
    assert.deepEqual(result.evidence.sampledTimestamps, result.visual.timestamps);
    assert.equal(calls.views, 1); assert.equal(calls.downloads, 1);
  });
}

test('explicit points override inferred windows and invalid windows do not silently read default frames', async () => {
  const calls = counts();
  const client = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: true }, fetcher(calls), async () => { assert.fail('must not download'); }, {
    extract: async () => { assert.fail('must not decode'); }, describe: async () => { assert.fail('must not call vision'); }
  });
  const bad = await client.watch('BV1234567890', signal(), 'frames', undefined, { edge: 'range', start: 10, end: 30 });
  assert.equal(bad.visual.failedAt, 'selection'); assert.equal(bad.evidence.visualObserved, false);
  assert.match(bad.visual.message, /未读取其他位置/); assert.equal(calls.play, 0);
  const disabled = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: false }, fetcher(calls));
  const result = await disabled.watch('BV1234567890', signal(), 'frames', [2], { edge: 'end', seconds: 10 });
  assert.deepEqual(result.visual.requestedTimestamps, [2]); assert.equal(result.visual.requestedWindow, undefined);
  const inferredDisabled = await disabled.watch('BV1234567890', signal(), 'frames', undefined, { edge: 'end', seconds: 10 });
  assert.equal(inferredDisabled.visual.status, 'disabled'); assert.deepEqual(inferredDisabled.visual.requestedTimestamps, [11, 15, 19]);
});

test('only the current explicit single-video user question can select a window; automatic reads keep normal sampling', async () => {
  const oldFetch = globalThis.fetch, tools = [], calls = counts();
  globalThis.fetch = fetcher(calls);
  const module = biliModule(); module.setup({ settings: { visualRead: false }, tool: tool => tools.push(tool), on() {} });
  const tool = tools.find(tool => tool.name === 'bili_watch');
  const context = { userText: '看BV1234567890，最后10秒是什么？', private: true, owner: false, signal: signal() };
  try {
    const result = await tool.execute({ link: 'https://www.bilibili.com/video/BV1234567890' }, context);
    assert.deepEqual(result.visual.requestedTimestamps, [11, 15, 19]);
    for (const change of [{ autonomous: true, owner: true }, { userText: 'BV1234567890和BVabcdefghij，最后10秒' }, { userText: 'BVabcdefghij最后10秒' }, { userText: '看看最后10秒' }, { userText: 'BV1234567890不要看最后10秒' }]) {
      const read = await tool.execute({ link: 'BV1234567890' }, { ...context, ...change });
      assert.equal(read.ok, true); assert.equal(read.visual.requestedTimestamps, undefined);
    }
  } finally { globalThis.fetch = oldFetch; }
});

test('target positions are bounded, deduplicated and sorted, with an exclusive part-duration boundary', () => {
  assert.equal(visualSampleRequest(undefined), undefined);
  assert.deepEqual(videoSampleTimes(20, [18, 2, 18]), [2, 18]);
  assert.deepEqual(videoSampleTimes(20, [0]), [0]);
  for (const bad of [[], [1, 2, 3, 4], [-1], [NaN], [Infinity], ['2'], '2', [86401]]) assert.throws(() => visualSampleRequest(bad));
  assert.throws(() => videoSampleTimes(20, [20]));
  assert.throws(() => videoSampleTimes(20, [21]));
});

test('explicit MP4 positions bypass scene snapping and clean up local frames', async () => {
  const seeks = []; let root;
  const frames = await extractVideoFrames(mp4, 20, signal(), async (command, args) => {
    assert.equal(command, 'ffmpeg');
    assert.ok(args.includes('-ss'), 'explicit requests must not run the scene probe');
    seeks.push(Number(args[args.indexOf('-ss') + 1]));
    root = dirname(args.at(-1));
    await writeFile(args.at(-1), await png());
  }, [18, 2, 18]);
  assert.deepEqual(seeks, [2, 18]);
  assert.deepEqual(frames.map(frame => frame.seconds), [2, 18]);
  await assert.rejects(access(root));
});

test('targeted subtitle crops use requested positions instead of twelve full-video samples', async () => {
  const seeks = [];
  const boards = await extractSubtitleStrips(mp4, 20, signal(), async (_command, args) => {
    seeks.push(Number(args[args.indexOf('-ss') + 1]));
    assert.match(args[args.indexOf('-vf') + 1], /crop=iw:ih\*0.25/);
    await writeFile(args.at(-1), await png());
  }, [18, 2]);
  assert.deepEqual(seeks, [2, 18]);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].region, 'bottom_band');
  assert.deepEqual(boards[0].positions, [2, 18]);
});

test('storyboard targets return nearest actual indexed times without fabricating requested frames', async () => {
  let downloads = 0;
  const frames = await extractStoryboardFrames(snapshot(), 20, getMediaConfig(), signal(), async () => { downloads++; return png(); }, [18, 19]);
  assert.equal(downloads, 1);
  assert.deepEqual(frames.map(frame => frame.seconds), [15]);
  assert.equal(frames[0].source, 'storyboard');
});

for (const mode of ['frames', 'subtitles', 'storyboard']) {
  test(`watch forwards target positions to ${mode} and returns actual scope separately`, async () => {
    const calls = counts();
    const extract = async (_bytes, duration, _signal, execute, at) => {
      assert.equal(duration, 20); assert.equal(execute, undefined); assert.deepEqual(at, [2, 18]);
      return mode === 'subtitles' ? [{ seconds: 2, positions: at, region: 'bottom_band', data: await png() }] : at.map(seconds => ({ seconds, data: Buffer.alloc(0) }));
    };
    const client = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: true }, fetcher(calls), async () => { calls.downloads++; return mode === 'storyboard' ? png() : mp4; }, {
      canDecode: async () => mode !== 'storyboard', extract, extractSubtitles: extract, describe: async () => '可见有限采样内容。'
    });
    const result = await client.watch('BV1234567890', signal(), mode === 'subtitles' ? 'subtitles' : 'frames', [18, 2]);
    assert.equal(result.visual.status, 'available');
    assert.deepEqual(result.visual.requestedTimestamps, [2, 18]);
    assert.deepEqual(result.visual.timestamps, mode === 'storyboard' ? [0, 15] : [2, 18]);
    assert.deepEqual(result.evidence.sampledTimestamps, result.visual.timestamps);
    assert.equal(result.evidence.audioObserved, false);
    assert.equal(calls.play, mode === 'storyboard' ? 0 : 1);
  });
}

test('out-of-part-range targets preserve metadata but do not download or silently read other positions', async () => {
  const calls = counts();
  const client = createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: true }, fetcher(calls), async () => { assert.fail('must not download'); }, {
    extract: async () => { assert.fail('must not decode'); }, describe: async () => { assert.fail('must not call vision'); }
  });
  const result = await client.watch('BV1234567890', signal(), 'frames', [21]);
  assert.equal(result.video.duration, 120);
  assert.equal(result.video.partDuration, 20);
  assert.equal(result.visual.failedAt, 'selection');
  assert.match(result.visual.message, /未读取其他位置/);
  assert.equal(result.evidence.visualObserved, false);
  assert.equal(calls.play, 0); assert.equal(calls.preview, 0);
  await assert.rejects(() => client.watch('BV1234567890', signal(), 'frames', []), /采样位置/);
  assert.equal(calls.views, 1);
});

test('requested positions never enable disabled visual reading', async () => {
  const calls = counts();
  const result = await createBiliClient({ cookie: '', timeoutMs: 5000, visualRead: false }, fetcher(calls), async () => { assert.fail('must not download'); }).watch('BV1234567890', signal(), 'frames', [2]);
  assert.equal(result.visual.status, 'disabled');
  assert.deepEqual(result.visual.requestedTimestamps, [2]);
  assert.equal(calls.play, 0); assert.equal(calls.preview, 0);
});

test('tool exposes bounded targets and persists distinct reading variants without bypassing autonomous repeat limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-visual-at-'));
  const oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), stateBackend: 'local', modules: { settings: { bili: { visualRead: false } } } } } };
  const config = getDSHConfig(), calls = counts(), tools = [];
  globalThis.fetch = fetcher(calls);
  const module = biliModule(config); module.setup({ settings: {}, tool: tool => tools.push(tool), on() {} });
  const tool = tools.find(tool => tool.name === 'bili_watch');
  const context = { platform: 'onebot', channelId: 'private:viewer', userId: 'viewer', botId: 'fish', inputId: 'same-turn', private: true, owner: false, signal: signal() };
  const store = getMemoryStore(config);
  try {
    assert.equal(tool.parameters.properties.visualAt.maxItems, 3);
    assert.equal((await tool.execute({ link: 'BV1234567890' }, context)).ok, true);
    assert.equal((await tool.execute({ link: 'BV1234567890', visualAt: [2] }, context)).ok, true);
    assert.equal((await tool.execute({ link: 'BV1234567890', visualAt: [2] }, context)).ok, true);
    let rows = store.list(context);
    assert.equal(rows.length, 2);
    assert.ok(rows.some(row => row.id === experienceMemoryId(JSON.stringify(['bili-read', 'same-turn', 'BV1234567890']))));
    assert.ok(rows.some(row => row.text.includes('requestedTimestamps')));
    const asked = { ...context, userText: 'BV1234567890最后10秒是什么？' };
    assert.equal((await tool.execute({ link: 'BV1234567890' }, asked)).ok, true);
    assert.equal((await tool.execute({ link: 'BV1234567890', visualAt: [11, 15, 19] }, asked)).ok, true);
    rows = store.list(context);
    assert.equal(rows.length, 3, 'question-selected locations must not overwrite the original default reading or duplicate equivalent explicit locations');
    assert.ok(rows.some(row => row.id === experienceMemoryId(JSON.stringify(['bili-read', 'same-turn', 'BV1234567890', { visualFocus: 'frames', visualAt: [11, 15, 19] }]))));
    const autonomous = { ...context, inputId: 'auto-turn', owner: true, autonomous: true, independentReading: true };
    assert.equal((await tool.execute({ link: 'BV1234567890', visualAt: [2] }, autonomous)).ok, true);
    const before = calls.views;
    assert.equal((await tool.execute({ link: 'BV1234567890', visualAt: [18] }, autonomous)).ok, false);
    assert.equal(calls.views, before);
  } finally { store.close(); globalThis.fetch = oldFetch; await rm(root, { recursive: true, force: true }); }
});
