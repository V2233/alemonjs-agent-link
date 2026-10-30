import { parseAds } from '../ads/config';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { resolveDSHConfig } from '../dsh/config';
import { getGroupChatPolicy } from '../social/group-policy';
import { getMediaConfig } from '../media/config';
import { resolveOneBotConfig } from '../onebot/config';
import { getModuleConfig } from '../agent/modules';

export const hiddenSecret = '__AGENTLINK_KEEP_SECRET__';
const maskKey = randomBytes(32);
const secretMarker = (value: unknown) => hiddenSecret + createHmac('sha256', maskKey).update(JSON.stringify(value)).digest('hex');
const secretKey = /^key$|api.?key|secret|password|token|authorization|master_key|bot_key/i;
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
const parse = (source: string) => {
  const doc = parseDocument(source);

  if (doc.errors.length || !isMap(doc.contents)) throw new Error('配置必须是有效的 YAML 对象');
  doc.toJS({ maxAliasCount: 100 });

  return doc;
};

export const validateConfiguration = (source: string, path: string) => {
  const value = parse(source).toJS({ maxAliasCount: 100 });
  const raw = value['alemonjs-agent-link'] ?? {};
  const config = resolveDSHConfig(raw, { configPath: path, hasRedis: Boolean(value.db?.redis) });

  getGroupChatPolicy(raw.groupChat);
  getMediaConfig(raw);
  parseAds(raw.ads);
  getModuleConfig(config);
  if (config.transport === 'onebot') resolveOneBotConfig(value);
  if (raw.budget?.enabled && !value.db?.redis) throw new Error('启用预算账本需要配置 db.redis');

  return config;
};
function redact(source: string) {
  // Serialize values only: comments may contain credentials copied by users.
  const doc = parse(JSON.stringify(parse(source).toJS({ maxAliasCount: 100 })));
  const visit = (node: any, sensitive = false) => {
    if (isMap(node))
      node.items.forEach((pair: any) => {
        const key = String(pair.key.value);

        if (['keys', 'modelPool'].includes(key) && isSeq(pair.value)) pair.value.items.forEach(item => visit(item, sensitive || isScalar(item)));
        else visit(pair.value, sensitive || secretKey.test(key));
      });
    else if (isSeq(node)) node.items.forEach(item => visit(item, sensitive));
    else if (isScalar(node) && sensitive && node.value) node.value = secretMarker(node.value);
  };

  visit(doc.contents);

  return JSON.stringify(doc.toJS({ maxAliasCount: 100 }), null, 2);
}
export class ProductSettingsFile {
  private busy = false;
  constructor(readonly path: string) {}
  async read() {
    const source = await readFile(this.path, 'utf8');

    const app = parse(source).toJS({ maxAliasCount: 100 })['alemonjs-agent-link'] ?? {};

    return { source: redact(JSON.stringify({ 'alemonjs-agent-link': app })), revision: revision(source) };
  }
  async prepare(source: string, expected: string) {
    const original = await readFile(this.path, 'utf8');

    if (revision(original) !== expected) throw new Error('配置已被其他操作修改，请重新读取后再保存');
    const doc = parse(source);

    if (!isMap(doc.contents) || doc.contents.items.some((pair: any) => String(pair.key.value) !== 'alemonjs-agent-link'))
      throw new Error('只能修改 AgentLink 配置');
    const before = parse(original);
    const secrets = new Map<string, unknown>();
    const collect = (node: any, sensitive = false) => {
      if (isMap(node))
        node.items.forEach((pair: any) => {
          const key = String(pair.key.value);

          if (['keys', 'modelPool'].includes(key) && isSeq(pair.value)) pair.value.items.forEach(item => collect(item, sensitive || isScalar(item)));
          else collect(pair.value, sensitive || secretKey.test(key));
        });
      else if (isSeq(node)) node.items.forEach(item => collect(item, sensitive));
      else if (isScalar(node) && sensitive && node.value) secrets.set(secretMarker(node.value), node.value);
    };

    collect(parse(JSON.stringify(before.toJS({ maxAliasCount: 100 }))).contents);
    const restore = (node: any, path: (string | number)[] = []) => {
      if (isMap(node)) node.items.forEach((pair: any) => restore(pair.value, [...path, String(pair.key.value)]));
      else if (isSeq(node)) node.items.forEach((item, index) => restore(item, [...path, index]));
      else if (isScalar(node) && typeof node.value === 'string' && node.value.startsWith(hiddenSecret)) {
        const value = secrets.get(node.value);

        if (value === undefined) throw new Error('新配置不能使用未修改密钥占位符');
        node.value = value;
      }
    };

    restore(doc.contents);
    // Retain original comments for unchanged and updated nodes.
    const merge = (old: any, next: any): any => {
      if (isMap(old) && isMap(next)) {
        old.items = old.items.filter((pair: any) => next.has(String(pair.key.value)));
        next.items.forEach((pair: any) => {
          const key = String(pair.key.value);
          const prior = old.get(key, true);

          old.set(key, prior ? merge(prior, pair.value) : pair.value);
        });

        return old;
      }
      if (isScalar(old) && isScalar(next)) {
        old.value = next.value;

        return old;
      }

      return next;
    };

    const appKey = 'alemonjs-agent-link';
    const nextApp = doc.get(appKey, true);

    if (!isMap(nextApp)) throw new Error('AgentLink 配置必须为对象');
    const previousApp = before.get(appKey, true);

    before.set(appKey, previousApp ? merge(previousApp, nextApp) : nextApp);
    const result = before.toString();

    validateConfiguration(result, this.path);

    return { original, result };
  }
  async save(source: string, expected: string) {
    if (this.busy) throw new Error('正在保存配置，请稍后重试');
    this.busy = true;
    const temp = this.path + '.' + randomUUID() + '.tmp';

    try {
      const { original, result } = await this.prepare(source, expected);
      const directory = join(dirname(this.path), '.agent-link-config-history');

      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, Date.now() + '-' + randomUUID() + '.yaml'),
        JSON.stringify({ 'alemonjs-agent-link': parse(original).toJS()['alemonjs-agent-link'] ?? {} }, null, 2),
        { mode: 0o600, flag: 'wx' }
      );
      await writeFile(temp, result, { mode: 0o600, flag: 'wx' });
      if (revision(await readFile(this.path, 'utf8')) !== expected) throw new Error('配置已变化，保存已取消');
      await rename(temp, this.path);

      return this.read();
    } finally {
      this.busy = false;
      await unlink(temp).catch(() => undefined);
    }
  }
}
