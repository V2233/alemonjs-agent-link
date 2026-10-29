import { requestReason, type RequestResult } from '../model-pool/request-result';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from 'alemonjs';
import { fetchPoolBalances } from '../model-pool/balance';
import type { DSHCredentials } from '../dsh/credentials';
import { parseModelPool, type ModelPoolConfig, type ModelPoolEndpoint, type ModelPoolPurpose } from '../model-pool/config';

type LifecycleStatistics = {
  sent: number;
  blocked: number;
  cancelled: number;
  records: Array<{
    id: string;
    requestId: string;
    attempt: number;
    purpose: ModelPoolPurpose;
    at: number;
    sent: boolean;
    ok: boolean;
    reason: string;
    status?: number;
  }>;
};
type PurposeStatistics = Partial<Record<ModelPoolPurpose, { total: number; success: number; failed: number }>>;
type EndpointState = {
  endpoint: ModelPoolEndpoint;
  active: number;
  failures: number;
  cooldownUntil: number;
  disabled: boolean;
  disabledUntil: number;
  lastUsed: number;
  healthy?: boolean;
  verified: Set<ModelPoolPurpose>;
  rejected: Set<ModelPoolPurpose>;
  capabilityProbed: boolean;
  recent: number[];
  pendingTokens: number;
  dailyDate: string;
  lastRequest?: RequestResult;
  lastNetworkRequest?: RequestResult;
  lifecycle: LifecycleStatistics;
  purposeStatistics: PurposeStatistics;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  statisticsSince: number;
  dailyRequests: number;
  dailyInput: number;
  dailyOutput: number;
  requestWindow: number[];
  usageWindow: Array<{ at: number; input: number; output: number }>;
  lastProbeAt: number;
  probeReachable?: boolean;
  probeStatus?: number;
  lastStatus?: number;
  latencyMs: number;
};

type PoolInput = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  provider?: unknown;
  dshHomeRoot?: unknown;
  modelPool?: unknown;
};

export type PoolSelectionOptions = {
  requestId?: string;
  purpose?: ModelPoolPurpose;
  stickyKey?: string;
  reserve?: boolean;
  stable?: boolean;
  provider?: string;
  fallbackOnly?: boolean;
  estimatedTokens?: number;
  startedAt?: number;
  waitForCapacity?: boolean;
  exclude?: ReadonlySet<string>;
};

const globalState = globalThis as typeof globalThis & {
  __agentLinkCredentialPool__?: { fingerprint: string; pool: CredentialPool };
};

const endpointFingerprint = (endpoint: ModelPoolEndpoint): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        endpoint.id,
        endpoint.provider,
        endpoint.baseUrl,
        endpoint.apiKey,
        endpoint.model,
        endpoint.weight,
        endpoint.maxConcurrent,
        endpoint.capabilities,
        endpoint.enabled
      ])
    )
    .digest('hex');

const retryAfterMs = (headers: Headers | undefined, now: number): number => {
  if (!headers) return 0;
  const value = headers.get('retry-after')?.trim();

  if (value) {
    if (/^\d+(?:\.\d+)?$/u.test(value)) return Math.max(0, Number(value) * 1000);
    const at = Date.parse(value);

    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get('x-ratelimit-reset-requests')?.trim();

  if (reset) {
    const match = reset.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u);

    if (match) {
      const amount = Number(match[1]);
      const unit = match[2] || 's';
      const multiplier = unit === 'ms' ? 1 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 1000;

      return Math.max(0, amount * multiplier);
    }
  }

  return 0;
};

const rateResetAfter = (headers: Headers | undefined): number => {
  if (!headers) return 0;
  const remaining = headers.get('x-ratelimit-remaining-requests') || headers.get('ratelimit-remaining');

  if (remaining === null || !/^\d+$/u.test(remaining.trim()) || Number(remaining) > 0) return 0;
  const reset = Number(headers.get('x-ratelimit-reset-requests') || headers.get('ratelimit-reset'));

  return Number.isFinite(reset) && reset > 0 ? Math.min(3600000, Math.max(1000, reset * 1000)) : 0;
};

export type ModelPoolStatus = {
  id: string;
  provider: string;
  account?: string;
  model: string;
  capabilities: ModelPoolPurpose[];
  verified: ModelPoolPurpose[];
  capabilityProbed: boolean;
  fallback: boolean;
  priority: number;
  workspace: boolean;
  bound: number;
  rpm?: number;
  tpm?: number;
  requests: number;
  tokens: number;
  lastRequest?: RequestResult;
  lastNetworkRequest?: RequestResult;
  lifecycle: LifecycleStatistics;
  purposeStatistics: PurposeStatistics;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  statisticsSince: number;
  dailyRequests: number;
  dailyTokens: number;
  recent: number;
  weight: number;
  maxConcurrent: number;
  active: number;
  failures: number;
  cooldownUntil: number;
  disabled: boolean;
  disabledUntil: number;
  latencyMs: number;
  healthy?: boolean;
};

export class CredentialPool {
  private readonly states: EndpointState[];
  private cursor = 0;
  private readonly bindings = new Map<string, { endpointId: string; expiresAt: number }>();
  private readonly accounts = new Map<
    string,
    { pendingTokens: number; requestWindow: number[]; usageWindow: Array<{ at: number; input: number; output: number }> }
  >();
  private readonly metricsPath?: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persisting = false;
  private monitor?: ReturnType<typeof setInterval>;
  private probing = false;

  constructor(
    readonly config: ModelPoolConfig,
    private readonly now: () => number = Date.now,
    metricsPath?: string
  ) {
    this.metricsPath = metricsPath;
    this.states = config.endpoints.map(endpoint => ({
      endpoint,
      active: 0,
      failures: 0,
      cooldownUntil: 0,
      disabled: endpoint.enabled === false,
      disabledUntil: endpoint.enabled === false ? Number.POSITIVE_INFINITY : 0,
      lastUsed: 0,
      verified: new Set(),
      rejected: new Set(),
      capabilityProbed: false,
      recent: [],
      pendingTokens: 0,
      dailyDate: '',
      lifecycle: { sent: 0, blocked: 0, cancelled: 0, records: [] },
      purposeStatistics: {},
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      statisticsSince: this.now(),
      dailyRequests: 0,
      dailyInput: 0,
      dailyOutput: 0,
      requestWindow: [],
      usageWindow: [],
      lastProbeAt: 0,
      lastStatus: undefined,
      latencyMs: 0
    }));
    this.loadMetrics();
  }

  private day(now = this.now()): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  private ensureDaily(state: EndpointState, now = this.now()): EndpointState {
    const day = this.day(now);

    if (state.dailyDate !== day) {
      state.dailyDate = day;
      state.dailyRequests = 0;
      state.dailyInput = 0;
      state.dailyOutput = 0;
    }

    return state;
  }

  private loadMetrics(): void {
    if (!this.metricsPath) return;
    try {
      const stored = JSON.parse(readFileSync(this.metricsPath, 'utf8')) as Record<
        string,
        {
          date?: unknown;
          requests?: unknown;
          input?: unknown;
          output?: unknown;
          totalCalls?: number;
          successfulCalls?: number;
          failedCalls?: number;
          statisticsSince?: number;
          purposeStatistics?: PurposeStatistics;
          lifecycle?: LifecycleStatistics;
          lastRequest?: RequestResult;
          lastNetworkRequest?: RequestResult;
        }
      >;
      const today = this.day();

      for (const state of this.states) {
        const item = stored[state.endpoint.id];

        if (item) {
          state.lifecycle = item.lifecycle || state.lifecycle;
          state.purposeStatistics = item.purposeStatistics || {};
          state.totalCalls = Math.max(0, Number(item.totalCalls) || 0);
          state.successfulCalls = Math.max(0, Number(item.successfulCalls) || 0);
          state.failedCalls = Math.max(0, Number(item.failedCalls) || 0);
          state.lastNetworkRequest = item.lastNetworkRequest;
          if (item.lastRequest && typeof item.lastRequest.reason === 'string' && Number.isFinite(item.lastRequest.at))
            state.lastRequest = {
              at: item.lastRequest.at,
              ok: item.lastRequest.ok,
              source: item.lastRequest.source,
              status: item.lastRequest.status,
              reason: item.lastRequest.reason,
              latencyMs: item.lastRequest.latencyMs
            };
          state.statisticsSince = Number(item.statisticsSince) || this.now();
        }
        if (item?.date !== today) continue;
        state.dailyDate = today;
        state.dailyRequests = Math.max(0, Number(item.requests) || 0);
        state.dailyInput = Math.max(0, Number(item.input) || 0);
        state.dailyOutput = Math.max(0, Number(item.output) || 0);
      }
    } catch {
      // A missing or malformed metrics file must never block model selection.
    }
  }

  private schedulePersist(): void {
    if (!this.metricsPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistMetrics();
    }, 250);
    this.persistTimer.unref?.();
  }

  private async persistMetrics(): Promise<void> {
    if (!this.metricsPath || this.persisting) return;
    this.persisting = true;
    const payload: Record<
      string,
      {
        date: string;
        requests: number;
        input: number;
        output: number;
        totalCalls: number;
        successfulCalls: number;
        failedCalls: number;
        statisticsSince: number;
        purposeStatistics: PurposeStatistics;
        lifecycle: LifecycleStatistics;
        lastRequest?: RequestResult;
        lastNetworkRequest?: RequestResult;
      }
    > = {};

    for (const state of this.states) {
      this.ensureDaily(state);
      payload[state.endpoint.id] = {
        date: state.dailyDate,
        lastRequest: state.lastRequest,
        lastNetworkRequest: state.lastNetworkRequest,
        totalCalls: state.totalCalls,
        successfulCalls: state.successfulCalls,
        failedCalls: state.failedCalls,
        statisticsSince: state.statisticsSince,
        purposeStatistics: state.purposeStatistics,
        lifecycle: state.lifecycle,
        requests: state.dailyRequests,
        input: state.dailyInput,
        output: state.dailyOutput
      };
    }
    const temp = join(dirname(this.metricsPath), `.${process.pid}.${Date.now()}.metrics.tmp`);

    try {
      await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
      await rename(temp, this.metricsPath);
    } catch {
      // Metrics are best effort; selection must continue if the disk is unavailable.
    } finally {
      this.persisting = false;
    }
  }

  get fingerprint(): string {
    return JSON.stringify([
      this.config.strategy,
      this.config.maxAttempts,
      this.config.failureThreshold,
      this.config.cooldownSeconds,
      this.config.retryStatuses,
      this.states.map(state => [state.endpoint.id, endpointFingerprint(state.endpoint)])
    ]);
  }

  get status(): ModelPoolStatus[] {
    return this.states.map(state => ({
      id: state.endpoint.id,
      provider: state.endpoint.provider,
      ...(state.endpoint.account ? { account: state.endpoint.account } : {}),
      model: state.endpoint.model,
      capabilities: this.effectiveCapabilities(state),
      verified: [...state.verified],
      capabilityProbed: state.capabilityProbed,
      fallback: state.endpoint.fallback === true,
      priority: state.endpoint.priority,
      workspace: state.endpoint.workspace === true,
      bound: this.boundCount(state),
      rpm: state.endpoint.rpm,
      tpm: state.endpoint.tpm,
      requests: this.windowStats(state).requests,
      tokens: this.windowStats(state).input + this.windowStats(state).output,
      lastRequest: state.lastRequest,
      lastNetworkRequest: state.lastNetworkRequest,
      totalCalls: state.totalCalls,
      successfulCalls: state.successfulCalls,
      failedCalls: state.failedCalls,
      statisticsSince: state.statisticsSince,
      purposeStatistics: state.purposeStatistics,
      lifecycle: state.lifecycle,
      dailyRequests: this.ensureDaily(state).dailyRequests,
      dailyTokens: this.ensureDaily(state).dailyInput + this.ensureDaily(state).dailyOutput,
      recent: this.recentCount(state),
      weight: state.endpoint.weight,
      maxConcurrent: state.endpoint.maxConcurrent,
      active: state.active,
      failures: state.failures,
      cooldownUntil: state.cooldownUntil,
      disabled: state.disabled,
      disabledUntil: state.disabledUntil,
      latencyMs: Math.round(state.latencyMs),
      healthy: state.healthy,
      lastProbeAt: state.lastProbeAt,
      probeReachable: state.probeReachable,
      probeStatus: state.probeStatus,
      lastStatus: state.lastStatus
    }));
  }

  private windowStats(
    target: { requestWindow: number[]; usageWindow: Array<{ at: number; input: number; output: number }> },
    now = this.now()
  ): { requests: number; input: number; output: number } {
    const cutoff = now - 60000;

    while (target.requestWindow.length > 0 && target.requestWindow[0] <= cutoff) target.requestWindow.shift();
    while (target.usageWindow.length > 0 && target.usageWindow[0].at <= cutoff) target.usageWindow.shift();

    return {
      requests: target.requestWindow.length,
      input: target.usageWindow.reduce((sum, item) => sum + item.input, 0),
      output: target.usageWindow.reduce((sum, item) => sum + item.output, 0)
    };
  }

  private accountState(name: string): { pendingTokens: number; requestWindow: number[]; usageWindow: Array<{ at: number; input: number; output: number }> } {
    const current = this.accounts.get(name);

    if (current) return current;
    const fresh = { pendingTokens: 0, requestWindow: [], usageWindow: [] };

    this.accounts.set(name, fresh);

    return fresh;
  }

  private withinLimits(state: EndpointState, now: number, estimatedTokens: number): boolean {
    const window = this.windowStats(state, now);
    const account = state.endpoint.account ? this.windowStats(this.accountState(state.endpoint.account), now) : undefined;
    const rpm = state.endpoint.rpm;
    const tpm = state.endpoint.tpm;

    if (rpm !== undefined && (window.requests >= rpm || (account && account.requests >= rpm))) return false;
    if (
      tpm !== undefined &&
      (window.input + window.output + state.pendingTokens + estimatedTokens > tpm ||
        (account && account.input + account.output + account.pendingTokens + estimatedTokens > tpm))
    )
      return false;

    return true;
  }

  private recordUsage(state: EndpointState, usage: { prompt_tokens?: number; completion_tokens?: number }): void {
    const now = this.now();
    const event = {
      at: now,
      input: Math.max(0, Number(usage.prompt_tokens) || 0),
      output: Math.max(0, Number(usage.completion_tokens) || 0)
    };

    this.windowStats(state, now);
    this.ensureDaily(state, now);
    state.dailyInput += event.input;
    state.dailyOutput += event.output;
    state.usageWindow.push(event);
    this.schedulePersist();
    if (state.endpoint.account) {
      const account = this.accountState(state.endpoint.account);

      this.windowStats(account, now);
      account.usageWindow.push(event);
    }
  }

  private recentCount(state: EndpointState, now = this.now()): number {
    const window = this.config.balanceWindowSeconds;

    if (window <= 0) return 0;
    const cutoff = now - window * 1000;

    while (state.recent.length > 0 && state.recent[0] <= cutoff) state.recent.shift();

    return state.recent.length;
  }

  private boundCount(state: EndpointState, now = this.now()): number {
    let count = 0;

    for (const binding of this.bindings.values()) {
      if (binding.endpointId === state.endpoint.id && binding.expiresAt > now) count += 1;
    }

    return count;
  }

  private pruneBindings(now: number): void {
    for (const [key, binding] of this.bindings) {
      if (binding.expiresAt <= now) this.bindings.delete(key);
    }
  }

  private canUse(state: EndpointState, purpose: ModelPoolPurpose, exclude: ReadonlySet<string>, provider?: string): boolean {
    return (
      !state.disabled &&
      state.cooldownUntil <= this.now() &&
      state.active < state.endpoint.maxConcurrent &&
      this.supports(state, purpose) &&
      (!provider || state.endpoint.provider === provider) &&
      !exclude.has(state.endpoint.id)
    );
  }

  private effectiveCapabilities(state: EndpointState): ModelPoolPurpose[] {
    const configured = state.capabilityProbed ? state.endpoint.capabilities.filter(capability => state.verified.has(capability)) : state.endpoint.capabilities;
    // Probing is evidence of capability, not permission to promote a gate-only key into chat.
    const discovered = [...state.verified].filter(
      capability => state.endpoint.capabilities.includes('chat') && capability !== 'chat' && capability !== 'replyGate' && !configured.includes(capability)
    );

    return [...new Set([...configured, ...discovered])];
  }

  private supports(state: EndpointState, purpose: ModelPoolPurpose): boolean {
    return this.effectiveCapabilities(state).includes(purpose);
  }

  private available(purpose: ModelPoolPurpose, exclude: ReadonlySet<string>, provider?: string, estimatedTokens = 0): EndpointState[] {
    const time = this.now();

    return this.states.filter(
      state =>
        !state.disabled &&
        state.cooldownUntil <= time &&
        state.active < state.endpoint.maxConcurrent &&
        this.supports(state, purpose) &&
        (!provider || state.endpoint.provider === provider) &&
        this.withinLimits(state, time, estimatedTokens) &&
        !exclude.has(state.endpoint.id)
    );
  }

  private hasBusyPrimary(purpose: ModelPoolPurpose, provider: string | undefined, estimatedTokens: number): boolean {
    const now = this.now();

    return this.states.some(
      state =>
        !state.endpoint.fallback &&
        !state.disabled &&
        state.cooldownUntil <= now &&
        this.supports(state, purpose) &&
        (!provider || state.endpoint.provider === provider) &&
        state.active >= state.endpoint.maxConcurrent &&
        state.healthy !== false &&
        this.withinLimits(state, now, estimatedTokens)
    );
  }

  private endpointScore(state: EndpointState): number {
    // 0 -> 1，10 -> 0.67，20 -> 0.5，100 -> 0.17；高优先级有偏好但不会独占。
    const priority = 1 / (1 + Math.max(0, state.endpoint.priority) / 20);
    const load = 1 / (1 + state.active * 2 + this.recentCount(state) + Math.min(10000, state.latencyMs) / 50);

    return Math.max(0.000001, state.endpoint.weight * priority * load);
  }

  private rank(state: EndpointState, key: string): number {
    const digest = createHash('sha256').update(`${key}:${state.endpoint.id}`).digest();
    const unit = (digest.readUInt32BE(0) + 1) / 0x100000000;

    return -Math.log(unit) / this.endpointScore(state);
  }

  private choose(
    purpose: ModelPoolPurpose,
    stickyKey: string | undefined,
    exclude: ReadonlySet<string>,
    stable = false,
    provider?: string,
    estimatedTokens = 0,
    waitForCapacity = false,
    fallbackOnly = false,
    workspaceOnly = false
  ): EndpointState | undefined {
    const available = this.available(purpose, exclude, provider, estimatedTokens).filter(state => !workspaceOnly || state.endpoint.workspace === true);

    if (!available.length) return undefined;
    // 备用端点只在没有可用主端点时才参与选择。
    const primary = fallbackOnly ? [] : available.filter(state => !state.endpoint.fallback);
    const fallback = available.filter(state => state.endpoint.fallback);

    if (
      !fallbackOnly &&
      !primary.length &&
      this.config.queueMaxWaitMs > 0 &&
      waitForCapacity &&
      fallback.length &&
      this.hasBusyPrimary(purpose, provider, estimatedTokens)
    )
      return undefined;
    const eligible = fallbackOnly ? fallback : primary.length ? primary : fallback;

    if (!eligible.length) return undefined;
    const candidates = eligible.some(state => state.healthy !== false) ? eligible.filter(state => state.healthy !== false) : eligible;

    if (stable) {
      // 工作区等稳定调用只要求“不轮询”；仍保留软优先级，不在慢端点之间乱跳。
      const latency = (state: EndpointState): number => (state.latencyMs > 0 ? state.latencyMs : 1200);

      return [...candidates].sort(
        (left, right) =>
          latency(left) - latency(right) ||
          this.endpointScore(right) - this.endpointScore(left) ||
          right.endpoint.weight - left.endpoint.weight ||
          left.lastUsed - right.lastUsed
      )[0];
    }
    if (this.config.strategy === 'least-busy') {
      return [...candidates].sort(
        (left, right) =>
          right.active - left.active ||
          right.endpoint.weight - left.endpoint.weight ||
          this.endpointScore(right) - this.endpointScore(left) ||
          left.latencyMs - right.latencyMs ||
          left.lastUsed - right.lastUsed
      )[0];
    }

    // 软优先级 + 权重 + 负载 + 延迟的离散加权选择：
    // 优先级只改变被选中的概率，不会把高优先级端点完全饿死。
    // 同一个 stickyKey 会得到稳定结果，实际绑定由 select() 持久化。
    const key = stickyKey ? `${this.config.strategy}:${stickyKey}` : `${this.config.strategy}:${this.cursor++}`;

    return [...candidates].sort((left, right) => this.rank(left, key) - this.rank(right, key))[0];
  }

  /** Probe endpoints without spending completion tokens. Called once at
   * startup and then on a timer so requests rarely discover an outage. */
  startHealthMonitor(): void {
    if (this.monitor || this.config.probeIntervalSeconds <= 0) return;
    void this.probeAll(true);
    this.monitor = setInterval(() => void this.probeAll(false), this.config.probeIntervalSeconds * 1000);
    this.monitor.unref?.();
  }

  stop(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    void this.persistMetrics();
  }

  private async probeAll(includeChat = false): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const targets = this.states.filter(state => !state.disabled || (this.config.recoveryProbeSeconds > 0 && state.disabledUntil <= this.now()));
      const chunkSize = 2;

      for (let index = 0; index < targets.length; index += chunkSize) {
        await Promise.allSettled(targets.slice(index, index + chunkSize).map(state => this.probe(state, includeChat)));
      }
    } finally {
      this.probing = false;
    }
  }

  private async probe(state: EndpointState, includeChat = false): Promise<void> {
    const endpoint = state.endpoint;
    const url = `${endpoint.baseUrl.replace(/\/+$/u, '')}/models`;

    state.lastProbeAt = this.now();
    state.probeStatus = undefined;
    const startedAt = this.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
        headers: { Authorization: `Bearer ${endpoint.apiKey}`, Accept: 'application/json' }
      });

      state.probeReachable = true;
      state.probeStatus = response.status;
      state.lastStatus = response.status;
      if (response.ok) {
        state.healthy = true;
        state.failures = 0;
        const reset = rateResetAfter(response.headers);

        // /models proves liveness, not chat quota. Never wipe an active 429
        // cooldown just because the lightweight probe succeeds.
        if (state.cooldownUntil <= this.now()) state.cooldownUntil = this.now() + reset;
        else if (reset > 0) state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + reset);
        state.disabled = false;
        state.disabledUntil = 0;
        const sample = Math.max(1, this.now() - startedAt);

        state.latencyMs = state.latencyMs ? state.latencyMs * 0.7 + sample * 0.3 : sample;
        await response.body?.cancel();
        if (includeChat && this.config.probeChat && state.healthy !== false) {
          await this.probeChat(state);
          if (state.healthy !== false && this.config.capabilityProbe) {
            await this.probeVision(state);
            await this.probeTools(state);
          }
        }
        if (includeChat && this.config.capabilityProbe) state.capabilityProbed = true;

        return;
      } else if (response.status === 401 || response.status === 402 || response.status === 403) {
        state.healthy = false;
        state.disabled = true;
        state.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1000;
      } else if (response.status === 404 || response.status === 405) {
        // Some OpenAI-compatible gateways do not expose /models; chat may still work.
        state.healthy = undefined;
        await response.body?.cancel();
        if (includeChat && this.config.probeChat) {
          await this.probeChat(state);
          if (state.healthy !== false && this.config.capabilityProbe) {
            await this.probeVision(state);
            await this.probeTools(state);
          }
        }
        if (includeChat && this.config.capabilityProbe) state.capabilityProbed = true;

        return;
      } else if (response.status === 429) {
        state.healthy = false;
        state.failures += 1;
        state.cooldownUntil = this.now() + Math.max(this.config.cooldownSeconds * 1000, retryAfterMs(response.headers, this.now()));
      } else if (response.status >= 500) {
        state.healthy = false;
        state.failures += 1;
        if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1000;
      }
      await response.body?.cancel();
    } catch {
      state.probeReachable = false;
      state.probeStatus = undefined;
      state.healthy = false;
      state.failures += 1;
      if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1000;
    }
  }

  private async probeChat(state: EndpointState): Promise<void> {
    const endpoint = state.endpoint;
    const url = `${endpoint.baseUrl.replace(/\/+$/u, '')}/chat/completions`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.capabilityProbeTimeoutMs),
        headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: endpoint.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false })
      });
      let detail = '';

      if (!response.ok) {
        try {
          const payload = (await response.json()) as { error?: { message?: unknown }; message?: unknown };

          detail = String(payload.error?.message || payload.message || '').slice(0, 300);
        } catch {
          // Best-effort provider diagnostics.
        }
      }
      state.lastStatus = response.status;
      if (response.ok) {
        state.healthy = true;
        state.failures = 0;
        state.cooldownUntil = 0;
        state.disabled = false;
        state.disabledUntil = 0;
        state.verified.add('chat');
        state.verified.add('replyGate');
      } else if (response.status === 401 || response.status === 402 || response.status === 403) {
        this.disableEndpoint(state);
      } else if (response.status === 429) {
        state.healthy = false;
        state.failures += 1;
        state.cooldownUntil = this.now() + Math.max(this.config.cooldownSeconds * 1000, retryAfterMs(response.headers, this.now()));
      } else if (/计费账户|余额不足|余额已|欠费|冻结|billing|insufficient|quota|frozen|credit/iu.test(detail)) {
        this.disableEndpoint(state);
      } else if (response.status >= 500 || response.status === 404 || response.status === 405) {
        state.healthy = false;
        state.failures += 1;
        if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1000;
      }
      if (!response.ok) {
        logger.warn(
          { endpoint: endpoint.id, model: endpoint.model, status: response.status, detail, action: state.disabled ? 'disabled' : 'cooldown' },
          'Startup chat probe rejected endpoint'
        );
      }
      await response.body?.cancel();
    } catch {
      state.healthy = false;
      state.failures += 1;
      if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1000;
    }
  }

  private async probeVision(state: EndpointState): Promise<void> {
    const endpoint = state.endpoint;
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

    try {
      const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.capabilityProbeTimeoutMs),
        headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这张纯色图片是什么颜色？只回答一个词。' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }
              ]
            }
          ],
          max_tokens: 256,
          stream: false
        })
      });
      let detail = '';
      let content = '';

      if (response.ok) {
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const value = payload.choices?.[0]?.message?.content;

        content = typeof value === 'string' ? value : '';
      } else {
        try {
          const payload = (await response.json()) as { error?: { message?: unknown }; message?: unknown };

          detail = String(payload.error?.message || payload.message || '').slice(0, 300);
        } catch {
          // Best-effort provider diagnostics.
        }
      }
      if (response.ok && content.trim()) state.verified.add('vision');
      else if (response.status === 400 && /image|vision|multimodal|unsupported|图片/iu.test(detail)) state.rejected.add('vision');
      else if (response.status === 429) {
        state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + this.config.cooldownSeconds * 1000);
      }
      if (!response.ok || !content.trim())
        logger.warn(
          { endpoint: endpoint.id, model: endpoint.model, status: response.status, vision: content ? 'verified' : 'unknown', detail },
          'Startup vision capability probe'
        );
    } catch (error) {
      logger.warn(
        { endpoint: state.endpoint.id, model: state.endpoint.model, detail: error instanceof Error ? error.message : String(error) },
        'Startup vision capability probe inconclusive'
      );
    }
  }

  private async probeTools(state: EndpointState): Promise<void> {
    const endpoint = state.endpoint;

    try {
      const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.capabilityProbeTimeoutMs),
        headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: 'user', content: '请调用 probe_value 工具获取测试值，不要直接回答。' }],
          tools: [
            {
              type: 'function',
              function: { name: 'probe_value', description: '返回一个测试值', parameters: { type: 'object', properties: {}, additionalProperties: false } }
            }
          ],
          tool_choice: 'auto',
          max_tokens: 128,
          stream: false
        })
      });
      let detail = '';
      let calls = 0;

      if (response.ok) {
        const payload = (await response.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };

        calls = payload.choices?.[0]?.message?.tool_calls?.length || 0;
      } else {
        try {
          const payload = (await response.json()) as { error?: { message?: unknown }; message?: unknown };

          detail = String(payload.error?.message || payload.message || '').slice(0, 300);
        } catch {
          // Best-effort provider diagnostics.
        }
      }
      if (response.ok && calls > 0) state.verified.add('tools');
      else if (response.status === 400 && /tool|function|function_call|工具/iu.test(detail)) state.rejected.add('tools');
      else if (response.status === 429) {
        state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + this.config.cooldownSeconds * 1000);
      }
      if (!response.ok || calls === 0)
        logger.warn(
          { endpoint: endpoint.id, model: endpoint.model, status: response.status, tools: calls > 0 ? 'verified' : 'unknown', detail },
          'Startup tool capability probe'
        );
    } catch {
      // A tool probe failure is inconclusive; keep configured tools.
    }
  }

  /** Manual health check; useful for tests and admin actions. */
  async probeNow(includeChat = false): Promise<void> {
    await this.probeAll(includeChat);
  }

  /**
   * Manual endpoint switch for this process. The configured enabled flag is
   * unchanged, so a restart returns to the configuration file.
   */
  setEndpointEnabled(id: string, enabled: boolean): boolean {
    const state = this.states.find(item => item.endpoint.id === id);

    if (!state) return false;
    if (enabled) {
      state.disabled = false;
      state.disabledUntil = 0;
      state.cooldownUntil = 0;
      state.failures = 0;
      state.healthy = undefined;
    } else {
      state.disabled = true;
      state.disabledUntil = Number.POSITIVE_INFINITY;
      state.healthy = false;
      for (const [key, binding] of this.bindings) {
        if (binding.endpointId === state.endpoint.id) this.bindings.delete(key);
      }
    }
    this.schedulePersist();

    return true;
  }

  private readonly healthChecks = new Map<string, Promise<boolean>>();

  /** Explicit diagnostic completion, independent of enablement, quota and probe flags. */
  healthCheckEndpoint(id: string): Promise<boolean> {
    const current = this.healthChecks.get(id);

    if (current !== undefined) return current;
    const state = this.states.find(item => item.endpoint.id === id);

    if (!state) return Promise.resolve(false);
    const work = (async () => {
      const started = this.now();
      let status: number | undefined;
      let detail = '';
      let ok = false;
      let errorKind: string | undefined;

      try {
        const response = await fetch(state.endpoint.baseUrl.replace(/\/+$/u, '') + '/chat/completions', {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + state.endpoint.apiKey, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(Math.min(15000, this.config.capabilityProbeTimeoutMs)),
          body: JSON.stringify({ model: state.endpoint.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16, stream: false })
        });

        status = response.status;
        const payload = (await response.json().catch(() => null)) as {
          choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
          error?: { code?: unknown; message?: unknown };
          message?: unknown;
        } | null;

        ok = response.ok && !payload?.error && Array.isArray(payload?.choices) && payload.choices.length > 0 && Boolean(payload.choices[0]?.message);
        detail = String(payload?.error?.code || '') + ' ' + String(payload?.error?.message || payload?.message || '');
      } catch (error) {
        errorKind = error instanceof Error && /timeout/i.test(error.name) ? 'timeout' : undefined;
      }
      state.lastRequest = {
        at: this.now(),
        source: 'health-check',
        ok,
        status,
        reason: requestReason({ ok, status, detail, errorKind }),
        latencyMs: Math.max(0, this.now() - started)
      };
      if (status !== undefined || ['network', 'timeout'].includes(state.lastRequest.reason)) state.lastNetworkRequest = state.lastRequest;
      this.schedulePersist();

      return true;
    })();

    this.healthChecks.set(id, work);
    void work.finally(() => this.healthChecks.delete(id));

    return work;
  }

  /** Probe one endpoint; includeChat also runs the paid chat probe. */
  async probeEndpoint(id: string, includeChat = false): Promise<boolean> {
    const state = this.states.find(item => item.endpoint.id === id);

    if (!state) return false;
    const wasDisabled = state.disabled;
    const disabledUntil = state.disabledUntil;

    await this.probe(state, includeChat);
    // Testing a manually stopped endpoint must not silently put it back in rotation.
    if (wasDisabled) {
      state.disabled = true;
      state.disabledUntil = disabledUntil;
    }

    return true;
  }

  select(options: PoolSelectionOptions = {}): DSHCredentials | null {
    const purpose = options.purpose || 'chat';
    const tried = new Set(options.exclude || []);
    const now = this.now();

    this.pruneBindings(now);
    const bindingKey = !options.stable && options.stickyKey ? `${purpose}:${options.stickyKey}` : undefined;
    let state: EndpointState | undefined;
    const bound = bindingKey ? this.bindings.get(bindingKey) : undefined;

    if (bound && bound.expiresAt > now && !tried.has(bound.endpointId)) {
      const candidate = this.states.find(item => item.endpoint.id === bound.endpointId);

      if (!options.fallbackOnly && candidate && candidate.healthy !== false && this.canUse(candidate, purpose, tried, options.provider)) {
        state = candidate;
        // 活跃会话滑动续期：持续接待一直保持同一端点，空闲超过 TTL 才释放。
        if (bindingKey && this.config.stickySeconds > 0)
          this.bindings.set(bindingKey, { endpointId: candidate.endpoint.id, expiresAt: now + this.config.stickySeconds * 1000 });
      }
    }
    if (!state)
      state = this.choose(
        purpose,
        options.stickyKey,
        tried,
        options.stable === true,
        options.provider,
        options.estimatedTokens || 0,
        options.waitForCapacity === true,
        options.fallbackOnly === true
      );

    if (!state) {
      if (bindingKey) this.bindings.delete(bindingKey);

      return null;
    }
    if (bindingKey && !state.endpoint.fallback && this.config.stickySeconds > 0) {
      this.bindings.set(bindingKey, { endpointId: state.endpoint.id, expiresAt: now + this.config.stickySeconds * 1000 });
    }
    tried.add(state.endpoint.id);
    const reserved = options.reserve !== false;

    if (reserved) {
      state.active += 1;
    }
    state.lastUsed = now;
    const reservedTokens = reserved ? Math.max(0, options.estimatedTokens || 0) : 0;

    if (reserved) {
      this.windowStats(state, now);
      this.ensureDaily(state, now).dailyRequests += 1;
      state.totalCalls += 1;
      const statistics = (state.purposeStatistics[purpose] ||= { total: 0, success: 0, failed: 0 });

      statistics.total += 1;
      state.requestWindow.push(now);
      this.schedulePersist();
      state.pendingTokens += reservedTokens;
      if (state.endpoint.account) {
        const account = this.accountState(state.endpoint.account);

        this.windowStats(account, now);
        account.requestWindow.push(now);
        account.pendingTokens += reservedTokens;
      }
      if (this.config.balanceWindowSeconds > 0) {
        state.recent.push(now);
        this.recentCount(state, now);
      }
    }
    let settled = false;
    let sent = false;
    const id = randomUUID();
    const credential: DSHCredentials = {
      apiKey: state.endpoint.apiKey,
      baseUrl: state.endpoint.baseUrl,
      model: state.endpoint.model,
      ...(state.endpoint.pricing ? { pricing: state.endpoint.pricing } : {}),
      endpointId: state.endpoint.id,
      startedAt: options.startedAt || Date.now(),
      retryBudgetMs: this.config.retryBudgetMs,
      retryJitterMs: this.config.retryJitterMs,
      reportUsage: usage => this.recordUsage(state, usage),
      invalidate: status => this.markInvalid(state, status),
      disable: () => this.disableEndpoint(state),
      maxAttempts: this.config.maxAttempts,
      attempt: 1,
      retryable: status => this.config.retryStatuses.includes(status),
      markSent: () => {
        if (sent || settled || !reserved) return;
        sent = true;
        state.lifecycle.sent += 1;
        this.schedulePersist();
      },
      report: outcome => {
        if (settled) return;
        settled = true;
        if (reserved) {
          const reason = requestReason(outcome);

          if (reason === 'local-budget') state.lifecycle.blocked += 1;
          if (reason === 'cancelled') state.lifecycle.cancelled += 1;
          state.lifecycle.records.push({
            id,
            requestId: options.requestId || id,
            attempt: credential.attempt || 1,
            purpose,
            at: this.now(),
            sent,
            ok: outcome.ok,
            reason,
            status: outcome.status
          });
          state.lifecycle.records = state.lifecycle.records.slice(-20);
        }
        this.report(state, outcome, reserved, reservedTokens, purpose);
      },
      next: (nextOptions?: { fallback?: boolean }) => {
        const next = this.select({
          purpose,
          stickyKey: options.stickyKey,
          reserve: reserved,
          stable: false,
          provider: options.provider,
          fallbackOnly: nextOptions?.fallback === true,
          estimatedTokens: options.estimatedTokens,
          startedAt: credential.startedAt,
          requestId: options.requestId || id,
          waitForCapacity: false,
          exclude: tried
        });

        if (next) next.attempt = (credential.attempt || 1) + 1;

        return next;
      }
    };

    return credential;
  }

  private disableEndpoint(state: EndpointState): void {
    const account = state.endpoint.account;
    const targets = account ? this.states.filter(item => item.endpoint.account === account) : [state];

    for (const target of targets) {
      target.disabled = true;
      target.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1000;
      target.healthy = false;
      for (const [key, binding] of this.bindings) {
        if (binding.endpointId === target.endpoint.id) this.bindings.delete(key);
      }
    }
  }

  private markInvalid(state: EndpointState, status?: number): void {
    state.lastStatus = status;
    state.failures += 1;
    state.healthy = false;
    if (state.failures >= this.config.failureThreshold) {
      state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1000;
    }
  }

  private report(
    state: EndpointState,
    outcome: { ok: boolean; status?: number; headers?: Headers; latencyMs?: number; detail?: string; errorKind?: string },
    reserved: boolean,
    reservedTokens = 0,
    purpose: ModelPoolPurpose = 'chat'
  ): void {
    if (reserved) {
      const statistics = (state.purposeStatistics[purpose] ||= { total: 0, success: 0, failed: 0 });

      if (outcome.ok) statistics.success += 1;
      else statistics.failed += 1;
      state.lastRequest = {
        at: this.now(),
        source: 'call',
        ok: outcome.ok,
        status: outcome.status,
        reason: requestReason(outcome),
        latencyMs: outcome.latencyMs
      };
      if (outcome.status !== undefined || ['network', 'timeout'].includes(state.lastRequest.reason)) state.lastNetworkRequest = state.lastRequest;
      if (outcome.ok) state.successfulCalls += 1;
      else state.failedCalls += 1;
      this.schedulePersist();
    }
    if (reserved && state.active > 0) state.active -= 1;
    if (reservedTokens > 0) {
      state.pendingTokens = Math.max(0, state.pendingTokens - reservedTokens);
      if (state.endpoint.account) {
        const account = this.accountState(state.endpoint.account);

        account.pendingTokens = Math.max(0, account.pendingTokens - reservedTokens);
      }
    }
    state.lastStatus = outcome.status;
    const responseReset = rateResetAfter(outcome.headers);

    if (responseReset > 0) state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + responseReset);
    if (outcome.ok) {
      state.failures = 0;
      state.cooldownUntil = this.now() + (rateResetAfter(outcome.headers) || 0);
      state.healthy = true;
      state.disabled = false;
      state.disabledUntil = 0;
      // 用真实请求耗时校正延迟模型，选择时能把慢端点排到后面。
      if (Number.isFinite(outcome.latencyMs) && Number(outcome.latencyMs) > 0) {
        const sample = Number(outcome.latencyMs);

        state.latencyMs = state.latencyMs ? state.latencyMs * 0.6 + sample * 0.4 : sample;
      }

      return;
    }
    const status = outcome.status;

    if (!outcome.ok) {
      for (const [key, binding] of this.bindings) {
        if (binding.endpointId === state.endpoint.id) this.bindings.delete(key);
      }
    }

    if (status === 401 || status === 402 || status === 403) {
      state.disabled = true;
      state.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1000;
      state.healthy = false;

      return;
    }
    if (status === 429) {
      state.failures += 1;
      state.healthy = false;
      const backoff = this.config.cooldownSeconds * 1000 * 2 ** Math.min(4, state.failures - 1);
      const retryAfter = retryAfterMs(outcome.headers, this.now());

      state.cooldownUntil = this.now() + Math.min(Math.max(backoff, retryAfter), 3600000);

      return;
    }
    if (status !== undefined && status >= 500 && status <= 599) {
      state.failures += 1;
      state.healthy = false;
      if (state.failures >= this.config.failureThreshold) {
        state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1000;
      }
    }
  }
}

export const getCredentialPool = (input: PoolInput): CredentialPool | null => {
  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'deepseek-official';
  const baseUrl =
    typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : provider === 'deepseek-official' ? 'https://api.deepseek.com' : '';
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : 'deepseek-v4-flash';
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : undefined;
  const pool = parseModelPool(input.modelPool, { provider, baseUrl, model, apiKey });

  if (!pool) {
    globalState.__agentLinkCredentialPool__?.pool.stop();
    globalState.__agentLinkCredentialPool__ = undefined;

    return null;
  }
  const fingerprint = JSON.stringify([pool, pool.endpoints.map(endpointFingerprint)]);
  const existing = globalState.__agentLinkCredentialPool__;

  if (existing?.fingerprint === fingerprint) return existing.pool;
  existing?.pool.stop();
  const metricsPath =
    typeof input.dshHomeRoot === 'string' && input.dshHomeRoot.trim() ? join(dirname(input.dshHomeRoot), 'model-pool-metrics.json') : undefined;
  const instance = new CredentialPool(pool, Date.now, metricsPath);

  globalState.__agentLinkCredentialPool__ = { fingerprint, pool: instance };

  return instance;
};

/** Sanitized-enough descriptor for the sandbox bridge; keys stay in the process env. */
export const modelPoolForBridge = (input: PoolInput): ModelPoolConfig | null => {
  const pool = getCredentialPool(input);

  if (!pool) return null;
  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'deepseek-official';
  const endpoints = pool.config.endpoints.filter(endpoint => endpoint.enabled && endpoint.provider === provider);

  // DSH's SDK profile speaks the deepseek-official Messages protocol. Only pass
  // endpoints with that provider to the bridge; OpenAI-compatible vendors still
  // serve the normal tool/chat loop in Node.
  return endpoints.length ? { ...pool.config, endpoints } : null;
};

export const warmCredentialPool = (input: PoolInput): CredentialPool | null => {
  const pool = getCredentialPool(input);

  pool?.startHealthMonitor();
  if (pool) {
    void fetchPoolBalances(pool.config)
      .then(balances => {
        const low = [...balances.values()].filter(item => item.amount !== undefined && item.amount < pool.config.balanceAlertYuan);

        if (low.length)
          logger.warn(
            {
              endpoints: [...balances.entries()]
                .filter(([, item]) => item.amount !== undefined && item.amount < pool.config.balanceAlertYuan)
                .map(([id]) => id),
              count: low.length,
              threshold: pool.config.balanceAlertYuan
            },
            'Model pool low balance at startup'
          );
      })
      .catch(() => undefined);
  }

  return pool;
};

export const stopCredentialPool = (): void => {
  globalState.__agentLinkCredentialPool__?.pool.stop();
  globalState.__agentLinkCredentialPool__ = undefined;
};
