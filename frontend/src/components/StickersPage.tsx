import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Image, Input, Layout, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useUnsavedNavigation } from './useUnsavedNavigation';
type Sticker = {
  id: string;
  name?: string;
  tags: string[];
  kind?: string;
  from?: string;
  uses?: number;
  bytes?: number;
  width?: number;
  height?: number;
  revision: string;
};
async function request(path = '', body?: unknown) {
  const response = await fetch('./api/admin/stickers' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '操作失败');
  return data.data;
}
export default function StickersPage() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Sticker[]>([]);
  const [capacity, setCapacity] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Sticker | null>();
  const [dirty, setDirty] = useState(false);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState('');
  const [form] = Form.useForm();
  useUnsavedNavigation(dirty);
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
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
      const data = await request();
      setRows(data.items);
      setCapacity(data.capacity);
      setError('');
    } catch (e) {
      setError(String(e));
      throw e;
    }
  };
  useEffect(() => {
    void run(load);
  }, []);
  const open = (item: Sticker | null) => {
    setEditing(item);
    setDirty(false);
    setFile(undefined);
    form.resetFields();
    form.setFieldsValue(item ? { ...item, tags: item.tags.join('，') } : { kind: 'sticker', tags: '' });
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
  const save = () =>
    run(async () => {
      const values = await form.validateFields();
      const tags = [
        ...new Set(
          String(values.tags || '')
            .split(/[,，\n]/)
            .map(s => s.trim())
            .filter(Boolean)
        )
      ];
      if (tags.length > 10 || tags.some(tag => tag.length > 20)) throw new Error('最多10个标签，每个最多20字');
      if (editing) await request('/edit', { id: editing.id, revision: editing.revision, name: values.name.trim(), tags });
      else {
        if (!file) throw new Error('请选择图片');
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('无法读取文件'));
          reader.readAsDataURL(file);
        });
        const result = await request('/upload', { name: values.name.trim(), tags, kind: values.kind, data });
        if (result.existing) message.info('图片已存在，已复用现有素材');
      }
      setDirty(false);
      setEditing(undefined);
      setFile(undefined);
      await load();
      message.success('已保存');
    });
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>表情管理</Typography.Title>
      <Typography.Paragraph type='secondary'>与聊天共用素材库。移除后不再参与选取，原文件保留；本页操作不修改 QQ 收藏。</Typography.Paragraph>
      {error && <Alert type='error' title={error} action={<Button onClick={() => run(load)}>重试</Button>} />}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder='搜索名称、ID或标签' value={query} onChange={e => setQuery(e.target.value)} allowClear />
        <Select
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '全部素材' },
            { value: 'sticker', label: '表情' },
            { value: 'avatar', label: '头像' }
          ]}
        />
        <Button loading={busy} onClick={() => run(load)}>
          刷新
        </Button>
        <Button type='primary' disabled={busy} onClick={() => open(null)}>
          上传素材
        </Button>
        <Typography.Text>
          {rows.length} / {capacity} 项
        </Typography.Text>
      </Space>
      <Table
        rowKey='id'
        loading={busy}
        scroll={{ x: 850 }}
        dataSource={rows.filter(
          item =>
            (kind === 'all' || (item.kind || 'sticker') === kind) &&
            [item.id, item.name || '', ...item.tags].some(text => text.toLowerCase().includes(query.toLowerCase()))
        )}
        columns={[
          {
            title: '预览',
            width: 100,
            render: (_, item) => (
              <Image width={72} height={72} style={{ objectFit: 'contain' }} src={'./api/admin/stickers/' + encodeURIComponent(item.id) + '/image'} />
            )
          },
          {
            title: '名称',
            render: (_, item) => (
              <>
                {item.name || item.id}
                <br />
                <Typography.Text type='secondary'>{item.id}</Typography.Text>
              </>
            )
          },
          { title: '类型', render: (_, item) => (item.kind === 'avatar' ? '头像' : '表情') },
          { title: '标签', render: (_, item) => item.tags.map(tag => <Tag key={tag}>{tag}</Tag>) },
          { title: '来源', dataIndex: 'from' },
          { title: '使用次数', render: (_, item) => item.uses || 0 },
          {
            title: '图片信息',
            render: (_, item) => (
              <>
                {item.width && item.height ? `${item.width}×${item.height}` : '未知尺寸'}
                <br />
                {item.bytes ? `${Math.ceil(item.bytes / 1024)} KB` : ''}
              </>
            )
          },
          {
            title: '操作',
            render: (_, item) => (
              <Space>
                <Button disabled={busy} onClick={() => open(item)}>
                  编辑
                </Button>
                <Button
                  danger
                  disabled={busy}
                  onClick={() =>
                    modal.confirm({
                      title: `移除“${item.name || item.id}”？`,
                      content: '原图片文件保留，聊天将不再选取该素材。',
                      onOk: () =>
                        run(async () => {
                          await request('/remove', { id: item.id, revision: item.revision });
                          await load();
                          message.success('已移除');
                        })
                    })
                  }
                >
                  移除
                </Button>
              </Space>
            )
          }
        ]}
      />
      <Modal title={editing ? '编辑素材' : '上传素材'} open={editing !== undefined} onCancel={close} maskClosable={false} confirmLoading={busy} onOk={save}>
        <Form form={form} layout='vertical' disabled={busy} onValuesChange={() => setDirty(true)}>
          {!editing && (
            <>
              <Form.Item label='图片（PNG、JPEG、WebP、GIF，最多5MB）' required>
                <input
                  type='file'
                  accept='image/png,image/jpeg,image/webp,image/gif'
                  disabled={busy}
                  onChange={e => {
                    const next = e.target.files?.[0];
                    if (next && next.size > 5 * 1024 * 1024) {
                      message.error('图片最多5MB');
                      e.target.value = '';
                      return;
                    }
                    setFile(next);
                    setDirty(true);
                  }}
                />
                {preview && <Image src={preview} width={120} />}
              </Form.Item>
              <Form.Item name='kind' label='素材类型' rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'sticker', label: '表情' },
                    { value: 'avatar', label: '头像' }
                  ]}
                />
              </Form.Item>
            </>
          )}
          <Form.Item name='name' label='名称' rules={[{ required: true, whitespace: true, max: 24 }]}>
            <Input maxLength={24} />
          </Form.Item>
          <Form.Item name='tags' label='标签（逗号分隔，最多10个，每个20字）'>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout.Content>
  );
}
