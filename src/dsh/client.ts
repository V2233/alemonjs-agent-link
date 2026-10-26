import { dafeiyuPrompt } from './persona';
import type { PrivateHistoryContext } from '@src/state/registry';
import { getConfigValue } from 'alemonjs';
import { join } from 'node:path';
import { ensureDSHSupervisor, getDSHBridge, hasDSHBridgeOverride } from '@src/dsh/supervisor';

export type DSHBridgeConfig = {
  groupWakeNames: string[];
  privateChatAccess: 'owner' | 'all';
  privateAutoReply: boolean;
  persona: 'assistant' | 'dafeiyu';
  privateHistoryMaxTurns: number;
  privateHistoryTtlSeconds: number;
  privateHistoryMaxChars: number;
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
const toCapabilities = (value: AgentCapabilities): AgentCapabilities => ({
  chat: value.chat,
  web: value.web,
  files: value.files,
  terminal: value.terminal
});

export type DSHStreamEvent =
  { type: 'content'; content: string } | { type: 'done' } | { type: 'tool_call'; tool?: string; args?: unknown } | { type: 'error'; message?: string };

type ConfigValue = {
  'alemonjs-agent-link'?: Partial<DSHBridgeConfig>;
};

const dataRoot = join(process.cwd(), '.data', 'agent-link');
const pythonExecutable = process.platform === 'win32' ? join(dataRoot, 'venv', 'Scripts', 'python.exe') : join(dataRoot, 'venv', 'bin', 'python');
const defaults: DSHBridgeConfig = {
  groupWakeNames: ['大肥鱼'],
  privateChatAccess: 'owner',
  privateAutoReply: true,
  persona: 'dafeiyu',
  privateHistoryMaxTurns: 10,
  privateHistoryTtlSeconds: 86400,
  privateHistoryMaxChars: 12000,
  runtimeMode: 'auto',
  pythonExecutable,
  workspaceRoot: join(dataRoot, 'workspaces'),
  dshHomeRoot: join(dataRoot, 'dsh-homes'),
  bridgePort: 18080,
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  defaultSystemPrompt: '你是一个友好、可靠的助手。',
  maxMessageLength: 1000,
  streamFlushIntervalMs: 500,
  requestTimeoutMs: 120000,
  startupTimeoutMs: 30000,
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

export class DSHError extends Error {
  constructor(
    public readonly kind: 'auth' | 'http' | 'network' | 'timeout' | 'cancelled' | 'protocol' | 'agent' | 'migration' | 'delivery',
    message: string
  ) {
    super(message);
    this.name = 'DSHError';
  }
}

export const getDSHConfig = (value: ConfigValue = getConfigValue()): DSHBridgeConfig => {
  const agentLink = value?.['alemonjs-agent-link'];

  const config = {
    ...defaults,
    ...agentLink
  };

  if (config.persona === 'dafeiyu' && agentLink?.defaultSystemPrompt === undefined) {
    config.defaultSystemPrompt = dafeiyuPrompt;
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
    !Array.isArray(config.groupWakeNames) ||
    config.groupWakeNames.length > 10 ||
    config.groupWakeNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 20 || name.trim() !== name || name.startsWith('/')) ||
    !['owner', 'all'].includes(config.privateChatAccess) ||
    typeof config.privateAutoReply !== 'boolean' ||
    !['assistant', 'dafeiyu'].includes(config.persona) ||
    config.privateHistoryMaxTurns < 0 ||
    config.privateHistoryMaxTurns > 100 ||
    config.privateHistoryTtlSeconds < 1 ||
    config.privateHistoryTtlSeconds > 2592000 ||
    config.privateHistoryMaxChars < 1 ||
    config.privateHistoryMaxChars > 100000 ||
    !['auto', 'sandbox', 'chat-only'].includes(config.runtimeMode) ||
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
    config.bridgePort < 1024 ||
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
    throw new DSHError('protocol', 'DSH 配置的类型或安全范围无效');
  }

  return config;
};

const getHeaders = (token: string): HeadersInit => {
  const headers: HeadersInit = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json'
  };

  headers.Authorization = `Bearer ${token}`;

  return headers;
};

const parseSSEMessage = (rawEvent: string): DSHStreamEvent | null => {
  const data = rawEvent
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');

  if (!data) {
    return null;
  }

  try {
    const event = JSON.parse(data) as DSHStreamEvent;

    if (!event || typeof event.type !== 'string' || (event.type === 'content' && typeof event.content !== 'string')) {
      throw new Error('missing type');
    }

    return event;
  } catch {
    throw new DSHError('protocol', 'DSH 返回了无效的流式数据');
  }
};

const consumeEvents = async (reader: ReadableStreamDefaultReader<Uint8Array>, onEvent: (event: DSHStreamEvent) => Promise<void>): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = async (rawEvent: string): Promise<void> => {
    const event = parseSSEMessage(rawEvent);

    if (!event) {
      return;
    }

    if (event.type === 'error') {
      const message = event.message || 'DSH Agent 执行失败';

      throw new DSHError(/timed out|超时/i.test(message) ? 'timeout' : 'agent', message);
    }

    await onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();

    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');

    let separator = buffer.indexOf('\n\n');

    while (separator >= 0) {
      await dispatch(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    await dispatch(buffer);
  }
};

export const streamChat = async (
  config: DSHBridgeConfig,
  sessionId: string,
  message: string,
  onEvent: (event: DSHStreamEvent) => Promise<void>,
  userId = 'unknown',
  externalSignal?: AbortSignal,
  capabilities: AgentCapabilities = { chat: true, web: true, files: false, terminal: false },
  privateHistory?: PrivateHistoryContext,
  onCompleted?: (signal: AbortSignal) => Promise<void>
): Promise<void> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  timeout.unref();

  try {
    // getConfigValue() is intentionally evaluated by the caller per request.
    // Reconfigure only when those current values actually differ.
    const supervisor = await ensureDSHSupervisor(config);

    if (!capabilities.chat) {
      throw new DSHError('auth', '聊天能力已关闭。');
    }
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;

    // Test bridge overrides retain their existing transport behavior.
    if (!hasDSHBridgeOverride()) {
      await supervisor.start();
      signal.throwIfAborted();
      if (supervisor.status().phase === 'degraded') {
        await supervisor.chatDirect(message, signal, onEvent, privateHistory, onCompleted);

        return;
      }
    }
    const bridge = await getDSHBridge();
    const response = await fetch(`${bridge.url}/v1/chat`, {
      method: 'POST',
      headers: { ...getHeaders(bridge.token), 'X-Agent-Link-User': userId },
      body: JSON.stringify({
        sessionId,
        message: privateHistory?.memoryContext ? `${privateHistory.memoryContext}\n\n当前消息：\n${message}` : message,
        systemPrompt: config.defaultSystemPrompt,
        stream: true,
        capabilities: toCapabilities(capabilities)
      }),
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      throw new DSHError('auth', 'DSH 鉴权失败');
    }

    if (!response.ok) {
      throw new DSHError('http', `DSH 服务返回 HTTP ${response.status}`);
    }

    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new DSHError('protocol', 'DSH 未返回 SSE 响应');
    }

    if (!response.body) {
      throw new DSHError('protocol', 'DSH 未返回流式响应');
    }

    await consumeEvents(response.body.getReader(), onEvent);
    signal.throwIfAborted();
    await onCompleted?.(signal);
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof DSHError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new DSHError('cancelled', 'DSH 请求已取消');
      }

      throw new DSHError('timeout', 'DSH 请求超时');
    }

    throw new DSHError('network', error instanceof Error ? error.message : '无法连接 DSH 服务');
  } finally {
    clearTimeout(timeout);
  }
};

export const clearSession = async (config: DSHBridgeConfig, sessionId: string): Promise<void> => {
  await deleteBridgeResource(config, `/v1/session/${encodeURIComponent(sessionId)}`, '无法清除 DSH 会话');
};

const deleteBridgeResource = async (config: DSHBridgeConfig, path: string, failureMessage: string): Promise<void> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  timeout.unref();

  try {
    const supervisor = await ensureDSHSupervisor(config);

    if (!hasDSHBridgeOverride()) {
      await supervisor.start();
      if (supervisor.status().phase === 'degraded') {
        if (path.startsWith('/v1/session/')) {
          return;
        } // Direct chat stores no SDK sessions.
        throw new DSHError('http', '纯聊天模式无法删除旧沙箱数据；请恢复 Bridge 后重试清理。');
      }
    }
    const bridge = await getDSHBridge();
    const response = await fetch(`${bridge.url}${path}`, {
      method: 'DELETE',
      headers: getHeaders(bridge.token),
      signal: controller.signal
    });

    if (response.status === 401 || response.status === 403) {
      throw new DSHError('auth', 'DSH 鉴权失败');
    }

    if (!response.ok) {
      throw new DSHError('http', failureMessage);
    }
  } catch (error) {
    if (error instanceof DSHError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DSHError('timeout', 'DSH 请求超时');
    }

    throw new DSHError('network', error instanceof Error ? error.message : '无法连接 DSH 服务');
  } finally {
    clearTimeout(timeout);
  }
};

export const purgeSessionData = async (config: DSHBridgeConfig, sessionId: string): Promise<void> => {
  await deleteBridgeResource(config, `/v1/group/${encodeURIComponent(sessionId)}`, '无法清除 DSH 群数据');
};

export const purgeGroupHashData = async (config: DSHBridgeConfig, groupHash: string): Promise<void> => {
  await deleteBridgeResource(config, `/v1/group-hash/${encodeURIComponent(groupHash)}`, '无法清除 DSH 群数据');
};

export const toUserMessage = (error: unknown): string => {
  if (!(error instanceof DSHError)) {
    return '服务暂时不可用，请稍后再试。';
  }

  const messages: Record<DSHError['kind'], string> = {
    delivery: '回复发送失败，请稍后重试。',
    auth: 'Agent 服务认证失败，请联系机器人管理员。',
    http: 'Agent 服务暂时不可用，请稍后再试。',
    network: '暂时无法连接 Agent 服务，请稍后再试。',
    timeout: 'Agent 响应超时，请稍后重试。',
    cancelled: '本次回复已取消。',
    protocol: 'Agent 服务响应异常，请联系机器人管理员。',
    agent: 'Agent 本轮执行失败，已自动开始新的群会话。请原样重试；若持续失败，请由主人私聊使用 /agentmodels 确认模型，并检查 alemon.config.yaml 中的模型配置。',
    migration: '会话正在初始化，请稍后重试。'
  };

  return messages[error.kind];
};
