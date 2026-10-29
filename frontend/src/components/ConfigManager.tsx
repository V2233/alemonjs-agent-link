import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  Select,
  Layout,
  Menu,
  Row,
  Space,
  Popover,
  Switch,
  Table,
  Tag,
  Typography,
  Upload
} from 'antd';
import {
  ApiOutlined,
  RobotOutlined,
  MessageOutlined,
  WalletOutlined,
  AppstoreOutlined,
  PictureOutlined,
  SettingOutlined,
  UploadOutlined,
  DownloadOutlined,
  SearchOutlined,
  UndoOutlined,
  DeleteOutlined,
  PlusOutlined,
  MenuOutlined,
  QuestionCircleOutlined,
  FileOutlined
} from '@ant-design/icons';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import schema from './config-schema.json';
import OnlineConfig from './OnlineConfig';
import AddConfig from './AddConfig';
import example from '../../../alemon.config.example.yaml?raw';
import './config-manager.css';

type Path = (string | number)[];
type Field = { path: Path; value: string | number | boolean | null; description: string; array?: boolean; object?: boolean };
const agent = 'alemonjs-agent-link';
const groups = [
  ['model', '模型连接', '模型、服务提供商与访问凭证', '◈'],
  ['platform', '平台与权限', 'QQ、OneBot 连接和机器人身份', '◎'],
  ['chat', '聊天行为', '人设、唤醒词与上下文记忆', '◌'],
  ['budget', '用量与预算', '配置请求额度和费用限制', '◇'],
  ['modules', '扩展能力', '按需调整 Agent 的工具与模块', '⊞'],
  ['media', '媒体与语音', '图片、表情和语音处理', '▧'],
  ['runtime', '运行参数', '并发、超时与数据保留', '⚙']
];
const labels: Record<string, string> = {
  apiKey: 'API 密钥',
  model: '默认模型',
  provider: '模型提供商',
  baseUrl: '服务地址',
  profile: '模型配置档',
  transport: '接入平台',
  runtimeMode: '运行模式',
  aiEnabled: 'AI 总开关',
  persona: '默认人设',
  privateChatAccess: '私聊权限',
  privateAutoReply: '私聊自动回复',
  groupWakeNames: '群聊唤醒词',
  maxMessageLength: '单条回复最大长度',
  bubbleDelayMs: '分条回复间隔',
  requestTimeoutMs: '请求超时',
  maxConcurrentRequests: '全局并发请求',
  maxQueuedPerGroup: '每群排队上限',
  app_id: '机器人 AppID',
  secret: '机器人密钥',
  selfId: '机器人账号',
  accessToken: '访问令牌',
  master_id: '主人账号',
  bot_id: '机器人账号',
  enabled: '启用',
  defaultSystemPrompt: '系统提示词'
};
function displayValue(field?: Field) {
  if (!field) return '未配置';
  if (field.path.some(key => /key|secret|password|token|authorization/i.test(String(key))) || String(field.value).includes('__AGENTLINK_KEEP_SECRET__'))
    return '••••••（已隐藏）';
  return field.value === null ? 'null' : String(field.value);
}
function groupOf(path: Path) {
  if (path[0] !== agent) return 'platform';
  const key = String(path[1]);
  if (/^(apiKey|model|provider|profile|baseUrl|modelPool)/i.test(key)) return 'model';
  if (key === 'transport') return 'platform';
  if (key === 'budget') return 'budget';
  if (key === 'modules') return 'modules';
  if (key === 'media') return 'media';
  if (/persona|private|group|recentChat|aiEnabled|aiDisabled|Prompt/i.test(key)) return 'chat';
  return 'runtime';
}
function fieldsOf(source: string): Field[] {
  const fields: Field[] = [];
  const walk = (node: any, path: Path, description = '') => {
    if (isMap(node) && ((path.length === 4 && path[2] === 'endpoints') || (path.length === 4 && path[2] === 'overrides')))
      fields.push({ path, value: null, description: '对象配置', object: true });
    if (isMap(node)) node.items.forEach((item: any) => walk(item.value, [...path, String(item.key.value)], item.key.commentBefore || ''));
    else if (isSeq(node)) {
      fields.push({ path, value: null, description, array: true });
      node.items.forEach((item, index) => walk(item, [...path, index]));
    } else if (isScalar(node))
      fields.push({
        path,
        value: node.value as Field['value'],
        description: [description, node.commentBefore, node.comment].filter(Boolean).join('\n').trim()
      });
  };
  walk(parseDocument(source).contents, []);
  return fields;
}
function Editor({ field, change, remove }: { field: Field; change: (value: unknown) => void; remove: () => void }) {
  const name = String(field.path[field.path.length - 1]);
  const title = labels[name] || (typeof field.path[field.path.length - 1] === 'number' ? `条目 ${Number(name) + 1}` : name);
  const id = JSON.stringify(field.path);
  const enums: Record<string, string[]> = {
    transport: ['qq-bot', 'onebot'],
    runtimeMode: ['auto', 'sandbox', 'chat-only'],
    persona: ['assistant', 'dafeiyu'],
    privateChatAccess: ['owner', 'all'],
    stateBackend: ['local', 'redis'],
    activity: ['quiet', 'balanced', 'active'],
    strategy: ['weighted-round-robin', 'least-busy', 'balanced', 'sticky']
  };
  const range = (schema.ranges as Record<string, number[]>)[name];
  const secret = /key|secret|token|password/i.test(name);
  return (
    <Row gutter={[24, 12]} className='config-field-row'>
      <Col xs={24} md={12}>
        <Typography.Text strong>
          <label htmlFor={id}>{title}</label>
        </Typography.Text>
        <Popover
          title={title}
          content={<div style={{ maxWidth: 360, whiteSpace: 'pre-wrap' }}>{field.description || field.path.join(' / ')}</div>}
          trigger={['click']}
        >
          <Button type='text' size='small' icon={<QuestionCircleOutlined />} aria-label={title + '帮助'} />
        </Popover>
      </Col>
      <Col xs={24} md={12}>
        <Form.Item style={{ marginBottom: 0 }}>
          {enums[name] ? (
            <Select id={id} aria-label={title} value={String(field.value)} options={enums[name].map(value => ({ value, label: value }))} onChange={change} />
          ) : typeof field.value === 'boolean' ? (
            <Switch id={id} aria-label={title} checked={field.value} checkedChildren='开启' unCheckedChildren='关闭' onChange={change} />
          ) : typeof field.value === 'number' ? (
            <InputNumber
              id={id}
              aria-label={title}
              style={{ width: '100%' }}
              min={range?.[0]}
              max={range?.[1]}
              precision={range ? 0 : undefined}
              value={field.value}
              onChange={value => {
                if (value !== null && Number.isFinite(value)) change(value);
              }}
              onBlur={event => {
                if (!event.target.value.trim()) event.target.value = String(field.value);
              }}
            />
          ) : secret ? (
            <Input.Password id={id} aria-label={title} autoComplete='off' value={String(field.value ?? '')} onChange={e => change(e.target.value)} />
          ) : /prompt/i.test(name) || String(field.value).includes('\n') ? (
            <Input.TextArea
              id={id}
              aria-label={title}
              autoSize={{ minRows: 4, maxRows: 12 }}
              value={String(field.value ?? '')}
              onChange={e => change(e.target.value)}
            />
          ) : (
            <Input id={id} aria-label={title} value={String(field.value ?? '')} onChange={e => change(e.target.value)} />
          )}
        </Form.Item>
        {
          <Button danger type='text' size='small' icon={<DeleteOutlined />} onClick={remove}>
            {typeof field.path[field.path.length - 1] === 'number' ? '删除条目' : '移除配置'}
          </Button>
        }
      </Col>
    </Row>
  );
}
export default function ConfigManager() {
  const { modal, message: toast } = App.useApp();
  const screens = Grid.useBreakpoint();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState(example);
  const [baseline, setBaseline] = useState(example);
  const [history, setHistory] = useState<string[]>([]);
  const [filename, setFilename] = useState('示例配置');
  const [section, setSection] = useState('model');
  const [search, setSearch] = useState('');
  const [review, setReview] = useState(false);
  const fields = useMemo(() => fieldsOf(source), [source]);
  const original = useMemo(() => fieldsOf(baseline), [baseline]);
  const changed = fields.filter(f => !f.array && !f.object && !original.some(o => JSON.stringify(o.path) === JSON.stringify(f.path) && o.value === f.value));
  const removed = original.filter(o => !o.array && !o.object && !fields.some(f => JSON.stringify(f.path) === JSON.stringify(o.path)));
  const dirty = source !== baseline;
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
  const update = (path: Path, value: unknown, remove = false) => {
    const doc = parseDocument(source);
    if (remove) doc.deleteIn(path);
    else doc.setIn(path, value);
    setHistory(old => [...old.slice(-49), source]);
    setSource(doc.toString());
  };
  const visible = fields.filter(f =>
    search
      ? `${f.path.join('.')} ${labels[String(f.path[f.path.length - 1])] || ''} ${f.description}`.toLowerCase().includes(search.toLowerCase())
      : groupOf(f.path) === section
  );
  const issues = fields.flatMap(field => {
    const key = String(field.path[1]);
    if (field.path[0] !== agent || field.path.length !== 2) return [];
    const range = (schema.ranges as Record<string, number[]>)[key];
    if (range && (!Number.isSafeInteger(field.value) || Number(field.value) < range[0] || Number(field.value) > range[1]))
      return [key + ' 需要 ' + range.join('–') + ' 范围内的整数'];
    if (key === 'baseUrl' && field.value) {
      try {
        const url = new URL(String(field.value));
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
      } catch {
        return ['baseUrl 需要不含凭证、查询参数的 HTTPS 地址'];
      }
    }
    return [];
  });
  const current = groups.find(g => g[0] === section)!;
  const icons = [<ApiOutlined />, <RobotOutlined />, <MessageOutlined />, <WalletOutlined />, <AppstoreOutlined />, <PictureOutlined />, <SettingOutlined />];
  const navigation = (
    <Menu
      mode='inline'
      selectedKeys={search ? [] : [section]}
      items={groups.map(([key, title], index) => ({
        key,
        icon: icons[index],
        label: (
          <Flex justify='space-between' align='center'>
            {title}
            <Typography.Text type='secondary'>{fields.filter(f => !f.array && !f.object && groupOf(f.path) === key).length}</Typography.Text>
          </Flex>
        )
      }))}
      onClick={({ key }) => {
        setSection(key);
        setSearch('');
        setNavigationOpen(false);
      }}
    />
  );
  const importFile = async (file: File) => {
    if (dirty && !(await modal.confirm({ title: '替换当前配置？', content: '导入将替换尚未导出的修改。', okText: '继续导入', cancelText: '取消' })))
      return Upload.LIST_IGNORE;
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseDocument(text);
      if (parsed.errors.length || !isMap(parsed.contents)) throw new Error('invalid');
      parsed.toJS({ maxAliasCount: 100 });
      setSource(text);
      setBaseline(text);
      setHistory([]);
      setFilename(file.name);

      toast.success('配置导入成功');
    } catch {
      toast.error('导入失败：请检查 YAML 格式和顶层结构，当前配置未改变。');
    } finally {
      setImporting(false);
    }
    return Upload.LIST_IGNORE;
  };
  const exportFile = () => {
    if (issues.length) {
      toast.error(issues[0]);
      return;
    }
    if (source.includes('__AGENTLINK_KEEP_SECRET__')) {
      toast.warning('在线配置含脱敏凭证，请使用在线保存；不能将占位符导出为运行配置。');
      return;
    }
    const url = URL.createObjectURL(new Blob([source], { type: 'application/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alemon.config.yaml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBaseline(source);
    setHistory([]);

    toast.success('配置文件已生成');
  };
  return (
    <Layout className='config-shell'>
      {screens.lg && (
        <Layout.Sider width={248} theme='light' className='config-sider'>
          <Flex align='center' gap={12} className='config-brand'>
            <Avatar shape='square' style={{ background: '#6558dd' }} icon={<RobotOutlined />} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              AgentLink
            </Typography.Title>
          </Flex>
          {navigation}
          <Typography.Paragraph type='secondary' className='sidebar-note'>
            <Typography.Link href='https://github.com/xiuxianjs/agent-link' target='_blank' rel='noreferrer'>
              项目文档
            </Typography.Link>
          </Typography.Paragraph>
        </Layout.Sider>
      )}
      <Drawer title='配置中心' placement='left' open={navigationOpen} onClose={() => setNavigationOpen(false)}>
        {navigation}
      </Drawer>
      <Layout>
        <Layout.Header className='config-header'>
          <Flex justify='space-between' align='center' gap={12}>
            <Space>
              {!screens.lg && <Button icon={<MenuOutlined />} aria-label='打开配置导航' onClick={() => setNavigationOpen(true)} />}
              <Breadcrumb items={[{ title: '工作台' }, { title: '配置中心' }]} />
            </Space>
            <Tag icon={<FileOutlined />} color='purple'>
              文件编辑模式
            </Tag>
          </Flex>
        </Layout.Header>
        <Layout.Content className='config-content'>
          <Flex justify='space-between' align='center' wrap gap={16}>
            <div>
              <Typography.Title level={2}>机器人配置</Typography.Title>
            </div>
            <Space wrap>
              <Button href='#/rotation'>额度轮转</Button>
              <OnlineConfig
                source={source}
                dirty={dirty}
                onLoad={data => {
                  setSource(data.source);
                  setBaseline(data.source);
                  setHistory([]);
                  setFilename('在线配置');
                }}
              />
              <AddConfig
                source={source}
                has={path => parseDocument(source).hasIn(path)}
                add={(path, value) => {
                  if (path[path.length - 1] === 'endpoints') {
                    const doc = parseDocument(source);
                    const existing = doc.getIn(path);
                    const entries = isSeq(existing) ? existing.toJSON() : [];
                    if (entries.some((item: { id: string }) => item.id === (value as { id: string }).id)) {
                      toast.error('端点 ID 已存在');
                      return false;
                    }
                    update(path, [...entries, value]);
                  } else update(path, value);
                  return true;
                }}
              />
              <Upload accept='.yaml,.yml' showUploadList={false} beforeUpload={importFile} disabled={importing}>
                <Button loading={importing} icon={<UploadOutlined />}>
                  导入配置
                </Button>
              </Upload>
              <Button type='primary' icon={<DownloadOutlined />} onClick={exportFile}>
                导出配置
              </Button>
            </Space>
          </Flex>
          <Flex align='center' gap={12} className='config-file-row'>
            <Tag>{filename}</Tag>
            <Typography.Text type='secondary'>{fields.filter(f => !f.array && !f.object).length} 项配置</Typography.Text>
            <Button type='link' onClick={() => setReview(true)}>
              查看变更{changed.length + removed.length > 0 ? `（${changed.length + removed.length}）` : ''}
            </Button>
          </Flex>
          {issues.length > 0 && <Alert type='error' showIcon title='配置存在问题' description={issues.join('；')} style={{ marginBottom: 16 }} />}
          <Flex justify='space-between' align='center' wrap gap={16} className='config-toolbar'>
            <div>
              <Typography.Title level={4}>{search ? '搜索结果' : current[1]}</Typography.Title>
              {search && <Typography.Text type='secondary'>{visible.length} 项</Typography.Text>}
            </div>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              className='config-search'
              aria-label='搜索配置'
              placeholder='搜索全部配置项…'
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </Flex>
          <Card styles={{ body: { padding: 0 } }}>
            <Form layout='vertical' component={false}>
              {visible.length ? (
                visible.map(field =>
                  field.object ? (
                    <Flex key={JSON.stringify(field.path)} className='config-array-heading' justify='space-between'>
                      <Typography.Text strong>{field.path.join(' / ')}</Typography.Text>
                      <Button danger onClick={() => modal.confirm({ title: '删除此对象及全部配置？', onOk: () => update(field.path, undefined, true) })}>
                        删除对象
                      </Button>
                    </Flex>
                  ) : field.array ? (
                    <Flex key={JSON.stringify(field.path)} justify='space-between' align='center' gap={16} className='config-array-heading'>
                      <div>
                        <Typography.Text strong>{labels[String(field.path[field.path.length - 1])] || field.path.join(' / ')}</Typography.Text>
                        {field.description && (
                          <Popover content={<div style={{ maxWidth: 360, whiteSpace: 'pre-wrap' }}>{field.description}</div>} trigger={['click']}>
                            <Button type='text' size='small' icon={<QuestionCircleOutlined />} aria-label='列表帮助' />
                          </Popover>
                        )}
                      </div>
                      <Button
                        icon={<PlusOutlined />}
                        onClick={() => {
                          const doc = parseDocument(source);
                          const values = doc.getIn(field.path);
                          if (isSeq(values)) {
                            const items = values.toJSON();
                            if (items.some((item: unknown) => item && typeof item === 'object')) {
                              toast.info('对象列表请使用「添加配置」中的模型池端点表单');
                              return;
                            }
                            update(field.path, [...items, typeof items[0] === 'number' ? 0 : typeof items[0] === 'boolean' ? false : '']);
                          }
                        }}
                      >
                        添加条目
                      </Button>
                    </Flex>
                  ) : (
                    <Editor
                      key={JSON.stringify(field.path)}
                      field={field}
                      change={value => update(field.path, value)}
                      remove={() => update(field.path, undefined, true)}
                    />
                  )
                )
              ) : (
                <Empty className='config-empty' description={search ? '没有找到匹配配置，请尝试其他关键词' : '当前文件未配置此分组'} />
              )}
            </Form>
          </Card>
          <Card className='config-footer' size='small'>
            <Flex justify='space-between' align='center' wrap gap={12}>
              <Badge status={dirty ? 'warning' : 'success'} text={dirty ? '存在未导出的修改' : '配置内容与导出基线一致'} />
              <Space wrap>
                <Button
                  disabled={!history.length}
                  icon={<UndoOutlined />}
                  onClick={() => {
                    setSource(history[history.length - 1]!);
                    setHistory(history.slice(0, -1));
                  }}
                >
                  撤销上一步
                </Button>
                <Button
                  danger
                  disabled={!dirty}
                  onClick={() =>
                    modal.confirm({
                      title: '放弃所有尚未导出的修改？',
                      content: '将恢复到导入或最近导出的内容。',
                      okText: '放弃修改',
                      okButtonProps: { danger: true },
                      cancelText: '继续编辑',
                      onOk: () => {
                        setSource(baseline);
                        setHistory([]);
                      }
                    })
                  }
                >
                  放弃修改
                </Button>
              </Space>
            </Flex>
          </Card>
        </Layout.Content>
      </Layout>
      <Drawer title='变更记录' open={review} onClose={() => setReview(false)} size={screens.md ? 560 : 'default'}>
        <Table
          size='small'
          rowKey='path'
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty description='暂无字段变更' /> }}
          columns={[
            { title: '操作', dataIndex: 'action', width: 80, render: value => <Tag color={value === '删除' ? 'red' : 'blue'}>{value}</Tag> },
            { title: '配置项', dataIndex: 'path', render: value => <Typography.Text className='field-path'>{value}</Typography.Text> },
            { title: '修改前', dataIndex: 'before', render: value => <Typography.Text className='field-path'>{value}</Typography.Text> },
            { title: '修改后', dataIndex: 'after', render: value => <Typography.Text className='field-path'>{value}</Typography.Text> }
          ]}
          dataSource={[
            ...changed.map(f => {
              const before = original.find(item => JSON.stringify(item.path) === JSON.stringify(f.path));
              return { path: f.path.join(' / '), action: before ? '修改' : '新增', before: displayValue(before), after: displayValue(f) };
            }),
            ...removed.map(f => ({ path: f.path.join(' / '), action: '删除', before: displayValue(f), after: '未配置' }))
          ]}
        />
      </Drawer>
    </Layout>
  );
}
