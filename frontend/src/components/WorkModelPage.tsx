import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Layout, Space, Typography } from 'antd';

const request = async (path: string, body?: unknown) => {
  const response = await fetch('./api/admin/work-model' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(40000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '操作失败');
  return result.data;
};
export default function WorkModelPage() {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    const data = await request('');
    setRevision(data.revision);
    form.setFieldsValue(data.values);
  };
  useEffect(() => {
    void run(load);
  }, []);
  return (
    <Layout.Content style={{ padding: 24 }}>
      <Typography.Title level={2}>工作模型</Typography.Title>
      <Typography.Paragraph type='secondary'>
        使用现有顶层 apiKey、baseUrl、model、provider 配置，默认提供方为 DeepSeek 官方，模型为 deepseek-v4-flash。目前用于「额度轮转 →
        智能识别」，后续文本生成、AI 总结等能力将在对应功能中提供入口。
      </Typography.Paragraph>
      {error && <Alert type='error' showIcon title={error} style={{ marginBottom: 16 }} />}
      <Card title='模型配置' style={{ marginBottom: 20 }}>
        <Form
          form={form}
          layout='vertical'
          onFinish={values =>
            run(async () => {
              const data = await request('', { revision, values });
              setRevision(data.revision);
              form.setFieldsValue(data.values);
              message.success('工作模型已保存');
            })
          }
        >
          <Form.Item name='provider' label='提供方' rules={[{ required: true }]}>
            <Input placeholder='deepseek-official' />
          </Form.Item>
          <Form.Item name='baseUrl' label='接口地址（DeepSeek 官方可留空）'>
            <Input placeholder='https://api.example.com/v1' />
          </Form.Item>
          <Form.Item name='apiKey' label='API Key（留空停用）'>
            <Input.Password autoComplete='off' />
          </Form.Item>
          <Form.Item name='model' label='模型名称' rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Space>
            <Button type='primary' htmlType='submit' loading={busy} disabled={!revision}>
              保存
            </Button>
            <Button disabled={busy} onClick={() => run(load)}>
              重新读取
            </Button>
          </Space>
        </Form>
      </Card>
    </Layout.Content>
  );
}
