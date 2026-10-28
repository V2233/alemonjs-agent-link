import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DSHBridgeConfig } from '../dsh/config';
import { getGroupChatPolicy, groupActivityPresets, type GroupChatActivity, type GroupChatPolicy } from './group-policy';

/**
 * 群管理员可改的运行时设置。刻意只开放四项：
 * 活跃档位（预设值，不能自填极端参数）、静默时段、活跃时段上限（只能往下调）、兴趣词与补充唤醒词。
 * 网页/文件工具不在这里——它们只跟群 Key 绑定。
 */
export type GroupSettings = {
  activity?: GroupChatActivity;
  quietHours?: [number, number];
  maxPerHour?: number;
  interests?: string[];
  wakeNames?: string[];
  bannedWords?: string[];
  /** false 表示本群一律用文字回，连显式 /语音 也不合成。 */
  voiceEnabled?: boolean;
  /** false 表示本群不自动发语音，只在明确要求时合成。 */
  voiceAuto?: boolean;
};

export type GroupSettingsField = keyof GroupSettings;
export type GroupSettingsAudit = {
  field: GroupSettingsField | 'reset';
  before: string;
  after: string;
  operator: string;
  at: number;
};

export const groupSettingsFields: GroupSettingsField[] = [
  'activity',
  'quietHours',
  'maxPerHour',
  'interests',
  'wakeNames',
  'bannedWords',
  'voiceEnabled',
  'voiceAuto'
];
export const groupActivities: GroupChatActivity[] = ['quiet', 'balanced', 'active'];
export const maxInterests = 100;
export const maxInterestLength = 40;
export const maxWakeNames = 32;
export const maxWakeNameLength = 20;
export const maxBannedWords = 50;
export const maxBannedWordLength = 30;
export const dailyChangeLimit = 10;
export const fieldCooldownMs = 10_000;

const scopeKey = (platform: string, channelId: string): string =>
  createHash('sha256')
    .update(JSON.stringify([platform, channelId]))
    .digest('hex');

const unique = (values: string[]): string[] => [...new Set(values.map(value => value.trim()).filter(Boolean))];

/** 校验并归一化单个字段；返回 undefined 表示清除该字段、回落到配置默认。 */
export const normalizeGroupSetting = (field: GroupSettingsField, value: unknown): GroupSettings[GroupSettingsField] => {
  if (field === 'activity') {
    const activity = String(value);

    if (activity === '默认' || activity === '清除') return undefined;
    if (!groupActivities.includes(activity as GroupChatActivity)) throw new Error('强度只能是 安静、正常 或 活跃。');

    return activity as GroupChatActivity;
  }
  if (field === 'quietHours') {
    if (value === undefined || value === null || value === '关闭') return undefined;
    const hours = Array.isArray(value) ? value.map(Number) : (String(value).match(/\d{1,2}/gu) || []).map(Number);

    if (hours.length !== 2 || hours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
      throw new Error('静默时段需要两个 0–23 的整点，例如 1-8；写“关闭”表示不静默。');
    }

    return [hours[0], hours[1]] as [number, number];
  }
  if (field === 'maxPerHour') {
    const number = Number(String(value).match(/\d+/u)?.[0] ?? value);

    if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error('每小时上限需要 0–100 的整数。');

    return number;
  }
  if (field === 'voiceEnabled' || field === 'voiceAuto') {
    if (value === undefined || value === null || value === '默认' || value === '恢复') return undefined;
    const text = String(value).toLowerCase();

    if (['开', '开启', 'on', 'true', '1'].includes(text)) return true;
    if (['关', '关闭', 'off', 'false', '0'].includes(text)) return false;
    throw new Error('语音开关只接受 开启 或 关闭。');
  }
  if (field === 'interests' || field === 'wakeNames' || field === 'bannedWords') {
    if (value === undefined || value === null || value === '清空') return undefined;
    const list = unique((Array.isArray(value) ? value.map(String) : String(value).split(/[,，\s]+/u)).filter(Boolean));
    const limit = field === 'interests' ? maxInterests : field === 'wakeNames' ? maxWakeNames : maxBannedWords;
    const length = field === 'interests' ? maxInterestLength : field === 'wakeNames' ? maxWakeNameLength : maxBannedWordLength;

    if (!list.length) return undefined;
    if (list.length > limit) throw new Error(`最多 ${limit} 个词。`);
    if (list.some(word => word.length > length || word.startsWith('/'))) throw new Error(`每个词不超过 ${length} 字，且不能以 / 开头。`);

    return list;
  }

  return undefined;
};

/** 群设置参与策略合并；活跃档位沿用与配置相同的预设，避免管理员自填极端参数。 */
export const settingsToPolicy = (settings: GroupSettings): Partial<GroupChatPolicy> => {
  const policy: Partial<GroupChatPolicy> = {};

  if (settings.activity) policy.activity = settings.activity;
  if (settings.quietHours) policy.quietHours = settings.quietHours;
  if (settings.maxPerHour !== undefined) policy.maxPerHour = settings.maxPerHour;
  if (settings.interests) policy.interests = settings.interests;

  return policy;
};

/** 档位预设允许的上限，用于把“每小时上限”限制在只能往下的范围内。 */
export const activityCeiling = (activity: GroupChatActivity): number => groupActivityPresets[activity].maxPerHour;

const describe = (value: GroupSettings[GroupSettingsField]): string => (value === undefined ? '' : Array.isArray(value) ? value.join(',') : String(value));

export class GroupSettingsStore {
  private readonly db: DatabaseSync;

  constructor(
    root: string,
    private readonly now: () => number = Date.now
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'group-settings.sqlite');

    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS group_settings (
        scope TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL, settings TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_settings_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
        field TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, operator TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS group_settings_audit_scope ON group_settings_audit(scope, at);`);
  }

  close(): void {
    this.db.close();
  }

  get(platform: string, channelId: string): GroupSettings {
    if (!platform || !channelId) return {};
    const row = this.db.prepare('SELECT settings FROM group_settings WHERE scope=?').get(scopeKey(platform, channelId));

    if (!row) return {};
    try {
      return JSON.parse(String(row.settings)) as GroupSettings;
    } catch {
      return {};
    }
  }

  countToday(platform: string, channelId: string): number {
    const dayStart = Math.floor(this.now() / 86400000) * 86400000;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM group_settings_audit WHERE scope=? AND at>=?').get(scopeKey(platform, channelId), dayStart);

    return Number(row?.n || 0);
  }

  lastChangeAt(platform: string, channelId: string, field: GroupSettingsField): number {
    const row = this.db
      .prepare('SELECT at FROM group_settings_audit WHERE scope=? AND field=? ORDER BY at DESC LIMIT 1')
      .get(scopeKey(platform, channelId), field);

    return Number(row?.at || 0);
  }

  audit(platform: string, channelId: string, limit = 10): GroupSettingsAudit[] {
    return this.db
      .prepare('SELECT field,before,after,operator,at FROM group_settings_audit WHERE scope=? ORDER BY at DESC LIMIT ?')
      .all(scopeKey(platform, channelId), Math.max(1, Math.min(50, limit))) as unknown as GroupSettingsAudit[];
  }

  /** 写入一个或多个字段；每日次数与单字段冷却在这里统一拦截。 */
  update(
    platform: string,
    channelId: string,
    operator: string,
    patch: GroupSettings,
    limits: { daily?: number; cooldownMs?: number } = {}
  ): { ok: true } | { ok: false; reason: string } {
    if (!platform || !channelId) return { ok: false, reason: '缺少群身份，无法保存本群设置。' };
    const daily = limits.daily ?? dailyChangeLimit;
    const cooldown = limits.cooldownMs ?? fieldCooldownMs;
    const now = this.now();

    if (this.countToday(platform, channelId) >= daily) return { ok: false, reason: `今天已经改过 ${daily} 次，明天再试或请主人调整。` };
    const fields = Object.keys(patch) as GroupSettingsField[];

    if (!fields.length) return { ok: false, reason: '没有需要保存的字段。' };
    for (const field of fields) {
      if (!groupSettingsFields.includes(field)) return { ok: false, reason: '不支持的设置项。' };
      if (now - this.lastChangeAt(platform, channelId, field) < cooldown) return { ok: false, reason: '同一项改得太快，请稍后再试。' };
    }
    const previous = this.get(platform, channelId);
    const next: GroupSettings = { ...previous };

    for (const field of fields) {
      // 赋 undefined 而不是 delete：序列化时会省略，避免动态键删除。
      (next as Record<string, unknown>)[field] = patch[field];
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO group_settings(scope,platform,channel_id,settings,updated_at,updated_by) VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at,updated_by=excluded.updated_by`
        )
        .run(scopeKey(platform, channelId), platform, channelId, JSON.stringify(next), now, operator);
      const insert = this.db.prepare('INSERT INTO group_settings_audit(scope,platform,channel_id,field,before,after,operator,at) VALUES(?,?,?,?,?,?,?,?)');

      for (const field of fields) {
        insert.run(scopeKey(platform, channelId), platform, channelId, field, describe(previous[field]), describe(patch[field]), operator, now);
      }
      this.db.exec('COMMIT');

      return { ok: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reset(platform: string, channelId: string, operator: string): void {
    if (!platform || !channelId) return;
    const previous = this.get(platform, channelId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM group_settings WHERE scope=?').run(scopeKey(platform, channelId));
      this.db
        .prepare('INSERT INTO group_settings_audit(scope,platform,channel_id,field,before,after,operator,at) VALUES(?,?,?,?,?,?,?,?)')
        .run(scopeKey(platform, channelId), platform, channelId, 'reset', JSON.stringify(previous), '', operator, this.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 退群、清群数据时清理本群设置与审计。 */
  purge(platform: string, channelId: string): void {
    const scope = scopeKey(platform, channelId);

    this.db.prepare('DELETE FROM group_settings WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM group_settings_audit WHERE scope=?').run(scope);
  }
}

const processState = globalThis as typeof globalThis & { __agentLinkGroupSettings__?: Map<string, GroupSettingsStore> };
const stores = (processState.__agentLinkGroupSettings__ ??= new Map<string, GroupSettingsStore>());

export const getGroupSettingsStore = (config: DSHBridgeConfig): GroupSettingsStore => {
  const root = dirname(config.workspaceRoot);
  let store = stores.get(root);

  if (!store) {
    store = new GroupSettingsStore(root);
    stores.set(root, store);
  }

  return store;
};

/** 本群语音策略：allowed=false 一律文字；auto=false 只回应显式语音请求。 */
export const groupVoicePolicy = (config: DSHBridgeConfig, channelId: string, platform = ''): { allowed: boolean; auto: boolean } => {
  try {
    const settings = getGroupSettingsStore(config).get(platform, channelId);

    return { allowed: settings.voiceEnabled !== false, auto: settings.voiceAuto !== false };
  } catch {
    return { allowed: true, auto: true };
  }
};

/** 本群生效的唤醒词 = 全局词表 + 群管理员补充（去重）。 */
export const wakeNamesFor = (config: DSHBridgeConfig, channelId: string, platform = ''): string[] => {
  try {
    const extra = getGroupSettingsStore(config).get(platform, channelId).wakeNames || [];

    return unique([...config.groupWakeNames, ...extra]);
  } catch {
    return [...config.groupWakeNames];
  }
};

/** 本群禁语词：只过滤机器人的群内输出，不影响用户消息。 */
export const bannedWordsFor = (config: DSHBridgeConfig, channelId: string, platform = ''): string[] => {
  try {
    return getGroupSettingsStore(config).get(platform, channelId).bannedWords || [];
  } catch {
    return [];
  }
};

/** 用等长的实心圆点遮盖禁语词，保持句子结构不被破坏。 */
export const maskBannedWords = (text: string, words: string[]): string => {
  if (!text || !words.length) return text;
  let output = text;

  for (const word of words) {
    if (!word) continue;
    const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');

    output = output.replace(pattern, match => '＊'.repeat(Math.max(1, Array.from(match).length)));
  }

  return output;
};

/** 叠加群设置的最终策略：默认值 → 配置显式值 → 群设置 → 配置再次覆盖（主人锁定）→ 按群覆盖。 */
export const groupPolicy = (config: DSHBridgeConfig, channelId: string, platform = ''): GroupChatPolicy => {
  try {
    return getGroupChatPolicy(config.groupChat, channelId, settingsToPolicy(getGroupSettingsStore(config).get(platform, channelId)));
  } catch {
    // 群设置存储不可用时退回纯配置策略，不能因此让消息处理失败。
    return getGroupChatPolicy(config.groupChat, channelId);
  }
};
