import { useEffect, useState } from 'react';
import { App, Button, Card, Image, Input, Layout, Select, Space, Tag, Typography } from 'antd';
type Item = { id: string; personaId: string; name: string; parentId: string; primary: boolean };
export default function AppearancesPage() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Item[]>([]);
  const [personas, setPersonas] = useState<{ id: string; name: string }[]>([]);
  const [persona, setPersona] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const call = async (path: string, body?: unknown) => {
    const response = await fetch('./api/admin/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '操作失败');
    return data.data;
  };
  const load = async () => {
    setBusy(true);
    try {
      const [items, people] = await Promise.all([call('appearances'), call('personas')]);
      setRows(items);
      setPersonas(people);
      setPersona(current => current || people[0]?.id || '');
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const act = async (id: string, action: string) => {
    setBusy(true);
    try {
      await call('appearances/edit', { id, action });
      await load();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    if (!file || !persona || !name.trim()) return;
    setBusy(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('图片最多5MB');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await call('appearances/upload', { personaId: persona, name: name.trim(), data: btoa(binary) });
      setFile(undefined);
      setName('');
      message.success('形象已上传');
      await load();
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>形象库</Typography.Title>
      <Typography.Paragraph>按人设保存形象。询问外貌时发送默认图，换装时以库中图片为参考，二创保留原图与来源。请先上传至少一张原始形象。</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 20 }}>
        <Select
          aria-label='形象所属人设'
          style={{ width: 180 }}
          value={persona}
          options={personas.map(p => ({ value: p.id, label: p.name }))}
          onChange={setPersona}
          disabled={busy}
        />
        <Input placeholder='形象名称，例如默认服装' maxLength={80} value={name} onChange={e => setName(e.target.value)} disabled={busy} />
        <input aria-label='上传形象图' type='file' accept='image/png,image/jpeg,image/webp' disabled={busy} onChange={e => setFile(e.target.files?.[0])} />
        <Button type='primary' loading={busy} disabled={!file || !name.trim() || !persona} onClick={upload}>
          上传
        </Button>
        <Button loading={busy} onClick={load}>
          刷新
        </Button>
      </Space>
      <Space wrap align='start'>
        {rows
          .filter(row => row.personaId === persona)
          .map(row => (
            <Card key={row.id} style={{ width: 260 }}>
              <Image alt={row.name} src={`./api/admin/appearances/${row.id}/image`} width='100%' height={220} style={{ objectFit: 'contain' }} />
              <Typography.Paragraph>{row.name}</Typography.Paragraph>
              <Space wrap>
                {row.primary && <Tag color='green'>默认形象</Tag>}
                {row.parentId && <Tag>二创版本</Tag>}
                <Button disabled={busy || row.primary} onClick={() => act(row.id, 'primary')}>
                  设为默认
                </Button>
                <Button
                  danger
                  disabled={busy}
                  onClick={() => modal.confirm({ title: '删除这个形象？', content: '存在二创版本时请先删除二创。', onOk: () => act(row.id, 'delete') })}
                >
                  删除
                </Button>
              </Space>
            </Card>
          ))}
      </Space>
      {!rows.some(row => row.personaId === persona) && <Typography.Paragraph type='secondary'>当前人设还没有形象，上传后聊天即可查找。</Typography.Paragraph>}
    </Layout.Content>
  );
}
