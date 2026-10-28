# DeepSeek 个人扫码登录实验

仅保留官方微信扫码流程；已移除手机号、短信验证码收集及自动填写入口。已加入私聊 `/个人登录` 源码入口，QQ 实机收图和无界面浏览器授权仍待部署验证。

## 流程

启动独立浏览器 → 初始化 DSH 授权 → 官方平台登录页显示微信二维码 → 用户微信扫码 → 在服务器浏览器完成授权确认 → localhost 回调校验 state → PKCE 换取账户令牌 → 查询账户与余额 → 退出授权。

这里扫描的是官方登录页里的微信二维码，不能将 authorize_url 直接转成二维码让手机打开，否则 localhost 回调将落到手机。后续接 QQ 时，需要从服务器浏览器取得官方二维码图片并仅发给发起登录的本人；必须确认二维码刷新、过期及扫码结果，不能假定扫码即完成授权。

## 运行

当前工作区已有 `playwright-core`（间接依赖），实验需要本机安装 Google Chrome。生产接入前需显式声明浏览器依赖与安装方式。

```sh
# 先构建共享授权模块
npm run build

# 仅初始化并取消，无需用户操作
node scripts/experiments/deepseek-login-probe.mjs

# 官方微信扫码，查询账户与余额后退出，不保存凭证
node scripts/experiments/deepseek-qr-login.mjs

# 额外调用一次 Flash，最多 16 个输出 token，按平台计费
DEEPSEEK_LOGIN_PROBE_MODEL=deepseek-flash node scripts/experiments/deepseek-qr-login.mjs

node --test scripts/experiments/deepseek-account-session.test.mjs
```

账户令牌仅在内存中使用，不打印响应正文、授权地址、模型回复或凭证。取消与超时结束当前授权任务。

## 已验证与未验证

2026-10-29 已真实验证：auth_init 和 auth_cancel；用户在官方网页授权后 auth_exchange、账户资料与余额查询；账户令牌携带 `x-dsh-auth-token` 调用 `https://api.deepseek.com/chat/completions` 返回 HTTP 200 和有效回复；随后 logout 成功。此前实测没有证明用户使用了微信扫码，因此不能将它标成扫码闭环已通过。

独立浏览器可正常显示官方登录页，已观察到微信扫码 iframe。本轮已由用户完成真实微信扫码及授权确认，并验证账户与余额查询成功。待验证：二维码图片发送到 QQ、扫码后的授权确认自动化、多人隔离、凭证加密持久化、现有聊天/工具/Python Bridge 的账户认证适配。

4 项协议测试覆盖错误 state、重复参数、重复回调、取消、令牌查询及撤销、模型请求头与禁止重定向。模拟测试不能替代真实扫码验证。

## 实现依据与接入边界

[官方账户实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/deepseek-account-platform/src/index.ts)与[协议校验](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/deepseek-account-platform/src/protocol.ts)。

账户授权与个人 API Key 分开保存、分开鉴权。当前项目个人 Key 使用 Bearer，Python Bridge 校验 sk- 格式，不能直接把账户令牌塞入 apiKey。后续按真实平台用户 ID 绑定浏览器任务和凭证，群聊不共享；取消后的回调不允许重新登录。余额不足与登录失效分开处理。

## 官方二维码提取

2026-10-29 已在真实独立浏览器中验证：授权页加载的二维码 iframe 来自 `https://open.weixin.qq.com/connect/qrconnect`，实际二维码图片为该 iframe 中可见的 `img.js_qrcode_img`。脚本等待图片加载成功后截图，仅提取二维码，不截图手机号表单或账户信息。

二维码文件存入 `.data/agent-link/experiments/qr-*/login.png`，每次实验使用独立临时目录、文件权限 0600；退出时删除本次目录。成功提取证明可以向聊天平台发送官方二维码图片，但尚不等于已完成 QQ 发送功能。二维码过期后当前实验应取消重试，暂未实现自动刷新推送。

## 真实扫码闭环结果

2026-10-29 用户扫描本次提取的官方二维码并完成授权，脚本输出：

```json
{ "authorized": true, "profileQuery": true, "balanceQuery": true }
```

进程退出码 0，远端退出成功，临时二维码文件已清理，没有持久化账户令牌。本轮未调用模型；此前网页授权实验已验证账户令牌调用 Flash 成功。本轮未确认授权按钮能否自动点击，不能宣称用户只扫码就无需后续确认。

## 私聊接入（源码已实现，未部署验收）

- `/个人登录`：生成官方微信二维码，向本人私聊发送图片；最多同时 3 个任务，每人一个任务。
- `/个人登录 状态`：查看任务状态或本地授权是否已保存。
- `/个人登录 取消`：取消等待，不接受晚到授权。
- `/个人退出`：移除该扫码账户的两种用途和关联群授权副本，并尝试远端退出。单群撤销请使用 `/授权记录`。

运行机器必须安装 Google Chrome 及其运行依赖；`playwright-core` 不自动安装浏览器。使用独立无界面浏览器上下文，不复用部署者的浏览器账户。平台若在扫码之后要求电脑网页额外确认，当前版本会等待到超时，不绕过确认；这一点须在真实 QQ 场景核验。

授权已统一存入现有 Redis 钥匙体系，不再使用独立 accounts 文件作为聊天凭证来源；Redis 与个人 Key 加密主密钥必须一起备份。当前按单进程、独立 Redis 实例运行设计，多副本不共享登录任务；跨用途原子写入不支持 Redis Cluster 的跨槽事务。

扫码自动准备私聊和群聊两个用途条目；已有私聊钥匙保留。群聊条目默认待授权，之后由管理员在群中授权。普通文本与工具聊天通过统一 budgetedFetch 携带账户认证，不扣机器人的内部额度。402 保留登录并提示充值，401/403 提示重新登录，不偷偷回退到公共 Key。退出后恢复原有凭证选择。

沙箱工作区暂未支持账户令牌，明确拒绝该路径，不能声称已兼容 Python Bridge。没有替换媒体服务的独立凭证，也没有增加登录后的工作区权限。

新增测试覆盖账户密文存储、用户隔离、账户认证头、402 不回退，以及凭证持久化成功前不得移交授权。全仓 TypeScript 检查仍有凭证池、媒体、记忆、面板等既存错误；本次涉及的新账户模块未出现在错误列表。
