import { useEffect, useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, Layout, Space, Select, InputNumber, Switch, Table, Tag, Typography } from 'antd';
import { useUnsavedNavigation } from './useUnsavedNavigation';
type Word = {
  trigger?: string;
  date?: string;
  leadDays?: number;
  fallback?: string;
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  enabled: boolean;
  updatedAt: number;
};
export default function EventsPage() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Word[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Word>();
  const [form] = Form.useForm();
  useUnsavedNavigation(open && dirty);
  const call = async (path = '', body?: unknown) => {
    const response = await fetch('./api/admin/events' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '操作失败');
    return data.data;
  };
  const load = async () => {
    setBusy(true);
    try {
      setRows(await call());
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const edit = (word?: Word) => {
    setSelected(word);
    form.resetFields();
    form.setFieldsValue(
      word ? { ...word, trigger: word.trigger || 'message', aliases: word.aliases.join('，') } : { enabled: true, trigger: 'message', leadDays: 7 }
    );
    setDirty(false);
    setOpen(true);
  };
  const close = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: '放弃未保存的修改？',
        onOk: () => {
          setDirty(false);
          setOpen(false);
        }
      });
    else setOpen(false);
  };
  const save = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      await call('', {
        ...selected,
        ...values,
        aliases: String(values.aliases || '')
          .split(/[,，\n]/)
          .map(s => s.trim())
          .filter(Boolean)
      });
      setDirty(false);
      setOpen(false);
      message.success('事件已保存');
      await load();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Layout.Content style={{ padding: 24, minWidth: 0 }}>
      <Typography.Title level={2}>事件库</Typography.Title>
      <Typography.Paragraph type='secondary'>维护事件触发词和应对方式。匹配聊天内容后提供行为参考；节日前准备在已有主动回合中生效。</Typography.Paragraph>
      {error && <Alert type='error' message={error} action={<Button onClick={load}>重试</Button>} />}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder='搜索事件名称、触发词或应对方式' value={query} onChange={e => setQuery(e.target.value)} allowClear />
        <Button type='primary' onClick={() => edit()} disabled={busy}>
          新增事件
        </Button>
      </Space>
      <Table
        rowKey='id'
        loading={busy}
        dataSource={rows.filter(w => [w.term, ...w.aliases, w.definition].some(s => s.toLowerCase().includes(query.toLowerCase())))}
        scroll={{ x: 700 }}
        columns={[
          { title: '事件名称', dataIndex: 'term', width: 140 },
          { title: '触发词', render: (_, w) => w.aliases.join('、') || '—', width: 160 },
          { title: '应对方式', dataIndex: 'definition', ellipsis: true },
          { title: '状态', render: (_, w) => <Tag color={w.enabled ? 'green' : undefined}>{w.enabled ? '启用' : '停用'}</Tag>, width: 90 },
          {
            title: '操作',
            width: 150,
            render: (_, w) => (
              <Space>
                <Button disabled={busy} onClick={() => edit(w)}>
                  编辑
                </Button>
                <Button
                  danger
                  disabled={busy}
                  onClick={() =>
                    modal.confirm({
                      title: `删除“${w.term}”？`,
                      onOk: async () => {
                        setBusy(true);
                        try {
                          await call('/delete', { id: w.id, updatedAt: w.updatedAt });
                          await load();
                        } catch (e) {
                          message.error(String(e));
                          throw e;
                        } finally {
                          setBusy(false);
                        }
                      }
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
      <Drawer
        title={selected ? '编辑事件' : '新增事件'}
        open={open}
        onClose={close}
        extra={
          <Button type='primary' loading={busy} onClick={() => void save().catch(() => {})}>
            保存
          </Button>
        }
      >
        <Form form={form} layout='vertical' onValuesChange={() => setDirty(true)} disabled={busy}>
          <Form.Item name='trigger' label='触发方式'>
            <Select
              options={[
                { value: 'message', label: '聊天关键词' },
                { value: 'budget', label: '实际额度不足' },
                { value: 'festival', label: '公历节日前' }
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() =>
              form.getFieldValue('trigger') === 'festival' ? (
                <>
                  <Form.Item name='date' label='公历日期（MM-DD）' rules={[{ required: true, pattern: /^\d{2}-\d{2}$/ }]}>
                    <Input placeholder='01-01' />
                  </Form.Item>
                  <Form.Item name='leadDays' label='提前天数' rules={[{ required: true }]}>
                    <InputNumber min={1} max={30} />
                  </Form.Item>
                </>
              ) : form.getFieldValue('trigger') === 'budget' ? (
                <Form.Item name='fallback' label='额度不足时直接发送的话（不调用模型）'>
                  <Input.TextArea maxLength={500} showCount placeholder='原有额度明细与操作入口会保留' />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name='term' label='事件名称' rules={[{ required: true, whitespace: true, max: 60 }]}>
            <Input maxLength={60} />
          </Form.Item>
          <Form.Item name='aliases' label='触发词（逗号分隔，最多 20 个）'>
            <Input.TextArea placeholder='额度没有了、额度耗尽' />
          </Form.Item>
          <Form.Item name='definition' label='应对方式' rules={[{ required: true, whitespace: true, max: 2000 }]}>
            <Input.TextArea rows={8} maxLength={2000} showCount placeholder='触发条件、如何回应、需要记录什么；不要将计划写成已完成' />
          </Form.Item>
          <Form.Item name='enabled' label='启用' valuePropName='checked'>
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </Layout.Content>
  );
}
