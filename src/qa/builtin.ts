export type BuiltinQaEntry = {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
  tags: string[];
};

/**
 * 随安装包发布的已确认问答。更新文案时保持 id 不变，启动时只刷新
 * origin=builtin 的条目，不会覆盖主人在聊天里手动修正过的内容。
 */
export const builtinQaEntries: BuiltinQaEntry[] = [
  {
    id: 'builtin-mention-only',
    question: '为什么必须@你（AT你）才回答？',
    answer:
      '因为 qq-bot 没有给肥鱼开启“接收全面消息”（也常写作“接受全面消息”，即全量消息）权限。在群里它收不到没有 @ 它的普通消息，只能收到 @、指令或引用，所以看起来就像个只会阿巴阿巴的人机助手。要让它自然接话，需要在 qq-bot / OneBot 的机器人配置里开启接收全部群消息，并确认 groupChat.enabled 为 true；主动接话还会受冷却、每小时上限和免打扰时段限制。如果只想让它被叫到才回，保持现状就可以。',
    keywords: [
      '@',
      'at',
      '艾特',
      '必须at',
      '必须艾特',
      '唤醒',
      '才回答',
      '才回',
      '不理我',
      '不回复',
      '全面消息',
      '全量消息',
      '接受全面消息',
      '接收全面消息',
      '接收消息',
      '收不到群消息',
      '人机',
      '阿巴阿巴',
      'qq-bot',
      'onebot',
      '群里不说话',
      '不接话',
      '主动接话',
      '接话'
    ],
    tags: ['唤醒', '群聊', '权限']
  }
];
