import { preparePython } from './python-bootstrap';
import { type ChatInput } from './input';
import type { PrivateHistoryContext } from '@src/state/registry';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { access, mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logger } from 'alemonjs';
import type { DSHBridgeConfig } from '@src/dsh/client';
import { getSandboxCredentials, type DSHCredentials } from '@src/dsh/credentials';
import { modelPoolForBridge } from '../credentials/pool';
import { directChat } from './direct-chat';
import type { DSHStreamEvent } from './client';

type BridgeRequest = { url: string; token: string };
type BridgeRuntimeRecord = {
  version: 1;
  port: number;
  token: string;
  fingerprint: string;
};
export type DSHSupervisorStatus = {
  phase: 'idle' | 'preparing' | 'installing' | 'starting' | 'ready' | 'degraded' | 'failed' | 'stopped';
  detail?: string;
  chatReady?: boolean;
};

const bridgeScript = join(dirname(fileURLToPath(import.meta.url)), '../../python/dsh_bridge.py');
const requirementsFile = join(dirname(fileURLToPath(import.meta.url)), '../../python/requirements.txt');

type SupervisorProcessState = {
  supervisor: DSHSupervisor | null;
  fingerprint: string | null;
  bridgeOverride: BridgeRequest | null;
  statusWrite?: Promise<void>;
};

// lvy hot reload can evaluate this module again without stopping its prior
// child process. Keep the owner and its token process-scoped so a reload
// reuses that authenticated bridge instead of racing it for the fixed port.
const globalState = globalThis as typeof globalThis & { __agentLinkDSHState__?: SupervisorProcessState };
const processState = (globalState.__agentLinkDSHState__ ??= { supervisor: null, fingerprint: null, bridgeOverride: null });
let shutdownHookInstalled = false;

const installShutdownHook = (): void => {
  if (shutdownHookInstalled) {
    return;
  }
  shutdownHookInstalled = true;
  const stopBridge = (): void => processState.supervisor?.stop();

  // AlemonJS/lvy sends these during reload. Reap the authenticated child before
  // the next runtime owns the fixed loopback port.
  process.once('SIGINT', stopBridge);
  process.once('SIGTERM', stopBridge);
  process.once('disconnect', stopBridge);
  process.once('exit', stopBridge);
};

const fingerprintConfig = (config: DSHBridgeConfig): string =>
  JSON.stringify(
    Object.entries(config)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
  );

const fingerprintCredentials = (credentials: DSHCredentials | null): string =>
  credentials
    ? createHash('sha256')
        .update(`${credentials.apiKey}\u0000${credentials.baseUrl ?? ''}\u0000${credentials.model ?? ''}`)
        .digest('hex')
    : 'none';

export class DSHSupervisor {
  private child: ChildProcess | null = null;
  private token = randomBytes(32).toString('hex');
  private starting: Promise<void> | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statusValue: DSHSupervisorStatus = { phase: 'idle' };
  private stopped = false;
  private attempt = 0;
  private preparation: AbortController | null = null;
  private actualPort: number;
  private nextRetryAt = 0;
  private readonly directSessions = new Set<string>();
  private readonly pendingResets = new Set<string>();

  constructor(
    private readonly config: DSHBridgeConfig,
    private readonly credentials: DSHCredentials | null,
    private readonly fingerprint: string
  ) {
    this.actualPort = config.bridgePort;
  }

  async start(): Promise<void> {
    if (this.statusValue.phase === 'ready') {
      return;
    }
    if (this.statusValue.phase === 'degraded' && (this.config.runtimeMode === 'chat-only' || !this.credentials || Date.now() < this.nextRetryAt)) {
      return;
    }
    if (this.starting !== null) {
      return this.starting;
    }
    this.stopped = false;
    const attempt = ++this.attempt;
    const controller = new AbortController();

    this.preparation = controller;
    this.statusValue = { phase: 'preparing' };
    const pending = (async () => {
      try {
        await this.writeStartupStatus();
        controller.signal.throwIfAborted();
        await this.launch(controller.signal);
        if (this.attempt !== attempt || this.stopped) {
          return;
        }
        this.retries = 0;
        this.statusValue = { phase: 'ready' };
        await this.writeStartupStatus();
      } catch (error) {
        if (this.attempt !== attempt || this.stopped) {
          return;
        }
        this.child?.kill('SIGTERM');
        this.child = null;
        if ((this.config.runtimeMode ?? 'auto') !== 'sandbox') {
          this.statusValue = {
            phase: 'degraded',
            detail:
              this.config.runtimeMode === 'chat-only' && this.credentials
                ? '普通聊天已就绪。'
                : `普通聊天模式：${this.describeStartupFailure(error)} 网页暂不可用；受限文件工具按模块及会话权限开放，终端禁止。`
          };
          if (this.credentials && this.config.runtimeMode !== 'chat-only') {
            this.scheduleRetry();
          }
          await this.writeStartupStatus();

          return;
        }
        this.statusValue = { phase: 'failed', detail: this.describeStartupFailure(error) };
        await this.writeStartupStatus();
        throw error;
      } finally {
        if (this.attempt === attempt) {
          this.starting = null;
          this.preparation = null;
        }
      }
    })();

    this.starting = pending;

    return await pending;
  }

  async prepareForChat(): Promise<void> {
    if (this.config.runtimeMode === 'sandbox' || this.config.runtimeMode === 'chat-only') {
      await this.start();

      return;
    }
    void this.start().catch(() => undefined);
  }

  useSandbox(sessionId: string): boolean {
    if (this.directSessions.has(sessionId)) {
      return false;
    }
    if (this.statusValue.phase === 'ready') {
      return true;
    }
    // Keep a conversation on its original backend until /new, preserving its
    // history while the optional sandbox finishes preparation in the background.
    this.directSessions.add(sessionId);

    return false;
  }

  queueSessionReset(sessionId: string): void {
    if ((this.config.runtimeMode ?? 'auto') === 'auto') {
      this.pendingResets.add(sessionId);
    }
  }

  private async flushSessionResets(signal: AbortSignal): Promise<void> {
    while (this.pendingResets.size) {
      signal.throwIfAborted();
      const id = this.pendingResets.values().next().value;
      const response = await fetch(`http://127.0.0.1:${this.actualPort}/v1/session/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.startupTimeoutMs)])
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Deferred session reset failed');
      }
      await response.body?.cancel();
      this.pendingResets.delete(id);
    }
  }

  resetTransport(sessionId: string): void {
    for (const id of this.directSessions) {
      if (id === sessionId || id.startsWith(`${sessionId}:v`)) {
        this.directSessions.delete(id);
      }
    }
  }

  async request(): Promise<BridgeRequest> {
    await this.start();

    return { url: `http://127.0.0.1:${this.actualPort}`, token: this.token };
  }

  stop(): void {
    this.stopped = true;
    this.attempt++;
    this.preparation?.abort();
    this.preparation = null;
    this.starting = null;
    this.statusValue = { phase: 'stopped' };
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.child?.killed === false) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
  }

  status(): DSHSupervisorStatus {
    return {
      ...this.statusValue,
      chatReady: Boolean(this.credentials) && !this.stopped && (this.statusValue.phase === 'ready' || (this.config.runtimeMode ?? 'auto') !== 'sandbox')
    };
  }

  async chatDirect(
    message: ChatInput,
    signal: AbortSignal,
    onEvent: (event: DSHStreamEvent) => Promise<void>,
    privateHistory?: PrivateHistoryContext,
    onCompleted?: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    await directChat(this.config, this.credentials, message, signal, onEvent, privateHistory, onCompleted);
  }

  private async launch(signal: AbortSignal): Promise<void> {
    if (!this.credentials) {
      throw new Error('Model credentials missing');
    }
    if (this.config.runtimeMode === 'chat-only') {
      throw new Error('chat-only selected');
    }
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('Native Windows sandbox unavailable');
    }
    if (process.platform === 'darwin') {
      await access('/usr/bin/sandbox-exec');
    }
    if (process.platform === 'linux') {
      const candidates = process.env.DSH_BWRAP_EXECUTABLE
        ? [process.env.DSH_BWRAP_EXECUTABLE]
        : (process.env.PATH || '')
            .split(':')
            .filter(Boolean)
            .map(path => join(path, 'bwrap'));
      const available = await Promise.all(
        candidates.map(path =>
          access(path).then(
            () => true,
            () => false
          )
        )
      );

      if (!available.some(Boolean)) {
        throw new Error('bubblewrap unavailable');
      }
    }
    if (this.child?.exitCode === null) {
      await this.waitForHealth(this.config.startupTimeoutMs, signal);

      return;
    }

    await this.bootstrapPython(signal);
    signal.throwIfAborted();
    if (await this.adoptAuthenticatedBridge()) {
      await this.flushSessionResets(signal);

      return;
    }
    signal.throwIfAborted();
    if (this.config.bridgePort === 0) {
      this.actualPort = await this.choosePort();
    }
    await this.assertPortAvailable();
    signal.throwIfAborted();
    this.statusValue = { phase: 'starting' };
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_BRIDGE_TOKEN: this.token,
      DSH_WORKSPACE_ROOT: this.config.workspaceRoot,
      DSH_HOME_ROOT: this.config.dshHomeRoot,
      DSH_PROFILE: this.config.profile,
      DSH_PROVIDER: this.config.provider,
      DSH_MODEL: this.credentials?.model || this.config.model,
      DSH_SYSTEM_PROMPT: this.config.defaultSystemPrompt,
      DSH_NODE_VERSION: process.version,
      DSH_MAX_REQUEST_BYTES: String(this.config.maxRequestBytes),
      // Leave a small margin for the Bridge to return an SSE error and reap
      // the worker before the Node-side request deadline aborts the stream.
      DSH_WORKER_TIMEOUT_SECONDS: String(Math.max(1, Math.floor((this.config.requestTimeoutMs - 5000) / 1000))),
      DSH_MAX_QUEUED_PER_GROUP: String(this.config.maxQueuedPerGroup),
      DSH_MAX_ACTIVE_WORKERS: String(this.config.maxActiveWorkers),
      DSH_MAX_CALLS_PER_USER_PER_MINUTE: String(this.config.maxCallsPerUserPerMinute),
      DSH_RETENTION_DAYS: String(this.config.retentionDays),
      DSH_INPUT_BLOCKED_KEYWORDS: this.config.inputBlockedKeywords.join(','),
      DSH_OUTPUT_BLOCKED_KEYWORDS: this.config.outputBlockedKeywords.join(',')
    };

    delete env.DEEPSEEK_API_KEY;
    delete env.DEEPSEEK_BASE_URL;
    delete env.DSH_MODEL_POOL;
    const pool = modelPoolForBridge(this.config);

    if (pool) {
      env.DSH_MODEL_POOL = JSON.stringify(pool);
    }
    if (this.credentials) {
      env.DEEPSEEK_API_KEY = this.credentials.apiKey;
      const baseUrl = this.credentials.baseUrl || (this.config.provider === 'deepseek-official' ? 'https://api.deepseek.com' : undefined);

      if (baseUrl) {
        env.DEEPSEEK_BASE_URL = baseUrl;
      }
    }

    const child = spawn(this.config.pythonExecutable, [bridgeScript, '--port', String(this.actualPort)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.child = child;
    child.on('error', () => {
      this.child = null;
    });
    // Keep routine child output quiet; never expose provider credentials from stderr.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'DSH bridge exited');
      if (this.child?.pid === child.pid) {
        this.child = null;
        if (!this.stopped) {
          this.statusValue = { phase: 'failed', detail: 'DSH Bridge 已退出，正在尝试恢复。' };
          this.scheduleRetry();
        }
      }
    });

    await this.waitForHealth(this.config.startupTimeoutMs, signal);
    await this.flushSessionResets(signal);
    await this.writeRuntimeRecord();
  }

  /**
   * A Bridge may outlive its Node parent during a supervisor restart. Reuse it
   * only when a local, owner-only record supplies the matching bearer token
   * and configuration fingerprint. A process merely occupying the port is
   * never trusted or adopted.
   */
  private async adoptAuthenticatedBridge(): Promise<boolean> {
    const record = await this.readRuntimeRecord();

    if (!record || (this.config.bridgePort !== 0 && record.port !== this.config.bridgePort) || record.fingerprint !== this.fingerprint) {
      return false;
    }

    const previousToken = this.token;
    const previousPort = this.actualPort;

    this.actualPort = record.port;

    this.token = record.token;
    try {
      await this.waitForHealth(1_500);

      return true;
    } catch {
      this.token = previousToken;
      this.actualPort = previousPort;

      return false;
    }
  }

  private runtimeRecordPath(): string {
    return join(dirname(this.config.dshHomeRoot), 'bridge-runtime.json');
  }

  private async readRuntimeRecord(): Promise<BridgeRuntimeRecord | null> {
    const path = this.runtimeRecordPath();

    try {
      const info = await stat(path);

      // The token authorizes local lifecycle and chat requests. Do not accept
      // a record readable by other local users or owned by another account.
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
        return null;
      }
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<BridgeRuntimeRecord>;

      if (value.version !== 1 || !Number.isSafeInteger(value.port) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(String(value.token))) {
        return null;
      }

      return value as BridgeRuntimeRecord;
    } catch {
      return null;
    }
  }

  private async writeRuntimeRecord(): Promise<void> {
    const path = this.runtimeRecordPath();
    const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const record: BridgeRuntimeRecord = {
      version: 1,
      port: this.actualPort,
      token: this.token,
      fingerprint: this.fingerprint
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  }

  private async bootstrapPython(signal: AbortSignal): Promise<void> {
    await preparePython(
      this.config,
      requirementsFile,
      () => {
        this.statusValue = { phase: 'installing' };
        void this.writeStartupStatus();
      },
      undefined,
      signal
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) {
      return;
    }
    const delay = Math.min(300000, 30000 * 2 ** Math.min(this.retries++, 4));

    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = 0;
      void this.start().catch(() => undefined);
    }, delay);
    this.retryTimer.unref();
  }

  private choosePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        server.close(error => (error ? reject(error) : resolve(port)));
      });
    });
  }

  private async assertPortAvailable(): Promise<void> {
    const occupied = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: this.actualPort });

      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (occupied) {
      throw new Error(`DSH bridge port ${this.actualPort} is already in use`);
    }
  }

  private async waitForHealth(timeoutMs = this.config.startupTimeoutMs, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let response: Response;

      try {
        response = await fetch(`http://127.0.0.1:${this.actualPort}/health`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now())))])
        });
      } catch {
        // Bridge is still starting.
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      if (response.ok) {
        return;
      }
      if (response.status === 503) {
        throw new Error(`DSH bridge preflight failed: ${(await response.text()).slice(0, 240)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('DSH bridge health check timed out');
  }

  private writeStartupStatus(): Promise<void> {
    const attempt = this.attempt;
    const record = { ...this.status(), platform: process.platform, arch: process.arch, node: process.version, updatedAt: new Date().toISOString() };
    const write = async (): Promise<void> => {
      try {
        if (attempt !== this.attempt) return;
        const path = join(dirname(this.config.dshHomeRoot), 'startup-status.json');

        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;

        await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
        if (attempt !== this.attempt) {
          await unlink(temp).catch(() => undefined);

          return;
        }
        await rename(temp, path);
      } catch {
        /* Diagnostics must not turn a working chat backend into a failure. */
      }
    };
    const pending = (processState.statusWrite ?? Promise.resolve()).then(write);

    processState.statusWrite = pending;

    return pending;
  }

  private describeStartupFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : '';

    if (message.includes('Model credentials missing')) {
      return '请填写 alemon.config.yaml 中的 alemonjs-agent-link.apiKey 后重新启动。';
    }
    if (message.includes('Windows sandbox')) {
      return '当前系统不提供受支持的本地沙箱。';
    }
    if (message.includes('bubblewrap')) {
      return '未找到 Linux Bubblewrap 沙箱。';
    }
    if (message.includes('No usable Python')) {
      return '未找到可用的 Python/venv。';
    }
    if (message.includes('sources unavailable')) {
      return '依赖下载源不可用；联网后重启可重试。';
    }
    if (message.includes('Configured Python')) {
      return '自定义 Python 环境不可用，请检查 pythonExecutable。';
    }
    if (message.includes('preflight failed')) {
      return '安全前置检查失败：请确认系统沙箱、Python 运行时和模型服务配置均有效。';
    }

    if (message.includes('port') && message.includes('already in use')) {
      return `DSH Bridge 端口 ${this.actualPort} 已被占用；请停止旧 Bridge 实例，或在配置中指定其他 bridgePort。`;
    }

    if (message.includes('health check timed out')) {
      return '启动超时。请检查端口是否被占用、Python 环境和网络连接。';
    }

    return '自动准备 DSH 失败。请检查 Python 3、网络连接和插件数据目录权限。';
  }
}

export const configureDSHSupervisor = (config: DSHBridgeConfig, credentials: DSHCredentials | null = null): DSHSupervisor => {
  installShutdownHook();
  const fingerprint = createHash('sha256')
    .update(`${fingerprintConfig(config)}:${fingerprintCredentials(credentials)}`)
    .digest('hex');

  if (processState.supervisor && processState.fingerprint === fingerprint) {
    return processState.supervisor;
  }

  processState.supervisor?.stop();
  processState.supervisor = new DSHSupervisor(config, credentials, fingerprint);
  processState.fingerprint = fingerprint;

  return processState.supervisor;
};

export const ensureDSHSupervisor = async (config: DSHBridgeConfig): Promise<DSHSupervisor> => {
  if (processState.bridgeOverride) {
    return configureDSHSupervisor(config);
  }

  let credentials: DSHCredentials | null = null;

  try {
    credentials = await getSandboxCredentials();
  } catch (error) {
    logger.warn({ err: error }, 'System credential store unavailable');
  }

  return configureDSHSupervisor(config, credentials);
};

export const getDSHBridge = async (): Promise<BridgeRequest> => {
  if (processState.bridgeOverride) {
    return processState.bridgeOverride;
  }

  if (!processState.supervisor) {
    throw new Error('DSH supervisor has not been configured');
  }

  return await processState.supervisor.request();
};

export const getDSHSupervisorStatus = (): DSHSupervisorStatus => processState.supervisor?.status() ?? { phase: 'idle' };
export const hasDSHBridgeOverride = (): boolean => processState.bridgeOverride !== null;

export const setDSHBridgeForTesting = (bridge: BridgeRequest | null): void => {
  processState.bridgeOverride = bridge;
};
