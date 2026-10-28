import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ResultCode } from 'alemonjs';
import { readRecordFile } from '../lib/onebot/record-file.js';
import { resolveOneBotConfig } from '../lib/onebot/config.js';
import { OneBotActions } from '../lib/onebot/actions.js';

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
const event = { Platform: 'onebot', BotId: '900', IsPrivate: true, UserId: '100', MessageId: '42', MessageMedia: [{ Type: 'audio', _onebotRecordFile: 'voice-token' }] };

test('configured cache reads bounded WAV and rejects outside files and escaping symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'record-file-'));
  const cache = join(root, 'cache');
  const outside = join(root, 'outside.wav');
  try {
    await mkdir(cache);
    await writeFile(join(cache, 'voice.wav'), wav);
    await writeFile(outside, wav);
    await writeFile(join(cache, 'wrong.wav'), 'not audio');
    await symlink(outside, join(cache, 'escape.wav'));
    assert.deepEqual(await readRecordFile(cache, join(cache, 'voice.wav')), wav);
    assert.deepEqual(await readRecordFile(cache, pathToFileURL(join(cache, 'voice.wav')).href), wav);
    await assert.rejects(readRecordFile(undefined, join(cache, 'voice.wav')));
    await assert.rejects(readRecordFile(cache, outside));
    await assert.rejects(readRecordFile(cache, join(cache, 'escape.wav')));
    await assert.rejects(readRecordFile(cache, join(cache, 'wrong.wav')));
    await assert.rejects(readRecordFile(cache, join(cache, 'voice.wav'), wav.length - 1));
    await assert.rejects(readRecordFile(cache, 'relative.wav'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OneBot returns WAV bytes from configured cache or a base64 file, and denies unconfigured paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'record-adapter-'));
  try {
    const path = join(root, 'voice.wav');
    await writeFile(path, wav);
    let result = { file: path };
    const connection = { config: { selfId: '900', recordDirectory: root }, call: async (action, args) => {
      assert.equal(action, 'get_record');
      assert.deepEqual(args, { file: 'voice-token', out_format: 'wav' });
      return result;
    } };
    const adapter = new OneBotActions(connection, () => ({ owner: () => true, groups: [], disabled: [] }));
    const convert = () => adapter.api({ payload: { event, key: 'agentLink.convertCurrentVoice', params: [] } });
    const fromPath = await convert();
    assert.equal(fromPath[0].code, ResultCode.Ok);
    assert.deepEqual(Buffer.from(fromPath[0].data.base64, 'base64'), wav);
    delete connection.config.recordDirectory;
    assert.notEqual((await convert())[0].code, ResultCode.Ok);
    result = { file: path, url: 'https://cdn.example/converted.wav' };
    assert.equal((await convert())[0].data.url, 'https://cdn.example/converted.wav');
    result = { file: `base64://${wav.toString('base64')}` };
    assert.equal((await convert())[0].code, ResultCode.Ok);
    const config = resolveOneBotConfig({ onebot: { url: 'ws://127.0.0.1:3001', selfId: '900', recordDirectory: root } });
    assert.equal(config.recordDirectory, root);
    assert.throws(() => resolveOneBotConfig({ onebot: { url: 'ws://127.0.0.1:3001', selfId: '900', recordDirectory: 'relative' } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
