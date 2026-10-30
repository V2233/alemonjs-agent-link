import { useEffect, useState } from 'react';
import BiliDiagnostics from './BiliDiagnostics';
import { Alert, App, Button, Card, Form, Input, InputNumber, Layout, Space, Switch, Table, Typography } from 'antd';

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
  const [activities, setActivities] = useState<{ scope: string; at: number; count: number; status: string }[]>([]);
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
    setActivities(data.activities || []);
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
        开启自主活动后，肥鱼会在已订阅的主人私聊范围内定时阅读 B 站资料，遵守主动搭话的免打扰时间和暂停状态。 需要启用 B 站模块及
        allowProactiveBrowse。阅读结果进入现有记忆机制；本轮不会直接发消息、点赞或评论。 抖音和 QQ 空间目前保留为兴趣偏好，尚未接入自主浏览。
      </Typography.Paragraph>
      {error && <Alert type='error' showIcon title={error} style={{ marginBottom: 16 }} />}
      <Card title='爱好与控制开关'>
        <Form
          form={form}
          layout='vertical'
          onFinish={values =>
            run(async () => {
              const data = await request('', { revision, values });
              setActivities(data.activities || []);
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
          <Form.Item name='autonomous' label='开启自主阅读活动（目前支持 B 站）' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name='intervalMinutes' label='活动间隔（分钟）'>
            <InputNumber min={15} max={1440} />
          </Form.Item>
          <Form.Item name='maxPerDay' label='每个会话每日最多尝试轮数'>
            <InputNumber min={1} max={20} />
          </Form.Item>
          <Form.Item name='maxReads' label='每轮最多读取视频数'>
            <InputNumber min={1} max={3} />
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
      <BiliDiagnostics />
      <Card title='最近活动（重新读取可刷新）' style={{ marginTop: 16 }}>
        <Table
          rowKey='scope'
          dataSource={activities}
          pagination={{ pageSize: 5 }}
          columns={[
            { title: '会话标识', dataIndex: 'scope', render: (value: string) => value.slice(0, 12) },
            { title: '最近执行', dataIndex: 'at', render: (value: number) => new Date(value).toLocaleString() },
            { title: '当日尝试', dataIndex: 'count' },
            {
              title: '结果',
              dataIndex: 'status',
              render: (value: string) =>
                ({
                  running: '执行中 / 中断待恢复',
                  recorded: '已保存阅读经历',
                  completed: '已结束，未确认新增经历',
                  unavailable: 'B 站能力未开启',
                  cancelled: '已取消',
                  failed: '执行失败'
                })[value] || value
            }
          ]}
        />
      </Card>
    </Layout.Content>
  );
}
