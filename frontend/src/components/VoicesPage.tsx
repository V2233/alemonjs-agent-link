import { useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';

type Voice = { id: string; name: string; enabled?: boolean; speech: Record<string, unknown>; ttsVoice?: string; balanceUrl?: string; probeUrl?: string };
type Settings = { revision: string; activeVoice: string; voices: Voice[] };
type Row = { id: string; engine: string; balance?: { text: string; status?: string; checkedAt: number }; probe?: { status: string; checkedAt: number } };
async function request(path: string, body?: unknown) {
  const response = await fetch('./api/admin/voices' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message || '操作失败');
  return result;
}
export default function VoicesPage() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<Settings>();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Voice | null>();
  const [filter, setFilter] = useState('all');
  const [form] = Form.useForm();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      message.error(String(error));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const [config, state] = await Promise.all([request('/settings'), request('')]);
    setSettings(config.data);
    setRows(state.data.voices);
  };
  useEffect(() => {
    void run(refresh);
  }, []);
  const save = async (next: Settings) => {
    const result = await request('/settings', next);
    setSettings(result.data);
    message.success(result.message);
    setRows((await request('')).data.voices);
  };
  const diagnose = (path: string, id?: string) => run(async () => setRows((await request(path, id ? { id } : {})).data.voices));
  const open = (voice: Voice | null) => {
    setEditing(voice);
    form.setFieldsValue(
      voice
        ? { ...voice, speech: JSON.stringify(voice.speech, null, 2) }
        : { id: '', name: '', enabled: true, speech: '{"engine":"system","fallback":true}', ttsVoice: '', balanceUrl: '', probeUrl: '' }
    );
  };
  return (
    <Space orientation='vertical' style={{ width: '100%' }} size='large'>
      <Typography.Title level={3}>音色库</Typography.Title>
      <Alert
        type='info'
        showIcon
        title='供应商余额独立查询；未知额度不当作零。测活成功不代表能合成或额度已恢复。'
        description='额度明确不足时按音色的 fallback 设置降级到本机。测活仅使用你配置的免费 GET 地址，不携带密钥。'
      />
      <Space wrap>
        <Button loading={busy} onClick={() => run(refresh)}>
          刷新
        </Button>
        <Button disabled={busy || !settings} onClick={() => open(null)}>
          新增音色
        </Button>
        <Button disabled={busy} onClick={() => diagnose('/balances')}>
          全部查额度
        </Button>
        <Button disabled={busy} onClick={() => diagnose('/probe')}>
          全部测活
        </Button>
        <Select
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部音色' },
            { value: 'enabled', label: '已启用' },
            { value: 'disabled', label: '已停用' },
            { value: 'exhausted', label: '额度不足' }
          ]}
        />
        <Select
          style={{ minWidth: 180 }}
          placeholder='默认音色'
          value={settings?.activeVoice || ''}
          disabled={busy || !settings}
          onChange={value => settings && run(() => save({ ...settings, activeVoice: value }))}
          options={[
            { value: '', label: '原有语音配置' },
            ...(settings?.voices || []).filter(v => v.enabled !== false).map(v => ({ value: v.id, label: v.name }))
          ]}
        />
      </Space>
      <Table
        rowKey='id'
        scroll={{ x: 950 }}
        dataSource={(settings?.voices || []).filter(
          v =>
            filter === 'all' ||
            (filter === 'enabled'
              ? v.enabled !== false
              : filter === 'disabled'
                ? v.enabled === false
                : rows.find(r => r.id === v.id)?.balance?.status === 'exhausted')
        )}
        columns={[
          {
            title: '音色',
            render: (_, v: Voice) => (
              <>
                {v.name} {settings?.activeVoice === v.id && <Tag>默认</Tag>}
                <br />
                <Typography.Text type='secondary'>
                  {v.id} · {String(v.speech.engine || 'auto')}
                </Typography.Text>
              </>
            )
          },
          {
            title: '启用',
            render: (_, v: Voice) => (
              <Switch
                checked={v.enabled !== false}
                disabled={busy}
                onChange={enabled =>
                  settings && run(() => save({ ...settings, voices: settings.voices.map(item => (item.id === v.id ? { ...item, enabled } : item)) }))
                }
              />
            )
          },
          {
            title: '供应商额度',
            render: (_, v: Voice) => {
              const b = rows.find(r => r.id === v.id)?.balance;
              return (
                <>
                  <Tag color={b?.status === 'exhausted' ? 'red' : undefined}>{b?.text || '未查询'}</Tag>
                  {b && <div>{new Date(b.checkedAt).toLocaleString()}</div>}
                </>
              );
            }
          },
          { title: '连通状态', render: (_, v: Voice) => rows.find(r => r.id === v.id)?.probe?.status || '未测活' },
          {
            title: '操作',
            render: (_, v: Voice) => (
              <Space wrap>
                <Button disabled={busy} onClick={() => diagnose('/balances', v.id)}>
                  查额度
                </Button>
                <Button disabled={busy} onClick={() => diagnose('/probe', v.id)}>
                  测活
                </Button>
                <Button disabled={busy} onClick={() => open(v)}>
                  编辑
                </Button>
                <Button
                  danger
                  disabled={busy || settings?.activeVoice === v.id}
                  onClick={() =>
                    Modal.confirm({
                      title: `删除音色 ${v.name}？`,
                      onOk: () => settings && run(() => save({ ...settings, voices: settings.voices.filter(item => item.id !== v.id) }))
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
      <Modal
        title={editing ? '编辑音色' : '新增音色'}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        confirmLoading={busy}
        onOk={() =>
          run(async () => {
            const values = await form.validateFields();
            const voice = { ...values, speech: JSON.parse(values.speech) };
            for (const field of ['ttsVoice', 'balanceUrl', 'probeUrl']) if (!voice[field]) delete voice[field];
            if (!settings) return;
            await save({ ...settings, voices: editing ? settings.voices.map(v => (v.id === editing.id ? voice : v)) : [...settings.voices, voice] });
            setEditing(undefined);
          })
        }
      >
        <Form form={form} layout='vertical'>
          <Form.Item name='id' label='音色ID' rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }]}>
            <Input disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item name='name' label='名称' rules={[{ required: true }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name='enabled' label='启用' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name='speech' label='引擎配置 JSON（沿用 speech 字段；保留密钥占位符）' rules={[{ required: true }]}>
            <Input.TextArea rows={7} />
          </Form.Item>
          <Form.Item name='ttsVoice' label='兼容接口音色ID'>
            <Input />
          </Form.Item>
          <Form.Item name='balanceUrl' label='额度查询 HTTPS 地址（包含 {key}）'>
            <Input />
          </Form.Item>
          <Form.Item name='probeUrl' label='供应商免费测活 HTTPS 地址（GET，不携带密钥）'>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
