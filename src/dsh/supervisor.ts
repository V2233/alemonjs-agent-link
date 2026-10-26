import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logger } from 'alemonjs';
import type { DSHBridgeConfig } from '@src/dsh/client';
import { getDSHCredentials, type DSHCredentials } from '@src/dsh/credentials';
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
};

const bridgeScript = join(dirname(fileURLToPath(import.meta.url)), '../../python/dsh_bridge.py');
const requirementsFile = join(dirname(fileURLToPath(import.meta.url)), '../../python/requirements.txt');

type SupervisorProcessState = {
  supervisor: DSHSupervisor | null;
  fingerprint: string | null;
  bridgeOverride: BridgeRequest | null;
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

  constructor(
    private readonly config: DSHBridgeConfig,
    private readonly credentials: DSHCredentials | null,
    private readonly fingerprint: string
  ) {}

  async start(): Promise<void> {
    if (this.statusValue.phase === 'degraded') {
      return;
    }
    const pending = this.starting;

    if (pending !== null) {
      return pending;
    }

    this.stopped = false;
    this.statusValue = { phase: 'preparing' };
    this.starting = this.launch();

    try {
      await this.starting;
      this.statusValue = { phase: 'ready' };
    } catch (error) {
      if ((this.config.runtimeMode ?? 'auto') !== 'sandbox' && this.credentials) {
        this.stop();
        this.statusValue = { phase: 'degraded', detail: '纯聊天模式：本地运行环境不可用或已选择纯聊天；网页、文件、终端关闭。修复环境后重启服务恢复沙箱。' };
        logger.warn('AgentLink 已降级为模型直连纯聊天；本地工具关闭。');

        return;
      }
      this.statusValue = { phase: 'failed', detail: this.describeStartupFailure(error) };
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async request(): Promise<BridgeRequest> {
    await this.start();

    return { url: `http://127.0.0.1:${this.config.bridgePort}`, token: this.token };
  }

  stop(): void {
    this.stopped = true;
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
    return { ...this.statusValue };
  }

  async chatDirect(message: string, signal: AbortSignal, onEvent: (event: DSHStreamEvent) => Promise<void>): Promise<void> {
    await directChat(this.config, this.credentials, message, signal, onEvent);
  }

  private async launch(): Promise<void> {
    if (this.config.runtimeMode === 'chat-only') {
      throw new Error('chat-only selected');
    }
    if (process.platform === 'win32') {
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
      await this.waitForHealth();

      return;
    }

    await this.bootstrapPython();
    if (await this.adoptAuthenticatedBridge()) {
      return;
    }
    await this.assertPortAvailable();
    this.statusValue = { phase: 'starting' };
    const env = {
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
    if (this.credentials) {
      env.DEEPSEEK_API_KEY = this.credentials.apiKey;
      const baseUrl = this.credentials.baseUrl || (this.config.provider === 'deepseek-official' ? 'https://api.deepseek.com' : undefined);

      if (baseUrl) {
        env.DEEPSEEK_BASE_URL = baseUrl;
      }
    }

    const child = spawn(this.config.pythonExecutable, [bridgeScript, '--port', String(this.config.bridgePort)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.child = child;
    child.on('error', () => {
      this.child = null;
    });
    child.stdout?.on('data', data => logger.info({ dsh: String(data).trim() }, 'DSH bridge'));
    child.stderr?.on('data', data => logger.warn({ dsh: String(data).trim() }, 'DSH bridge'));
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

    await this.waitForHealth();
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

    if (record?.port !== this.config.bridgePort || record?.fingerprint !== this.fingerprint) {
      return false;
    }

    const previousToken = this.token;

    this.token = record.token;
    try {
      await this.waitForHealth(1_500);
      logger.info({ port: this.config.bridgePort }, 'Reused authenticated DSH bridge');

      return true;
    } catch {
      this.token = previousToken;

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
      port: this.config.bridgePort,
      token: this.token,
      fingerprint: this.fingerprint
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
  }

  private async bootstrapPython(): Promise<void> {
    try {
      await access(this.config.pythonExecutable);
      await this.run(this.config.pythonExecutable, [
        '-c',
        'from deepseek_harness import DeepSeekHarness; from deepseek_harness_runtime import bundled_runtime_path; bundled_runtime_path()'
      ]);

      return;
    } catch {
      // Recover incomplete installs as well as missing virtual environments.
    }
    const venvRoot = dirname(dirname(this.config.pythonExecutable));

    this.statusValue = { phase: 'installing' };
    await mkdir(venvRoot, { recursive: true });
    const bootstrapCommand = process.platform === 'win32' ? 'py' : 'python3';
    const bootstrapArgs = process.platform === 'win32' ? ['-3', '-m', 'venv', venvRoot] : ['-m', 'venv', venvRoot];

    await this.run(bootstrapCommand, bootstrapArgs);
    await this.run(this.config.pythonExecutable, ['-m', 'pip', 'install', '--requirement', requirementsFile]);
  }

  private run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'pipe' });

      // Drain installation output without logging possible registry credentials.
      child.stdout?.resume();
      child.stderr?.resume();
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Python preparation timed out'));
      }, this.config.startupTimeoutMs);

      child.once('close', () => clearTimeout(timer));

      child.once('error', reject);
      child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    });
  }

  private scheduleRetry(): void {
    if (this.retries >= 5 || this.retryTimer) {
      return;
    }
    const delay = 1000 * 2 ** this.retries++;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start().catch(error => logger.error({ err: error }, 'DSH bridge restart failed'));
    }, delay);
    this.retryTimer.unref();
  }

  private async assertPortAvailable(): Promise<void> {
    const occupied = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: this.config.bridgePort });

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
      throw new Error(`DSH bridge port ${this.config.bridgePort} is already in use`);
    }
  }

  private async waitForHealth(timeoutMs = this.config.startupTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let response: Response;

      try {
        response = await fetch(`http://127.0.0.1:${this.config.bridgePort}/health`, {
          headers: { Authorization: `Bearer ${this.token}` }
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
    this.stop();
    throw new Error('DSH bridge health check timed out');
  }

  private describeStartupFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : '';

    if (message.includes('preflight failed')) {
      return '安全前置检查失败：请确认 macOS、sandbox-exec、Python 运行时和模型服务配置均有效。';
    }

    if (message.includes('port') && message.includes('already in use')) {
      return `DSH Bridge 端口 ${this.config.bridgePort} 已被占用；请停止旧 Bridge 实例，或在配置中指定其他 bridgePort。`;
    }

    if (message.includes('health check timed out')) {
      return '启动超时。请检查端口是否被占用、Python 环境和网络连接。';
    }

    return '自动准备 DSH 失败。请检查 Python 3、网络连接和插件数据目录权限。';
  }
}

export const configureDSHSupervisor = (config: DSHBridgeConfig, credentials: DSHCredentials | null = null): DSHSupervisor => {
  installShutdownHook();
  const fingerprint = `${fingerprintConfig(config)}:${fingerprintCredentials(credentials)}`;

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
    credentials = await getDSHCredentials();
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
