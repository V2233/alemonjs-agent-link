import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode } from 'alemonjs';
import { OneBotActions } from '../lib/onebot/actions.js';

const adapter = call => new OneBotActions({ config: { selfId: '900' }, call }, () => ({ owner: () => false, groups: [], disabled: [] }));
const frame = overrides => ({
  payload: {
    key: 'agentLink.stickerFavorites',
    event: { Platform: 'onebot', IsMaster: true, UserId: '100', ChannelId: '200', IsPrivate: false },
    params: [{ count: 10 }],
    ...overrides
  }
});

test('favorites action reads only its own QQ account and normalizes URLs', async () => {
  let seen;
  const result = await adapter(async (action, args) => {
    seen = { action, args };
    return ['https://cdn.test/a.png', { url: 'https://cdn.test/b.png' }, 'http://cdn.test/c.png', 'https://cdn.test/d.png?x=1'];
  }).api(frame());
  assert.equal(result.length, 1);
  assert.equal(result[0].code, ResultCode.Ok);
  assert.deepEqual(result[0].data.urls, ['https://cdn.test/a.png', 'https://cdn.test/b.png', 'https://cdn.test/d.png?x=1']);
  assert.deepEqual(seen, { action: 'fetch_custom_face', args: { count: 10 } });
});

test('favorites action rejects non-owners, invalid counts and foreign bots', async () => {
  const instance = adapter(async () => assert.fail('must not call the gateway'));
  const api = instance.api.bind(instance);
  for (const payload of [
    frame({ event: { Platform: 'onebot', IsMaster: false, UserId: '100', ChannelId: '200', IsPrivate: false } }),
    frame({ params: [{ count: 0 }] }),
    frame({ params: [{ count: 501 }] }),
    frame({ event: { Platform: 'onebot', IsMaster: true, UserId: '100', ChannelId: '200', IsPrivate: false, BotId: '901' } })
  ]) {
    const result = await api(payload);
    assert.equal(result[0].code, ResultCode.Fail);
  }
});

test('favorites action tolerates a gateway without a URL list', async () => {
  const result = await adapter(async () => ({ unexpected: true })).api(frame());
  assert.equal(result[0].code, ResultCode.Ok);
  assert.deepEqual(result[0].data.urls, []);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('favorite add, rename and delete call the matching OneBot actions', async () => {
  const calls = [];
  const instance = adapter(async (action, args) => {
    calls.push({ action, args });
    if (action === 'add_custom_face') return { emoji_id: 'e_1' };
    return {};
  });
  const event = { Platform: 'onebot', IsMaster: true, UserId: '100', ChannelId: '200', IsPrivate: false };
  const added = await instance.api({
    payload: { key: 'agentLink.stickerFavoriteAdd', event, params: [{ data: png.toString('base64'), name: '猫猫' }] }
  });
  assert.equal(added[0].code, ResultCode.Ok);
  assert.deepEqual(added[0].data, { emojiId: 'e_1' });
  const renamed = await instance.api({
    payload: { key: 'agentLink.stickerFavoriteRename', event, params: [{ emojiId: 'e_1', name: '新名字' }] }
  });
  assert.equal(renamed[0].code, ResultCode.Ok);
  const deleted = await instance.api({
    payload: { key: 'agentLink.stickerFavoriteDelete', event, params: [{ emojiId: 'e_1' }] }
  });
  assert.equal(deleted[0].code, ResultCode.Ok);
  assert.deepEqual(
    calls.map(call => call.action),
    ['add_custom_face', 'modify_custom_face', 'delete_custom_face']
  );
  assert.equal(calls[0].args.file, `base64://${png.toString('base64')}`);
  assert.deepEqual(calls[1].args, { emoji_id: 'e_1', desc: '新名字' });
  assert.deepEqual(calls[2].args, { emoji_id: 'e_1' });
});

test('favorite writes reject non-owners, bad ids and invalid payloads', async () => {
  const instance = adapter(async () => assert.fail('must not call the gateway'));
  const event = { Platform: 'onebot', IsMaster: false, UserId: '100', ChannelId: '200', IsPrivate: false };
  for (const payload of [
    { key: 'agentLink.stickerFavoriteAdd', event, params: [{ data: png.toString('base64') }] },
    { key: 'agentLink.stickerFavoriteRename', event: { ...event, IsMaster: true }, params: [{ emojiId: 'bad id', name: 'x' }] },
    { key: 'agentLink.stickerFavoriteDelete', event: { ...event, IsMaster: true }, params: [{ emojiId: '..' }] }
  ]) {
    const result = await instance.api({ payload });
    assert.equal(result[0].code, ResultCode.Fail);
  }
  const added = await adapter(async () => ({})).api({
    payload: { key: 'agentLink.stickerFavoriteAdd', event: { ...event, IsMaster: true }, params: [{ data: png.toString('base64') }] }
  });
  assert.equal(added[0].code, ResultCode.Fail);
});
