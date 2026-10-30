import { useEffect, useState } from 'react';
import { Alert, Button, Card, DatePicker, Layout, Select, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';
type Usage = { key_id?: string; requests: number; known: number; input: number; output: number; cached: number };
export default function TokenUsagePage() {
  const [mode, setMode] = useState('day');
  const [date, setDate] = useState(dayjs(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)));
  const [data, setData] = useState<{ total: Usage; keys: Usage[] }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const period = mode === 'all' ? 'all' : date.format(mode === 'day' ? 'YYYY-MM-DD' : mode === 'month' ? 'YYYY-MM' : 'YYYY');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setData(undefined);
    fetch('./api/admin/token-usage?period=' + encodeURIComponent(period), { signal: controller.signal })
      .then(async r => {
        const v = await r.json();
        if (!r.ok) throw new Error(v.message || '读取失败');
        return v.data;
      })
      .then(setData)
      .catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [period, refresh]);
  const columns = [
    { title: '关联端点（最后记录）', dataIndex: 'label' },
    { title: 'Key 指纹', dataIndex: 'key_id', render: (v: string) => <Typography.Text copyable={{ text: v }}>{v.slice(0, 16)}</Typography.Text> },
    { title: '输入 Token', dataIndex: 'input' },
    { title: '输出 Token', dataIndex: 'output' },
    { title: '合计 Token', render: (_: unknown, r: Usage) => r.input + r.output },
    { title: '缓存命中（含在输入内）', dataIndex: 'cached' },
    { title: '请求尝试', dataIndex: 'requests' },
    { title: '未取得用量', render: (_: unknown, r: Usage) => r.requests - r.known }
  ];
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>Token 用量</Typography.Title>
      <Typography.Paragraph type='secondary'>
        按请求发起时的北京时间统计，默认今日。按服务地址与 Key 指纹累计；删除 Key
        或端点后保留历史。仅记录供应商返回的实际用量，不估算缺失数据。缓存命中包含在输入 Token 内。新账本从升级后开始记录。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          value={mode}
          onChange={setMode}
          options={[
            { value: 'day', label: '按日' },
            { value: 'month', label: '按月' },
            { value: 'year', label: '按年' },
            { value: 'all', label: '累计' }
          ]}
        />
        {mode !== 'all' && (
          <DatePicker
            allowClear={false}
            value={date}
            picker={mode === 'day' ? 'date' : (mode as 'month' | 'year')}
            onChange={v => {
              if (v) setDate(v);
            }}
          />
        )}
        <Button loading={busy} onClick={() => setRefresh(v => v + 1)}>
          刷新
        </Button>
      </Space>
      {error && <Alert type='error' title={error} />}
      <Card title='全部 Key 总量（含已删除 Key）' style={{ marginBottom: 16 }}>
        {data ? (
          <Space wrap size='large'>
            <span>输入 {data.total.input}</span>
            <span>输出 {data.total.output}</span>
            <strong>合计 {data.total.input + data.total.output}</strong>
            <span>未取得用量 {data.total.requests - data.total.known} 次</span>
          </Space>
        ) : (
          '—'
        )}
      </Card>
      <Table loading={busy} rowKey='key_id' columns={columns} dataSource={data?.keys || []} scroll={{ x: 1000 }} pagination={{ pageSize: 20 }} />
    </Layout.Content>
  );
}
