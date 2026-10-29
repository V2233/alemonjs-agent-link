import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  App,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography
} from 'antd';
import { parseDocument } from 'yaml';
import AddConfig from './AddConfig';

type Endpoint = {
  id: string;
  provider: string;
  model: string;
  account?: string;
  active: number;
  maxConcurrent: number;
  requests: number;
  tokens: number;
  dailyRequests: number;
  dailyTokens: number;
  disabled: boolean;
  disabledUntil: number;
  cooldownUntil: number;
  healthy?: boolean;
  capabilities: string[];
  weight: number;
  priority: number;
  fallback: boolean;
  lastStatus?: number;
  latencyMs: number;
  rpm?: number;
  tpm?: number;
};
type Snapshot = {
  sampledAt: number;
  enabled: boolean;
  strategy?: string;
  balanceAlertYuan?: number;
  endpoints: Endpoint[];
  bridge?: { date: string; endpoints: Record<string, { requests: number; input: number; output: number }> } | null;
  budget: { enabled?: boolean; globalDailyYuan?: number; personalDailyYuan?: number; replyGateDailyYuan?: number };
};
type Balance = { text: string; amount?: number; currency?: string; checkedAt: number };
const root = 'alemonjs-agent-link';
const strategies = [
  { value: 'balanced', label: '均衡分配' },
  { value: 'weighted-round-robin', label: '按权重轮转' },
  { value: 'least-busy', label: '优先空闲' },
  { value: 'sticky', label: '会话粘性' }
];
const ruleFields = [
  { name: 'maxAttempts', label: '最大尝试次数', min: 1, max: 20 },
  { name: 'failureThreshold', label: '连续失败阈值', min: 1, max: 100 },
  { name: 'cooldownSeconds', label: '冷却秒数', min: 1, max: 86400 },
  { name: 'queueMaxWaitMs', label: '主端点排队毫秒', min: 0, max: 30000 },
  { name: 'retryBudgetMs', label: '重试时间预算（毫秒）', min: 1000, max: 300000 },
  { name: 'balanceAlertYuan', label: '余额提醒阈值（元）', min: 0 }
];
export default function PoolPage() {
  const { message, modal } = App.useApp();
  const [token, setToken] = useState('');
  const [data, setData] = useState<Snapshot>();
  const [balances, setBalances] = useState<Record<string, Balance>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [source, setSource] = useState('');
  const [baseline, setBaseline] = useState('');
  const [revision, setRevision] = useState('');
  const [filter, setFilter] = useState('');
  const [form] = Form.useForm();
  const [endpointForm] = Form.useForm();
  const [editing, setEditing] = useState<number>();
  const [rulesDirty, setRulesDirty] = useState(false);
  const pending = useRef(false);
  const request = async (path: string, body?: unknown) => {
    const response = await fetch('./api/admin/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json().catch(() => {
      throw new Error('管理接口不可用，请检查服务地址');
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
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    setData((await request('pool')).data);
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (source !== baseline || rulesDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [source, baseline, rulesDirty]);
  const update = (path: (string | number)[], value: unknown) => {
    const doc = parseDocument(source);
    doc.setIn(path, value);
    setSource(doc.toString());
  };
  const openSettings = async () => {
    const result = await request('config');
    setSource(result.data.source);
    setBaseline(result.data.source);
    setRevision(result.data.revision);
    const pool = parseDocument(result.data.source).toJS()?.[root]?.modelPool || {};
    form.resetFields();
    form.setFieldsValue(pool);
    setRulesDirty(false);
    setSettings(true);
  };
  const state = (row: Endpoint) =>
    row.disabled
      ? '已停用'
      : row.cooldownUntil > (data?.sampledAt || 0)
        ? '冷却中'
        : row.active >= row.maxConcurrent
          ? '并发已满'
          : row.healthy === false
            ? '检测异常'
            : '待调度';
  const action = async (row: Endpoint, action: string) => {
    if (
      !(await modal.confirm({
        title: action === 'probe' ? '执行轻量测活？' : action === 'disable' ? '暂停此端点？' : '恢复此端点？',
        content: action === 'probe' ? '仅检查模型列表接口，不验证聊天额度。' : '仅影响本次运行，持久配置在轮转设置中修改。'
      }))
    )
      return;
    await run(async () => {
      setData((await request('pool/action', { id: row.id, action })).data);
      message.success('操作完成');
    });
  };
  const endpoints =
    data?.endpoints.filter(row => [row.id, row.model, row.provider, row.account || ''].join(' ').toLowerCase().includes(filter.toLowerCase())) || [];
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Content style={{ width: '100%', maxWidth: 1440, margin: 'auto', padding: 24 }}>
        <Flex justify='space-between' align='center' wrap gap={16}>
          <Space>
            <Link to='/manage'>配置中心</Link>
            <Typography.Title level={2} style={{ margin: 0 }}>
              额度轮转
            </Typography.Title>
          </Space>
          <Space wrap>
            <Input.Password
              aria-label='轮转管理令牌'
              placeholder='管理令牌'
              value={token}
              disabled={busy}
              onChange={e => {
                setToken(e.target.value);
                setData(undefined);
                setBalances({});
              }}
            />
            <Button type='primary' disabled={!token || busy} loading={busy} onClick={() => run(refresh)}>
              读取状态
            </Button>
          </Space>
        </Flex>
        {error && <Alert type='error' showIcon title={error} style={{ marginTop: 16 }} />}
        {data ? (
          <>
            <Flex wrap gap={12} align='center' style={{ margin: '20px 0' }}>
              <Badge status={data.enabled ? 'success' : 'default'} text={data.enabled ? '轮转已启用' : '使用单 Key'} />
              <Tag>{strategies.find(item => item.value === data.strategy)?.label || '未配置轮转策略'}</Tag>
              <Typography.Text type='secondary'>{new Date(data.sampledAt).toLocaleTimeString()} 采样</Typography.Text>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setBalances((await request('pool/balances', {})).data);
                  })
                }
              >
                查询余额
              </Button>
              <Button disabled={busy} onClick={() => run(openSettings)}>
                轮转设置与端点
              </Button>
            </Flex>
            <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
              {[
                { title: '端点', value: data.endpoints.length },
                { title: '冷却中', value: data.endpoints.filter(row => !row.disabled && row.cooldownUntil > data.sampledAt).length },
                { title: '执行中', value: data.endpoints.reduce((sum, row) => sum + row.active, 0) },
                { title: '今日请求 · 当前进程', value: data.endpoints.reduce((sum, row) => sum + row.dailyRequests, 0) }
              ].map(item => (
                <Col xs={12} md={6} key={item.title}>
                  <Card>
                    <Statistic {...item} />
                  </Card>
                </Col>
              ))}
            </Row>
            <Card
              title='端点调度'
              extra={<Input.Search aria-label='搜索轮转端点' placeholder='搜索端点、模型或账号' allowClear onChange={e => setFilter(e.target.value)} />}
            >
              <Table
                rowKey='id'
                scroll={{ x: 1250 }}
                dataSource={endpoints}
                locale={{ emptyText: <Empty description='暂无轮转端点' /> }}
                columns={[
                  {
                    title: '端点',
                    dataIndex: 'id',
                    fixed: 'left',
                    width: 180,
                    render: (_, row) => (
                      <Space orientation='vertical' size={0}>
                        <Typography.Text strong>{row.id}</Typography.Text>
                        <Typography.Text type='secondary'>{row.model}</Typography.Text>
                        {row.account && <Tag>{row.account}</Tag>}
                        <Space>
                          <Tag>{row.fallback ? '备用' : '主用'}</Tag>
                          <Tag>优先级 {row.priority}</Tag>
                        </Space>
                      </Space>
                    )
                  },
                  {
                    title: '状态',
                    width: 160,
                    render: (_, row) => (
                      <Space orientation='vertical' size={0}>
                        <Tag color={row.disabled ? 'default' : row.cooldownUntil > data.sampledAt ? 'orange' : row.healthy === false ? 'red' : 'blue'}>
                          {state(row)}
                        </Tag>
                        {row.cooldownUntil > data.sampledAt && (
                          <Typography.Text type='secondary'>至 {new Date(row.cooldownUntil).toLocaleTimeString()}</Typography.Text>
                        )}
                        <Typography.Text type='secondary'>
                          {row.lastStatus ? 'HTTP ' + row.lastStatus : '未检测'}
                          {row.latencyMs > 0 ? ' · ' + row.latencyMs + 'ms' : ''}
                        </Typography.Text>
                      </Space>
                    )
                  },
                  {
                    title: '供应商余额',
                    width: 160,
                    render: (_, row) => {
                      const balance = balances[row.id];
                      return balance ? (
                        <Space orientation='vertical' size={0}>
                          <Typography.Text
                            type={
                              balance.amount !== undefined && balance.currency === 'CNY' && balance.amount < (data.balanceAlertYuan ?? 0) ? 'danger' : undefined
                            }
                          >
                            {balance.text}
                          </Typography.Text>
                          <Typography.Text type='secondary'>{new Date(balance.checkedAt).toLocaleTimeString()}</Typography.Text>
                        </Space>
                      ) : (
                        '未查询'
                      );
                    }
                  },
                  {
                    title: '并发 / 分钟限流',
                    width: 170,
                    render: (_, row) => (
                      <Space orientation='vertical' size={0}>
                        <span>
                          {row.active} / {row.maxConcurrent} 并发
                        </span>
                        <span>
                          {row.requests} / {row.rpm ?? '∞'} RPM
                        </span>
                        <span>
                          {row.tokens} / {row.tpm ?? '∞'} TPM
                        </span>
                      </Space>
                    )
                  },
                  {
                    title: '用量',
                    width: 170,
                    render: (_, row) => (
                      <Space orientation='vertical' size={0}>
                        <span>进程今日 {row.dailyRequests} 次</span>
                        <span>{row.dailyTokens.toLocaleString()} Token</span>
                        {data.bridge && (
                          <Typography.Text type='secondary'>
                            沙箱 {data.bridge.date}：{data.bridge.endpoints[row.id]?.requests ?? 0} 次
                          </Typography.Text>
                        )}
                      </Space>
                    )
                  },
                  {
                    title: '用途 / 权重',
                    width: 160,
                    render: (_, row) => (
                      <Space orientation='vertical' size={0}>
                        <span>{row.capabilities.join(' / ')}</span>
                        <span>权重 {row.weight}</span>
                      </Space>
                    )
                  },
                  {
                    title: '操作',
                    width: 140,
                    render: (_, row) => (
                      <Space orientation='vertical'>
                        <Button size='small' disabled={busy} onClick={() => action(row, row.disabled ? 'enable' : 'disable')}>
                          {row.disabled ? '恢复' : '暂停'}
                        </Button>
                        <Button size='small' disabled={busy} onClick={() => action(row, 'probe')}>
                          轻量测活
                        </Button>
                      </Space>
                    )
                  }
                ]}
              />
            </Card>
            <Card title='本地预算保护' style={{ marginTop: 20 }}>
              <Space wrap>
                <Tag color={data.budget.enabled ? 'green' : 'default'}>{data.budget.enabled ? '已启用' : '未启用'}</Tag>
                <Typography.Text>全局每日：{data.budget.globalDailyYuan || '不限'} 元</Typography.Text>
                <Typography.Text>个人每日：{data.budget.personalDailyYuan ?? '默认'} 元</Typography.Text>
                <Typography.Text>回复门控每日：{data.budget.replyGateDailyYuan ?? '默认'} 元</Typography.Text>
              </Space>
            </Card>
          </>
        ) : (
          <Empty style={{ marginTop: 80 }} description='输入管理令牌，读取额度轮转状态' />
        )}
        <Drawer
          title='轮转设置与端点'
          open={settings}
          size={720}
          onClose={async () => {
            if ((source !== baseline || rulesDirty) && !(await modal.confirm({ title: '放弃尚未保存的修改？' }))) return;
            setSettings(false);
          }}
          extra={
            <Button
              type='primary'
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const values = await form.validateFields();
                  const doc = parseDocument(source);
                  for (const [key, value] of Object.entries(values)) {
                    if (value === undefined || value === null) doc.deleteIn([root, 'modelPool', key]);
                    else doc.setIn([root, 'modelPool', key], value);
                  }
                  await request('validate', { source: doc.toString(), revision });
                  if (!(await modal.confirm({ title: '保存轮转配置？', content: '保存前自动备份，将重载模型池。' }))) return;
                  const result = await request('config', { source: doc.toString(), revision });
                  setSource(result.data.source);
                  setBaseline(result.data.source);
                  setRevision(result.data.revision);
                  setSettings(false);
                  setRulesDirty(false);
                  message.success(result.message);
                  await refresh();
                })
              }
            >
              校验并保存
            </Button>
          }
        >
          <Form form={form} layout='vertical' onValuesChange={() => setRulesDirty(true)}>
            <Form.Item name='enabled' label='启用额度轮转' valuePropName='checked'>
              <Switch />
            </Form.Item>
            <Form.Item name='strategy' label='分配策略'>
              <Select allowClear placeholder='使用服务端默认策略' options={strategies} />
            </Form.Item>
            <Row gutter={16}>
              {ruleFields.map(field => (
                <Col xs={24} sm={12} key={field.name}>
                  <Form.Item name={field.name} label={field.label}>
                    <InputNumber min={field.min} max={field.max} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </Form>
          {source && (
            <>
              <AddConfig
                source={source}
                has={path => parseDocument(source).hasIn(path)}
                add={(path, value) => {
                  if (path[path.length - 1] === 'endpoints') {
                    const doc = parseDocument(source);
                    const entries = doc.toJS()?.[root]?.modelPool?.endpoints || [];
                    if (entries.some((item: { id: string }) => item.id === (value as { id: string }).id)) {
                      message.error('端点 ID 已存在');
                      return false;
                    }
                    update(path, [...entries, value]);
                  } else update(path, value);
                  return true;
                }}
              />
              <Table
                style={{ marginTop: 16 }}
                rowKey='index'
                dataSource={(parseDocument(source).toJS()?.[root]?.modelPool?.endpoints || []).map(
                  (item: { id: string; model: string; enabled?: boolean }, index: number) => ({ ...item, index })
                )}
                columns={[
                  { title: '端点', dataIndex: 'id' },
                  { title: '模型', dataIndex: 'model' },
                  {
                    title: '持久启用',
                    render: (_, row) => (
                      <Switch checked={row.enabled !== false} onChange={value => update([root, 'modelPool', 'endpoints', row.index, 'enabled'], value)} />
                    )
                  },
                  {
                    title: '编辑',
                    render: (_, row) => (
                      <Button
                        onClick={() => {
                          setEditing(row.index);
                          endpointForm.resetFields();
                          endpointForm.setFieldsValue(parseDocument(source).toJS()[root].modelPool.endpoints[row.index]);
                        }}
                      >
                        编辑
                      </Button>
                    )
                  },
                  {
                    title: '操作',
                    render: (_, row) => (
                      <Button
                        danger
                        onClick={() =>
                          modal.confirm({
                            title: '删除端点 ' + row.id + '？',
                            onOk: () => {
                              const doc = parseDocument(source);
                              doc.deleteIn([root, 'modelPool', 'endpoints', row.index]);
                              setSource(doc.toString());
                            }
                          })
                        }
                      >
                        删除
                      </Button>
                    )
                  }
                ]}
                pagination={false}
              />
            </>
          )}
        </Drawer>
        <Drawer
          title='编辑端点'
          open={editing !== undefined}
          onClose={() => setEditing(undefined)}
          extra={
            <Button
              type='primary'
              onClick={async () => {
                try {
                  const values = await endpointForm.validateFields();
                  const doc = parseDocument(source);
                  const path = [root, 'modelPool', 'endpoints', editing!];
                  const previous = doc.getIn(path);
                  const original = previous && typeof previous === 'object' && 'toJSON' in previous ? (previous as { toJSON: () => object }).toJSON() : {};
                  update(path, { ...original, ...values });
                  setEditing(undefined);
                } catch {
                  /* Form shows errors */
                }
              }}
            >
              更新草稿
            </Button>
          }
        >
          <Form form={endpointForm} layout='vertical'>
            {['id', 'provider', 'model', 'baseUrl', 'apiKey', 'account'].map(name => (
              <Form.Item key={name} name={name} label={name} rules={name === 'account' ? [] : [{ required: true }]}>
                {name === 'apiKey' ? <Input.Password /> : <Input />}
              </Form.Item>
            ))}
            <Form.Item name='capabilities' label='用途' rules={[{ required: true }]}>
              <Select mode='multiple' options={['chat', 'tools', 'vision', 'replyGate'].map(value => ({ value, label: value }))} />
            </Form.Item>
            {['priority', 'weight', 'maxConcurrent', 'rpm', 'tpm'].map(name => (
              <Form.Item key={name} name={name} label={name}>
                <InputNumber min={name === 'priority' ? 0 : 1} precision={0} />
              </Form.Item>
            ))}
            <Form.Item name='fallback' label='备用端点' valuePropName='checked'>
              <Switch />
            </Form.Item>
          </Form>
        </Drawer>
      </Layout.Content>
    </Layout>
  );
}
