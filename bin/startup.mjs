import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parseDocument } from 'yaml';

export const minimalConfig = `# 填好下面三项后，再次运行同一条启动命令。
# 这份文件包含密钥，请不要发给别人。
qq-bot:
  app_id: '' # QQ 机器人 AppID
  secret: '' # QQ 机器人密钥

alemonjs-agent-link:
  apiKey: '' # 模型 API Key；默认使用 DeepSeek
`;

const provided = value =>
  (typeof value === 'string' && Boolean(value.trim()) && !/^<.*>$/.test(value.trim())) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (name, status, message) => ({ name, status, message });

// Do not import the framework here: doctor must not start watchers, adapters,
// Redis clients, model requests or Python installation.
export const inspectConfig = value => {
  if (!object(value)) return [check('config', 'error', '配置应为 YAML 对象，请保留各配置项的缩进。')];
  const agent = value['alemonjs-agent-link'];
  const qq = { ...(object(value['qq-bot']) ? value['qq-bot'] : {}), ...(object(value['@alemonjs/qq-bot']) ? value['@alemonjs/qq-bot'] : {}) };
  const checks = [];
  const credentials = [['alemonjs-agent-link.apiKey', agent?.apiKey, false]];
  if (object(qq.bots) && Object.keys(qq.bots).length) {
    for (const [id, bot] of Object.entries(qq.bots)) {
      credentials.push(['qq-bot.bots.*.secret', bot?.secret, false]);
      if (!id.trim() || (bot?.app_id && String(bot.app_id) !== id)) checks.push(check('qq-bot.bots', 'error', 'bots 的账号键需要与对应 AppID 一致。'));
    }
    if ((Object.keys(qq.bots).length > 1 && !qq.default_bot) || (qq.default_bot && !Object.hasOwn(qq.bots, qq.default_bot)))
      checks.push(check('qq-bot.default_bot', 'error', '请将 default_bot 设置为 bots 中的一个 AppID。'));
  } else {
    credentials.push(['qq-bot.app_id', qq.app_id, true], ['qq-bot.secret', qq.secret, false]);
  }
  for (const [name, candidate, numeric] of credentials) {
    checks.push(
      check(
        name,
        provided(candidate) && (numeric || typeof candidate === 'string') ? 'ok' : 'error',
        provided(candidate) && (numeric || typeof candidate === 'string') ? `${name} 已填写。` : `请填写 ${name}。`
      )
    );
  }
  if (agent?.baseUrl !== undefined && agent.baseUrl !== '') {
    let valid = false;
    try {
      const url = new URL(agent.baseUrl);
      valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      /* Invalid URL. */
    }
    checks.push(check('model-url', valid ? 'ok' : 'error', valid ? '模型地址格式正确；连接尚未验证。' : 'baseUrl 需要不含账号、密码或查询参数的 HTTPS 地址。'));
  }
  if (agent?.provider && agent.provider !== 'deepseek-official' && !agent.baseUrl) {
    checks.push(check('model-url', 'error', '使用其他模型服务时，请填写 baseUrl 和 model。'));
  }
  if (agent?.model !== undefined && (typeof agent.model !== 'string' || !agent.model.trim())) {
    checks.push(check('model', 'error', 'model 需要填写模型服务提供的模型名称。'));
  }
  for (const [name, choices] of [
    ['runtimeMode', ['auto', 'sandbox', 'chat-only']],
    ['stateBackend', ['local', 'redis']]
  ]) {
    if (agent?.[name] !== undefined && !choices.includes(agent[name])) {
      checks.push(check(name, 'error', `${name} 可填写 ${choices.join('、')}。`));
    }
  }
  return checks;
};

const writableAncestor = async path => {
  let candidate = path;
  while (true) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) return false;
      await access(candidate, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(candidate) === candidate) return false;
      candidate = dirname(candidate);
    }
  }
};

export const diagnose = async ({ cwd = process.cwd(), configPath = resolve(cwd, process.env.CFG_PATH || 'alemon.config.yaml') } = {}) => {
  const checks = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push(check('node', major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'error', `Node.js ${process.versions.node}；需要 22.12 或更高版本。`));
  let config;
  try {
    const lineCounter = new LineCounter();
    const document = parseDocument(await readFile(configPath, 'utf8'), { prettyErrors: false, uniqueKeys: true, lineCounter });
    if (document.errors.length) {
      // YAML parser errors can contain source lines with secrets. Only report location.
      const position = document.errors[0].pos?.[0];
      const line = typeof position === 'number' ? lineCounter.linePos(position).line : undefined;
      checks.push(check('config', 'error', `配置 YAML 格式有误${line ? `，请检查第 ${line} 行` : '，请检查缩进或重复配置项'}。`));
    } else {
      config = document.toJS({ maxAliasCount: 50 });
      checks.push(...inspectConfig(config));
    }
  } catch (error) {
    checks.push(check('config', 'error', error.code === 'ENOENT' ? '尚无配置文件；运行启动命令会自动生成。' : '无法读取配置，请检查文件权限和 YAML 格式。'));
  }
  const agent = object(config?.['alemonjs-agent-link']) ? config['alemonjs-agent-link'] : {};
  const dataPath = typeof agent.dshHomeRoot === 'string' ? dirname(resolve(cwd, agent.dshHomeRoot)) : join(cwd, '.data', 'agent-link');
  const writable = await writableAncestor(dataPath);
  checks.push(check('data', writable ? 'ok' : 'error', writable ? '数据目录可写。' : '数据目录不可写，请把应用放到当前用户可写的目录。'));
  const backend = agent.stateBackend ?? (config?.db?.redis ? 'redis' : 'local');
  checks.push(check('state', 'info', backend === 'redis' ? '使用已有 Redis 配置；离线检查不验证连接。' : '使用本地持久化，无需安装 Redis。'));
  checks.push(
    check(
      'runtime',
      'info',
      agent.runtimeMode === 'sandbox' ? '已要求完整沙箱；启动时会验证 Python 和系统沙箱。' : '普通聊天无需 Python；沙箱不可用时自动使用普通聊天。'
    )
  );
  return { ok: !checks.some(item => item.status === 'error'), configPath, platform: process.platform, arch: process.arch, checks };
};

const ensureConfig = async path => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, minimalConfig, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
};

export const runCLI = async (argv, { cwd = process.cwd(), write = text => process.stdout.write(`${text}\n`), start } = {}) => {
  let command = 'start';
  let configPath = resolve(cwd, process.env.CFG_PATH || 'alemon.config.yaml');
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['start', 'init', 'doctor'].includes(arg) && index === 0) command = arg;
    else if (arg === '--config' && argv[index + 1] && !argv[index + 1].startsWith('-')) configPath = resolve(cwd, argv[++index]);
    else if (arg === '--json') json = true;
    else if (arg === '--login' && argv[index + 1] === 'qq-bot') index++;
    else if (arg === '--help' || arg === '-h') {
      write('AgentLink：agent-link [start | init | doctor] [--config 文件路径]\n直接运行即可启动；首次自动生成配置。doctor --json 输出离线诊断。');
      return 0;
    } else {
      write('无法识别参数。运行 agent-link --help 查看用法。');
      return 2;
    }
  }
  try {
    if (command !== 'doctor') {
      const created = await ensureConfig(configPath);
      if (created || command === 'init') {
        write(`${created ? '已生成最小配置' : '配置已存在'}：${configPath}\n填写 QQ AppID、QQ 密钥和模型 API Key，然后再次运行启动命令。`);
        return created && command === 'start' ? 2 : 0;
      }
    }
    const report = await diagnose({ cwd, configPath });
    if (command === 'doctor') {
      write(
        json
          ? JSON.stringify(report, null, 2)
          : [
              report.ok ? '本地检查通过，模型和 QQ 连接需实际启动验证。' : '请先处理以下配置或环境问题：',
              `配置文件：${configPath}`,
              ...report.checks.map(item => `${item.status === 'error' ? '×' : item.status === 'ok' ? '✓' : '·'} ${item.message}`)
            ].join('\n')
      );
      return report.ok ? 0 : 1;
    }
    if (!report.ok) {
      write(
        [
          `请修改配置：${configPath}`,
          ...report.checks.filter(item => item.status === 'error').map(item => `- ${item.message}`),
          '保存后再次运行同一条启动命令。'
        ].join('\n')
      );
      return 2;
    }
    if (start) {
      await start({ configPath, cwd });
    } else {
      const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url));
      await access(entry);
      process.env.CFG_PATH = configPath;
      const framework = await import('alemonjs');
      // The framework resolves its main entry relative to cwd, including when
      // this package lives in the npx cache rather than the user's directory.
      framework.start({ input: relative(cwd, entry), platform: fileURLToPath(import.meta.resolve('@alemonjs/qq-bot')), autoPort: true });
    }
    return 0;
  } catch (error) {
    const permission = error.code === 'EACCES' || error.code === 'EPERM';
    write(
      permission
        ? '无法访问启动文件或配置目录，请使用当前用户可写的目录后重试。'
        : '启动未完成。请运行 agent-link doctor 检查配置，并确认使用包含 lib 构建产物的完整安装包。'
    );
    return 1;
  }
};
