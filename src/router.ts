import { contextEvents } from './social/event-context';
import { Router } from 'alemonjs';

// AlemonJS applies top-level defaults before each res.events. Keep event scopes
// on individual registrations so group handlers cannot consume private messages.
const router = Router.create();

router.res({ events: [...contextEvents] }, () => import('@src/response/platform-events/res'));

// Capture before command and wake handlers consume the event.
router.res({ events: ['message.create', 'private.message.create'] }, () => import('@src/response/history-capture/res'));

const commandGroup = router.group({
  events: ['message.create', 'private.message.create'],
  routeText: {
    prefixes: ['/'],
    stripPrefix: true,
    allowBare: false
  },
  fallback: {
    suggest: true,
    allowPrefixMatch: true
  },
  duplicateKey: 'throw'
});

commandGroup.use(
  { path: '主动搭话', events: ['private.message.create'], description: '主人管理自己的主动搭话订阅' },
  () => import('@src/response/agent-proactive/res')
);

commandGroup.use({ path: '人格', description: '查看及切换当前会话人格' }, () => import('@src/response/agent-persona/res'));
commandGroup.use({ path: '心情', description: '查看当前会话心情及变化' }, () => import('@src/response/agent-mood/res'));

commandGroup.use({ path: '清除聊天记录', description: '清除当前会话的持久化聊天归档' }, () => import('@src/response/history-clear/res'));

commandGroup.use({ path: '我是主人', events: ['private.message.create'], description: '申请主人验证码' }, () => import('@src/response/master/res'));
commandGroup.use({ path: '我的主人', events: ['private.message.create'], description: '验证并加入机器人主人' }, () => import('@src/response/master/res'));

commandGroup.use(
  {
    path: 'agenthelp',
    description: '查看使用说明'
  },
  () => import('@src/response/agent-help/res')
);

commandGroup.use(
  {
    path: 'agent',
    description: '查看 AgentLink 使用说明'
  },
  () => import('@src/response/agent-help/res')
);

commandGroup.use({ path: 'agentpolicy', description: '主人管理当前群 Agent 工具策略' }, () => import('@src/response/agent-policy/res'));
commandGroup.use(
  { path: 'agentmodules', events: ['private.message.create'], description: '主人查看模块加载状态并检查更新' },
  () => import('@src/response/agent-modules/res')
);
commandGroup.use({ path: 'agentpurge', description: '主人清除当前群 Agent 数据' }, () => import('@src/response/agent-purge/res'));

commandGroup.use(
  {
    path: 'agentmodels',
    events: ['private.message.create'],
    description: '主人私聊查看模型服务可用模型'
  },
  () => import('@src/response/agent-models/res')
);

commandGroup.use(
  {
    path: 'cancel',
    events: ['message.create', 'private.message.create'],
    description: '取消自己正在处理或排队的请求'
  },
  () => import('@src/response/agent-cancel/res')
);

commandGroup.use(
  {
    path: 'agentmodel',
    events: ['private.message.create'],
    description: '主人私聊查看模型及配置修改指引'
  },
  () => import('@src/response/agent-model/res')
);

commandGroup.use(
  {
    path: 'agentcontext',
    description: '预览下一次会提供给 DSH 的近期上下文'
  },
  () => import('@src/response/agent-context/res')
);

commandGroup.use(
  {
    path: 'agentcontext clear',
    description: '清除当前群的近期普通聊天上下文'
  },
  () => import('@src/response/agent-context-clear/res')
);

commandGroup.use(
  {
    path: 'agentprivacy',
    description: '查看聊天数据与隐私说明'
  },
  () => import('@src/response/agent-privacy/res')
);

commandGroup.use(
  {
    path: 'agentbind',
    events: ['private.message.create'],
    description: '主人私聊查看模型 API Key 配置指引'
  },
  () => import('@src/response/agent-bind/res')
);

commandGroup.use(
  {
    path: 'agentunbind',
    events: ['private.message.create'],
    description: '主人私聊查看模型 API Key 移除指引'
  },
  () => import('@src/response/agent-unbind/res')
);

commandGroup.use(
  {
    path: 'agentstatus',
    description: '查看 DSH 自动安装和服务状态'
  },
  () => import('@src/response/agent-status/res')
);

commandGroup.use(
  {
    path: 'new',
    description: '开始新的群会话'
  },
  () => import('@src/response/agent-new/res')
);

commandGroup.use(
  {
    path: 'chat',
    description: '向 Agent 发送消息'
  },
  () => import('@src/response/agent-chat/res')
);

commandGroup.use({ path: '语音', description: '使用 AI 合成语音回答，不可用时回退文字' }, () => import('@src/response/agent-voice/res'));
commandGroup.use({ path: '表情', description: '列出或发送配置的表情素材' }, () => import('@src/response/agent-sticker/res'));

for (const path of ['记忆', '记住', '忘记', '忘记全部']) {
  commandGroup.use({ path, events: ['private.message.create'], description: '查看、保存或删除自己的长期记忆' }, () => import('@src/response/agent-memory/res'));
}
for (const path of ['记忆检索', '记忆来源', '过时记忆', '恢复记忆', '整理记忆', '群记忆', '忘记群记忆']) {
  commandGroup.use(
    { path, events: ['message.create', 'private.message.create'], description: '检索、核对和管理当前会话的长期记忆' },
    () => import('@src/response/memory-tools/res')
  );
}

// 保存近期群聊参考；后续群聊协调器按参与策略决定是否创建回合。
router.res({ events: ['message.create'] }, () => import('@src/response/chat-context/capture'));

// @ 提及内容必须在平台适配器解析后才能确定，属于事件型入口而不是普通命令。
router.res({ events: ['message.create'] }, () => import('@src/response/dsh/res'));

router.res({ events: ['private.message.create'] }, () => import('@src/response/private-chat/res'));

export default router.define;
