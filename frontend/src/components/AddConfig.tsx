import { useEffect, useState } from 'react';
import { App, Button, Drawer, Form, Input, InputNumber, Select, Space, Switch } from 'antd';
import { parseDocument } from 'yaml';
import schema from './config-schema.json';
import metadata from '../../../package.json';
const root = 'alemonjs-agent-link';
type Props = { has: (path: (string | number)[]) => boolean; add: (path: (string | number)[], value: unknown) => boolean; source: string };
export default function AddConfig({ has, add, source }: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('field');
  const [field, setField] = useState('baseUrl');
  const [form] = Form.useForm();
  useEffect(() => {
    form.setFieldValue('enabled', kind === 'endpoint' ? true : undefined);
  }, [kind, form]);
  const { message } = App.useApp();
  const catalog = [...metadata.alemonjs.config, ...schema.fields, { name: 'baseUrl', type: 'string', description: '模型 HTTPS 地址', required: false }].filter(
    (entry, index, array) => array.findIndex(item => item.name === entry.name) === index
  );
  const available = catalog.filter(item => !has([root, item.name]));
  useEffect(() => {
    if (open && kind === 'field' && !available.some(item => item.name === field)) {
      setField(available[0]?.name || '');
      form.resetFields(['value']);
    }
  }, [open, kind, field, available.map(item => item.name).join(',')]);
  const groupFields = ['activity', 'enabled', 'replyGateEnabled', 'cooldownSeconds', 'maxPerHour', 'interjectChance', 'interests'];
  const groups = parseDocument(source).toJS()?.[root]?.groupChat?.overrides || {};
  const loadGroup = (id: string) => {
    const existing = groups[id] || {};
    form.setFieldsValue(
      Object.fromEntries(
        groupFields.map(key => [
          key,
          key === 'interests' && Array.isArray(existing[key])
            ? existing[key].join('\n')
            : typeof existing[key] === 'boolean'
              ? String(existing[key])
              : existing[key]
        ])
      )
    );
  };
  const selected = catalog.find(item => item.name === field);
  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (kind === 'endpoint') {
        if (!add([root, 'modelPool', 'endpoints'], values)) return;
      } else if (kind === 'group') {
        const policy = { ...groups[values.id] };
        for (const key of groupFields) {
          if (values[key] === undefined || values[key] === null || values[key] === '') delete policy[key];
          else
            policy[key] =
              key === 'interests'
                ? String(values[key])
                    .split('\n')
                    .map(value => value.trim())
                    .filter(Boolean)
                : ['enabled', 'replyGateEnabled'].includes(key)
                  ? values[key] === 'true'
                  : values[key];
        }
        if (!add([root, 'groupChat', 'overrides', values.id], policy)) return;
      } else {
        if (has([root, field])) {
          message.error('该配置已存在');
          return;
        }
        if (
          !add(
            [root, field],
            selected?.type === 'array'
              ? String(values.value || '')
                  .split('\n')
                  .filter(Boolean)
              : selected?.type === 'boolean'
                ? Boolean(values.value)
                : (values.value ?? '')
          )
        )
          return;
      }
      setOpen(false);
      form.resetFields();
    } catch {
      /* Form displays validation errors. */
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>添加配置</Button>
      <Drawer
        title='添加配置项'
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button type='primary' disabled={kind === 'field' && !selected} onClick={submit}>
            添加
          </Button>
        }
      >
        <Space orientation='vertical' size='large' style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            value={kind}
            onChange={value => {
              setKind(value);
              form.resetFields();
            }}
            options={[
              { value: 'field', label: '主配置字段' },
              { value: 'endpoint', label: '模型池端点' },
              { value: 'group', label: '新增或编辑群策略' }
            ]}
          />
          <Form
            form={form}
            layout='vertical'
            initialValues={{
              provider: 'openai-compatible',
              capabilities: ['chat'],
              weight: 1,
              maxConcurrent: 1,
              priority: 0
            }}
          >
            {kind === 'field' ? (
              <>
                <Select
                  showSearch
                  optionFilterProp='label'
                  style={{ width: '100%', marginBottom: 20 }}
                  value={field}
                  onChange={value => {
                    setField(value);
                    form.resetFields(['value']);
                  }}
                  options={catalog.filter(item => !has([root, item.name])).map(item => ({ value: item.name, label: item.name }))}
                />
                <Form.Item
                  name='value'
                  label={selected?.description}
                  valuePropName={selected?.type === 'boolean' ? 'checked' : 'value'}
                  rules={[{ required: selected?.type !== 'boolean' }]}
                >
                  {selected?.type === 'number' ? (
                    <InputNumber style={{ width: '100%' }} />
                  ) : selected?.type === 'boolean' ? (
                    <Switch />
                  ) : selected?.type === 'array' ? (
                    <Input.TextArea placeholder='每行一项' />
                  ) : /key/i.test(field) ? (
                    <Input.Password />
                  ) : (
                    <Input />
                  )}
                </Form.Item>
              </>
            ) : kind === 'group' ? (
              <>
                <Form.Item name='id' label='群 ID' rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_-]+$/, message: '请输入平台群 ID' }]}>
                  <Input onChange={event => loadGroup(event.target.value)} />
                </Form.Item>
                <Select
                  aria-label='选择已有群'
                  allowClear
                  placeholder='选择已有群以编辑'
                  style={{ width: '100%', marginBottom: 20 }}
                  options={Object.keys(groups).map(value => ({ value, label: value }))}
                  onChange={id => {
                    form.setFieldValue('id', id || '');
                    loadGroup(id || '');
                  }}
                />
                <Form.Item name='activity' label='活跃程度'>
                  <Select allowClear placeholder='继承全局配置' options={['quiet', 'balanced', 'active'].map(value => ({ value, label: value }))} />
                </Form.Item>
                {['enabled', 'replyGateEnabled'].map(name => (
                  <Form.Item key={name} name={name} label={name === 'enabled' ? '群聊参与开关' : '回复门控开关'}>
                    <Select
                      allowClear
                      placeholder='继承全局配置'
                      options={[
                        { value: 'true', label: '开启' },
                        { value: 'false', label: '关闭' }
                      ]}
                    />
                  </Form.Item>
                ))}
                {['cooldownSeconds', 'maxPerHour', 'interjectChance'].map(name => (
                  <Form.Item
                    key={name}
                    name={name}
                    label={
                      ({ cooldownSeconds: '回复冷却（秒）', maxPerHour: '每小时回复上限', interjectChance: '插话概率（0–1）' } as Record<string, string>)[name]
                    }
                  >
                    <InputNumber
                      min={0}
                      max={name === 'interjectChance' ? 1 : undefined}
                      precision={name === 'interjectChance' ? 2 : 0}
                      placeholder='继承全局配置'
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                ))}
                <Form.Item name='interests' label='兴趣词'>
                  <Input.TextArea placeholder='每行一项，留空继承' />
                </Form.Item>
              </>
            ) : (
              <>
                {['id', 'provider', 'baseUrl', 'model', 'apiKey'].map(name => (
                  <Form.Item
                    key={name}
                    name={name}
                    label={name}
                    rules={[
                      { required: true },
                      ...(name === 'baseUrl'
                        ? [
                            {
                              validator: async (_: unknown, value: string) => {
                                const url = new URL(value);
                                if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
                                  throw new Error('需要不含凭证或查询参数的 HTTPS 地址');
                              }
                            }
                          ]
                        : []),
                      ...(name === 'apiKey' ? [{ min: 8, max: 500, message: '密钥长度需要为 8–500 字符' }] : []),
                      ...(name === 'id' ? [{ pattern: /^[a-z][a-z0-9-]{0,39}$/, message: '小写字母开头，最多 40 个字母、数字或连字符' }] : [])
                    ]}
                  >
                    {name === 'apiKey' ? <Input.Password /> : <Input />}
                  </Form.Item>
                ))}
                <Form.Item name='capabilities' label='用途' rules={[{ required: true }]}>
                  <Select mode='multiple' options={['chat', 'tools', 'vision', 'replyGate'].map(value => ({ value, label: value }))} />
                </Form.Item>
                {['weight', 'maxConcurrent', 'priority'].map(name => (
                  <Form.Item key={name} name={name} label={name}>
                    <InputNumber min={name === 'priority' ? 0 : 1} max={100} precision={0} />
                  </Form.Item>
                ))}
                <Form.Item name='enabled' label='启用端点' valuePropName='checked'>
                  <Switch />
                </Form.Item>
              </>
            )}
          </Form>
        </Space>
      </Drawer>
    </>
  );
}
