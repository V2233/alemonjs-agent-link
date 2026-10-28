import test from 'node:test';
import assert from 'node:assert/strict';
import { addFavoriteDirect, deleteFavoriteDirect, fetchFavoriteUrlsDirect, renameFavoriteDirect } from '../lib/media/onebot-direct.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('direct OneBot favorite helpers normalize reads and write identifiers', async () => {
  const calls = [];
  const connection = {
    call: async (action, args) => {
      calls.push({ action, args });
      if (action === 'fetch_custom_face') return ['https://cdn.test/a', { url: 'https://cdn.test/b' }, 'http://bad.test/c'];
      if (action === 'add_custom_face') return { data: { emoji_id: 'e_1' } };
      return {};
    }
  };
  assert.deepEqual(await fetchFavoriteUrlsDirect(connection, 10), ['https://cdn.test/a', 'https://cdn.test/b']);
  assert.equal(await addFavoriteDirect(connection, png, '猫猫'), 'e_1');
  assert.equal(await renameFavoriteDirect(connection, 'e_1', '新名字'), true);
  assert.equal(await deleteFavoriteDirect(connection, 'e_1'), true);
  assert.deepEqual(
    calls.map(call => call.action),
    ['fetch_custom_face', 'add_custom_face', 'modify_custom_face', 'delete_custom_face']
  );
  assert.equal(calls[1].args.file, `base64://${png.toString('base64')}`);
  assert.equal(calls[1].args.name, '猫猫');
  assert.deepEqual(calls[2].args, { emoji_id: 'e_1', desc: '新名字' });
  assert.deepEqual(calls[3].args, { emoji_id: 'e_1' });
});

test('direct OneBot favorite helpers reject invalid ids and gateway failures', async () => {
  const failing = { call: async () => assert.fail('invalid inputs must not call the gateway') };
  assert.equal(await renameFavoriteDirect(failing, 'bad id', 'x'), false);
  assert.equal(await deleteFavoriteDirect(failing, '..'), false);
  assert.equal(await fetchFavoriteUrlsDirect(failing, 0), undefined);
  const broken = {
    call: async () => {
      throw new Error('gateway');
    }
  };
  assert.equal(await fetchFavoriteUrlsDirect(broken, 10), undefined);
  assert.equal(await addFavoriteDirect(broken, png, 'x'), undefined);
});
