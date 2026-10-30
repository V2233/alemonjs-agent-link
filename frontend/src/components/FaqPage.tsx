import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, Layout, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useUnsavedNavigation } from './useUnsavedNavigation';
type Note = {
  id: string;
  platform: string;
  channelId: string;
  question: string;
  reason: string;
  status: string;
  count: number;
  createdAt: number;
  updatedAt: number;
  publishedId?: string;
};
async function request(body?: unknown) {
  const response = await fetch('./api/admin/faq' + (body ? '/process' : ''), {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '操作失败');
  return data.data;
}
export default function FaqPage() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Note[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('pending');
  const [selected, setSelected] = useState<Note>();
  const [dirty, setDirty] = useState(false);
  const [form] = Form.useForm();
  useUnsavedNavigation(dirty);
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
      setRows(await request());
      setError('');
    } catch (e) {
      setError(String(e));
      throw e;
    }
  };
  useEffect(() => {
    void run(load);
  }, []);
  const close = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: '放弃未保存的加工内容？',
        onOk: () => {
          setDirty(false);
          setSelected(undefined);
        }
      });
    else setSelected(undefined);
  };
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>常见问题</Typography.Title>
      <Alert
        type='info'
        title='待人工加工的问题笔记，不参与肥鱼回答'
        description='自动记录问答库未命中的问题，未命中不代表一定没有答案。人工核实、填写答案后才发布到问答库；发布至全局前请移除会话隐私。'
      />
      {error && <Alert type='error' title={error} action={<Button onClick={() => run(load)}>重试</Button>} />}
      <Space wrap style={{ margin: '16px 0' }}>
        <Input.Search placeholder='搜索问题、平台或会话' value={query} onChange={e => setQuery(e.target.value)} allowClear />
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: 'pending', label: '待加工' },
            { value: 'published', label: '已入问答库' },
            { value: 'dismissed', label: '已忽略' },
            { value: 'all', label: '全部' }
          ]}
        />
        <Button loading={busy} onClick={() => run(load)}>
          刷新
        </Button>
      </Space>
      <Table
        rowKey='id'
        loading={busy}
        scroll={{ x: 900 }}
        dataSource={rows.filter(
          item =>
            (status === 'all' || item.status === status) &&
            [item.question, item.platform, item.channelId].some(value => value.toLowerCase().includes(query.toLowerCase()))
        )}
        columns={[
          { title: '问题原文', dataIndex: 'question' },
          { title: '来源会话', render: (_, item) => `${item.platform} / ${item.channelId}` },
          { title: '收集原因', dataIndex: 'reason' },
          { title: '出现次数', dataIndex: 'count', sorter: (a, b) => a.count - b.count },
          { title: '最近出现', render: (_, item) => new Date(item.updatedAt).toLocaleString() },
          {
            title: '状态',
            render: (_, item) => <Tag>{({ pending: '待加工', published: '已入问答库', dismissed: '已忽略' } as Record<string, string>)[item.status]}</Tag>
          },
          {
            title: '操作',
            render: (_, item) =>
              item.status === 'pending' ? (
                <Space>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setSelected(item);
                      setDirty(false);
                      form.resetFields();
                      form.setFieldsValue({ question: item.question, answer: '', scope: 'session' });
                    }}
                  >
                    加工入库
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      modal.confirm({
                        title: '忽略这个问题？',
                        onOk: () =>
                          run(async () => {
                            await request({ id: item.id, updatedAt: item.updatedAt, action: 'dismiss' });
                            await load();
                          })
                      })
                    }
                  >
                    忽略
                  </Button>
                </Space>
              ) : item.publishedId ? (
                <Typography.Text type='secondary'>问答ID：{item.publishedId}</Typography.Text>
              ) : (
                '—'
              )
          }
        ]}
      />
      <Modal
        title='人工加工并发布到问答库'
        open={Boolean(selected)}
        onCancel={close}
        maskClosable={false}
        confirmLoading={busy}
        onOk={() =>
          run(async () => {
            const values = await form.validateFields();
            if (!selected) return;
            await request({
              id: selected.id,
              updatedAt: selected.updatedAt,
              action: 'publish',
              question: values.question,
              answer: values.answer,
              global: values.scope === 'global'
            });
            setDirty(false);
            setSelected(undefined);
            await load();
            message.success('已发布到问答库');
          })
        }
      >
        <Form form={form} layout='vertical' disabled={busy} onValuesChange={() => setDirty(true)}>
          <Form.Item name='question' label='标准问题' rules={[{ required: true, whitespace: true, min: 2, max: 300 }]}>
            <Input.TextArea rows={3} maxLength={300} />
          </Form.Item>
          <Form.Item name='answer' label='人工确认的答案' rules={[{ required: true, whitespace: true, max: 1200 }]}>
            <Input.TextArea rows={7} maxLength={1200} showCount />
          </Form.Item>
          <Form.Item name='scope' label='发布范围' rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'session', label: '仅原会话' },
                { value: 'global', label: '全局问答库' }
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Layout.Content>
  );
}
