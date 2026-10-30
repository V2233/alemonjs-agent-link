import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Layout, Space, Switch, Typography } from 'antd';
export default function SponsorsPage() {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const request = async (body?: unknown) => {
    const response = await fetch('./api/admin/sponsors', {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message);
    return result.data;
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
  const load = async () => {
    const data = await request();
    setRevision(data.revision);
    form.setFieldsValue(data);
  };
  useEffect(() => {
    void run(load);
  }, []);
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>赞助列表</Typography.Title>
      <Alert
        showIcon
        title='默认关闭。开启后，/额度 显示赞助列表入口。'
        description='按后台顺序展示已启用的赞助条目，每页5条。关闭后隐藏入口，赞助列表指令静默。'
      />
      <Form
        form={form}
        layout='vertical'
        disabled={busy}
        onFinish={values =>
          run(async () => {
            const data = await request({ ...values, revision });
            setRevision(data.revision);
            form.setFieldsValue(data);
            message.success('已保存赞助配置');
          })
        }
      >
        <Form.Item name='enabled' label='开启赞助功能' valuePropName='checked'>
          <Switch />
        </Form.Item>
        <Form.List name='items'>
          {(fields, { add, remove }) => (
            <Space orientation='vertical' style={{ width: '100%' }}>
              {fields.map(field => (
                <Card
                  key={field.key}
                  title={`赞助 ${field.name + 1}`}
                  extra={
                    <Button danger onClick={() => remove(field.name)}>
                      删除
                    </Button>
                  }
                >
                  <Form.Item name={[field.name, 'id']} label='稳定赞助ID' rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name={[field.name, 'title']} label='标题' rules={[{ required: true }]}>
                    <Input maxLength={80} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'content']} label='赞助说明（可选）'>
                    <Input.TextArea rows={4} maxLength={1500} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'url']} label='HTTPS 链接（可选）'>
                    <Input />
                  </Form.Item>
                  <Form.Item name={[field.name, 'enabled']} label='展示' valuePropName='checked'>
                    <Switch />
                  </Form.Item>
                </Card>
              ))}
              <Button onClick={() => add({ id: crypto.randomUUID(), title: '', content: '', enabled: false })}>新增赞助</Button>
            </Space>
          )}
        </Form.List>
        <Space style={{ marginTop: 20 }}>
          <Button type='primary' htmlType='submit' loading={busy} disabled={!revision}>
            保存
          </Button>
          <Button onClick={() => run(load)}>重新读取</Button>
        </Space>
      </Form>
    </Layout.Content>
  );
}
