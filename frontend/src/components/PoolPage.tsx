import EndpointDragHandle from './EndpointDragHandle';
import ModelConnectionFields from './ModelConnectionFields';
import { useEffect, useRef, useState } from 'react';
import {
  App,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography
} from 'antd';
import { PlusOutlined, ReloadOutlined, MoreOutlined } from '@ant-design/icons';
import { useUnsavedNavigation } from './useUnsavedNavigation';

const strategies = [
  { value: 'balanced', label: '均衡分配' },
  { value: 'weighted-round-robin', label: '按权重轮转' },
  { value: 'least-busy', label: '优先空闲' },
  { value: 'sticky', label: '会话粘性' }
];
const ruleFields = [
  { name: 'maxAttempts', label: '最大尝试次数', min: 1, max: 20 },
  { name: 'failureThreshold', label: '连续失败阈值', min: 1, max: 100 },
  { name: 'cooldownSeconds', label: '冷却时间（秒）', min: 1, max: 86400 },
  { name: 'queueMaxWaitMs', label: '主端点排队（毫秒）', min: 0, max: 30000 },
  { name: 'retryBudgetMs', label: '重试时间预算（毫秒）', min: 1000, max: 300000 },
  { name: 'balanceAlertYuan', label: '低余额提醒（元）', min: 0 }
];
const budgetFields = [
  { name: 'globalDailyYuan', label: '全局每日上限', default: 0 },
  { name: 'personalDailyYuan', label: '个人每日默认额度', default: 1 },
  { name: 'replyGateDailyYuan', label: '回复门控每日额度', default: 1 },
  { name: 'replyGateGlobalDailyYuan', label: '门控全局每日上限', default: 0 }
];
type Balance = { text: string; amount?: number; currency?: string; status?: string; checkedAt: number; httpStatus?: number };
type Endpoint = {
  id: string;
  model: string;
  provider: string;
  baseUrl: string;
  account?: string;
  enabled?: boolean;
  disabled?: boolean;
  cooldownUntil?: number;
  reachability?: boolean;
  observedAt?: number;
  observationSource?: string;
  observedStatus?: number;
  probeReachable?: boolean;
  probeStatus?: number;
  lastProbeAt?: number;
  active?: number;
  maxConcurrent?: number;
  requests?: number;
  tokens?: number;
  rpm?: number;
  tpm?: number;
  fallback?: boolean;
  priority?: number;
  weight?: number;
  lastRequest?: { source?: 'call' | 'health-check'; at: number; ok: boolean; status?: number; reason: string; latencyMs?: number };
  lifecycle?: {
    sent: number;
    blocked: number;
    cancelled: number;
    records: Array<{
      id: string;
      requestId?: string;
      attempt: number;
      purpose: string;
      at: number;
      sent: boolean;
      ok: boolean;
      reason: string;
      status?: number;
    }>;
  };
  purposeStatistics?: Record<string, { total: number; success: number; failed: number }>;
  totalCalls?: number;
  successfulCalls?: number;
  failedCalls?: number;
  statisticsSince?: number;
  dailyRequests?: number;
  dailyTokens?: number;
  capabilities?: string[];
};
type Snapshot = {
  balances?: Record<string, Balance>;
  balancesRefreshing?: boolean;
  replyGateStatistics?: { total: number; success: number; failed: number; since: number; updatedAt: number };
  enabled: boolean;
  sampledAt: number;
  strategy?: string;
  endpoints: Endpoint[];
  probeRun?: { running: boolean; results: { id: string; state: string }[] };
};
type ConfigSnapshot = { revision: string; modelPool: Record<string, any>; budget: Record<string, any>; baseUrl?: string };
const secureUrl = async (_: unknown, value: string) => {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error();
  } catch {
    throw new Error('请输入不含凭证、查询参数的 HTTPS 地址');
  }
};
const labels: Record<string, string> = {
  normal: '正常',
  exhausted: '额度耗尽',
  'rate-limited': '供应商限流',
  frozen: '账户冻结',
  invalid: '凭证无效',
  forbidden: '访问受限',
  unavailable: '服务商标记不可用',
  unsupported: '不支持查询',
  failed: '查询失败',
  unknown: '额度未知'
};
export default function PoolPage() {
  const { message, modal } = App.useApp();
  const [data, setData] = useState<Snapshot>();
  const [config, setConfig] = useState<ConfigSnapshot>();
  const [balances, setBalances] = useState<Record<string, Balance>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionText, setRecognitionText] = useState('');
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState<'endpoint' | 'rules' | 'budget'>();
  const [editor, setEditor] = useState<ConfigSnapshot>();
  const [editingId, setEditingId] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm();
  const pending = useRef(false);
  useUnsavedNavigation(dirty);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const request = async (path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await fetch('./api/admin/' + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(40000)
      });
    } catch {
      throw new Error('连接失败或请求超时，请刷新核对操作结果');
    }
    const result = await response.json().catch(() => {
      throw new Error('管理服务未返回有效结果');
    });
    if (!response.ok) throw new Error(result.message || '操作失败');
    return result;
  };
  const run = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      const text = e instanceof Error ? e.message : '操作失败';
      setError(text);
      message.error(text);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    const [snapshot, current] = await Promise.all([request('pool'), request('pool/settings')]);
    setData(snapshot.data);
    setConfig(current.data);
  };
  useEffect(() => {
    void run(refresh);
  }, []);
  useEffect(() => {
    if (!data?.probeRun?.running) return;
    const timer = setTimeout(() => void run(async () => setData((await request('pool')).data)), 1500);
    return () => clearTimeout(timer);
  }, [data, busy]);
  useEffect(() => {
    if (data?.balances) setBalances(data.balances);
  }, [data?.balances]);
  const app: ConfigSnapshot = config || { revision: '', modelPool: {}, budget: {} };
  const configured: Endpoint[] = app.modelPool?.endpoints || [];
  const endpoints: Endpoint[] = configured.map(item => ({
    ...item,
    ...data?.endpoints.find(row => row.id === item.id),
    capabilities: item.capabilities,
    baseUrl: item.baseUrl || app.baseUrl || (item.provider === 'deepseek-official' ? 'https://api.deepseek.com' : '')
  }));
  // Also support normalized legacy pool entries returned by the runtime.
  for (const item of data?.endpoints || []) if (!endpoints.some(row => row.id === item.id)) endpoints.push(item);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !pending.current) void run(async () => setData((await request('pool')).data));
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  const open = async (kind: 'endpoint' | 'rules' | 'budget', id?: string) => {
    const current = (await request('pool/settings')).data as ConfigSnapshot;
    const value = current;
    const entry = id ? value.modelPool?.endpoints?.find((item: Endpoint) => item.id === id) : undefined;
    if (id && !entry) throw new Error('端点已变化，请刷新列表后重试');
    form.resetFields();
    setEditor(current);
    setEditingId(id);
    setDirty(false);
    setDrawer(kind);
    if (kind === 'endpoint') form.setFieldsValue(entry || { provider: 'openai-compatible', enabled: true, capabilities: [], weight: 1, maxConcurrent: 2 });
    else form.setFieldsValue(kind === 'rules' ? value.modelPool || {} : value.budget || {});
  };
  const save = async () => {
    let values: Record<string, unknown>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    await run(async () => {
      if (!editor) return;
      const result = await request('pool/settings', {
        revision: editor.revision,
        action: drawer,
        id: editingId,
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === undefined ? null : value]))
      });
      setDirty(false);
      setDrawer(undefined);
      setBalances({});
      await refresh();
      message.success(result.message);
    });
  };
  const reorder = async (id: string, target: string) => {
    if (!config || id === target) return;
    const ids = configured.map(item => item.id).filter(value => value !== id);
    const index = configured.findIndex(item => item.id === target);
    if (index < 0) return;
    ids.splice(index, 0, id);
    await run(async () => {
      const result = await request('pool/settings', { revision: config.revision, action: 'reorder', values: { ids } });
      await refresh();
      message.success(result.message);
    });
  };
  const lookup = async (id?: string) => {
    const result = await request('pool/balances', id ? { id } : {});
    setBalances(old => ({ ...old, ...result.data }));
  };
  const remove = async (row: Endpoint) => {
    if (!(await modal.confirm({ title: '删除端点 ' + row.id + '？' }))) return;
    await run(async () => {
      const current = (await request('pool/settings')).data;
      await request('pool/settings', { revision: current.revision, action: 'remove', id: row.id });
      await refresh();
    });
  };
  const setEnabled = async (row: Endpoint, enabled: boolean) => {
    if (!config) return;
    const result = await request('pool/settings', {
      revision: config.revision,
      action: 'endpoint',
      id: row.id,
      values: { enabled }
    });
    await refresh();
    message.success(result.message);
  };
  const budget = app.budget || {};
  const balanceState = (balance: Balance) =>
    balance.status === 'normal' && balance.currency === 'CNY' && balance.amount !== undefined && balance.amount < (app.modelPool?.balanceAlertYuan ?? 1)
      ? '余额偏低'
      : labels[balance.status || 'unknown'];
  const testing = (row: Endpoint) => data?.probeRun?.running && data.probeRun.results.some(item => item.id === row.id && item.state === 'running');
  const statistics = endpoints.reduce(
    (sum, row) => ({
      total: sum.total + (row.totalCalls || 0),
      success: sum.success + (row.successfulCalls || 0),
      failed: sum.failed + (row.failedCalls || 0)
    }),
    { total: 0, success: 0, failed: 0 }
  );
  return (
    <Layout.Content className='workspace-content'>
      <Flex justify='space-between' align='center' wrap gap={16} className='workspace-page-heading'>
        <Typography.Title level={2} style={{ margin: 0 }}>
          额度轮转
        </Typography.Title>
        <Space wrap>
          <Button
            disabled={busy || data?.probeRun?.running || !endpoints.length}
            loading={data?.probeRun?.running}
            onClick={() =>
              run(async () => {
                await request('pool/probe-all', {});
                await refresh();
              })
            }
          >
            一键测活
          </Button>
          <Button disabled={busy || !endpoints.length} onClick={() => run(() => lookup())}>
            立即查额度
          </Button>
          <Button type='primary' icon={<PlusOutlined />} disabled={busy} onClick={() => run(() => open('endpoint'))}>
            新增端点
          </Button>
          <Button disabled={busy} onClick={() => setRecognizing(true)}>
            智能识别
          </Button>
          <Button icon={<ReloadOutlined />} aria-label='刷新轮转状态' disabled={busy} onClick={() => run(refresh)} />
        </Space>
      </Flex>
      {error && <Alert type='error' title={error} showIcon style={{ marginBottom: 16 }} />}
      {data?.probeRun && (
        <Typography.Paragraph type='secondary'>
          测活 {data.probeRun.results.filter(item => ['done', 'failed'].includes(item.state)).length} / {data.probeRun.results.length}
        </Typography.Paragraph>
      )}
      <Typography.Paragraph type='secondary' style={{ fontSize: 12 }}>
        按端点 ID 累计统计，更换 Key 沿用原 ID 的历史；包含发送前拦截。重试单独计次，成功率按已完成调用计算，不含测活、额度查询及沙箱独立统计。
      </Typography.Paragraph>
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {[
          ['调用尝试', statistics.total],
          ['成功', statistics.success],
          ['失败', statistics.failed],
          ['成功率', statistics.success + statistics.failed ? ((statistics.success / (statistics.success + statistics.failed)) * 100).toFixed(1) + '%' : '—']
        ].map(([label, value]) => (
          <Col xs={12} md={6} key={label}>
            <Card size='small'>
              <Typography.Text type='secondary'>{label}</Typography.Text>
              <Typography.Title level={3} style={{ margin: '8px 0 0' }}>
                {value}
              </Typography.Title>
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[16, 16]} style={{ marginBlock: 20 }}>
        <Col xs={24} lg={12}>
          <Card
            title='本地额度保护'
            extra={
              <Button disabled={busy} onClick={() => run(() => open('budget'))}>
                编辑保护规则
              </Button>
            }
          >
            <Descriptions
              size='small'
              column={1}
              items={[
                { key: 'enabled', label: '保护', children: <Tag color={budget.enabled ? 'green' : 'default'}>{budget.enabled ? '已启用' : '未启用'}</Tag> },
                ...budgetFields.map(item => ({
                  key: item.name,
                  label: item.label,
                  children:
                    (budget[item.name] ?? (item.name === 'personalDailyYuan' ? budget.privateDailyYuan : undefined) ?? item.default) === 0 &&
                    ['globalDailyYuan', 'replyGateGlobalDailyYuan'].includes(item.name)
                      ? '不限'
                      : (budget[item.name] ?? (item.name === 'personalDailyYuan' ? budget.privateDailyYuan : undefined) ?? item.default) + ' 元'
                }))
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title='轮转规则'
            extra={
              <Button disabled={busy} onClick={() => run(() => open('rules'))}>
                编辑规则
              </Button>
            }
          >
            <Descriptions
              column={1}
              size='small'
              items={[
                { key: 'enabled', label: '轮转', children: <Tag color={data?.enabled ? 'green' : 'default'}>{data?.enabled ? '已启用' : '未启用'}</Tag> },
                {
                  key: 'strategy',
                  label: '分配策略',
                  children: strategies.find(item => item.value === (app.modelPool?.strategy || 'weighted-round-robin'))?.label
                },
                { key: 'retry', label: '失败重试', children: (app.modelPool?.maxAttempts ?? 3) + ' 次尝试' },
                { key: 'cooldown', label: '失败冷却', children: (app.modelPool?.cooldownSeconds ?? 60) + ' 秒' }
              ]}
            />
          </Card>
        </Col>
      </Row>
      <Card title='回复门控调用' style={{ marginBottom: 20 }}>
        <Space wrap size='large'>
          <Typography.Text>
            尝试数：<strong>{data?.replyGateStatistics?.total ?? 0}</strong>
          </Typography.Text>
          <Typography.Text type='success'>成功：{data?.replyGateStatistics?.success ?? 0}</Typography.Text>
          <Typography.Text type='danger'>失败：{data?.replyGateStatistics?.failed ?? 0}</Typography.Text>
          <Typography.Text type='secondary'>包含池内、独立配置与自带 Key；成功表示响应有效，不代表允许回复</Typography.Text>
        </Space>
      </Card>
      <Card
        title='端点与额度'
        extra={<Input.Search aria-label='搜索轮转端点' placeholder='搜索端点、模型、账号' allowClear onChange={event => setFilter(event.target.value)} />}
      >
        <Table<Endpoint>
          loading={busy && !data}
          rowKey='id'
          pagination={false}
          onRow={row => ({ 'data-endpoint-id': row.id }) as React.HTMLAttributes<HTMLTableRowElement>}
          scroll={{ x: 1150 }}
          dataSource={endpoints.filter(row => [row.id, row.model, row.account, row.baseUrl].join(' ').toLowerCase().includes(filter.toLowerCase()))}
          locale={{ emptyText: <Empty description={endpoints.length ? '没有符合筛选条件的端点' : '添加端点，开始管理额度轮转'} /> }}
          expandable={{
            expandedRowRender: row => (
              <>
                <Descriptions
                  size='small'
                  column={{ xs: 1, sm: 3 }}
                  items={[
                    {
                      key: '1',
                      label: '用途',
                      children: row.capabilities
                        ?.map(value => ({ chat: '聊天', replyGate: '回复门控', tools: '工具', vision: '视觉' })[value] || value)
                        .join(' / ')
                    },
                    {
                      key: '2',
                      label: '主备 / 优先级',
                      children: (row.fallback ? '备用' : '主用') + ' / ' + (configured.findIndex(item => item.id === row.id) + 1)
                    },
                    { key: '3', label: '权重', children: row.weight ?? 1 },
                    { key: '4', label: '并发', children: row.active === undefined ? '无运行数据' : row.active + ' / ' + row.maxConcurrent },
                    { key: '5', label: '分钟请求', children: row.requests === undefined ? '无运行数据' : row.requests + ' / ' + (row.rpm ?? '不限') },
                    { key: '6', label: '分钟 Token', children: row.tokens === undefined ? '无运行数据' : row.tokens + ' / ' + (row.tpm ?? '不限') },
                    { key: '7', label: '进程今日尝试', children: row.dailyRequests ?? '无运行数据' },
                    { key: 'sent', label: '实际发送', children: row.lifecycle?.sent ?? 0 },
                    { key: 'blocked', label: '本地拦截', children: row.lifecycle?.blocked ?? 0 },
                    { key: 'cancelled', label: '取消', children: row.lifecycle?.cancelled ?? 0 }
                  ]}
                />
                <Table
                  size='small'
                  rowKey='id'
                  style={{ marginTop: 16 }}
                  dataSource={[...(row.lifecycle?.records || [])].reverse()}
                  pagination={{ pageSize: 5 }}
                  columns={[
                    { title: '时间', dataIndex: 'at', render: value => new Date(value).toLocaleString() },
                    {
                      title: '用途',
                      dataIndex: 'purpose',
                      render: value => ({ chat: '聊天', replyGate: '回复门控', tools: '工具', vision: '视觉' })[value as string] || value
                    },
                    { title: '尝试序号', dataIndex: 'attempt' },
                    { title: '已发送', dataIndex: 'sent', render: value => (value ? '是' : '否') },
                    {
                      title: '结果',
                      render: (_, record) =>
                        record.ok
                          ? '成功'
                          : {
                              'local-budget': '本地额度拦截',
                              cancelled: '取消',
                              timeout: '超时',
                              network: '网络异常',
                              'invalid-response': '响应无效',
                              'stream-error': '响应中断',
                              frozen: '冻结',
                              exhausted: '额度耗尽',
                              'rate-limited': '限流',
                              invalid: '凭证无效',
                              forbidden: '访问受限',
                              'server-error': '接口异常',
                              'request-error': '请求被拒绝'
                            }[record.reason] || '失败'
                    },
                    { title: 'HTTP', dataIndex: 'status' }
                  ]}
                />
              </>
            )
          }}
          columns={[
            {
              title: '顺序',
              width: 120,
              render: (_, row) => (
                <Space>
                  <EndpointDragHandle id={row.id} disabled={busy || Boolean(filter) || Boolean(drawer)} onMove={target => void reorder(row.id, target)} />
                  <span>{configured.findIndex(item => item.id === row.id) + 1}</span>
                  <Button
                    size='small'
                    disabled={busy || Boolean(drawer) || configured[0]?.id === row.id}
                    onClick={() => void reorder(row.id, configured[0]?.id)}
                  >
                    置顶
                  </Button>
                </Space>
              )
            },
            {
              title: '端点 / 请求地址',
              width: 300,
              render: (_, row) => (
                <Space orientation='vertical' size={2}>
                  <Typography.Text strong>{row.id}</Typography.Text>
                  <Typography.Text type='secondary'>
                    {row.provider} · {row.model}
                  </Typography.Text>
                  <Typography.Text copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {row.baseUrl || '未设置请求地址'}
                  </Typography.Text>
                  {row.account && <Tag>{row.account}</Tag>}
                </Space>
              )
            },
            {
              title: '额度',
              width: 190,
              filters: [
                { text: '未查询', value: 'unchecked' },
                { text: '余额偏低', value: 'low' },
                ...Object.entries(labels).map(([value, text]) => ({ value, text }))
              ],
              onFilter: (value, row) => {
                const balance = balances[row.id];
                if (!balance) return value === 'unchecked';
                if (value === 'low') return balanceState(balance) === '余额偏低';
                return (balance.status || 'unknown') === value;
              },
              render: (_, row) => {
                const balance = balances[row.id];
                return balance ? (
                  <Space orientation='vertical' size={2}>
                    <Typography.Text strong>{balance.text}</Typography.Text>
                    <Tag
                      color={balance.status === 'normal' && balanceState(balance) !== '余额偏低' ? 'green' : balance.status === 'failed' ? 'default' : 'orange'}
                    >
                      {balanceState(balance)}
                    </Tag>
                    <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                      {new Date(balance.checkedAt).toLocaleTimeString()}
                      {balance.httpStatus ? ' · HTTP ' + balance.httpStatus : ''}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type='secondary'>未查询</Typography.Text>
                );
              }
            },
            {
              title: '连通（自动更新）',
              width: 150,
              filters: [
                { text: '可连通', value: 'reachable' },
                { text: '连接失败', value: 'failed' },
                { text: '未检测', value: 'unchecked' }
              ],
              onFilter: (value, row) => value === (row.reachability === true ? 'reachable' : row.reachability === false ? 'failed' : 'unchecked'),
              render: (_, row) => (
                <Space orientation='vertical' size={2}>
                  <Badge
                    status={testing(row) ? 'processing' : row.reachability === true ? 'success' : row.reachability === false ? 'error' : 'default'}
                    text={testing(row) ? '检测中' : row.reachability === true ? '可连通' : row.reachability === false ? '连接失败' : '未检测'}
                  />
                  {row.observedStatus && <Typography.Text type='secondary'>HTTP {row.observedStatus}</Typography.Text>}
                  {row.observedAt && <Typography.Text type='secondary'>{new Date(row.observedAt).toLocaleTimeString()}</Typography.Text>}
                  {row.observationSource && (
                    <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                      {row.observationSource === 'call' ? '来自实际调用' : row.observationSource === 'health-check' ? '来自健康检查' : '来自测活'}
                    </Typography.Text>
                  )}
                </Space>
              )
            },
            {
              title: '参与轮转',
              width: 140,
              filters: [
                { text: '已启用', value: 'enabled' },
                { text: '已停用', value: 'disabled' }
              ],
              onFilter: (value, row) => (row.enabled !== false) === (value === 'enabled'),
              render: (_, row) => (
                <Space orientation='vertical' size={2}>
                  <Switch
                    aria-label={row.id + '参与轮转'}
                    checked={row.enabled !== false}
                    disabled={busy}
                    onChange={value => run(() => setEnabled(row, value))}
                  />
                  <Typography.Text type='secondary'>
                    {!data?.enabled
                      ? '轮转未启用'
                      : row.disabled
                        ? row.enabled === false
                          ? '已停用'
                          : '运行时停用'
                        : (row.cooldownUntil || 0) > (data?.sampledAt || 0)
                          ? '冷却中'
                          : row.active !== undefined && row.active >= (row.maxConcurrent || 1)
                            ? '并发满'
                            : '待调度'}
                  </Typography.Text>
                </Space>
              )
            },
            {
              title: '最近一次调用',
              width: 180,
              render: (_, row) => {
                const result = row.lastRequest;
                const names: Record<string, string> = {
                  success: '成功',
                  frozen: '账户冻结',
                  exhausted: '额度耗尽',
                  'rate-limited': '供应商限流',
                  invalid: '凭证无效',
                  forbidden: '访问受限',
                  'server-error': '接口异常',
                  'request-error': '请求被拒绝',
                  network: '网络异常',
                  'invalid-response': '响应无效',
                  'stream-error': '响应中断',
                  timeout: '请求超时',
                  cancelled: '已取消',
                  'local-budget': '本地额度保护拦截'
                };
                return result ? (
                  <Space orientation='vertical' size={2}>
                    {result.source === 'health-check' && <Typography.Text type='secondary'>手动健康检查</Typography.Text>}
                    <Tag color={result.ok ? 'green' : 'red'}>{names[result.reason] || '调用异常'}</Tag>
                    <Typography.Text type='secondary'>{new Date(result.at).toLocaleString()}</Typography.Text>
                    {result.status && <Typography.Text type='secondary'>HTTP {result.status}</Typography.Text>}
                    {result.latencyMs !== undefined && <Typography.Text type='secondary'>{Math.round(result.latencyMs)}ms</Typography.Text>}
                  </Space>
                ) : (
                  <Typography.Text type='secondary'>暂无调用记录</Typography.Text>
                );
              }
            },
            {
              title: '其中：门控尝试',
              width: 150,
              render: (_, row) => {
                const stat = row.purposeStatistics?.replyGate;
                return (
                  <Space orientation='vertical' size={0}>
                    <span>尝试数 {stat?.total ?? 0}</span>
                    <Typography.Text type='success'>成功 {stat?.success ?? 0}</Typography.Text>
                    <Typography.Text type={stat?.failed ? 'danger' : 'secondary'}>失败 {stat?.failed ?? 0}</Typography.Text>
                  </Space>
                );
              }
            },
            {
              title: '全部尝试（含门控）',
              width: 170,
              render: (_, row) => (
                <Space orientation='vertical' size={0}>
                  <span>尝试数 {row.totalCalls ?? 0}</span>
                  <Typography.Text type='secondary'>
                    未结算 {Math.max(0, (row.totalCalls ?? 0) - (row.successfulCalls ?? 0) - (row.failedCalls ?? 0))}
                  </Typography.Text>
                  <Typography.Text type='success'>成功 {row.successfulCalls ?? 0}</Typography.Text>
                  <Typography.Text type={row.failedCalls ? 'danger' : 'secondary'}>失败 {row.failedCalls ?? 0}</Typography.Text>
                  <Typography.Text type='secondary'>
                    成功率{' '}
                    {(row.successfulCalls || 0) + (row.failedCalls || 0)
                      ? (((row.successfulCalls || 0) / ((row.successfulCalls || 0) + (row.failedCalls || 0))) * 100).toFixed(1) + '%'
                      : '—'}
                  </Typography.Text>
                </Space>
              )
            },
            {
              title: '操作',
              fixed: 'right',
              width: 230,
              render: (_, row) => (
                <Space>
                  <Button size='small' disabled={busy} onClick={() => run(() => open('endpoint', row.id))}>
                    编辑
                  </Button>
                  <Button
                    size='small'
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await modal.confirm({
                          title: '检查此 Key 的模型调用能力？',
                          content: '将发送一次小型模型请求，可能消耗少量额度；不会更改启停状态。',
                          okText: '开始检查',
                          cancelText: '取消'
                        }))
                      )
                        return;
                      await run(async () => setData((await request('pool/action', { id: row.id, action: 'health-check' })).data));
                    }}
                  >
                    健康检查
                  </Button>
                  <Dropdown
                    menu={{
                      items: [
                        { key: 'probe', label: '测活' },
                        { key: 'balance', label: '查额度' },
                        { key: 'delete', label: '删除', danger: true }
                      ],
                      onClick: ({ key }) => {
                        if (key === 'delete') void remove(row);
                        else
                          void run(async () => {
                            if (key === 'balance') await lookup(row.id);
                            else setData((await request('pool/action', { id: row.id, action: 'probe' })).data);
                          });
                      }
                    }}
                  >
                    <Button size='small' icon={<MoreOutlined />} aria-label={row.id + '更多操作'} />
                  </Dropdown>
                </Space>
              )
            }
          ]}
        />
      </Card>
      <Modal
        title='智能识别端点'
        open={recognizing}
        confirmLoading={busy}
        okText='识别并填写'
        cancelText='取消'
        onCancel={() => {
          if (!busy) setRecognizing(false);
        }}
        onOk={() =>
          run(async () => {
            const result = await request('pool/recognize', { text: recognitionText });
            await open('endpoint');
            form.setFieldsValue(result.data);
            setDirty(true);
            setRecognizing(false);
            setRecognitionText('');
            message.success('已填写识别结果，请核对并补全后保存');
          })
        }
      >
        <Alert type='info' showIcon title='文本会发送给已配置的工作模型，可能包含 API Key。识别后请核对配置，再保存新增。' style={{ marginBottom: 16 }} />
        <Input.TextArea
          aria-label='待识别的端点资料'
          rows={8}
          maxLength={20000}
          showCount
          value={recognitionText}
          onChange={event => setRecognitionText(event.target.value)}
          placeholder='粘贴供应商提供的地址、Key、模型名称或配置说明'
        />
      </Modal>
      <Drawer
        title={drawer === 'endpoint' ? (editingId ? '编辑端点' : '新增端点') : drawer === 'rules' ? '轮转规则' : '本地额度保护'}
        open={Boolean(drawer)}
        size={680}
        onClose={async () => {
          if (dirty && !(await modal.confirm({ title: '放弃未保存的修改？' }))) return;
          setDirty(false);
          setDrawer(undefined);
        }}
        extra={
          <Button type='primary' loading={busy} onClick={save}>
            保存
          </Button>
        }
      >
        {error && <Alert type='error' title={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout='vertical' onValuesChange={() => setDirty(true)}>
          {drawer === 'endpoint' ? (
            <>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    name='id'
                    label='端点名称 / 编号'
                    rules={[{ required: true }, { pattern: /^[a-z][a-z0-9-]{0,39}$/, message: '小写字母开头，最多 40 位字母、数字或连字符' }]}
                  >
                    <Input disabled={Boolean(editingId)} placeholder='例如 primary-chat' />
                  </Form.Item>
                </Col>
              </Row>
              <ModelConnectionFields form={form} providers={configured.map(item => item.provider)} addresses={configured.map(item => item.baseUrl)} />
              <Form.Item name='account' label='账号分组'>
                <Input placeholder='同账号端点使用相同分组' />
              </Form.Item>
              <Form.Item name='capabilities' label='用途' rules={[{ required: true }]}>
                <Select
                  mode='multiple'
                  options={[
                    { value: 'chat', label: '聊天' },
                    { value: 'tools', label: '工具' },
                    { value: 'vision', label: '视觉' },
                    { value: 'replyGate', label: '回复门控' }
                  ]}
                />
              </Form.Item>
              <Space size='large'>
                <Form.Item name='enabled' label='参与轮转' valuePropName='checked'>
                  <Switch />
                </Form.Item>
                <Form.Item name='fallback' label='备用端点' valuePropName='checked'>
                  <Switch />
                </Form.Item>
              </Space>
              <Collapse
                items={[
                  {
                    key: 'advanced',
                    label: '轮转权重、限流与额度查询',
                    children: (
                      <>
                        <Row gutter={16}>
                          {[
                            { name: 'weight', label: '权重', min: 1, max: 100 },
                            { name: 'maxConcurrent', label: '并发上限', min: 1, max: 100 },
                            { name: 'rpm', label: '每分钟请求上限', min: 1, max: 1000000 },
                            { name: 'tpm', label: '每分钟 Token 上限', min: 1, max: 1000000000 }
                          ].map(item => (
                            <Col span={12} key={item.name}>
                              <Form.Item name={item.name} label={item.label}>
                                <InputNumber min={item.min} max={item.max} precision={0} style={{ width: '100%' }} />
                              </Form.Item>
                            </Col>
                          ))}
                        </Row>
                        <Form.Item name='balanceStyle' label='额度查询方式'>
                          <Select allowClear placeholder='按供应商或全局设置' options={[{ value: 'newapi', label: 'New API 已用额度' }]} />
                        </Form.Item>
                        <Form.Item
                          name='balanceUrl'
                          label='自定义额度查询地址'
                          rules={[
                            {
                              validator: async (_, value) => {
                                if (!value) return;
                                try {
                                  const url = new URL(value.replaceAll('{key}', 'test-key'));
                                  if (!value.includes('{key}') || url.protocol !== 'https:' || url.username || url.password || value.length > 1000)
                                    throw new Error();
                                } catch {
                                  throw new Error('请输入包含 {key} 占位符且不含用户名密码的 HTTPS 地址');
                                }
                              }
                            }
                          ]}
                        >
                          <Input placeholder='HTTPS 查询地址，可使用 {key} 占位符' />
                        </Form.Item>
                      </>
                    )
                  }
                ]}
              />
            </>
          ) : drawer === 'rules' ? (
            <>
              <Form.Item name='enabled' label='启用轮转' valuePropName='checked'>
                <Switch />
              </Form.Item>
              <Form.Item name='strategy' label='分配策略'>
                <Select allowClear placeholder='默认按权重轮转' options={strategies} />
              </Form.Item>
              <Row gutter={16}>
                {ruleFields.map(item => (
                  <Col span={12} key={item.name}>
                    <Form.Item name={item.name} label={item.label}>
                      <InputNumber min={item.min} max={item.max} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                ))}
              </Row>
            </>
          ) : (
            <>
              <Form.Item name='enabled' label='启用本地额度保护' valuePropName='checked'>
                <Switch />
              </Form.Item>
              <Row gutter={16}>
                {budgetFields.map(item => (
                  <Col span={12} key={item.name}>
                    <Form.Item name={item.name} label={item.label}>
                      <InputNumber min={0} max={10000} precision={4} placeholder={'默认 ' + item.default} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                ))}
              </Row>
              <Form.Item name='maxOutputTokens' label='单次最大输出 Token'>
                <InputNumber min={1} max={8192} precision={0} />
              </Form.Item>
            </>
          )}
        </Form>
      </Drawer>
    </Layout.Content>
  );
}
