import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, InputNumber, Layout, Select, Space, Switch, Typography } from 'antd';
import { useUnsavedNavigation } from './useUnsavedNavigation';
export default function SettingsPage() {
  const [form] = Form.useForm();
  const { message, modal } = App.useApp();
  const [revision, setRevision] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [override, setOverride] = useState(false);
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
  const request = async (body?: unknown) => {
    const response = await fetch('./api/admin/settings', {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '设置操作失败');
    return result;
  };
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
  const apply = (data: any) => {
    setRevision(data.revision);
    form.setFieldsValue(data.values);
    setOverride(data.customPromptConfigured || Boolean(data.modulePersona));
    setDirty(false);
  };
  const load = async () => apply((await request()).data);
  useEffect(() => {
    void run(load);
  }, []);
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>设置</Typography.Title>
      <Typography.Paragraph type='secondary'>调整机器人如何接收消息、与谁聊天以及怎样回复。模型、额度、音色和广告仍在各自页面管理。</Typography.Paragraph>
      {notice && <Alert showIcon title={notice} style={{ marginBottom: 16 }} />}
      <Form
        form={form}
        layout='vertical'
        disabled={busy || !revision}
        onValuesChange={() => setDirty(true)}
        onFinish={values =>
          run(async () => {
            const result = await request({ revision, values });
            apply(result.data);
            setNotice(result.message);
            message.success('设置已保存');
          })
        }
      >
        <Space orientation='vertical' size='large' style={{ width: '100%' }}>
          <Card title='服务与接入'>
            <Form.Item name='aiEnabled' label='允许 AI 回复' valuePropName='checked' extra='关闭后停止新的 AI 请求；管理指令仍可使用。'>
              <Switch />
            </Form.Item>
            <Form.Item name='aiDisabledReason' label='AI 关闭时的提示' extra='留空时使用默认提示。'>
              <Input.TextArea rows={2} maxLength={500} showCount />
            </Form.Item>
            <Form.Item name='transport' label='连接方式' extra='切换后需要重启。请先配置对应平台的连接信息；这里不修改平台账号或密钥。'>
              <Select
                options={[
                  { value: 'qq-bot', label: 'QQ 官方机器人' },
                  { value: 'onebot', label: 'OneBot 接入' }
                ]}
              />
            </Form.Item>
            <Form.Item name='runtimeMode' label='运行方式' extra='沙箱模式需要部署环境已安装相关组件。已有任务不会因保存设置而自动重跑。'>
              <Select
                options={[
                  { value: 'auto', label: '自动选择' },
                  { value: 'chat-only', label: '聊天模式（无需 Python 沙箱）' },
                  { value: 'sandbox', label: '沙箱模式' }
                ]}
              />
            </Form.Item>
          </Card>
          <Card title='聊天与唤醒'>
            <Form.Item name='privateChatAccess' label='谁可以私聊机器人'>
              <Select
                options={[
                  { value: 'all', label: '所有用户' },
                  { value: 'owner', label: '仅机器人主人' }
                ]}
              />
            </Form.Item>
            <Form.Item
              name='privateAutoReply'
              label='自动回复私聊消息'
              valuePropName='checked'
              extra='关闭后不自动回应普通私聊文字，用户仍可使用明确的聊天指令。'
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name='groupWakeNames'
              label='群聊唤醒词'
              extra='输入后按回车添加；最多64个，每个最多20字，不能以 / 开头。清空只关闭关键词唤醒，不关闭 @ 和聊天指令。'
              rules={[
                {
                  validator: (_, value) =>
                    Array.isArray(value) &&
                    value.length <= 64 &&
                    value.every((v: string) => v.trim() === v && v.length > 0 && v.length <= 20 && !v.startsWith('/'))
                      ? Promise.resolve()
                      : Promise.reject(new Error('请检查唤醒词数量与长度'))
                }
              ]}
            >
              <Select mode='tags' tokenSeparators={['，', ',']} placeholder='输入称呼或唤醒词' />
            </Form.Item>
            <Form.Item name='persona' label='默认人设' extra='会话已选人设、自定义提示词等设置可能优先于这里的默认值。'>
              <Select
                options={[
                  { value: 'dafeiyu', label: '肥鱼' },
                  { value: 'assistant', label: '普通助手' }
                ]}
              />
            </Form.Item>
            {override && <Alert type='info' showIcon title='当前配置含自定义提示词或人设模块默认值，修改基础人设未必改变实际表现。' />}
          </Card>
          <Card title='回复体验'>
            <Form.Item name='maxMessageLength' label='单条回复最大字数' extra='1–10000；过长回复会按现有规则分条发送。'>
              <InputNumber min={1} max={10000} precision={0} />
            </Form.Item>
            <Form.Item name='bubbleDelayMs' label='分条发送间隔（毫秒）' extra='0–5000；1000毫秒等于1秒。'>
              <InputNumber min={0} max={5000} precision={0} />
            </Form.Item>
            <Form.Item name='privateHistoryMaxTurns' label='私聊携带的近期对话轮数' extra='0–100；0表示不携带近期对话，不会删除已保存的聊天记录或长期记忆。'>
              <InputNumber min={0} max={100} precision={0} />
            </Form.Item>
          </Card>
          <Space>
            <Button type='primary' htmlType='submit' loading={busy} disabled={!dirty || !revision}>
              保存设置
            </Button>
            <Button
              onClick={() =>
                run(async () => {
                  if (dirty && !(await modal.confirm({ title: '放弃未保存的修改并重新读取？' }))) return;
                  await load();
                })
              }
            >
              重新读取
            </Button>
            {dirty && <Typography.Text type='secondary'>有未保存的修改</Typography.Text>}
          </Space>
        </Space>
      </Form>
    </Layout.Content>
  );
}
