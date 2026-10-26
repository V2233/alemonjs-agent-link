import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from 'alemonjs';
import type { DSHBridgeConfig } from '../dsh/client';
import type { ChatInput } from '../dsh/input';
import { memoryModule } from '../modules/memory';
import { chatHistoryModule } from '../modules/chat-history';
import { personaModule } from '../modules/persona';
import { moodModule } from '../modules/mood';
import { platformModule, groupAdminModule } from '../modules/platform';
import { proactiveModule } from '../modules/proactive';
import { voiceModule } from '../modules/voice';
import { validateArguments } from './schema';
import type { AgentModule, AgentTool, ModuleApi, ModuleConfig, ModuleHooks, TurnContext } from './types';

const moduleId = /^[a-z][a-z0-9-]{0,63}$/u;
const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;

type LoadedModule = {
  definition: AgentModule;
  revision: string;
  source: 'builtin' | 'local';
  tools: AgentTool[];
  hooks: { [K in keyof ModuleHooks]: ModuleHooks[K][] };
  cleanups: (() => void | Promise<void>)[];
  users: number;
  retired: boolean;
};

export type ModuleStatus = { id: string; name?: string; version?: string; source: 'builtin' | 'local'; state: 'ready' | 'disabled' | 'failed'; error?: string };

export const getModuleConfig = (config: DSHBridgeConfig): Required<ModuleConfig> => {
  const value = config.modules || {};
  const result = {
    directory: value.directory || resolve(config.workspaceRoot, '..', 'modules'),
    disabled: value.disabled || [],
    settings: value.settings || {},
    maxToolRounds: value.maxToolRounds ?? 8
  };

  if (
    typeof result.directory !== 'string' ||
    !result.directory.trim() ||
    !Array.isArray(result.disabled) ||
    result.disabled.some(id => typeof id !== 'string' || !moduleId.test(id)) ||
    !result.settings ||
    typeof result.settings !== 'object' ||
    Array.isArray(result.settings) ||
    Object.entries(result.settings).some(([id, settings]) => !moduleId.test(id) || !settings || typeof settings !== 'object' || Array.isArray(settings)) ||
    !Number.isSafeInteger(result.maxToolRounds) ||
    result.maxToolRounds < 1 ||
    result.maxToolRounds > 16
  ) {
    throw new Error('modules 配置无效。');
  }

  return { ...result, directory: resolve(result.directory) };
};

// Snapshot all local files together, so relative imports reload with the entry.
// Local modules are trusted server code; their directory is never writable by a chat tool.
const snapshot = async (directory: string): Promise<{ revision: string; files: Map<string, Buffer> }> => {
  const files = new Map<string, Buffer>();
  let bytes = 0;
  const walk = async (relative = '', depth = 0): Promise<void> => {
    if (depth > 8) {
      throw new Error('模块目录层级过深。');
    }
    for (const entry of (await readdir(join(directory, relative))).sort()) {
      if (entry.startsWith('.') || entry === 'node_modules') {
        continue;
      }
      const name = join(relative, entry);
      const info = await lstat(join(directory, name));

      if (info.isSymbolicLink()) {
        throw new Error('模块目录不能包含符号链接。');
      }
      if (info.isDirectory()) {
        await walk(name, depth + 1);
      } else if (info.isFile()) {
        if (files.size >= 200 || bytes + info.size > 5 * 1024 * 1024) {
          throw new Error('模块文件总量超过限制。');
        }
        const content = await readFile(join(directory, name));

        bytes += content.length;
        if (bytes > 5 * 1024 * 1024) {
          throw new Error('模块文件总量超过限制。');
        }
        files.set(name, content);
      } else {
        throw new Error('模块目录只能包含普通文件。');
      }
    }
  };

  await walk();
  if (!files.has('index.mjs')) {
    throw new Error('模块缺少 index.mjs。');
  }
  const hash = createHash('sha256');

  for (const [name, content] of files) {
    hash.update(name).update('\0').update(String(content.length)).update('\0').update(content);
  }

  return { revision: hash.digest('hex'), files };
};

export class ModuleLease {
  private released = false;

  constructor(
    private readonly modules: LoadedModule[],
    private readonly retire: (module: LoadedModule) => Promise<void>
  ) {
    modules.forEach(module => module.users++);
  }

  tools(context: TurnContext): AgentTool[] {
    return this.modules
      .flatMap(module => module.tools)
      .filter(tool => (!context.autonomous || tool.readOnly === true) && (!tool.available || tool.available(context)));
  }

  get transformsSystem(): boolean {
    return this.modules.some(module => module.hooks.system.length > 0);
  }

  async system(prompt: string, context: TurnContext): Promise<string> {
    for (const module of this.modules) {
      for (const handler of module.hooks.system) {
        context.signal.throwIfAborted();
        prompt = await handler(prompt, context);
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) {
          throw new Error('模块系统提示词无效或过长。');
        }
      }
    }

    return prompt;
  }

  async context(context: TurnContext): Promise<string> {
    const parts: string[] = [];

    for (const module of this.modules) {
      for (const handler of module.hooks.context) {
        context.signal.throwIfAborted();
        const value = await handler(context);

        if (typeof value !== 'string' || value.length > 16000) {
          throw new Error('模块上下文无效或过长。');
        }
        if (value) {
          parts.push(value);
        }
      }
    }
    const text = parts.join('\n\n');

    if (text.length > 32000) {
      throw new Error('模块上下文总量超过限制。');
    }

    return text;
  }

  async prompt(input: ChatInput, context: TurnContext): Promise<ChatInput> {
    for (const module of this.modules) {
      for (const handler of module.hooks.prompt) {
        context.signal.throwIfAborted();
        input = await handler(input, context);
        if (typeof input !== 'string' && (!Array.isArray(input) || input.some(block => !block || !['text', 'image'].includes(block.type)))) {
          throw new Error('模块消息内容无效。');
        }
      }
    }

    return input;
  }

  get transformsReplies(): boolean {
    return this.modules.some(module => module.hooks.reply.length > 0);
  }

  async reply(text: string, context: TurnContext): Promise<string> {
    for (const module of this.modules) {
      for (const handler of module.hooks.reply) {
        context.signal.throwIfAborted();
        text = await handler(text, context);
        if (typeof text !== 'string' || text.length > 100000) {
          throw new Error('模块回复内容无效或过长。');
        }
      }
    }

    return text;
  }

  async activity(input: string, output: string, context: TurnContext): Promise<void> {
    for (const module of this.modules) {
      for (const handler of module.hooks.activity) {
        context.signal.throwIfAborted();
        await handler({ input, output }, context);
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const module of this.modules) {
      module.users--;
      await this.retire(module);
    }
  }
}

export class ModuleRuntime {
  private readonly loaded = new Map<string, LoadedModule>();
  private statuses: ModuleStatus[] = [];
  private refreshPending?: Promise<void>;
  private closed = false;

  constructor(
    private readonly config: DSHBridgeConfig,
    private readonly builtins: AgentModule[] = [
      personaModule(config),
      moodModule(config),
      platformModule(config),
      groupAdminModule(config),
      proactiveModule(config),
      voiceModule(config),
      memoryModule(config),
      chatHistoryModule(config)
    ]
  ) {}

  status(): ModuleStatus[] {
    return this.statuses.map(status => ({ ...status }));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async acquire(): Promise<ModuleLease> {
    await this.refresh();
    if (this.closed) {
      throw new Error('模块运行时已关闭，请重试当前请求。');
    }

    return new ModuleLease([...this.loaded.values()], module => this.disposeRetired(module));
  }

  refresh(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('模块运行时已关闭。'));
    }
    if (this.refreshPending === undefined) {
      this.refreshPending = this.reload().finally(() => {
        this.refreshPending = undefined;
      });
    }

    return this.refreshPending;
  }

  private async disposeRetired(module: LoadedModule): Promise<void> {
    if (!module.retired || module.users > 0) {
      return;
    }
    for (const cleanup of module.cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch {
        logger.warn({ module: module.definition.id }, 'AgentLink module cleanup failed');
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.refreshPending;
    const modules = [...this.loaded.values()];

    this.loaded.clear();
    for (const module of modules) {
      module.retired = true;
      await this.disposeRetired(module);
    }
  }

  private async prepare(definition: AgentModule, revision: string, source: 'builtin' | 'local', settings: Record<string, unknown>): Promise<LoadedModule> {
    if (
      !definition ||
      !moduleId.test(definition.id) ||
      definition.apiVersion !== 1 ||
      typeof definition.name !== 'string' ||
      typeof definition.version !== 'string' ||
      typeof definition.setup !== 'function'
    ) {
      throw new Error('模块定义或 API 版本无效。');
    }
    const record: LoadedModule = {
      definition,
      revision,
      source,
      tools: [],
      hooks: { system: [], context: [], prompt: [], reply: [], activity: [] },
      cleanups: [],
      users: 0,
      retired: false
    };
    const dataDirectory = resolve(this.config.workspaceRoot, '..', 'module-data', definition.id);

    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const api: ModuleApi = {
      id: definition.id,
      settings: Object.freeze(structuredClone(settings)),
      dataDirectory,
      tool: tool => {
        if (
          !tool ||
          !toolName.test(tool.name) ||
          typeof tool.description !== 'string' ||
          typeof tool.execute !== 'function' ||
          (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') ||
          tool.parameters?.type !== 'object' ||
          tool.name === 'agent_workspace' ||
          record.tools.some(existing => existing.name === tool.name)
        ) {
          throw new Error('工具定义无效或名称重复。');
        }
        record.tools.push(tool);
      },
      on: (event, handler) => {
        if (!Object.hasOwn(record.hooks, event) || typeof handler !== 'function') {
          throw new Error('模块事件无效。');
        }
        (record.hooks[event] as ModuleHooks[typeof event][]).push(handler);
      },
      onDispose: cleanup => {
        record.cleanups.push(cleanup);
      }
    };

    try {
      await definition.setup(api);
    } catch (error) {
      record.retired = true;
      await this.disposeRetired(record);
      throw error;
    }

    return record;
  }

  private async reload(): Promise<void> {
    const options = getModuleConfig(this.config);
    const candidates = new Map<string, { definition?: AgentModule; revision: string; source: 'builtin' | 'local'; error?: string }>();

    for (const definition of this.builtins) {
      candidates.set(definition.id, {
        definition,
        revision: `${definition.version}:${JSON.stringify(options.settings[definition.id] || {})}`,
        source: 'builtin'
      });
    }
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    for (const entry of (await readdir(options.directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!moduleId.test(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) {
        continue;
      }
      try {
        if (entry.isSymbolicLink()) {
          throw new Error('模块目录不能是符号链接。');
        }
        if (options.disabled.includes(entry.name)) {
          candidates.set(entry.name, { revision: '', source: 'local' });
          continue;
        }
        const files = await snapshot(join(options.directory, entry.name));
        const revision = `${files.revision}:${JSON.stringify(options.settings[entry.name] || {})}`;
        const cached = this.loaded.get(entry.name);

        if (cached?.revision === revision && cached.source === 'local') {
          candidates.set(entry.name, { definition: cached.definition, revision, source: 'local' });
          continue;
        }
        const cacheRoot = resolve(this.config.workspaceRoot, '..', 'module-cache');
        const target = join(cacheRoot, entry.name, files.revision);
        const staging = `${target}-${randomUUID()}`;

        await mkdir(staging, { recursive: true, mode: 0o700 });
        try {
          for (const [name, data] of files.files) {
            const file = join(staging, name);

            await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
            await writeFile(file, data, { mode: 0o600 });
          }
          await rename(staging, target).catch(async error => {
            if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
              throw error;
            }
            await rm(staging, { recursive: true, force: true });
          });
          const imported = await import(pathToFileURL(join(target, 'index.mjs')).href);
          const definition = imported.default as AgentModule;

          if (definition?.id !== entry.name) {
            throw new Error('模块 id 必须与目录名一致。');
          }
          candidates.set(entry.name, { definition, revision, source: 'local' });
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      } catch {
        candidates.set(entry.name, { revision: '', source: 'local', error: '模块加载失败，请检查定义、文件和依赖。' });
      }
    }
    const statuses: ModuleStatus[] = [];
    const active = new Set<string>();
    const names = new Set<string>();

    for (const [id, candidate] of candidates) {
      const { definition, revision, source } = candidate;
      let current = this.loaded.get(id);
      const disabled = options.disabled.includes(id);

      if (current && (disabled || candidate.error || current.revision !== revision || current.source !== source)) {
        this.loaded.delete(id);
        current.retired = true;
        await this.disposeRetired(current);
        current = undefined;
      }
      if (disabled) {
        statuses.push({ id, source, state: 'disabled' });
        continue;
      }
      try {
        if (candidate.error) {
          throw new Error(candidate.error);
        }
        current ??= await this.prepare(definition, revision, source, options.settings[id] || {});
        for (const tool of current.tools) {
          if (names.has(tool.name)) {
            throw new Error('不同模块注册了同名工具。');
          }
        }
        current.tools.forEach(tool => names.add(tool.name));
        this.loaded.set(id, current);
        active.add(id);
        statuses.push({ id, source, state: 'ready', name: definition.name, version: definition.version });
      } catch {
        if (current) {
          this.loaded.delete(id);
          current.retired = true;
          await this.disposeRetired(current);
        }
        statuses.push({ id, source, state: 'failed', error: '模块加载失败，请检查定义、文件、工具名称和依赖。' });
      }
    }
    for (const [id, module] of this.loaded) {
      if (!active.has(id)) {
        this.loaded.delete(id);
        module.retired = true;
        await this.disposeRetired(module);
      }
    }
    this.statuses = statuses;
  }
}

export const executeTool = async (tool: AgentTool, args: unknown, context: TurnContext): Promise<unknown> => {
  context.signal.throwIfAborted();
  if (context.autonomous && tool.readOnly !== true) {
    throw new Error('主动消息不能使用写入或管理工具。');
  }
  if (tool.available && !tool.available(context)) {
    throw new Error('当前会话没有这个工具的权限。');
  }
  validateArguments(tool.parameters, args);
  const result = await tool.execute(args as Record<string, unknown>, context);

  context.signal.throwIfAborted();

  return result;
};

const globalState = globalThis as typeof globalThis & { __agentLinkModules__?: { key: string; runtime: ModuleRuntime } };

export const getModuleRuntime = async (config: DSHBridgeConfig): Promise<ModuleRuntime> => {
  const key = JSON.stringify(config);

  if (globalState.__agentLinkModules__?.key !== key || globalState.__agentLinkModules__.runtime.isClosed) {
    const previous = globalState.__agentLinkModules__?.runtime;
    const runtime = new ModuleRuntime(config);

    globalState.__agentLinkModules__ = { key, runtime };
    await previous?.close();

    return runtime;
  }

  return globalState.__agentLinkModules__.runtime;
};

export const closeModuleRuntime = async (): Promise<void> => {
  const current = globalState.__agentLinkModules__;

  globalState.__agentLinkModules__ = undefined;
  await current?.runtime.close();
};
