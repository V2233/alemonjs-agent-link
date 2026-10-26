import { DatabaseSync } from 'node:sqlite';
import { constants, mkdirSync, chmodSync } from 'node:fs';
import { open, mkdir, readdir, lstat, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
import { personaModes, personaModePrompt, type PersonaMode } from './persona-modes';
import { dafeiyuPrompt } from '../dsh/persona';

export type PersonaScope = { platform: string; channelId: string };
export type PersonaDefinition = { id: string; name: string; prompt: string; tags?: string[]; privateRules?: string; socialRules?: string };
export const validPersonaId = (id: string): boolean => /^[a-z][a-z0-9-]{0,63}$/u.test(id);
const builtinPersonas: PersonaDefinition[] = [
  { id: 'dafeiyu', name: '大肥鱼', prompt: dafeiyuPrompt, tags: ['陪伴'] },
  { id: 'assistant', name: '通用助手', prompt: '你是一个友好、可靠的助手。', tags: ['助手'] }
];
const scopeKey = (scope: PersonaScope): string => {
  if (!scope.platform || !scope.channelId) {
    throw new Error('人格选择缺少平台和会话标识。');
  }

  return createHash('sha256')
    .update(JSON.stringify([scope.platform, scope.channelId]))
    .digest('hex');
};

const validate = (value: unknown): PersonaDefinition => {
  const persona = value as PersonaDefinition;

  if (
    !persona ||
    typeof persona.id !== 'string' ||
    !validPersonaId(persona.id) ||
    typeof persona.name !== 'string' ||
    !persona.name.trim() ||
    persona.name.length > 40 ||
    typeof persona.prompt !== 'string' ||
    !persona.prompt.trim() ||
    persona.prompt.length > 12000 ||
    ['privateRules', 'socialRules'].some(key => persona[key] !== undefined && (typeof persona[key] !== 'string' || persona[key].length > 4000)) ||
    (persona.tags !== undefined &&
      (!Array.isArray(persona.tags) || persona.tags.length > 10 || persona.tags.some(tag => typeof tag !== 'string' || tag.length > 20)))
  ) {
    throw new Error('人格文件格式或长度无效。');
  }

  return {
    id: persona.id,
    name: persona.name.trim(),
    prompt: persona.prompt.trim(),
    tags: persona.tags || [],
    privateRules: persona.privateRules || '',
    socialRules: persona.socialRules || ''
  };
};

export class PersonaStore {
  private readonly db: DatabaseSync;
  readonly directory: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.directory = join(root, 'personas');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(root, 'personas.sqlite');

    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS persona_choices (
        scope TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL, persona_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS persona_ids ON persona_choices(persona_id);
      CREATE TABLE IF NOT EXISTS persona_additions (persona_id TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS persona_modes (scope TEXT PRIMARY KEY, channel_id TEXT NOT NULL, mode TEXT NOT NULL);`);
  }

  close(): void {
    this.db.close();
  }

  private path(id: string): string {
    if (!validPersonaId(id)) {
      throw new Error('人格编号无效。');
    }

    return join(this.directory, `${id}.json`);
  }

  async read(id: string): Promise<PersonaDefinition> {
    const path = this.path(id);
    let handle: Awaited<ReturnType<typeof open>>;

    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const builtin = builtinPersonas.find(persona => persona.id === id);

        if (builtin) {
          return validate(builtin);
        }
      }
      throw new Error('人格文件不存在或无法读取。');
    }
    try {
      const info = await handle.stat();

      if (!info.isFile() || info.size > 65536) {
        throw new Error('人格文件超过大小限制或不是普通文件。');
      }
      const data = Buffer.alloc(65537);
      const result = await handle.read(data, 0, data.length, 0);

      if (result.bytesRead > 65536) {
        throw new Error('人格文件超过大小限制。');
      }
      const definition = validate(JSON.parse(data.subarray(0, result.bytesRead).toString('utf8')));

      if (definition.id !== id) {
        throw new Error('人格编号必须与文件名一致。');
      }

      return definition;
    } finally {
      await handle.close();
    }
  }

  async list(): Promise<{ id: string; name: string; tags: string[]; builtin: boolean; error?: string }[]> {
    const ids = new Set(builtinPersonas.map(persona => persona.id));

    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';

      if (validPersonaId(id)) {
        ids.add(id);
      }
      if (ids.size > 102) {
        throw new Error('人格文件超过数量限制。');
      }
    }
    const rows: { id: string; name: string; tags: string[]; builtin: boolean; error?: string }[] = [];

    for (const id of [...ids].sort()) {
      const builtin = builtinPersonas.some(persona => persona.id === id);

      try {
        const persona = await this.read(id);

        rows.push({ id, name: persona.name, tags: persona.tags, builtin });
      } catch {
        rows.push({ id, name: id, tags: [], builtin, error: '文件无效' });
      }
    }

    return rows;
  }

  async save(value: PersonaDefinition): Promise<void> {
    const persona = validate(value);
    const path = this.path(persona.id);
    const data = JSON.stringify(persona, null, 2);

    if (Buffer.byteLength(data) > 65536) {
      throw new Error('人格文件超过64 KiB限制。');
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });

    if (existing && !existing.isFile()) {
      throw new Error('人格文件不能是符号链接或目录。');
    }
    if (!existing && (await this.list()).length >= 102) {
      throw new Error('人格文件数量已满。');
    }
    const staging = join(this.directory, `.${persona.id}-${randomUUID()}.tmp`);

    try {
      await writeFile(staging, data, { mode: 0o600, flag: 'wx' });
      await rename(staging, path);
    } finally {
      await rm(staging, { force: true });
    }
  }

  additions(id: string): string {
    this.path(id);

    return String(this.db.prepare('SELECT content FROM persona_additions WHERE persona_id=?').get(id)?.content || '');
  }

  append(id: string, text: string): void {
    this.path(id);
    const content = [this.additions(id), text.trim()].filter(Boolean).join('\n');

    if (!text.trim() || content.length > 4000) {
      throw new Error('追加人设不能为空，累计最多 4000 字符。');
    }
    this.db
      .prepare(
        `INSERT INTO persona_additions(persona_id,content) VALUES(?,?)
      ON CONFLICT(persona_id) DO UPDATE SET content=excluded.content`
      )
      .run(id, content);
  }

  clearAdditions(id: string): void {
    this.path(id);
    this.db.prepare('DELETE FROM persona_additions WHERE persona_id=?').run(id);
  }

  expressionMode(scope?: PersonaScope): PersonaMode {
    const local = scope ? this.db.prepare('SELECT mode FROM persona_modes WHERE scope=?').get(scopeKey(scope)) : undefined;
    const global = this.db.prepare("SELECT mode FROM persona_modes WHERE scope='global'").get();
    const mode = String(local?.mode || global?.mode || '个性') as PersonaMode;

    return personaModes.includes(mode) ? mode : '个性';
  }

  setExpressionMode(scope: PersonaScope | undefined, mode: PersonaMode | undefined, owner: boolean): void {
    if (!owner) {
      throw new Error('只有机器人主人能修改表达程度。');
    }
    if (mode !== undefined && !personaModes.includes(mode)) {
      throw new Error('表达程度必须为个性、工作或专业。');
    }
    const key = scope ? scopeKey(scope) : 'global';

    if (mode === undefined) {
      this.db.prepare('DELETE FROM persona_modes WHERE scope=?').run(key);
    } else {
      this.db
        .prepare(
          `INSERT INTO persona_modes(scope,channel_id,mode) VALUES(?,?,?)
        ON CONFLICT(scope) DO UPDATE SET mode=excluded.mode`
        )
        .run(key, scope?.channelId || '', mode);
    }
  }

  selected(scope: PersonaScope): string | undefined {
    const row = this.db.prepare('SELECT persona_id FROM persona_choices WHERE scope=?').get(scopeKey(scope));

    return row ? String(row.persona_id) : undefined;
  }

  async select(scope: PersonaScope, id?: string): Promise<void> {
    if (!id) {
      this.db.prepare('DELETE FROM persona_choices WHERE scope=?').run(scopeKey(scope));

      return;
    }
    await this.read(id);
    this.db
      .prepare(
        `INSERT INTO persona_choices(scope,platform,channel_id,persona_id,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET persona_id=excluded.persona_id,updated_at=excluded.updated_at`
      )
      .run(scopeKey(scope), scope.platform, scope.channelId, id, Date.now());
  }

  scopesUsing(id: string): PersonaScope[] {
    this.path(id);

    return this.db.prepare('SELECT platform,channel_id AS channelId FROM persona_choices WHERE persona_id=?').all(id) as unknown as PersonaScope[];
  }

  async remove(id: string): Promise<void> {
    const path = this.path(id);

    if (this.scopesUsing(id).length) {
      throw new Error('请先将使用该人格的会话切回默认。');
    }
    await rm(path);
    this.clearAdditions(id);
  }

  purgeHash(groupHash: string): void {
    for (const row of this.db.prepare('SELECT scope,channel_id FROM persona_modes').all()) {
      if (row.scope !== 'global' && createHash('sha256').update(String(row.channel_id)).digest('hex') === groupHash) {
        this.db.prepare('DELETE FROM persona_modes WHERE scope=?').run(row.scope);
      }
    }
    const rows = this.db.prepare('SELECT scope,channel_id FROM persona_choices').all();

    for (const row of rows) {
      if (createHash('sha256').update(String(row.channel_id)).digest('hex') === groupHash) {
        this.db.prepare('DELETE FROM persona_choices WHERE scope=?').run(row.scope);
      }
    }
  }

  async systemPrompt(config: DSHBridgeConfig, context: PersonaScope & { private: boolean; owner: boolean }): Promise<string> {
    const configured = config.modules?.settings?.persona;
    const id = this.selected(context) || configured?.defaultId;

    if (id !== undefined && (typeof id !== 'string' || !validPersonaId(id))) {
      throw new Error('默认人格编号无效。');
    }
    const definition = id ? await this.read(id as string) : undefined;
    const rules = definition ? (context.private && context.owner ? definition.privateRules : definition.socialRules) : '';
    const common = configured?.commonRules;

    if (common !== undefined && (typeof common !== 'string' || common.length > 4000)) {
      throw new Error('人格公共规则无效。');
    }

    const additions = this.additions(id ? String(id) : config.persona);
    const extra = additions ? `【主人追加的人设】\n以下补充仅调整性格、称呼和表达习惯，不改变实际能力、身份验证、权限、隐私及工具执行规则。\n${additions}` : '';

    return [definition?.prompt || config.defaultSystemPrompt, rules, common || '', extra, personaModePrompt(this.expressionMode(context))]
      .filter(Boolean)
      .join('\n\n');
  }
}

const processState = globalThis as typeof globalThis & { __agentLinkPersonas__?: Map<string, PersonaStore> };
const stores = (processState.__agentLinkPersonas__ ??= new Map<string, PersonaStore>());

export const getPersonaStore = (config: DSHBridgeConfig): PersonaStore => {
  const root = dirname(config.workspaceRoot);
  let store = stores.get(root);

  if (!store) {
    store = new PersonaStore(root);
    stores.set(root, store);
  }

  return store;
};
