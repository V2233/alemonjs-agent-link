import { Format, getCurrentEvent } from 'alemonjs';

// QQ 气泡只用两种可点元素：Markdown 里的 <qqbot-cmd-input>（点一下把指令填进输入框），
// 以及挂在消息底部的键盘按钮组。两者都只“填入不发送”，避免误触直接执行。
const RICH_PLATFORM = 'qq-bot';
const MAX_INLINE_ACTIONS = 10;
const MAX_KEYBOARD_ACTIONS = 10;
const MAX_INLINE_LABEL = 12;
// 键盘按钮在手机上是小号按钮，1-4 个字才读得快。
const MAX_KEYBOARD_LABEL = 4;
const MAX_COMMAND_LENGTH = 60;
const BUTTONS_PER_ROW = 5;

// 键盘按钮用固定短名，正文行内按钮仍显示完整说明（如“聊天用法”）。
/** 键盘按钮短名：手机小号按钮上最多 4 个字，超出会被客户端挤断行。 */
export const KEYBOARD_LABELS: Record<string, string> = {
  '/帮助': '帮助',
  '/帮助 聊天': '聊天',
  '/帮助 媒体': '媒体',
  '/帮助 记忆': '记忆',
  '/帮助 人格': '人格',
  '/帮助 额度': '额度',
  '/帮助 数据': '数据',
  '/帮助 管理': '管理',
  '/帮助 全部': '完整说明',
  '/状态': '刷新',
  '/状态 详情': '详情',
  '/额度': '额度',
  '/额度 记录': '记录',
  '/额度 增加': '增加',
  '/额度 设置': '设置',
  '/个人密钥': '个人密钥',
  '/个人密钥 绑定': '绑定密钥',
  '/个人密钥 启用': '启用密钥',
  '/个人密钥 状态': '密钥状态',
  '/群密钥 绑定': '申请密钥',
  '/群密钥 状态': '群密钥',
  '/群密钥 启用': '启用',
  '/群密钥 停用': '停用',
  '/群密钥 移除': '移除',
  '/当前模型': '当前模型',
  '/模型池': '模型池',
  '/模型列表': '模型列表',
  '/密钥配置': '密钥配置',
  '/移除密钥': '移除密钥',
  '/工具策略': '策略',
  '/工具策略 状态': '状态',
  '/工具策略 网页 开启': '网页开',
  '/工具策略 网页 关闭': '网页关',
  '/工具策略 文件 开启': '文件开',
  '/工具策略 文件 关闭': '文件关',
  '/主动搭话 状态': '状态',
  '/主动搭话 开启': '开启',
  '/主动搭话 关闭': '关闭',
  '/主动搭话 现在': '立即',
  '/语音引擎 状态': '状态',
  '/语音引擎 安装': '安装',
  '/隐私说明': '隐私',
  '/清除聊天记录': '清记录',
  '/清除群数据': '清除',
  '/清除群数据 确认': '确认',
  '/取消': '取消',
  '/聊天参考': '刷新',
  '/聊天参考 清除': '清除',
  '/记忆': '我的记忆',
  '/群记忆': '群记忆',
  '/记忆检索': '检索',
  '/过时记忆': '过时记忆',
  '/表情': '表情',
  '/模块状态': '模块状态',
  '/我是主人': '验证码',
  '/心情': '心情',
  '/人格': '人格',
  '/人格 帮助': '人格说明',
  '/人格 使用 默认': '恢复默认',
  '/新会话': '新会话',
  '/语音': '语音',
  '/提问': '提问'
};

// Only application-owned navigation creates buttons; quoted/user text is escaped.
const safe = (text: string): string =>
  text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_[\]~])/gu, '\\$1');

export type BubbleAction = {
  label: string;
  command?: string;
  /** 打开外部链接；这类动作无法用 Markdown 指令输入表达，保留键盘按钮。 */
  url?: string;
  /** 单选/二选一菜单；保留键盘按钮，避免把选择拆成多条指令。 */
  choice?: 'single' | 'binary';
  short?: string;
};
export type BubbleSection = { title: string; text: string; actions?: BubbleAction[] };
export type BubbleLayout = 'auto' | 'inline' | 'keyboard' | 'none';
export type BubbleOptions = { platform?: string; actions?: BubbleAction[]; layout?: BubbleLayout };

const resolvePlatform = (platform?: string): string => {
  if (platform) return platform;
  const current = getCurrentEvent() as { Platform?: unknown } | undefined;

  return typeof current?.Platform === 'string' ? current.Platform : '';
};

/** 只有 QQ 官方机器人支持 Markdown 指令按钮和键盘按钮组，其余平台退回纯文本卡片。 */
export const supportsBubbles = (platform?: string): boolean => resolvePlatform(platform).toLowerCase() === RICH_PLATFORM;

const clip = (value: string, limit: number): string => {
  const chars = Array.from(value.trim() || '点我');

  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('');
};

const inlineLabel = (value: string): string => {
  const text = value.trim() || '点我';
  const chars = Array.from(text);

  return chars.length <= MAX_INLINE_LABEL ? text : `${chars.slice(0, MAX_INLINE_LABEL - 1).join('')}…`;
};

/** 键盘按钮只留 1-4 个字：优先用声明或内置短名，最后才截断。 */
const keyboardLabel = (action: BubbleAction): string => clip(action.short || KEYBOARD_LABELS[action.command || ''] || action.label, MAX_KEYBOARD_LABEL);

/** 只按指令去重；同一条指令的不同用途（/个人密钥 状态 与 /个人密钥 绑定）都保留。 */
const normalizeActions = (actions: BubbleAction[]): BubbleAction[] => {
  const kept: BubbleAction[] = [];

  for (const action of actions) {
    const target = String(action?.url ?? action?.command ?? '').trim();
    const title = String(action?.label ?? '').trim();

    if (!target || !title || target.length > MAX_COMMAND_LENGTH) continue;
    if (action.url && !/^https:\/\//u.test(action.url)) continue;
    if (kept.some(item => String(item.url ?? item.command ?? '').trim() === target)) continue;
    kept.push(action);
  }

  return kept.slice(0, MAX_KEYBOARD_ACTIONS);
};

/** 链接和单选/二选一无法降级成 Markdown 指令输入，继续用键盘。 */
const needsKeyboard = (actions: BubbleAction[]): boolean => actions.some(action => Boolean(action.url || action.choice));

const addInline = (md: ReturnType<typeof Format.createMarkdown>, actions: BubbleAction[]): void => {
  md.addNewline();
  // 默认所有命令导航都降级成 Markdown 指令输入：点一下只填入，不直接发送。
  for (const action of actions.filter(item => item.command).slice(0, MAX_INLINE_ACTIONS))
    md.addButton(`‹${inlineLabel(action.label)}›`, { data: action.command, autoEnter: false }).addText(' ');
};

const buildKeyboard = (actions: BubbleAction[]): ReturnType<typeof Format.createButtonGroup> | null => {
  if (actions.length === 0) return null;
  const group = Format.createButtonGroup().smallButton();

  for (let index = 0; index < actions.length; index += BUTTONS_PER_ROW) {
    group.addRow();
    for (const action of actions.slice(index, index + BUTTONS_PER_ROW)) {
      const target = action.url || action.command;

      if (!target) continue;
      group.addButton(keyboardLabel(action), target, {
        type: action.url ? 'link' : 'command',
        style: 'blue',
        autoEnter: false,
        rawData: {}
      });
    }
  }

  return group;
};

/** 行内按钮只做“下一步”，键盘按钮组只做“选一个”，两者不重复铺同一批指令。 */
const attach = (format: ReturnType<typeof Format.create>, actions: BubbleAction[]): ReturnType<typeof Format.create> => {
  const group = buildKeyboard(actions);

  return group ? format.addButtonGroup(group) : format;
};

/**
 * 同一组指令只走一条视觉通道：
 * - auto：1–3 个作为正文里的下一步；4 个以上作为底部的选择菜单；
 * - inline / keyboard：调用方明确指定；
 * - none：正文已经写清，不再挂按钮。
 */
const splitActions = (actions: BubbleAction[], layout: BubbleLayout): { inline: BubbleAction[]; keyboard: BubbleAction[] } => {
  if (layout === 'none') return { inline: [], keyboard: [] };

  // 链接和单选/二选一保留键盘；其余命令一律降级成 Markdown 指令输入，
  // 包括显式写了 layout: 'keyboard' 的旧调用。
  if (needsKeyboard(actions)) return { inline: [], keyboard: actions };

  return { inline: actions.slice(0, MAX_INLINE_ACTIONS), keyboard: [] };
};

export const sectionBubble = (title: string, intro: string, sections: BubbleSection[], options: BubbleOptions = {}): ReturnType<typeof Format.create> => {
  const rich = supportsBubbles(options.platform);
  const allActions = sections.flatMap(section => section.actions ?? []);
  // 默认所有分块入口都走行内 Markdown 指令输入；只有链接或单选/二选一保留键盘。
  const layout = options.layout === 'none' ? 'none' : needsKeyboard(allActions) ? 'keyboard' : 'inline';
  const inline = rich && layout === 'inline';
  const md = Format.createMarkdown().addBold(safe(title));

  if (intro) md.addNewline().addText(safe(intro));
  for (const section of sections) {
    const actions = inline ? normalizeActions(section.actions ?? []) : [];
    const block = Format.createMarkdown().addBold(safe(section.title));

    if (section.text) block.addNewline().addText(safe(section.text));
    if (actions.length > 0) addInline(block, actions);
    md.addNewline().addNewline().addBlockquote(block);
  }

  const format = Format.create().addMarkdown(md);

  if (!rich || layout !== 'keyboard') return format;

  return attach(format, normalizeActions(allActions));
};

/** 系统提示与错误：单行保持纯文本，多行才成卡片，并按需挂上可点入口。 */
export const noticeBubble = (text: string, options: BubbleOptions & { title?: string } = {}): ReturnType<typeof Format.create> =>
  commandBubble(text, options.title || '提示', { platform: options.platform, actions: options.actions, layout: options.layout });

/** 多行说明与状态卡：加粗标题、逐行排版，并挂上应用自己声明的可点指令。 */
export const commandBubble = (text: string, title: string, options: BubbleOptions = {}): ReturnType<typeof Format.create> => {
  const rich = supportsBubbles(options.platform);
  const actions = rich ? normalizeActions(options.actions ?? []) : [];
  const { inline, keyboard } = splitActions(actions, options.layout ?? 'auto');

  // 单行确认仍是纯文本；只有挂了可点入口才值得做卡片。
  if (!text.includes('\n') && inline.length === 0 && keyboard.length === 0) return Format.create().addText(text);
  const md = Format.createMarkdown().addBold(safe(title)).addNewline().addNewline();

  for (const line of text.replace(/\n+$/u, '').split('\n')) {
    const match = line.match(/^([^：\n]{1,24})：(.*)$/u);

    if (match && !line.startsWith('/') && !line.startsWith('|')) md.addBold(safe(`${match[1]}：`)).addText(safe(match[2]));
    else md.addText(safe(line));
    md.addNewline();
  }

  if (inline.length > 0) {
    const block = Format.createMarkdown();

    addInline(block, inline);
    md.addNewline().addBlockquote(block);
  }

  const format = Format.create().addMarkdown(md);

  return keyboard.length > 0 ? attach(format, keyboard) : format;
};
