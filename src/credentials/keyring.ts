import { createHash, randomUUID } from 'node:crypto';
import { budgetRedis, type BudgetScope } from '../billing/budget';
import { encryptStoredKey, decryptStoredKey, encryptionKey, type RecordValue } from './personal';
import { DSHError } from '../dsh/errors';
import { groupStorageKey } from './group';

type Entry = { id: number; value: RecordValue };
type Grant = { id: number; keyId: number; channelId: string; token: string };
type Ring = { account?: RecordValue; next: number; keys: Entry[]; grants: Grant[] };
export const keyringStorageKey = (scope: BudgetScope) => {
  if (!scope.platform || !scope.userId) throw new DSHError('budget', '无法确认账号。');

  return `data:{agent-link-group-keys}:v1:ring:${createHash('sha256')
    .update(JSON.stringify([scope.platform, scope.userId]))
    .digest('hex')}`;
};

export const readKeyring = async (scope: BudgetScope) => {
  const raw = await (await budgetRedis()).get(keyringStorageKey(scope));

  return { raw: raw || '', ring: raw ? (JSON.parse(raw) as Ring) : ({ next: 1, keys: [], grants: [] } as Ring) };
};
export const changeKeyring = async (scope: BudgetScope, action: 'add' | 'grant' | 'revoke', input: string) => {
  if (['add', 'revoke'].includes(action) && scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}`)
    throw new DSHError('budget', '请在本人私聊操作。');
  if (action !== 'add' && !/^[1-9][0-9]*$/u.test(input)) throw new DSHError('budget', '请使用有效编号。');
  const redis = await budgetRedis();
  const key = keyringStorageKey(scope);
  const { raw, ring } = await readKeyring(scope);
  let target = key;
  let payload = '';
  let expected = '';

  if (action === 'add') {
    if (!scope.channelId.startsWith('private:') || !/^sk-[A-Za-z0-9_-]{8,240}$/u.test(input))
      throw new DSHError('budget', '请私聊发送 /我的钥匙 群聊 添加 sk-你的Key。');
    ring.keys.push({ id: ring.next++, value: { encrypted: await encryptStoredKey(key, input), enabled: true, revision: randomUUID(), reason: '' } });
  } else if (action === 'grant') {
    if (scope.channelId.startsWith('private:')) throw new DSHError('budget', '请在目标群授权。');
    const entry = ring.keys.find(item => item.id === Number(input));

    if (!entry) throw new DSHError('budget', '没有这个群聊钥匙编号。');
    target = groupStorageKey(scope);
    const token = randomUUID();
    const credential = decryptStoredKey(key, entry.value, scope, await encryptionKey());

    payload = JSON.stringify({
      encrypted: await encryptStoredKey(target, credential.apiKey),
      enabled: true,
      revision: randomUUID(),
      reason: '',
      grantToken: token,
      ...(entry.value.auth ? { auth: entry.value.auth, accountId: entry.value.accountId } : {})
    });
    ring.grants.push({ id: ring.next++, keyId: entry.id, channelId: scope.channelId, token });
  } else {
    if (!scope.channelId.startsWith('private:')) throw new DSHError('budget', '授权记录仅本人私聊可管理。');
    const grant = ring.grants.find(item => item.id === Number(input));

    if (!grant) throw new DSHError('budget', '没有这个授权记录编号。');
    target = groupStorageKey({ ...scope, channelId: grant.channelId });
    expected = grant.token;
    ring.grants = ring.grants.filter(item => item.id !== grant.id);
  }
  const result = await redis.eval(
    `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
if ARGV[3] == 'grant' then
 if redis.call('GET', KEYS[2]) then return 2 end
 redis.call('SET', KEYS[2], ARGV[4])
elseif ARGV[3] == 'revoke' then
 local current = redis.call('GET', KEYS[2])
 if current and cjson.decode(current).grantToken == ARGV[5] then redis.call('DEL', KEYS[2]) end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`,
    2,
    key,
    target,
    raw,
    JSON.stringify(ring),
    action,
    payload,
    expected
  );

  if (Number(result) !== 1) throw new DSHError('budget', Number(result) === 2 ? '本群已有钥匙，请先移除原授权。' : '状态已变更，请重试。');
};

/** 当前群管理员移除群副本，不需要知道提供者，也不触碰个人钥匙库。 */
export const removeCurrentGroupKey = async (scope: BudgetScope): Promise<boolean> => Number(await (await budgetRedis()).del(groupStorageKey(scope))) > 0;

/** 记录保留供提供者核对，群已移除或换用另一授权时标记为失效。 */
export const grantIsCurrent = async (scope: BudgetScope, grant: Grant): Promise<boolean> => {
  const raw = await (await budgetRedis()).get(groupStorageKey({ ...scope, channelId: grant.channelId }));

  return Boolean(raw && JSON.parse(raw).grantToken === grant.token);
};
