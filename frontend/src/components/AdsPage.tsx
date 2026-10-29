import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, InputNumber, Layout, Space, Switch, Typography } from 'antd';
export default function AdsPage() {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const request = async (body?: unknown) => {
    const response = await fetch('./api/admin/ads', {
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
      <Typography.Title level={2}>私聊广告</Typography.Title>
      <Alert
        showIcon
        title='默认关闭。关闭后广告指令静默，额度页不显示广告入口。'
        description='每个平台用户每条广告仅奖励一次，详情发送成功后计入私聊充值余额；不验证外部链接阅读。修改广告ID会被视作新广告，请勿为重复发奖更换ID。'
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
            message.success('已保存广告配置');
          })
        }
      >
        <Form.Item name='enabled' label='开启广告功能' valuePropName='checked'>
          <Switch />
        </Form.Item>
        <Form.List name='items'>
          {(fields, { add, remove }) => (
            <Space orientation='vertical' style={{ width: '100%' }}>
              {fields.map(field => (
                <Card
                  key={field.key}
                  title={`广告 ${field.name + 1}`}
                  extra={
                    <Button danger onClick={() => remove(field.name)}>
                      删除
                    </Button>
                  }
                >
                  <Form.Item name={[field.name, 'id']} label='稳定广告ID' rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name={[field.name, 'title']} label='标题' rules={[{ required: true }]}>
                    <Input maxLength={80} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'content']} label='广告内容' rules={[{ required: true }]}>
                    <Input.TextArea rows={4} maxLength={1500} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'url']} label='HTTPS 链接（可选）'>
                    <Input />
                  </Form.Item>
                  <Form.Item name={[field.name, 'rewardYuan']} label='奖励额度（元）' rules={[{ required: true }]}>
                    <InputNumber min={0.01} max={10} precision={2} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'enabled']} label='上架' valuePropName='checked'>
                    <Switch />
                  </Form.Item>
                </Card>
              ))}
              <Button onClick={() => add({ id: crypto.randomUUID(), title: '', content: '', enabled: false, rewardYuan: 0.01 })}>新增广告</Button>
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
