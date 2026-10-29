import { useEffect, useState } from 'react';
import { Alert, App, Button, Drawer, Input, Layout, Space, Table, Tag, Typography } from 'antd';
type Event = {
  id: string;
  author: string;
  quote: string;
  comment: string;
  perspective: string;
  dimension: string;
  at: number;
  revoked: boolean;
  before: number | null;
  after: number | null;
};
type Opinion = {
  id: string;
  name: string;
  kind: string;
  targetId: string;
  platform: string;
  channelId: string;
  personaId: string;
  score: number | null;
  label: string;
  dimensions: Record<string, number>;
  frozen: boolean;
  revision: number;
  events: Event[];
};
const origins: Record<string, string> = { reported: '网友观点', direct: '直接互动', inferred: '基于反馈的暂定看法' };
export default function OpinionsPage() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Opinion[]>([]);
  const [selected, setSelected] = useState<Opinion>();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const call = async (path = '', body?: unknown) => {
    const response = await fetch('./api/admin/opinions' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '操作失败');
    return result.data;
  };
  const load = async () => {
    setBusy(true);
    try {
      const items = await call();
      setRows(items);
      setSelected(current => items.find((item: Opinion) => item.id === current?.id));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const act = async (item: Opinion, action: string, value?: string) => {
    setBusy(true);
    try {
      const updated = await call('/edit', { id: item.id, revision: item.revision, action, value });
      setRows(current => current.map(row => (row.id === updated.id ? updated : row)));
      setSelected(current => (current?.id === updated.id ? updated : current));
      message.success('已更新');
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>对象评价</Typography.Title>
      <Typography.Paragraph type='secondary'>按会话与人物隔离。网友观点保留原话；肥鱼的暂定看法与直接互动分别标注。分数不是事实判定。</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder='搜索对象、用户ID或会话' value={query} onChange={e => setQuery(e.target.value)} allowClear />
        <Button loading={busy} onClick={load}>
          刷新
        </Button>
      </Space>
      {error && <Alert type='error' title={error} />}
      <Table<Opinion>
        rowKey='id'
        loading={busy}
        dataSource={rows.filter(row => [row.name, row.targetId, row.channelId].some(s => s.toLowerCase().includes(query.toLowerCase())))}
        scroll={{ x: 900 }}
        columns={[
          { title: '对象', dataIndex: 'name' },
          { title: '会话 / 人物', render: (_, row) => `${row.platform} / ${row.channelId} / ${row.personaId}` },
          {
            title: '态度',
            render: (_, row) => (
              <Space>
                <Tag>{row.score === null ? '未评分' : row.score}</Tag>
                {row.label}
              </Space>
            )
          },
          { title: '状态', render: (_, row) => (row.frozen ? '已冻结' : '自动更新') },
          {
            title: '操作',
            render: (_, row) => (
              <Space>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setSelected(row);
                    setName(row.name);
                  }}
                >
                  查看依据
                </Button>
                <Button disabled={busy} onClick={() => act(row, row.frozen ? 'unfreeze' : 'freeze')}>
                  {row.frozen ? '恢复更新' : '冻结'}
                </Button>
              </Space>
            )
          }
        ]}
      />
      <Drawer title='评价与变化记录' open={Boolean(selected)} size={800} onClose={() => setSelected(undefined)}>
        {selected && (
          <>
            <Typography.Paragraph>对象ID：{selected.targetId || selected.id}</Typography.Paragraph>
            <Space wrap>
              <Input aria-label='对象显示名称' maxLength={80} value={name} onChange={e => setName(e.target.value)} />
              <Button disabled={busy || !name.trim()} onClick={() => act(selected, 'rename', name)}>
                修正显示名称
              </Button>
            </Space>
            <Typography.Paragraph type='secondary'>改名不变更平台身份。对象识别错误时撤销对应事件，不把记录转给另一个网友。</Typography.Paragraph>
            <Space wrap>
              {Object.entries(selected.dimensions).map(([key, value]) => (
                <Tag key={key}>
                  {key}：{value}
                </Tag>
              ))}
            </Space>
            {selected.events
              .slice()
              .reverse()
              .map(event => (
                <div key={event.id} style={{ borderTop: '1px solid #eee', padding: '16px 0' }}>
                  <Space wrap>
                    <Tag>{origins[event.perspective]}</Tag>
                    <Tag>{event.dimension}</Tag>
                    {event.revoked && <Tag color='red'>已撤销</Tag>}
                    <Typography.Text type='secondary'>{new Date(event.at).toLocaleString()}</Typography.Text>
                  </Space>
                  <Typography.Paragraph>
                    发言人：{event.author} · {event.before === null ? '不计入肥鱼分数' : `${event.before} → ${event.after}`}
                  </Typography.Paragraph>
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>原话：{event.quote}</Typography.Paragraph>
                  <Typography.Paragraph>{event.comment}</Typography.Paragraph>
                  <Button
                    danger
                    disabled={busy || event.revoked}
                    onClick={() =>
                      modal.confirm({
                        title: '撤销这条评价？',
                        content: '保留原记录并标记撤销，重新计算态度分。',
                        onOk: () => act(selected, 'revoke', event.id)
                      })
                    }
                  >
                    撤销错误事件
                  </Button>
                </div>
              ))}
          </>
        )}
      </Drawer>
    </Layout.Content>
  );
}
