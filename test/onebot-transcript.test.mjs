import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode, getConfig } from 'alemonjs';
import { OneBotActions } from '../lib/onebot/actions.js';
import { currentVoiceTranscript } from '../lib/media/onebot-transcript.js';
import { prepareNativeMedia } from '../lib/media/providers.js';
import { getMediaConfig } from '../lib/media/config.js';
import { normalizeOneBotEvent } from '../lib/onebot/events.js';

const event = { Platform: 'onebot', BotId: '900', IsPrivate: true, UserId: '100', MessageId: '42', MessageMedia: [{ Type: 'audio' }] };

test('current voice crosses the platform bridge and becomes model input without an external ASR', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    return { text: '  今天想吃饭  ' };
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    const media = await currentVoiceTranscript(event);
    assert.equal(media[0].Transcript, '今天想吃饭');
    assert.equal(event.MessageMedia[0].Transcript, undefined);
    const input = await prepareNativeMedia(media, '', { maxAttachments: 4 }, new AbortController().signal);
    assert.match(input, /今天想吃饭/);
    assert.deepEqual(calls, [{ action: 'fetch_ptt_text', args: { message_id: 42 } }]);
  });
});

test('voice lookup rejects ambiguous inputs and falls back if the extension fails', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  let calls = 0;
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async () => { calls++; throw new Error('unsupported'); } },
    () => ({ owner: () => true, groups: [], disabled: [] }));
  const api = (input, args = {}) => adapter.api({ payload: { event: input, key: 'agentLink.transcribeCurrentVoice', params: [args] } });
  assert.notEqual((await api({ ...event, MessageMedia: [...event.MessageMedia, ...event.MessageMedia] }))[0].code, ResultCode.Ok);
  assert.notEqual((await api({ ...event, MessageId: 'bad' }))[0].code, ResultCode.Ok);
  assert.notEqual((await api({ ...event, BotId: '901' }))[0].code, ResultCode.Ok);
  assert.equal(calls, 0);
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    assert.deepEqual(await currentVoiceTranscript(event), event.MessageMedia);
    assert.equal(calls, 1);
    const existing = { ...event, MessageMedia: [{ Type: 'audio', Transcript: '已有转写' }] };
    assert.deepEqual(await currentVoiceTranscript(existing), existing.MessageMedia);
    assert.equal(calls, 1);
  });
});

test('separate group messages use their own message IDs', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (_action, args) => {
    calls.push(args.message_id);
    return { text: `语音 ${args.message_id}` };
  } }, () => ({ owner: () => false, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    const group = { ...event, IsPrivate: false, ChannelId: '200' };
    const results = await Promise.all([currentVoiceTranscript(group), currentVoiceTranscript({ ...group, UserId: '101', MessageId: '43' })]);
    assert.deepEqual(calls, [42, 43]);
    assert.deepEqual(results.map(items => items[0].Transcript), ['语音 42', '语音 43']);
  });
});

test('QQ record conversion feeds bounded WAV to configured ASR when native transcription fails', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const raw = { post_type: 'message', message_type: 'private', self_id: 900, user_id: 100, message_id: 42,
    message: [{ type: 'record', data: { file: 'record-token', url: 'https://example.test/voice.silk' } }] };
  const normalized = normalizeOneBotEvent(raw, '900', () => true);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    if (action === 'fetch_ptt_text') throw new Error('not supported');
    assert.equal(action, 'get_record');
    return { base64: wav.toString('base64') };
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  const originalFetch = globalThis.fetch;
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { budget: { enabled: false }, media: { asr: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'local' } } } });
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:8000/v1/audio/transcriptions');
        const file = init.body.get('file');
        assert.equal(file.name, 'speech.wav');
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
        return Response.json({ text: '转码后的语音' });
      };
      const media = await currentVoiceTranscript(normalized);
      const result = await prepareNativeMedia(media, '', getMediaConfig(), new AbortController().signal, async () => assert.fail('should use gateway WAV'));
      assert.match(result, /转码后的语音/);
      assert.deepEqual(calls, [{ action: 'fetch_ptt_text', args: { message_id: 42 } }, { action: 'get_record', args: { file: 'record-token', out_format: 'wav' } }]);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('converted audio rejects malformed bytes and ambiguous messages', async () => {
  let calls = 0;
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async () => { calls++; return { base64: Buffer.from('not wav').toString('base64') }; } },
    () => ({ owner: () => true, groups: [], disabled: [] }));
  const source = { ...event, MessageMedia: [{ Type: 'audio', _onebotRecordFile: 'token' }] };
  const call = input => adapter.api({ payload: { event: input, key: 'agentLink.convertCurrentVoice', params: [] } });
  assert.notEqual((await call({ ...source, MessageMedia: [...source.MessageMedia, ...source.MessageMedia] }))[0].code, ResultCode.Ok);
  assert.equal(calls, 0);
  assert.notEqual((await call(source))[0].code, ResultCode.Ok);
  assert.equal(calls, 1);
});
