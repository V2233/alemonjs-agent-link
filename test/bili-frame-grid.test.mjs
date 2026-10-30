import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { packVideoFrames, videoSampleTimes, videoSceneSampleTimes } from '../lib/bili/visual.js';
import { describeVideoFrames } from '../lib/media/providers.js';
import { biliEvidence } from '../lib/bili/evidence.js';
import { readingDiary } from '../lib/bili/diary.js';

const signal = () => new AbortController().signal;
const sourceFrames = () =>
  Promise.all(
    Array.from({ length: 9 }, async (_, index) => ({
      seconds: index + 1,
      data: await sharp({ create: { width: 16, height: 8, channels: 3, background: { r: index * 20, g: 30, b: 50 } } })
        .png()
        .toBuffer()
    }))
  );

test('nine samples cover all ninths, local scene cuts cannot consume other time segments', () => {
  const times = videoSampleTimes(90, undefined, 9);
  assert.deepEqual(times, [5, 15, 25, 35, 45, 55, 65, 75, 85]);
  assert.deepEqual(videoSceneSampleTimes(90, 'pts_time:1 pts_time:2 pts_time:8 pts_time:41 pts_time:87', 9), [2.1, 15, 25, 35, 41.1, 55, 65, 75, 87.1]);
  assert.deepEqual(videoSampleTimes(90, [85, 5], 9), [5, 85]);
  assert.ok(videoSampleTimes(0.001, undefined, 9).every(time => time < 0.001));
});

test('all nine observations survive three chronological full-frame boards with exact row pixels', async () => {
  const frames = await sourceFrames(),
    boards = await packVideoFrames(frames, signal());
  assert.equal(boards.length, 3);
  assert.deepEqual(
    boards.flatMap(board => board.positions),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
  for (const [index, board] of boards.entries()) {
    assert.equal(board.region, 'frame_grid');
    const { data, info } = await sharp(board.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 16);
    assert.equal(info.height, 32);
    for (let row = 0; row < 3; row++) {
      const offset = row * 12 * info.width * 3;
      assert.deepEqual([...data.subarray(offset, offset + 3)], [(index * 3 + row) * 20, 30, 50]);
    }
  }
  assert.equal(await packVideoFrames(frames.slice(0, 3), signal()).then(result => result[0]), frames[0]);
  for (const invalid of [[], [...frames, frames[0]], [frames[1], frames[0]], [{ ...frames[0], region: 'bottom_band' }]])
    await assert.rejects(packVideoFrames(invalid, signal()));
  await assert.rejects(packVideoFrames(frames, AbortSignal.abort()), { name: 'AbortError' });
});

test('high-entropy square frames preserve all rows and remain within the per-image byte cap', async () => {
  const data = await sharp(randomBytes(640 * 640 * 3), { raw: { width: 640, height: 640, channels: 3 } })
    .png()
    .toBuffer();
  const frames = Array.from({ length: 9 }, (_, index) => ({ seconds: index, data }));
  const boards = await packVideoFrames(frames, signal());
  assert.deepEqual(
    boards.flatMap(frame => frame.positions),
    frames.map(frame => frame.seconds)
  );
  for (const board of boards) {
    assert.ok(board.data.length <= 2 * 1024 * 1024);
    const info = await sharp(board.data).metadata();
    assert.equal(info.width, 480);
    assert.equal(info.height, 1448);
  }
});

test('actual vision request uses three boards and associates all nine row timestamps without claiming audio', async () => {
  const boards = await packVideoFrames(await sourceFrames(), signal());
  let calls = 0;
  const config = { vision: { model: 'fixture', baseUrl: 'https://fixture.example', apiKey: 'fixture' } };
  const description = await describeVideoFrames(boards, config, signal(), async (_config, _path, bytes) => {
    calls++;
    const body = JSON.parse(bytes),
      content = body.messages[1].content;
    assert.equal(body.max_tokens, 1200);
    assert.equal(content.filter(item => item.type === 'image_url').length, 3);
    assert.deepEqual(
      content.filter(item => item.type === 'text').map(item => item.text.match(/（秒）：([^；]+)/u)[1]),
      ['1、2、3', '4、5、6', '7、8、9']
    );
    assert.match(body.messages[0].content, /没有听到音频/);
    assert.match(body.messages[0].content, /每行是一张独立静帧/);
    return Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '1–9秒采样画面中可见不同色块。' } }] }));
  });
  assert.equal(calls, 1);
  const visual = { status: 'available', region: 'frame_grid', timestamps: boards.flatMap(board => board.positions), description };
  const evidence = biliEvidence({ status: 'empty', text: '' }, { status: 'available', items: [] }, visual);
  assert.equal(evidence.visualObserved, true);
  assert.equal(evidence.audioObserved, false);
  assert.equal(evidence.visualRegion, 'frame_grid');
  assert.equal(evidence.sampledTimestamps.length, 9);
  const diary = readingDiary(
    [
      {
        id: 'source',
        origin: 'event',
        kind: 'event',
        status: 'active',
        createdAt: Date.now(),
        tags: ['B站'],
        text: JSON.stringify({
          contentBasis: evidence.basis,
          visualStatus: visual.status,
          visualRegion: evidence.visualRegion,
          sampledTimestamps: evidence.sampledTimestamps
        })
      }
    ],
    24
  );
  assert.deepEqual(diary[0].sourceEvidence[0].sampledTimestamps, evidence.sampledTimestamps);
  assert.equal(diary[0].sourceEvidence[0].visualScope, 'sampled_frames');
  assert.equal(
    biliEvidence({ status: 'empty', text: '' }, { status: 'available', items: [] }, { ...visual, timestamps: Array(10).fill(1) }).visualObserved,
    false
  );
  await assert.rejects(
    describeVideoFrames([{ ...boards[0], positions: [1, 2, 3, 4] }], config, signal(), () => assert.fail('invalid board must not call model'))
  );
  await assert.rejects(
    describeVideoFrames(boards, config, signal(), async () =>
      Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '截断' } }] }))
    ),
    /截断/
  );
});

test('storyboard boards keep approximate origin on the actual model request', async () => {
  const boards = await packVideoFrames(
    (await sourceFrames()).map(frame => ({ ...frame, source: 'storyboard' })),
    signal()
  );
  assert.ok(boards.every(board => board.source === 'storyboard'));
  await describeVideoFrames(boards, { vision: { model: 'fixture' } }, signal(), async (_config, _path, bytes) => {
    const body = JSON.parse(bytes);
    assert.ok(body.messages[1].content.filter(item => item.type === 'text').every(item => item.text.includes('低清预览近似索引')));
    assert.match(body.messages[0].content, /时间只是近似索引/);
    return Buffer.from(JSON.stringify({ choices: [{ message: { content: '预览色块。' } }] }));
  });
});

test('known DeepSeek vision models explicitly disable thinking within the same bounded extraction request', async () => {
  const boards = await packVideoFrames(await sourceFrames(), signal());
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'DeepSeek-V4-Pro', 'other-vision']) {
    let calls = 0;
    await describeVideoFrames(boards, { vision: { model } }, signal(), async (_config, _path, bytes) => {
      calls++;
      const body = JSON.parse(bytes);
      assert.deepEqual(body.thinking, model === 'other-vision' ? undefined : { type: 'disabled' });
      assert.equal(body.max_tokens, 1200);
      return Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '采样中可见色块。' } }] }));
    });
    assert.equal(calls, 1);
  }
});
