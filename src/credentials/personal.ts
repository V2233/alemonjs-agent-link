import { getConfigValue } from 'alemonjs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { budgetRedis, getBudgetScope, type BudgetScope } from '../billing/budget';
import { DSHError } from '../dsh/errors';

export const isPersonalKeyCommand = (text: unknown): boolean => /^\/(?:apikey|个人密钥|群密钥|groupapikey)(?:\s|$)/iu.test(String(text ?? '').trimStart());
const keyFile = () => resolve(process.env.AGENT_LINK_PERSONAL_KEY_FILE || '.data/agent-link/personal-key.key');

export type RecordValue = { encrypted: string; enabled: boolean; revision: string; reason: 'manual' | 'balance' | '' };
export type PersonalCredential = { apiKey: string; revision: string; scope: BudgetScope };
const keyFor = (scope: BudgetScope): string => {
  if (!scope.platform || !scope.userId || scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}`) {
    throw new DSHError('budget', '个人 API Key 只能在本人私聊中管理和使用。');
  }

  return `data:{agent-link-personal-keys}:v1:${createHash('sha256')
    .update(JSON.stringify([scope.platform, scope.userId]))
    .digest('hex')}`;
};

export const encryptionKey = async (create = false): Promise<Buffer | null> => {
  if (create) {
    await mkdir(dirname(keyFile()), { recursive: true, mode: 0o700 });
    await writeFile(keyFile(), randomBytes(32), { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  try {
    const key = await readFile(keyFile());

    if (key.length !== 32) throw new Error('key');

    return key;
  } catch (error) {
    if (!create && error.code === 'ENOENT') return null;
    throw new DSHError('budget', '个人密钥存储不可用，请联系主人检查。');
  }
};
const recordFor = async (scope: BudgetScope): Promise<RecordValue | null> => {
  const key = keyFor(scope);
  const raw = await (await budgetRedis()).get(key);

  return raw ? (JSON.parse(raw) as RecordValue) : null;
};

export const claimPersonalKeyCommand = async (scope: BudgetScope, messageId: string): Promise<boolean> => {
  if (!messageId) throw new DSHError('budget', '缺少消息编号，请重新发送个人密钥管理指令。');
  const command = createHash('sha256').update(messageId).digest('hex');

  return (await (await budgetRedis()).set(`${keyFor(scope)}:command:${command}`, '1', 'EX', 32 * 86400, 'NX')) === 'OK';
};

export const encryptStoredKey = async (storageKey: string, apiKey: string): Promise<string> => {
  const key = await encryptionKey(true);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  cipher.setAAD(Buffer.from(storageKey));
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');

  return encrypted;
};

export const bindPersonalKey = async (scope: BudgetScope, apiKey: string): Promise<void> => {
  const storageKey = keyFor(scope);

  if (!/^sk-[A-Za-z0-9_-]{8,240}$/u.test(apiKey)) throw new DSHError('budget', 'Key 格式无效，请使用 DeepSeek 官方 API Key。');
  const encrypted = await encryptStoredKey(storageKey, apiKey);

  await (await budgetRedis()).set(storageKey, JSON.stringify({ encrypted, enabled: true, revision: randomUUID(), reason: '' } satisfies RecordValue));
};
export const personalKeyStatus = async (scope: BudgetScope) => {
  const value = await recordFor(scope);

  return { bound: Boolean(value), enabled: value?.enabled === true, reason: value?.reason || '' };
};
export const updatePersonalKey = async (scope: BudgetScope, action: 'enable' | 'disable' | 'remove', revision?: string): Promise<boolean> => {
  const redis = await budgetRedis();
  const result = await redis.eval(
    `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if ARGV[2] ~= '' and value.revision ~= ARGV[2] then return 0 end
if ARGV[1] == 'remove' then redis.call('DEL', KEYS[1]); return 1 end
value.enabled = ARGV[1] == 'enable'
value.reason = ARGV[2] ~= '' and 'balance' or (value.enabled and '' or 'manual')
value.revision = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(value))
return 1`,
    1,
    keyFor(scope),
    action,
    revision || '',
    randomUUID()
  );

  return Number(result) === 1;
};
export const getPersonalCredential = async (): Promise<PersonalCredential | null> => {
  const scope = getBudgetScope();

  if (!scope?.channelId.startsWith('private:')) return null;
  const key = await encryptionKey();

  // Installations that have never bound a personal key need no extra Redis dependency.
  if (!key && !getConfigValue<{ db?: { redis?: unknown } }>()?.db?.redis) return null;
  const value = await recordFor(scope);

  if (value?.enabled !== true) return null;
  if (!key) throw new DSHError('budget', '个人密钥加密文件缺失，请联系主人恢复或重新绑定。');

  return decryptStoredKey(keyFor(scope), value, scope, key);
};

export const decryptStoredKey = (storageKey: string, value: RecordValue, scope: BudgetScope, key: Buffer): PersonalCredential => {
  try {
    const bytes = Buffer.from(value.encrypted, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));

    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(Buffer.from(storageKey));

    return { apiKey: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), revision: value.revision, scope };
  } catch {
    throw new DSHError('budget', '个人密钥无法解密，请重新绑定。');
  }
};
export const checkCredentialBalance = async (
  credential: PersonalCredential | null,
  disable: (credential: PersonalCredential) => Promise<boolean>,
  latestCredential: () => Promise<PersonalCredential | null>,
  signal?: AbortSignal
): Promise<PersonalCredential | null> => {
  if (!credential) return null;
  let response: Response;

  try {
    response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${credential.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
    });
  } catch {
    signal?.throwIfAborted();
    throw new DSHError('budget', '绑定 Key 余额查询暂时失败，未切换到机器人额度，请稍后再试。');
  }
  if (!response.ok && response.status !== 402) {
    await response.body?.cancel();
    throw new DSHError('budget', '绑定 Key 余额查询失败，请检查 Key 或稍后重试；未切换到机器人额度。');
  }
  let available: unknown = false;

  if (response.status !== 402) {
    // Do not retain provider bodies (they can contain account information).
    const reader = response.body?.getReader();
    let body = '';

    try {
      if (!reader) throw new Error('body');
      while (true) {
        const part = await reader.read();

        if (part.done) break;
        body += Buffer.from(part.value).toString('utf8');
        if (Buffer.byteLength(body) > 16384) throw new Error('body too large');
      }
      available = JSON.parse(body).is_available;
    } catch {
      available = undefined;
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  } else await response.body?.cancel();
  if (available === false) {
    if (!(await disable(credential))) throw new DSHError('budget', '绑定 Key 设置已变更，请重新发送请求。');

    return null;
  }
  if (available !== true) throw new DSHError('budget', '绑定 Key 余额返回格式无效，未切换到机器人额度。');
  const latest = await latestCredential();

  if (latest?.revision !== credential.revision) throw new DSHError('budget', '绑定 Key 设置已变更，请重新发送请求。');

  return credential;
};

export const checkedPersonalCredential = async (signal?: AbortSignal): Promise<PersonalCredential | null> =>
  checkCredentialBalance(
    await getPersonalCredential(),
    credential => updatePersonalKey(credential.scope, 'disable', credential.revision),
    getPersonalCredential,
    signal
  );
