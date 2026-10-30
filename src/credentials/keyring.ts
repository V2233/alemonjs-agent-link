import { createHash, randomUUID } from 'node:crypto';
import { groupKeyLimitDetails, groupKeyBudgetStatus, budgetRedis, type BudgetScope } from '../billing/budget';
import { encryptStoredKey, decryptStoredKey, encryptionKey, type RecordValue } from './personal';
import { DSHError } from '../dsh/errors';
import { groupStorageKey, resolveGrantScope, credentialStateLabel } from './group';

type Entry = { id: number; value: RecordValue };
type Grant = { id: number; keyId: number; channelId: string; token: string };
type Ring = { owner?: { platform: string; userId: string }; account?: RecordValue; next: number; keys: Entry[]; grants: Grant[] };
export const keyringStorageKey = (scope: BudgetScope) => {
  if (!scope.platform || !scope.userId) throw new DSHError('budget', '无法确认账号。');

  return `data:{agent-link-group-keys}:v1:ring:${createHash('sha256')
    .update(JSON.stringify([scope.platform, scope.userId]))
    .digest('hex')}`;
};

export const readKeyring = async (scope: BudgetScope) => {
  const raw = await (await budgetRedis()).get(keyringStorageKey(scope));

  const ring = raw ? (JSON.parse(raw) as Ring) : ({ next: 1, keys: [], grants: [] } as Ring);

  ring.owner = { platform: scope.platform, userId: scope.userId };

  return { raw: raw || '', ring };
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
  let pool = key;

  if (action === 'add') {
    if (!scope.channelId.startsWith('private:') || !/^sk-[A-Za-z0-9_-]{8,240}$/u.test(input))
      throw new DSHError('budget', '请私聊发送 /我的钥匙 群聊 添加 sk-你的Key。');
    ring.keys.push({ id: ring.next++, value: { encrypted: await encryptStoredKey(key, input), enabled: true, revision: randomUUID(), reason: '' } });
  } else if (action === 'grant') {
    if (scope.channelId.startsWith('private:')) throw new DSHError('budget', '请在目标群授权。');
    const entry = ring.keys.find(item => item.id === Number(input));

    if (!entry) throw new DSHError('budget', '没有这个群聊钥匙编号。');
    for (const grant of ring.grants.filter(item => item.channelId === scope.channelId && item.keyId === entry.id)) {
      if (await grantIsCurrent(scope, grant)) throw new DSHError('budget', '这把钥匙已分享给本群。');
    }
    const token = randomUUID();

    pool = `${groupStorageKey(scope)}:pool`;

    target = groupStorageKey({ ...scope, credentialId: token });
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
    target = groupStorageKey(await resolveGrantScope({ ...scope, channelId: grant.channelId }, grant.token));
    pool = `${groupStorageKey({ ...scope, channelId: grant.channelId })}:pool`;
    expected = grant.token;
    ring.grants = ring.grants.filter(item => item.id !== grant.id);
  }
  const result = await redis.eval(
    `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
if ARGV[3] == 'grant' then
 if redis.call('LLEN', KEYS[3]) >= 64 then return 2 end
 redis.call('SET', KEYS[2], ARGV[4])
 redis.call('RPUSH', KEYS[3], cjson.decode(ARGV[4]).grantToken)
elseif ARGV[3] == 'revoke' then
 local current = redis.call('GET', KEYS[2])
 if not current or cjson.decode(current).grantToken == ARGV[5] then
  redis.call('DEL', KEYS[2])
  redis.call('LREM', KEYS[3], 0, ARGV[5])
 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`,
    3,
    key,
    target,
    pool,
    raw,
    JSON.stringify(ring),
    action,
    payload,
    expected
  );

  if (Number(result) !== 1) throw new DSHError('budget', Number(result) === 2 ? '本群共享钥匙已达 64 把，请先移除不用的授权。' : '状态已变更，请重试。');
};

/** 当前群管理员移除群副本，不需要知道提供者，也不触碰个人钥匙库。 */
export const removeCurrentGroupKey = async (scope: BudgetScope): Promise<boolean> => {
  const root = groupStorageKey({ ...scope, credentialId: undefined });

  return (
    Number(
      await (
        await budgetRedis()
      ).eval(
        `
local ids=redis.call('LRANGE',KEYS[2],0,-1)
local count=redis.call('DEL',KEYS[1])
for _,id in ipairs(ids) do count=count+redis.call('DEL',KEYS[1]..':grant:'..id) end
redis.call('DEL',KEYS[2])
return count`,
        2,
        root,
        `${root}:pool`
      )
    ) > 0
  );
};

/** 记录保留供提供者核对，群已移除或换用另一授权时标记为失效。 */
export const grantIsCurrent = async (scope: BudgetScope, grant: Grant): Promise<boolean> => {
  const raw = await (await budgetRedis()).get(groupStorageKey(await resolveGrantScope({ ...scope, channelId: grant.channelId }, grant.token)));

  return Boolean(raw && JSON.parse(raw).grantToken === grant.token);
};

/** 只有原提供者可调整该次授权的上限；旧记录不能修改替换后的钥匙。 */
export const setGrantDailyLimit = async (scope: BudgetScope, id: string, input: string): Promise<void> => {
  if (scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}`) throw new DSHError('budget', '请在本人私聊操作。');
  if (!/^[1-9][0-9]*$/u.test(id) || !/^\d+(?:\.\d{1,6})?$/u.test(input) || Number(input) > 10000)
    throw new DSHError('budget', '请使用记录编号和 0–10000 元的每日上限。');
  const { ring } = await readKeyring(scope);
  const grant = ring.grants.find(item => item.id === Number(id));

  if (!grant) throw new DSHError('budget', '没有这个授权记录。');
  const changed = await (
    await budgetRedis()
  ).eval(
    `
local raw=redis.call('GET', KEYS[1])
if not raw then return 0 end
local value=cjson.decode(raw)
if value.grantToken ~= ARGV[1] then return 0 end
value.donorDailyLimit=tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(value))
return 1`,
    1,
    groupStorageKey(await resolveGrantScope({ ...scope, channelId: grant.channelId }, grant.token)),
    grant.token,
    input
  );

  if (Number(changed) !== 1) throw new DSHError('budget', '授权已失效，不能修改新钥匙。');
};

export const grantLimitDetails = async (scope: BudgetScope, grant: Grant) => {
  const target = await resolveGrantScope({ ...scope, channelId: grant.channelId }, grant.token);
  const raw = await (await budgetRedis()).get(groupStorageKey(target));
  const record = raw ? JSON.parse(raw) : null;

  if (record?.grantToken !== grant.token) return null;
  // A stopped key is still an owned grant. Only the matching grant's limit is shown.
  const details = await groupKeyLimitDetails(target);
  const latest = await (await budgetRedis()).get(groupStorageKey(target));

  if (!latest || JSON.parse(latest).grantToken !== grant.token) return null;

  const usage = await groupKeyBudgetStatus({} as import('../dsh/config').DSHBridgeConfig, target);

  return {
    ...details,
    enabled: record.enabled === true,
    label: credentialStateLabel(record),
    donorUsed: usage.donorUsed,
    donorRemaining: usage.donorRemaining
  };
};

/** Re-enable only the caller's matching grant; does not reset either usage ledger. */
export const setGrantState = async (scope: BudgetScope, id: string, enabled: boolean): Promise<void> => {
  if (scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}` || !/^[1-9][0-9]*$/u.test(id))
    throw new DSHError('budget', '请在本人私聊使用有效记录编号。');
  const { ring } = await readKeyring(scope);
  const grant = ring.grants.find(item => item.id === Number(id));

  if (!grant) throw new DSHError('budget', '没有这个授权记录。');
  const target = await resolveGrantScope({ ...scope, channelId: grant.channelId }, grant.token);
  const changed = await (
    await budgetRedis()
  ).eval(
    `
local raw=redis.call('GET',KEYS[1])
if not raw then return 0 end
local value=cjson.decode(raw)
if value.grantToken ~= ARGV[1] then return 0 end
value.enabled=ARGV[2]=='1'
value.reason=value.enabled and '' or 'manual'
value.revision=ARGV[3]
redis.call('SET',KEYS[1],cjson.encode(value))
return 1`,
    1,
    groupStorageKey(target),
    grant.token,
    enabled ? '1' : '0',
    randomUUID()
  );

  if (Number(changed) !== 1) throw new DSHError('budget', '授权已失效，请重新分享。');
};
