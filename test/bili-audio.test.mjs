import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extractAudioExcerpt, pcmAudioSeconds } from '../lib/bili/audio.js';
import { createBiliClient, biliOptions } from '../lib/bili/client.js';
import { biliEvidence } from '../lib/bili/evidence.js';
import { readingDiary, formatReadingDiary } from '../lib/bili/diary.js';

let previous;
beforeEach(() => {
  previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false }, media: {
    vision: { baseUrl: 'https://vision.example/v1', apiKey: 'fixture', model: 'fixture' },
    asr: { baseUrl: 'http://127.0.0.1:12001/v1', model: 'fixture-local' }
  } } } };
});
afterEach(() => { globalThis.__config = previous; });
const signal = () => new AbortController().signal;
const mp4 = Buffer.from([0, 0, 0, 12, ...Buffer.from('ftypisom')]);
const wav = (seconds = 1) => {
  const size = Math.round(seconds * 32000), data = Buffer.alloc(44 + size);
  data.write('RIFF'); data.writeUInt32LE(36 + size, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(size, 40);
  return data;
};
const ok = data => Response.json({ code: 0, data });
const mock = ({ duration = 157, part = duration, subtitles = false } = {}) => {
  const calls = { playback: 0, videoDownloads: 0, transcriptions: 0 };
  const fetcher = async url => {
    if (url.endsWith('/nav')) return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
    if (url.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, duration, pages: [{ duration: part }] });
    if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: subtitles ? [{ subtitle_url: 'https://i0.hdslb.com/subtitle.json', lan: 'zh' }] : [] } });
    if (url.includes('/reply/')) return ok({ replies: [] });
    if (url.includes('/playurl')) { calls.playback++; return ok({ durl: [{ url: 'https://v.bilivideo.com/video.mp4' }] }); }
    throw new Error('unexpected API');
  };
  const download = async url => {
    if (url.endsWith('subtitle.json')) return Buffer.from(JSON.stringify({ body: [{ from: 0, to: 1, content: '官方返回字幕' }] }));
    calls.videoDownloads++; return mp4;
  };
  const services = {
    canDecode: async () => true,
    extract: async () => [{ seconds: 1, data: Buffer.alloc(0) }], describe: async () => '一个采样画面。',
    extractAudio: async (_bytes, _start, seconds) => ({ data: wav(seconds), seconds }),
    transcribe: async () => { calls.transcriptions++; return '受控ASR文字，不是真实识别。'; }
  };
  const client = (options = {}, overrides = {}) => createBiliClient({ cookie: '', timeoutMs: 5000, audioRead: true, ...options }, fetcher, download, { ...services, ...overrides });
  return { calls, client, fetcher, download, services };
};

test('audio read is opt-in and PCM validation rejects empty, malformed, oversized or inconsistent data', () => {
  assert.equal(biliOptions({}).audioRead, false); assert.throws(() => biliOptions({ audioRead: 'true' }));
  assert.equal(pcmAudioSeconds(wav(1.5)), 1.5);
  for (const bytes of [Buffer.alloc(0), wav(0), wav(61), wav(1).subarray(0, 100)]) assert.throws(() => pcmAudioSeconds(bytes));
  const stereo = wav(1); stereo.writeUInt16LE(2, 22); assert.throws(() => pcmAudioSeconds(stereo));
});

test('audio extraction uses local-only ffmpeg, measures actual PCM length and cleans up on success or failure', async () => {
  let root;
  const result = await extractAudioExcerpt(mp4, 147, 10, signal(), async (command, args) => {
    assert.equal(command, 'ffmpeg'); assert.equal(args[args.indexOf('-ss') + 1], '147');
    assert.equal(args[args.indexOf('-t') + 1], '10'); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
    assert.equal(args[args.indexOf('-ar') + 1], '16000'); root = dirname(args.at(-1)); await writeFile(args.at(-1), wav(2));
  });
  assert.equal(result.seconds, 2); await assert.rejects(access(root));
  await assert.rejects(extractAudioExcerpt(mp4, 0, 1, signal(), async (_command, args) => { root = dirname(args.at(-1)); await writeFile(args.at(-1), wav(2)); }));
  await assert.rejects(access(root));
  for (const seconds of [0, -1, 61, NaN, Infinity]) await assert.rejects(extractAudioExcerpt(mp4, 0, seconds, signal(), async () => assert.fail('must not decode')));
});

test('without subtitles a first read targets the question and marks only the actually decoded audio range', async () => {
  const f = mock();
  const result = await f.client().watch('BV1234567890', signal(), 'frames', undefined, { edge: 'end', seconds: 10 });
  assert.equal(result.audio.status, 'available'); assert.equal(result.audio.startSeconds, 147); assert.equal(result.audio.endSeconds, 157);
  assert.equal(result.evidence.basis, 'audio_excerpt'); assert.equal(result.evidence.audioObserved, false);
  assert.equal(result.evidence.audioTranscribed, true); assert.deepEqual(result.evidence.transcribedRange, [147, 157]);
  assert.equal(f.calls.playback, 1); assert.equal(f.calls.videoDownloads, 1); assert.equal(f.calls.transcriptions, 1);
  const shorter = await f.client({}, { extractAudio: async () => ({ data: wav(2), seconds: 2 }) }).watch('BV1234567890', signal(), 'frames', undefined, { edge: 'end', seconds: 10 });
  assert.equal(shorter.audio.endSeconds, 149);
  const boundedEnding = await f.client().watch('BV1234567890', signal(), 'frames', undefined, { edge: 'end', seconds: 100 });
  assert.deepEqual(boundedEnding.evidence.transcribedRange, [97, 157], 'a long ending request must retain the ending inside the 60-second bound');
});

test('visual and ASR stages share exactly one bounded MP4 download and retain independent evidence', async () => {
  const f = mock();
  const result = await f.client({ visualRead: true }).watch('BV1234567890', signal());
  assert.equal(result.visual.status, 'available'); assert.equal(result.audio.status, 'available');
  assert.equal(f.calls.playback, 1); assert.equal(f.calls.videoDownloads, 1); assert.equal(f.calls.transcriptions, 1);
  assert.equal(result.audio.endSeconds, 60); assert.equal(result.evidence.visualObserved, true); assert.equal(result.evidence.audioObserved, false);
});

test('returned subtitles suppress fallback ASR and disabled audio performs no video work', async () => {
  const official = mock({ subtitles: true }); const result = await official.client().watch('BV1234567890', signal());
  assert.equal(result.audio.status, 'not_needed'); assert.equal(result.evidence.basis, 'subtitles');
  assert.equal(official.calls.videoDownloads, 0); assert.equal(official.calls.transcriptions, 0);
  const disabled = mock(); const off = await disabled.client({ audioRead: false }).watch('BV1234567890', signal());
  assert.equal(off.audio.status, 'disabled'); assert.equal(disabled.calls.videoDownloads, 0);
});

test('missing or remote ASR, absent ffmpeg and invalid part ranges cannot start downloads or transcription', async () => {
  for (const asr of [undefined, { baseUrl: 'https://asr.example/v1', apiKey: 'fixture', model: 'fixture' }]) {
    globalThis.__config.value['alemonjs-agent-link'].media.asr = asr;
    const f = mock(); const result = await f.client().watch('BV1234567890', signal());
    assert.equal(result.audio.status, 'unconfigured'); assert.equal(f.calls.videoDownloads, 0); assert.equal(f.calls.transcriptions, 0);
  }
  globalThis.__config.value['alemonjs-agent-link'].media.asr = { baseUrl: 'http://127.0.0.1:12001/v1', model: 'fixture-local' };
  const missing = mock(); const noFfmpeg = await missing.client({}, { canDecode: async () => false }).watch('BV1234567890', signal());
  assert.equal(noFfmpeg.audio.failedAt, 'decode'); assert.equal(missing.calls.videoDownloads, 0);
  const part = mock({ duration: 157, part: 20 });
  const bad = await part.client().watch('BV1234567890', signal(), 'frames', undefined, { edge: 'range', start: 19, end: 25 });
  assert.equal(bad.audio.failedAt, 'selection'); assert.equal(part.calls.videoDownloads, 0);
});

test('ASR failures do not erase metadata or fabricate a transcript, and truncation is explicit', async () => {
  const f = mock();
  for (const overrides of [{ extractAudio: async () => { throw new Error('decode'); } }, { transcribe: async () => { throw new Error('asr'); } }, { extractAudio: async () => ({ data: wav(1), seconds: NaN }) }]) {
    const result = await f.client({}, overrides).watch('BV1234567890', signal());
    assert.equal(result.ok, true); assert.equal(result.audio.status, 'unavailable'); assert.equal(result.audio.text, '');
    assert.equal(result.evidence.audioTranscribed, false); assert.equal(result.evidence.basis, 'metadata');
  }
  const clipped = await f.client({}, { transcribe: async () => '字'.repeat(4001) }).watch('BV1234567890', signal());
  assert.equal(clipped.audio.text.length, 4000); assert.equal(clipped.audio.truncated, true);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(f.client().watch('BV1234567890', controller.signal), /cancelled/);
});

test('a local ASR receives a real multipart clip through the complete watch fallback', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    try {
      const form = await new Request('http://127.0.0.1/', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).formData();
      assert.equal(req.url, '/v1/audio/transcriptions'); assert.equal(form.get('model'), 'fixture-local');
      assert.equal(form.get('file').name, 'speech.wav'); assert.equal(pcmAudioSeconds(Buffer.from(await form.get('file').arrayBuffer())), 1);
      received.push(true); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '仅HTTP夹具，不代表真实识别。' }));
    } catch (error) { server.testError = error; res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    globalThis.__config.value['alemonjs-agent-link'].media.asr.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const f = mock({ duration: 1 });
    const client = createBiliClient({ cookie: '', timeoutMs: 5000, audioRead: true }, f.fetcher, f.download, { ...f.services, transcribe: undefined });
    const result = await client.watch('BV1234567890', signal());
    if (server.testError) throw server.testError;
    assert.equal(result.audio.status, 'available'); assert.equal(received.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('reading provenance keeps validated ASR bounds separate from listening and rejects invented ranges', () => {
  const now = 1000000;
  const source = details => ({ id: 'abcdef123456', status: 'active', origin: 'event', kind: 'event', tags: ['B站'], subjectId: 'fish', createdAt: now,
    text: JSON.stringify({ bvid: 'BV1234567890', contentBasis: 'audio_excerpt', visualStatus: 'disabled', audioObserved: false, ...details }) });
  const thought = { ...source({}), id: 'thought', origin: 'diary', kind: 'diary', tags: ['B站', 'reading:abcdef123456'], text: JSON.stringify({ sourceReadingIds: ['abcdef123456'], thought: '仅是读到转写后的想法' }) };
  const rows = readingDiary([source({ audioStatus: 'available', audioTranscribed: true, transcribedRange: [147, 157] }), thought], 24, now);
  const evidence = rows.find(row => row.id === 'thought').sourceEvidence[0];
  assert.equal(evidence.audioScope, 'transcribed_excerpt'); assert.deepEqual(evidence.transcribedRange, [147, 157]);
  assert.equal(evidence.contentBasis, 'audio_excerpt'); assert.match(formatReadingDiary(rows, 24, 'UTC'), /ASR转写片段/u);
  for (const range of [[0, 61], [3, 2], [0, NaN], [99999, 100000]]) {
    const bad = readingDiary([source({ audioStatus: 'available', audioTranscribed: true, transcribedRange: range }), thought], 24, now).find(row => row.id === 'thought').sourceEvidence[0];
    assert.equal(bad.contentBasis, 'unknown'); assert.equal(bad.audioScope, 'not_observed');
  }
  const invalid = biliEvidence({ status: 'empty', text: '' }, { status: 'available', items: [] }, undefined, { status: 'available', text: '伪造', startSeconds: 0, endSeconds: 61 });
  assert.equal(invalid.audioTranscribed, false);
});
