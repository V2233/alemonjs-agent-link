import type { BudgetConfig } from '../billing/budget';
import { dirname, join, resolve } from 'node:path';
import { dafeiyuPrompt } from './persona';
import { DSHError } from './errors';
import type { ModuleConfig } from '../agent/types';
import { getGroupChatPolicy, type GroupChatConfig } from '../social/group-policy';

export type AgentConfig = Partial<DSHBridgeConfig> & { baseUrl?: string; apiKey?: string };
export type ConfigContext = { cwd?: string; configPath?: string; dataRoot?: string; hasRedis?: boolean };

export type DSHBridgeConfig = {
  aiEnabled?: boolean;
  aiDisabledReason?: string;
  aiNoticeEpoch?: string;
  budget?: BudgetConfig;
  transport?: 'qq-bot' | 'onebot';
  replyGate?: { model?: string; baseUrl?: string; apiKey?: string };
  groupChat?: GroupChatConfig;
  modules?: ModuleConfig;
  groupWakeNames: string[];
  privateChatAccess: 'owner' | 'all';
  privateAutoReply: boolean;
  persona: 'assistant' | 'dafeiyu';
  privateHistoryMaxTurns: number;
  privateHistoryTtlSeconds: number;
  privateHistoryMaxChars: number;
  stateBackend?: 'local' | 'redis';
  pythonPackageSources?: string[];
  runtimeMode?: 'auto' | 'sandbox' | 'chat-only';
  pythonExecutable?: string;
  bridgePort: number;
  workspaceRoot: string;
  dshHomeRoot: string;
  profile: string;
  provider: string;
  model: string;
  defaultSystemPrompt: string;
  maxMessageLength: number;
  streamFlushIntervalMs: number;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  preparationTimeoutMs?: number;
  maxQueuedPerGroup: number;
  maxConcurrentRequests: number;
  maxActiveWorkers: number;
  maxCallsPerUserPerMinute: number;
  inputBlockedKeywords: string[];
  outputBlockedKeywords: string[];
  maxRequestBytes: number;
  retentionDays: number;
  recentChatMaxMessages: number;
  recentChatWindowSeconds: number;
  recentChatMaxChars: number;
  recentChatSummaryMaxChars: number;
};

export type AgentCapabilities = { chat: boolean; web: boolean; files: boolean; terminal: boolean };
export const resolveDSHConfig = (agentLink: AgentConfig = {}, options: ConfigContext = {}): DSHBridgeConfig => {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? process.env.CFG_PATH;
  const base = configPath ? dirname(resolve(cwd, configPath)) : cwd;
  const dataRoot = options.dataRoot ?? process.env.AGENT_LINK_DATA_DIR ?? join(base, '.data', 'agent-link');
  const pythonExecutable = process.platform === 'win32' ? join(dataRoot, 'venv', 'Scripts', 'python.exe') : join(dataRoot, 'venv', 'bin', 'python');
  const defaults: DSHBridgeConfig = {
    aiEnabled: true,
    aiDisabledReason: '',
    transport: 'qq-bot',
    groupWakeNames: [
      '帮我',
      '帮忙',
      '帮一下',
      '帮个忙',
      '求助',
      '求解',
      '请教',
      '肥鱼',
      '大肥鱼',
      '小肥鱼',
      '肥鱼儿',
      '肥鱼酱',
      '鱼宝',
      '鱼鱼',
      '小鲸鱼',
      '鲸鱼',
      'deepseek',
      'deep seek',
      'deep-seek',
      '深度求索',
      '深求',
      'dsh',
      'ds harness',
      'deepseek harness',
      'agentlink',
      'agent link'
    ],
    privateChatAccess: 'owner',
    privateAutoReply: true,
    persona: 'dafeiyu',
    privateHistoryMaxTurns: 10,
    privateHistoryTtlSeconds: 86400,
    privateHistoryMaxChars: 12000,
    stateBackend: 'local',
    pythonPackageSources: ['https://pypi.org/simple', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
    runtimeMode: 'auto',
    pythonExecutable,
    workspaceRoot: join(dataRoot, 'workspaces'),
    dshHomeRoot: join(dataRoot, 'dsh-homes'),
    bridgePort: 0,
    profile: 'sdk',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    defaultSystemPrompt: '你是一个友好、可靠的助手。',
    maxMessageLength: 1000,
    streamFlushIntervalMs: 500,
    requestTimeoutMs: 120000,
    startupTimeoutMs: 30000,
    preparationTimeoutMs: 120000,
    maxQueuedPerGroup: 3,
    maxConcurrentRequests: 8,
    maxActiveWorkers: 16,
    maxCallsPerUserPerMinute: 6,
    inputBlockedKeywords: [],
    outputBlockedKeywords: [],
    maxRequestBytes: 1048576,
    retentionDays: 30,
    recentChatMaxMessages: 20,
    recentChatWindowSeconds: 900,
    recentChatMaxChars: 6000,
    recentChatSummaryMaxChars: 1600
  };

  if (!agentLink || typeof agentLink !== 'object' || Array.isArray(agentLink)) {
    throw new DSHError('protocol', 'DSH 应用配置需要为对象');
  }

  const config = {
    ...defaults,
    ...agentLink,
    // Preserve existing deployments with explicit framework Redis configuration.
    stateBackend: agentLink?.stateBackend ?? (options.hasRedis ? 'redis' : 'local')
  };

  for (const field of ['workspaceRoot', 'dshHomeRoot'] as const) {
    if (typeof config[field] === 'string' && config[field].trim()) {
      config[field] = resolve(base, config[field]);
    }
  }
  if (typeof agentLink?.pythonExecutable === 'string' && /[\\/]/.test(agentLink.pythonExecutable)) {
    config.pythonExecutable = resolve(base, agentLink.pythonExecutable);
  }

  if (typeof agentLink?.dshHomeRoot === 'string' && agentLink.pythonExecutable === undefined) {
    const root = dirname(config.dshHomeRoot);

    config.pythonExecutable = process.platform === 'win32' ? join(root, 'venv', 'Scripts', 'python.exe') : join(root, 'venv', 'bin', 'python');
  }

  if (config.persona === 'dafeiyu' && agentLink?.defaultSystemPrompt === undefined) {
    config.defaultSystemPrompt = dafeiyuPrompt;
  }
  const ranges: Partial<Record<keyof DSHBridgeConfig, [number, number]>> = {
    privateHistoryMaxTurns: [0, 100],
    privateHistoryTtlSeconds: [1, 2592000],
    privateHistoryMaxChars: [1, 100000],
    maxMessageLength: [1, 10000],
    streamFlushIntervalMs: [1, 10000],
    requestTimeoutMs: [1, 300000],
    preparationTimeoutMs: [1000, 600000],
    startupTimeoutMs: [1, 300000],
    bridgePort: [0, 65535],
    maxQueuedPerGroup: [0, 3],
    maxConcurrentRequests: [1, 100],
    maxActiveWorkers: [1, 200],
    maxCallsPerUserPerMinute: [1, 60],
    maxRequestBytes: [1, 5 * 1024 * 1024],
    retentionDays: [30, 30],
    recentChatMaxMessages: [0, 10000],
    recentChatWindowSeconds: [0, 86400],
    recentChatMaxChars: [0, 1000000],
    recentChatSummaryMaxChars: [0, 1000000]
  };

  for (const [field, [min, max]] of Object.entries(ranges)) {
    const value = config[field];

    if (!Number.isSafeInteger(value) || value < min || value > max || (field === 'bridgePort' && value > 0 && value < 1024)) {
      throw new DSHError(
        'protocol',
        `DSH 配置 ${field} 无效：需要 ${min}–${max} 范围内的整数${field === 'bridgePort' ? '（0 自动选择，固定端口至少 1024）' : ''}。`
      );
    }
  }
  if (agentLink?.baseUrl !== undefined && agentLink.baseUrl !== '') {
    try {
      const url = new URL(agentLink.baseUrl);

      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error();
      }
    } catch {
      throw new DSHError('protocol', 'DSH 配置 baseUrl 需要不含凭证、查询参数的 HTTPS 基础地址。');
    }
  }
  if (config.replyGate !== undefined) {
    const gate = config.replyGate;

    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
      throw new DSHError('protocol', 'replyGate 需要为配置对象。');
    }
    for (const field of ['model', 'baseUrl', 'apiKey'] as const) {
      if (gate[field] !== undefined && typeof gate[field] !== 'string') {
        throw new DSHError('protocol', `replyGate.${field} 需要为字符串。`);
      }
    }
    if (gate.baseUrl?.trim()) {
      try {
        const url = new URL(gate.baseUrl.trim());

        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
          throw new Error();
        }
      } catch {
        throw new DSHError('protocol', 'replyGate.baseUrl 需要不含凭证、查询参数的 HTTPS 基础地址。');
      }
    }
  }
  if (typeof agentLink?.apiKey === 'string' && !agentLink.apiKey.trim()) {
    /* Unconfigured, handled by the setup flow. */
  }
  if (config.budget !== undefined) {
    const b = config.budget;

    if (!b || typeof b !== 'object' || Array.isArray(b) || (b.enabled !== undefined && typeof b.enabled !== 'boolean')) {
      throw new DSHError('protocol', 'budget 配置无效');
    }
    for (const field of ['groupDailyYuan', 'privateDailyYuan', 'personalDailyYuan', 'replyGateDailyYuan', 'globalDailyYuan'] as const) {
      if (b[field] !== undefined && (!Number.isFinite(b[field]) || b[field] < 0 || b[field] > 10000)) {
        throw new DSHError('protocol', `budget.${field} 需要为 0–10000 元`);
      }
    }
    if (b.maxOutputTokens !== undefined && (!Number.isSafeInteger(b.maxOutputTokens) || b.maxOutputTokens < 1 || b.maxOutputTokens > 8192)) {
      throw new DSHError('protocol', 'budget.maxOutputTokens 需要为 1–8192 的整数');
    }
  }
  const integerFields = [
    config.privateHistoryMaxTurns,
    config.privateHistoryTtlSeconds,
    config.privateHistoryMaxChars,
    config.maxMessageLength,
    config.streamFlushIntervalMs,
    config.requestTimeoutMs,
    config.startupTimeoutMs,
    config.bridgePort,
    config.maxQueuedPerGroup,
    config.maxConcurrentRequests,
    config.maxActiveWorkers,
    config.maxCallsPerUserPerMinute,
    config.maxRequestBytes,
    config.retentionDays,
    config.recentChatMaxMessages,
    config.recentChatWindowSeconds,
    config.recentChatMaxChars,
    config.recentChatSummaryMaxChars
  ];
  const stringFields = [
    config.pythonExecutable,
    config.workspaceRoot,
    config.dshHomeRoot,
    config.profile,
    config.provider,
    config.model,
    config.defaultSystemPrompt
  ];

  if (
    !['local', 'redis'].includes(config.stateBackend) ||
    !Array.isArray(config.pythonPackageSources) ||
    config.pythonPackageSources.length < 1 ||
    config.pythonPackageSources.length > 5 ||
    config.pythonPackageSources.some(source => {
      try {
        const url = new URL(source);

        return url.protocol !== 'https:' || Boolean(url.username || url.password);
      } catch {
        return true;
      }
    }) ||
    !Array.isArray(config.groupWakeNames) ||
    config.groupWakeNames.length > 64 ||
    config.groupWakeNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 20 || name.trim() !== name || name.startsWith('/')) ||
    !['owner', 'all'].includes(config.privateChatAccess) ||
    typeof config.privateAutoReply !== 'boolean' ||
    typeof config.aiEnabled !== 'boolean' ||
    typeof config.aiDisabledReason !== 'string' ||
    config.aiDisabledReason.length > 500 ||
    !['assistant', 'dafeiyu'].includes(config.persona) ||
    config.privateHistoryMaxTurns < 0 ||
    config.privateHistoryMaxTurns > 100 ||
    config.privateHistoryTtlSeconds < 1 ||
    config.privateHistoryTtlSeconds > 2592000 ||
    config.privateHistoryMaxChars < 1 ||
    config.privateHistoryMaxChars > 100000 ||
    !['auto', 'sandbox', 'chat-only'].includes(config.runtimeMode) ||
    !['qq-bot', 'onebot'].includes(config.transport) ||
    !integerFields.every(Number.isSafeInteger) ||
    !stringFields.every(value => typeof value === 'string' && value.trim().length > 0) ||
    config.maxMessageLength < 1 ||
    config.maxMessageLength > 10_000 ||
    config.streamFlushIntervalMs < 1 ||
    config.streamFlushIntervalMs > 10_000 ||
    config.requestTimeoutMs < 1 ||
    config.requestTimeoutMs > 300_000 ||
    config.recentChatMaxMessages < 0 ||
    config.recentChatWindowSeconds < 0 ||
    config.recentChatMaxChars < 0 ||
    config.recentChatSummaryMaxChars < 0 ||
    (config.bridgePort !== 0 && config.bridgePort < 1024) ||
    config.bridgePort > 65535 ||
    config.startupTimeoutMs < 1 ||
    config.maxQueuedPerGroup < 0 ||
    config.maxQueuedPerGroup > 3 ||
    config.maxConcurrentRequests < 1 ||
    config.maxConcurrentRequests > 100 ||
    config.maxActiveWorkers < 1 ||
    config.maxActiveWorkers > 200 ||
    config.maxCallsPerUserPerMinute < 1 ||
    config.maxCallsPerUserPerMinute > 60 ||
    config.maxRequestBytes < 1 ||
    config.maxRequestBytes > 5 * 1024 * 1024 ||
    config.retentionDays !== 30 ||
    !Array.isArray(config.inputBlockedKeywords) ||
    !config.inputBlockedKeywords.every(value => typeof value === 'string') ||
    !Array.isArray(config.outputBlockedKeywords) ||
    !config.outputBlockedKeywords.every(value => typeof value === 'string')
  ) {
    throw new DSHError('protocol', 'DSH 配置的类型或安全范围无效，请检查 pythonPackageSources、路径、唤醒词及输入输出策略。');
  }

  getGroupChatPolicy(config.groupChat);

  return config;
};
