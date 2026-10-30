import ImageResources from './ImageResources';
import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Image, Input, Layout, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useUnsavedNavigation } from './useUnsavedNavigation';
type Preset = {
  id: string;
  name: string;
  enabled: boolean;
  provider: { baseUrl: string; apiKey: string; model: string; size?: string; stylePrompt?: string; ownerOnly?: boolean };
};
type Settings = { revision: string; imageLibrary: Preset[]; activeImage: string; legacyAvailable: boolean };
async function request(path: string, body?: unknown) {
  const response = await fetch('./api/admin/images' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '操作失败');
  return data;
}
export default function ImagesPage() {
  const { message, modal } = App.useApp();
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Preset | null>();
  const [dirty, setDirty] = useState(false);
  const [prompt, setPrompt] = useState('一只圆滚滚的小鲸鱼，柔和的蓝色背景，简洁插画');
  const [preview, setPreview] = useState<{ url: string; name: string }>();
  const [form] = Form.useForm();
  useUnsavedNavigation(dirty);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview]
  );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    try {
      setSettings((await request('/settings')).data);
      setError('');
    } catch (e) {
      setError(String(e));
      throw e;
    }
  };
  useEffect(() => {
    void run(load);
  }, []);
  const save = async (next: Settings) => {
    const result = await request('/settings', next);
    setSettings(result.data);
    message.success(result.message);
  };
  const open = (item: Preset | null) => {
    setEditing(item);
    setDirty(false);
    form.resetFields();
    form.setFieldsValue(item || { enabled: true, provider: { size: '1024x1024', ownerOnly: false, stylePrompt: '' } });
  };
  const close = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: '放弃未保存的修改？',
        onOk: () => {
          setDirty(false);
          setEditing(undefined);
        }
      });
    else setEditing(undefined);
  };
  const generate = (id: string, name: string) =>
    run(async () => {
      const response = await fetch('./api/admin/images/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, prompt }),
        signal: AbortSignal.timeout(125000)
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.message || '生成失败');
      }
      setPreview({ url: URL.createObjectURL(await response.blob()), name });
    });
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>生图库</Typography.Title>
      <Tabs
        items={[
          {
            key: 'configured',
            label: '已配置生图',
            children: (
              <>
                <Alert
                  type='info'
                  showIcon
                  title='配置兼容 OpenAI Images 的生图服务'
                  description='接口地址会追加 /images/generations。试生成使用已保存的配置，可能消耗供应商额度；生成结果仅在管理页展示。'
                />
                {error && <Alert type='error' title={error} action={<Button onClick={() => run(load)}>重试</Button>} />}
                {settings?.legacyAvailable && (
                  <Alert
                    type='info'
                    title='检测到原有 media.imageGen 配置'
                    action={
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const result = await request('/migrate', { revision: settings.revision });
                            setSettings(result.data);
                            message.success('已迁入并设为默认');
                          })
                        }
                      >
                        迁入生图库
                      </Button>
                    }
                  />
                )}
                {settings?.imageLibrary.some(item => item.id === settings.activeImage && !item.enabled) && (
                  <Alert type='warning' title='默认生图配置已停用，聊天生图当前不可用，请启用或切换。' />
                )}
                <Space wrap style={{ margin: '16px 0' }}>
                  <Input.Search placeholder='搜索名称、ID或模型' value={query} onChange={e => setQuery(e.target.value)} allowClear />
                  <Button loading={busy} onClick={() => run(load)}>
                    刷新
                  </Button>
                  <Button type='primary' disabled={busy || !settings} onClick={() => open(null)}>
                    新增生图配置
                  </Button>
                  <Select
                    style={{ minWidth: 200 }}
                    value={settings?.activeImage || ''}
                    disabled={busy || !settings}
                    onChange={activeImage => settings && run(() => save({ ...settings, activeImage }))}
                    options={[
                      { value: '', label: '原有生图配置' },
                      ...(settings?.imageLibrary || []).map(item => ({
                        value: item.id,
                        label: item.name + (item.enabled ? '' : '（已停用）'),
                        disabled: !item.enabled
                      }))
                    ]}
                  />
                </Space>
                <Table
                  rowKey='id'
                  loading={busy}
                  scroll={{ x: 900 }}
                  dataSource={settings?.imageLibrary.filter(item =>
                    [item.id, item.name, item.provider.model].some(value => value.toLowerCase().includes(query.toLowerCase()))
                  )}
                  columns={[
                    {
                      title: '配置',
                      render: (_, item: Preset) => (
                        <>
                          {item.name} {settings?.activeImage === item.id && <Tag>默认</Tag>}
                          <br />
                          <Typography.Text type='secondary'>{item.id}</Typography.Text>
                        </>
                      )
                    },
                    { title: '模型', render: (_, item) => item.provider.model },
                    { title: '尺寸', render: (_, item) => item.provider.size || '1024x1024' },
                    { title: '使用范围', render: (_, item) => (item.provider.ownerOnly ? '仅主人' : '按聊天权限') },
                    {
                      title: '启用',
                      render: (_, item) => (
                        <Switch
                          checked={item.enabled}
                          disabled={busy}
                          onChange={enabled =>
                            settings &&
                            run(() => save({ ...settings, imageLibrary: settings.imageLibrary.map(row => (row.id === item.id ? { ...row, enabled } : row)) }))
                          }
                        />
                      )
                    },
                    {
                      title: '操作',
                      render: (_, item) => (
                        <Space wrap>
                          <Button disabled={busy || !item.enabled || !prompt.trim()} onClick={() => generate(item.id, item.name)}>
                            试生成
                          </Button>
                          <Button disabled={busy} onClick={() => open(item)}>
                            编辑
                          </Button>
                          <Button
                            danger
                            disabled={busy || settings?.activeImage === item.id}
                            onClick={() =>
                              modal.confirm({
                                title: `删除“${item.name}”？`,
                                onOk: () => settings && run(() => save({ ...settings, imageLibrary: settings.imageLibrary.filter(row => row.id !== item.id) }))
                              })
                            }
                          >
                            删除
                          </Button>
                        </Space>
                      )
                    }
                  ]}
                />
                <Typography.Title level={4}>试生成</Typography.Title>
                <Input.TextArea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} maxLength={1000} showCount />
                <Button
                  style={{ margin: '16px 0' }}
                  disabled={busy || !settings || !prompt.trim()}
                  onClick={() => generate(settings?.activeImage || '', '当前默认配置')}
                >
                  使用默认配置生成
                </Button>
                {preview && (
                  <div>
                    <Typography.Paragraph>{preview.name} · 生成结果</Typography.Paragraph>
                    <Image src={preview.url} width={320} style={{ maxWidth: '100%' }} />
                  </div>
                )}
              </>
            )
          },
          {
            key: 'resources',
            label: '服务资源（10）',
            children: (
              <ImageResources
                disabled={busy || !settings}
                onAdd={(name, baseUrl) => {
                  open(null);
                  form.setFieldsValue({ name, provider: { baseUrl } });
                }}
              />
            )
          }
        ]}
      />
      <Modal
        title={editing ? '编辑生图配置' : '新增生图配置'}
        open={editing !== undefined}
        maskClosable={false}
        onCancel={close}
        confirmLoading={busy}
        onOk={() =>
          run(async () => {
            const value = await form.validateFields();
            if (!settings) return;
            await save({
              ...settings,
              imageLibrary: editing ? settings.imageLibrary.map(item => (item.id === editing.id ? value : item)) : [...settings.imageLibrary, value]
            });
            setDirty(false);
            setEditing(undefined);
          })
        }
      >
        <Form form={form} layout='vertical' disabled={busy} onValuesChange={() => setDirty(true)}>
          <Form.Item name='id' label='配置ID' rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }]}>
            <Input disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item name='name' label='名称' rules={[{ required: true, whitespace: true, max: 80 }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name='enabled' label='启用' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name={['provider', 'baseUrl']} label='接口地址（含 /v1 等前缀，不含 /images/generations）' rules={[{ required: true }]}>
            <Input placeholder='https://example.com/v1' />
          </Form.Item>
          <Form.Item name={['provider', 'apiKey']} label='API Key（本机回环服务可留空；保留占位符即保留原密钥）'>
            <Input.Password autoComplete='new-password' />
          </Form.Item>
          <Form.Item name={['provider', 'model']} label='模型名称' rules={[{ required: true, whitespace: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name={['provider', 'size']} label='尺寸（以供应商支持为准）' rules={[{ required: true, pattern: /^\d{2,4}x\d{2,4}$/ }]}>
            <Input placeholder='1024x1024' />
          </Form.Item>
          <Form.Item name={['provider', 'stylePrompt']} label='附加风格提示词'>
            <Input.TextArea rows={3} maxLength={2000} showCount />
          </Form.Item>
          <Form.Item name={['provider', 'ownerOnly']} label='仅主人可在聊天中调用' valuePropName='checked'>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Layout.Content>
  );
}
