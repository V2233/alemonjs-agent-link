import { poolSnapshot, poolBalances, poolAction } from './panel/pool-service';
import KoaRouter from 'koa-router';
import bodyParser from 'koa-bodyparser';
import { getConfig } from 'alemonjs';
import { authorizeAdmin, getAdminStore } from './panel/admin-panel';
import { getDSHConfig } from './dsh/runtime-config';
import { getCredentialPool } from './credentials/pool';

const apiRouter = new KoaRouter({ prefix: '/api/admin' });

apiRouter.use(async (ctx, next) => {
  ctx.set('Cache-Control', 'no-store');
  if (!authorizeAdmin(ctx.get('authorization'))) {
    ctx.status = 401;
    ctx.body = { code: 401, message: '管理令牌无效', data: null };

    return;
  }
  try {
    await next();
  } catch (error) {
    const conflict = /配置已|正在保存/.test(String(error));

    ctx.status = conflict ? 409 : (error as { status?: number }).status === 413 ? 413 : 400;
    ctx.body = {
      code: ctx.status,
      message: conflict ? '配置版本冲突，请重新读取后再操作' : '操作失败，请检查配置类型、取值范围、字段依赖或文件权限',
      data: null
    };
  }
});
apiRouter.use(bodyParser({ enableTypes: ['json'], jsonLimit: '1mb' }));
const success = (ctx: KoaRouter.RouterContext, data: unknown, message = 'ok') => {
  ctx.status = 200;
  ctx.body = { code: 200, message, data };
};

apiRouter.get('/pool', async ctx => success(ctx, await poolSnapshot()));
apiRouter.post('/pool/balances', async ctx => success(ctx, await poolBalances()));
apiRouter.post('/pool/action', async ctx => {
  const body = ctx.request.body as { id?: unknown; action?: unknown };

  success(ctx, await poolAction(body?.id, body?.action));
});
apiRouter.get('/config', async ctx => success(ctx, await getAdminStore().read()));
apiRouter.get('/history', async ctx => success(ctx, await getAdminStore().history()));
apiRouter.get('/status', ctx =>
  success(ctx, {
    uptime: process.uptime(),
    pool: getCredentialPool(getDSHConfig())?.status ?? [],
    note: '当前进程快照；不代表平台或模型连接成功'
  })
);
apiRouter.post('/validate', async ctx => {
  const body = ctx.request.body as { source?: string; revision?: string };

  if (typeof body?.source !== 'string' || typeof body?.revision !== 'string') ctx.throw(400);
  await getAdminStore().prepare(body.source, body.revision);
  success(ctx, null, '配置结构与核心业务规则校验通过；模块运行环境仍需实际启动验证');
});
for (const action of ['config', 'restore'])
  apiRouter.post('/' + action, async ctx => {
    const body = ctx.request.body as { source?: string; revision?: string; id?: string };

    if (typeof body?.revision !== 'string' || typeof body[action === 'restore' ? 'id' : 'source'] !== 'string') ctx.throw(400);
    const result = action === 'restore' ? await getAdminStore().restore(body.id, body.revision) : await getAdminStore().save(body.source, body.revision);
    let message = '已保存并通知配置重载；平台连接及进程级参数建议重启后核实。';

    try {
      getConfig().reload();
    } catch {
      message = '文件已保存，但内存重载失败，请检查配置并重启。';
    }
    success(ctx, result, message);
  });
export default apiRouter;
