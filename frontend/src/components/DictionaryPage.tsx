import { useEffect, useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, Layout, Space, Switch, Table, Tag, Typography } from 'antd';
import { useUnsavedNavigation } from './useUnsavedNavigation';
type Word = { id: string; term: string; aliases: string[]; definition: string; enabled: boolean; updatedAt: number };
export default function DictionaryPage() {
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
    const response = await fetch('./api/admin/dictionary' + path, {
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
    form.setFieldsValue(word ? { ...word, aliases: word.aliases.join('，') } : { enabled: true });
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
      message.success('词条已保存');
      await load();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Layout.Content style={{ padding: 24, minWidth: 0 }}>
      <Typography.Title level={2}>热词词典</Typography.Title>
      <Typography.Paragraph type='secondary'>解释网络热词、烂梗和缩写。启用的词条对所有会话生效，聊天命中后提供释义参考。</Typography.Paragraph>
      {error && <Alert type='error' message={error} action={<Button onClick={load}>重试</Button>} />}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder='搜索热词、别名或释义' value={query} onChange={e => setQuery(e.target.value)} allowClear />
        <Button type='primary' onClick={() => edit()} disabled={busy}>
          新增词条
        </Button>
      </Space>
      <Table
        rowKey='id'
        loading={busy}
        dataSource={rows.filter(w => [w.term, ...w.aliases, w.definition].some(s => s.toLowerCase().includes(query.toLowerCase())))}
        scroll={{ x: 700 }}
        columns={[
          { title: '热词', dataIndex: 'term', width: 140 },
          { title: '别名', render: (_, w) => w.aliases.join('、') || '—', width: 160 },
          { title: '释义', dataIndex: 'definition', ellipsis: true },
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
        title={selected ? '编辑词条' : '新增词条'}
        open={open}
        onClose={close}
        extra={
          <Button type='primary' loading={busy} onClick={() => void save().catch(() => {})}>
            保存
          </Button>
        }
      >
        <Form form={form} layout='vertical' onValuesChange={() => setDirty(true)} disabled={busy}>
          <Form.Item name='term' label='热词' rules={[{ required: true, whitespace: true, max: 60 }]}>
            <Input maxLength={60} />
          </Form.Item>
          <Form.Item name='aliases' label='别名（逗号分隔，最多 20 个）'>
            <Input.TextArea placeholder='缩写、不同写法' />
          </Form.Item>
          <Form.Item name='definition' label='释义' rules={[{ required: true, whitespace: true, max: 2000 }]}>
            <Input.TextArea rows={8} maxLength={2000} showCount placeholder='含义、使用场景、例句；不确定的出处请注明' />
          </Form.Item>
          <Form.Item name='enabled' label='启用' valuePropName='checked'>
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </Layout.Content>
  );
}
