import { Router } from 'alemonjs';

const router = Router.create({
  events: ['message.create', 'private.message.create']
});

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
    events: ['message.create'],
    description: '取消自己正在处理或排队的请求'
  },
  () => import('@src/response/agent-cancel/res')
);

commandGroup.use(
  {
    path: 'agentmodel',
    events: ['private.message.create'],
    description: '主人私聊查看或切换全局模型'
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
    description: '主人私聊绑定全群共用的模型 API Key'
  },
  () => import('@src/response/agent-bind/res')
);

commandGroup.use(
  {
    path: 'agentunbind',
    events: ['private.message.create'],
    description: '主人私聊移除全群共用的模型 API Key'
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

// 普通群消息仅保存为短时参考上下文，不会直接创建 DSH Agent 回合。
router.res({ events: ['message.create'] }, () => import('@src/response/chat-context/capture'));

// @ 提及内容必须在平台适配器解析后才能确定，属于事件型入口而不是普通命令。
router.res({ events: ['message.create'] }, () => import('@src/response/dsh/res'));

export default router.define;
