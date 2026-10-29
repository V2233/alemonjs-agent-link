import { useState } from 'react';
import { App, Popover, Button, Drawer, Input, Space, Table, Typography } from 'antd';
export type OnlineSnapshot = { source: string; revision: string; message?: string };
export default function OnlineConfig({ source, dirty, onLoad }: { source: string; dirty: boolean; onLoad: (data: OnlineSnapshot) => void }) {
  const { modal, message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [status, setStatus] = useState<{
    uptime: number;
    pool: { id: string; model: string; active: number; failures: number; disabled: boolean }[];
    note: string;
  }>();
  const request = async (path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await fetch('./api/admin/' + path, {
        signal: AbortSignal.timeout(15000),
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      throw new Error(
        error instanceof Error && error.name === 'TimeoutError'
          ? '请求超时；写入结果尚未确认，请重新读取配置后核对，勿重复提交'
          : '无法连接框架管理服务，请确认后端及代理地址'
      );
    }
    const data = await response.json().catch(() => {
      throw new Error('服务未返回 JSON，请检查框架接口挂载及代理路径');
    });
    if (response.status === 401) setRevision('');
    if (response.status === 409) setRevision('');
    if (!response.ok) throw new Error(data.message || '管理服务不可用');
    return data.data && typeof data.data === 'object' && !Array.isArray(data.data)
      ? { ...data.data, message: data.message === 'ok' ? undefined : data.message }
      : (data.data ?? { message: data.message });
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '请求失败');
    } finally {
      setBusy(false);
    }
  };
  const accept = (data: OnlineSnapshot) => {
    setRevision(data.revision);
    onLoad(data);
    message.success(data.message || '已读取配置');
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>在线管理</Button>
      <Drawer title='在线管理' open={open} onClose={() => setOpen(false)} size={640}>
        <Space orientation='vertical' size='large' style={{ width: '100%' }}>
          <Popover title='管理令牌' content='在配置目录的 .agent-link-admin/token 文件中查看。' trigger={['click']}>
            <Button type='link' size='small'>
              如何获取令牌？
            </Button>
          </Popover>
          <Input.Password
            aria-label='管理令牌'
            placeholder='输入管理令牌'
            disabled={busy}
            value={token}
            onChange={e => {
              setToken(e.target.value);
              setRevision('');
              setHistory([]);
              setStatus(undefined);
            }}
          />
          <Space wrap>
            <Button
              loading={busy}
              disabled={!token || busy}
              onClick={() =>
                run(async () => {
                  if (dirty && !(await modal.confirm({ title: '读取将覆盖页面未导出的修改，继续吗？' }))) return;
                  accept(await request('config'));
                })
              }
            >
              读取当前配置
            </Button>
            <Button
              disabled={!revision || busy}
              onClick={() =>
                run(async () => {
                  const data = await request('validate', { source, revision });
                  message.success(data.message);
                })
              }
            >
              服务端校验
            </Button>
            <Button
              type='primary'
              disabled={!revision || busy}
              onClick={() =>
                run(async () => {
                  await request('validate', { source, revision });
                  if (
                    !(await modal.confirm({
                      title: '保存到当前服务配置？',
                      content: '自动备份原文件。平台连接和进程级参数可能需要重启；可先在主页面查看变更记录。'
                    }))
                  )
                    return;
                  accept(await request('config', { source, revision }));
                })
              }
            >
              校验并保存
            </Button>
            <Button
              disabled={!token || busy}
              onClick={() =>
                run(async () => {
                  setHistory(await request('history'));
                  setStatus(await request('status'));
                })
              }
            >
              刷新历史与状态
            </Button>
          </Space>
          {status && (
            <>
              <Typography.Text>进程运行 {Math.floor(status.uptime)} 秒</Typography.Text>
              <Table
                size='small'
                rowKey='id'
                dataSource={status.pool}
                columns={[
                  { title: '端点', dataIndex: 'id' },
                  { title: '模型', dataIndex: 'model' },
                  { title: '执行中', dataIndex: 'active' },
                  { title: '失败计数', dataIndex: 'failures' }
                ]}
                pagination={{ pageSize: 5 }}
              />
            </>
          )}
          <Table
            size='small'
            rowKey='id'
            dataSource={history.map(id => ({ id }))}
            columns={[
              { title: '保存前备份', dataIndex: 'id', render: id => <Typography.Text style={{ overflowWrap: 'anywhere' }}>{id}</Typography.Text> },
              {
                title: '操作',
                width: 70,
                render: (_, row) => (
                  <Button
                    size='small'
                    disabled={!revision || busy}
                    onClick={() =>
                      run(async () => {
                        if (!(await modal.confirm({ title: '恢复此备份？', content: '当前服务配置会先备份，页面未保存的编辑会被替换。' }))) return;
                        accept(await request('restore', { id: row.id, revision }));
                      })
                    }
                  >
                    恢复
                  </Button>
                )
              }
            ]}
            pagination={{ pageSize: 5 }}
          />
        </Space>
      </Drawer>
    </>
  );
}
