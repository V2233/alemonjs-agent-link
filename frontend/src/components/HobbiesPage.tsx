import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Layout, Space, Switch, Typography } from 'antd';

const request = async (path: string, body?: unknown) => {
  const response = await fetch('./api/admin/hobbies' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(40000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '操作失败');
  return result.data;
};
export default function HobbiesPage() {
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
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>爱好设置</Typography.Title>
      <Typography.Paragraph type='secondary'>
        设置角色的聊天兴趣偏好。总开关关闭后不注入爱好，各项选择仍会保留。开启爱好不会自动浏览、点赞、评论或发布。 B 站与 QQ
        空间实际访问取决于现有工具配置；抖音目前仅支持兴趣偏好，尚未接入浏览工具。
      </Typography.Paragraph>
      {error && <Alert type='error' showIcon title={error} style={{ marginBottom: 16 }} />}
      <Card title='爱好与控制开关'>
        <Form
          form={form}
          layout='vertical'
          onFinish={values =>
            run(async () => {
              const data = await request('', { revision, values });
              setRevision(data.revision);
              form.setFieldsValue(data.values);
              message.success('爱好设置已保存');
            })
          }
        >
          <Form.Item name='enabled' label='启用爱好' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name='douyin' label='刷抖音' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name='bilibili' label='刷 bilibili' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name='qzone' label='刷 QQ 空间' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name='interests' label='兴趣描述 / 其他爱好'>
            <Input.TextArea maxLength={1000} showCount rows={4} placeholder='例如：喜欢科技、游戏、美食，不喜欢恐怖内容' />
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
