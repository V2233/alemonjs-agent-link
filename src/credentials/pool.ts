import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from 'alemonjs';
import { fetchPoolBalances } from '../model-pool/balance';
import type { DSHCredentials } from '../dsh/credentials';
import { parseModelPool, type ModelPoolConfig, type ModelPoolEndpoint, type ModelPoolPurpose } from '../model-pool/config';

type EndpointState = {
  endpoint: ModelPoolEndpoint;
  active: number;
  failures: number;
  cooldownUntil: number;
  disabled: boolean;
  disabledUntil: number;
  lastUsed: number;
  healthy?: boolean;
  recent: number[];
  pendingTokens: number;
  dailyDate: string;
  dailyRequests: number;
  dailyInput: number;
  dailyOutput: number;
  requestWindow: number[];
  usageWindow: Array<{ at: number; input: number; output: number }>;
  lastProbeAt: number;
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
  fallback: boolean;
  priority: number;
  bound: number;
  rpm?: number;
  tpm?: number;
  requests: number;
  tokens: number;
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
  recent: number[];
  pendingTokens: number;
  dailyDate: string;
  dailyRequests: number;
  dailyInput: number;
  dailyOutput: number;
  requestWindow: number[];
  usageWindow: Array<{ at: number; input: number; output: number }>;
  lastProbeAt: number;
  lastStatus?: number;
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
      recent: [],
      pendingTokens: 0,
      dailyDate: '',
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
        { date?: unknown; requests?: unknown; input?: unknown; output?: unknown }
      >;
      const today = this.day();

      for (const state of this.states) {
        const item = stored[state.endpoint.id];

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
    const payload: Record<string, { date: string; requests: number; input: number; output: number }> = {};

    for (const state of this.states) {
      this.ensureDaily(state);
      payload[state.endpoint.id] = {
        date: state.dailyDate,
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
      capabilities: state.endpoint.capabilities,
      fallback: state.endpoint.fallback === true,
      priority: state.endpoint.priority,
      bound: this.boundCount(state),
      rpm: state.endpoint.rpm,
      tpm: state.endpoint.tpm,
      requests: this.windowStats(state).requests,
      tokens: this.windowStats(state).input + this.windowStats(state).output,
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
      state.endpoint.capabilities.includes(purpose) &&
      (!provider || state.endpoint.provider === provider) &&
      !exclude.has(state.endpoint.id)
    );
  }

  private available(purpose: ModelPoolPurpose, exclude: ReadonlySet<string>, provider?: string, estimatedTokens = 0): EndpointState[] {
    const time = this.now();

    return this.states.filter(
      state =>
        !state.disabled &&
        state.cooldownUntil <= time &&
        state.active < state.endpoint.maxConcurrent &&
        state.endpoint.capabilities.includes(purpose) &&
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
        state.endpoint.capabilities.includes(purpose) &&
        (!provider || state.endpoint.provider === provider) &&
        state.active >= state.endpoint.maxConcurrent &&
        state.healthy !== false &&
        this.withinLimits(state, now, estimatedTokens)
    );
  }

  private choose(
    purpose: ModelPoolPurpose,
    stickyKey: string | undefined,
    exclude: ReadonlySet<string>,
    stable = false,
    provider?: string,
    estimatedTokens = 0,
    waitForCapacity = false,
    fallbackOnly = false
  ): EndpointState | undefined {
    const available = this.available(purpose, exclude, provider, estimatedTokens);

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
    const priorities = [...new Set(eligible.map(state => state.endpoint.priority))].sort((left, right) => left - right);
    const tiers = priorities.map(priority => eligible.filter(state => state.endpoint.priority === priority));
    const tier = tiers.find(group => group.some(state => state.healthy !== false)) || tiers[0];
    const preferred = tier.filter(state => state.healthy !== false);
    const candidates = preferred.length ? preferred : tier;

    if (stable) {
      return candidates[0];
    }
    if (this.config.strategy === 'sticky' && stickyKey) {
      const digest = createHash('sha256').update(stickyKey).digest();
      const index = digest.readUInt32BE(0) % candidates.length;

      return candidates[index];
    }
    if (this.config.strategy === 'least-busy') {
      return [...candidates].sort(
        (left, right) =>
          left.active - right.active ||
          this.recentCount(left) - this.recentCount(right) ||
          left.latencyMs - right.latencyMs ||
          right.endpoint.weight - left.endpoint.weight ||
          left.lastUsed - right.lastUsed
      )[0];
    }
    if (this.config.strategy === 'balanced') {
      return [...candidates].sort((left, right) => {
        const leftLoad = (left.active * 2 + this.boundCount(left) * 2 + this.recentCount(left)) / Math.max(1, left.endpoint.weight);
        const rightLoad = (right.active * 2 + this.boundCount(right) * 2 + this.recentCount(right)) / Math.max(1, right.endpoint.weight);

        return leftLoad - rightLoad || left.latencyMs - right.latencyMs || right.endpoint.weight - left.endpoint.weight || left.lastUsed - right.lastUsed;
      })[0];
    }
    const expanded = candidates.flatMap(state => Array.from({ length: state.endpoint.weight }, () => state));
    const selected = expanded[this.cursor % expanded.length];

    this.cursor = (this.cursor + 1) % Math.max(1, expanded.length);

    return selected;
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
    const startedAt = this.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
        headers: { Authorization: `Bearer ${endpoint.apiKey}`, Accept: 'application/json' }
      });

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
        if (includeChat && this.config.probeChat && state.healthy !== false) await this.probeChat(state);

        return;
      } else if (response.status === 401 || response.status === 402 || response.status === 403) {
        state.healthy = false;
        state.disabled = true;
        state.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1000;
      } else if (response.status === 404 || response.status === 405) {
        // Some OpenAI-compatible gateways do not expose /models; chat may still work.
        state.healthy = undefined;
        await response.body?.cancel();
        if (includeChat && this.config.probeChat) await this.probeChat(state);

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
        signal: AbortSignal.timeout(this.config.probeTimeoutMs),
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

  /** Manual health check; useful for tests and admin actions. */
  async probeNow(includeChat = false): Promise<void> {
    await this.probeAll(includeChat);
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

      if (!options.fallbackOnly && candidate && candidate.healthy !== false && this.canUse(candidate, purpose, tried, options.provider)) state = candidate;
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
      report: outcome => {
        if (settled) return;
        settled = true;
        this.report(state, outcome, reserved, reservedTokens);
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

  private report(state: EndpointState, outcome: { ok: boolean; status?: number; headers?: Headers }, reserved: boolean, reservedTokens = 0): void {
    if (reserved && state.active > 0) state.active -= 1;
    if (reservedTokens > 0) {
      state.pendingTokens = Math.max(0, state.pendingTokens - reservedTokens);
      if (state.endpoint.account) {
        const account = this.accountState(state.endpoint.account);

        account.pendingTokens = Math.max(0, account.pendingTokens - reservedTokens);
      }
    }
    state.lastStatus = outcome.status;
    if (outcome.ok) {
      state.failures = 0;
      state.cooldownUntil = this.now() + (rateResetAfter(outcome.headers) || 0);
      state.healthy = true;
      state.disabled = false;
      state.disabledUntil = 0;

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
