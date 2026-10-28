export const personalKeyGuide = [
  '添加个人密钥（只用于你和我的私聊）：',
  '1. 准备一个有余额的 DeepSeek API Key。',
  '2. 私聊我发送下面这条，把 sk-你的Key 换成真实密钥：',
  '/个人密钥 绑定 sk-你的Key',
  '3. 绑定成功后，再发一次你的问题。',
  '如果以前因欠费停用，充值后发送：',
  '/个人密钥 启用',
  '真实密钥只在私聊提交，不要发到群里。'
].join('\n');

export const groupKeyGuide = [
  '添加群密钥（供本群使用）：',
  '1. 群主或管理员在本群发送：',
  '/群密钥 绑定',
  '2. 拿到临时码后，由申请人私聊我发送：',
  '/群密钥 绑定 临时码 sk-你的Key',
  '把临时码换成刚收到的码，把 sk-你的Key 换成有余额的 DeepSeek API Key。',
  '临时码5分钟有效。真实密钥不要发到群里。'
].join('\n');

export const quotaHelp = (isPrivate: boolean): string =>
  [
    '个人免费额度跨群和私聊共用，默认每天1元。群后台判断另有每天1元预算。',
    isPrivate ? personalKeyGuide : groupKeyGuide,
    '也可联系机器人主人增加额度；/额度 查看剩余。免费额度按北京时间零点重置。'
  ].join('\n\n');

export const insufficientBudgetHelp = (isPrivate: boolean): string =>
  ['本次可用额度不足。', isPrivate ? personalKeyGuide : groupKeyGuide, '也可联系机器人主人增加额度，或等北京时间零点重置。/额度 可查剩余。'].join('\n\n');
