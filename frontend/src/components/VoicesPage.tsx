import { useUnsavedNavigation } from './useUnsavedNavigation';
import { useEffect, useState } from 'react';
import { App, Alert, Button, Form, Input, Modal, Layout, Select, InputNumber, Space, Switch, Table, Tag, Typography } from 'antd';

type Voice = { id: string; name: string; enabled?: boolean; speech: Record<string, unknown>; ttsVoice?: string; balanceUrl?: string; probeUrl?: string };
type Settings = {
  legacyAvailable?: boolean;
  originalSpeech?: { engine: string; edgeVoice?: string; systemVoice?: string; fallback: boolean };
  localSpeech: { enabled: boolean; fallback: boolean; voice?: string };
  revision: string;
  activeVoice: string;
  voices: Voice[];
};
type Row = { id: string; engine: string; balance?: { text: string; status?: string; checkedAt: number }; probe?: { status: string; checkedAt: number } };
async function request(path: string, body?: unknown) {
  const response = await fetch('./api/admin/voices' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message || '操作失败');
  return result;
}
export default function VoicesPage() {
  const { message, modal } = App.useApp();
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState('');
  const [previewText, setPreviewText] = useState('你好，我是肥鱼。今天也要好好照顾自己。');
  const [audio, setAudio] = useState<{ url: string; engine: string; fallback: string; name: string }>();
  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio.url);
    },
    [audio]
  );
  useUnsavedNavigation(dirty);
  const [settings, setSettings] = useState<Settings>();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Voice | null>();
  const [filter, setFilter] = useState('all');
  const [form] = Form.useForm();
  const engine = Form.useWatch(['speech', 'engine'], form) || 'auto';
  const closeEditor = () => {
    if (busy) return;
    if (dirty)
      modal.confirm({
        title: '放弃未保存的音色修改？',
        onOk: () => {
          setDirty(false);
          setEditing(undefined);
        }
      });
    else setEditing(undefined);
  };
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
    const { legacyAvailable: _legacyAvailable, originalSpeech: _originalSpeech, ...payload } = next;
    const result = await request('/settings', payload);
    setSettings(result.data);
    message.success(result.message);
    setRows((await request('')).data.voices);
  };
  const diagnose = (path: string, id?: string) => run(async () => setRows((await request(path, id ? { id } : {})).data.voices));
  const open = (voice: Voice | null) => {
    setEditing(voice);
    setDirty(false);
    form.resetFields();
    form.setFieldsValue(
      voice
        ? { ...voice, speech: { ...voice.speech, engine: voice.speech.engine || 'auto', fallback: voice.speech.fallback !== false } }
        : { id: '', name: '', enabled: true, speech: { engine: 'system', fallback: true }, ttsVoice: '', balanceUrl: '', probeUrl: '' }
    );
  };
  const preview = (id: string, name: string) =>
    run(async () => {
      const response = await fetch('./api/admin/voices/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text: previewText }),
        signal: AbortSignal.timeout(65000)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '试听失败');
      }
      const blob = await response.blob();
      setAudio({
        url: URL.createObjectURL(blob),
        engine: response.headers.get('X-Speech-Engine') || '未知',
        fallback: response.headers.get('X-Speech-Fallback') || '',
        name
      });
    });
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>音色库</Typography.Title>
      {settings && (
        <Alert
          type='info'
          showIcon
          title={`当前使用：${settings.activeVoice ? settings.voices.find(v => v.id === settings.activeVoice)?.name || settings.activeVoice : '配置文件 speech'}`}
          description={
            settings.activeVoice
              ? `音色库默认项优先。直接修改 media.speech 不会覆盖它；原始 speech 当前引擎：${settings.originalSpeech?.engine || 'auto'}${settings.originalSpeech?.edgeVoice ? ' / ' + settings.originalSpeech.edgeVoice : ''}。`
              : `直接使用 media.speech：${settings.originalSpeech?.engine || 'auto'}${settings.originalSpeech?.edgeVoice ? ' / ' + settings.originalSpeech.edgeVoice : ''}`
          }
        />
      )}
      {settings?.legacyAvailable && (
        <Alert
          type='info'
          title='配置文件 speech 中的音色尚未收录到列表'
          description='可追加到音色列表并设为默认，已有音色会保留。'
          action={
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await request('/migrate', { revision: settings.revision });
                  await refresh();
                  message.success('原有音色已迁入并设为默认');
                })
              }
            >
              迁入音色库
            </Button>
          }
        />
      )}

      <Alert
        type='info'
        showIcon
        title='供应商余额独立查询；未知额度不当作零。测活成功不代表能合成或额度已恢复。'
        description='本地兜底需要同时开启本地音色、本地兜底和当前音色的 fallback。Edge TTS 需要联网，不属于本地系统音色。测活不代表实际合成成功。'
      />
      {settings &&
        settings.voices.some(
          v => v.id === settings.activeVoice && (v.enabled === false || (v.speech.engine === 'system' && !settings.localSpeech.enabled))
        ) && <Alert type='warning' showIcon title='当前默认音色已停用或本地引擎已关闭，请切换默认音色或重新启用。' />}
      {settings && (
        <Form layout='vertical' style={{ marginTop: 16 }}>
          <Space wrap align='start'>
            <Form.Item label='启用本机系统 TTS（system）'>
              <Switch
                checked={settings.localSpeech.enabled}
                disabled={busy}
                onChange={enabled => run(() => save({ ...settings, localSpeech: { ...settings.localSpeech, enabled } }))}
              />
            </Form.Item>
            <Form.Item label='允许降级到系统 TTS'>
              <Switch
                checked={settings.localSpeech.fallback}
                disabled={busy || !settings.localSpeech.enabled}
                onChange={fallback => run(() => save({ ...settings, localSpeech: { ...settings.localSpeech, fallback } }))}
              />
            </Form.Item>
            <Form.Item label='系统 TTS 的声音名称（可留空）'>
              <Input.Search
                key={settings.revision}
                defaultValue={settings.localSpeech.voice || ''}
                maxLength={200}
                disabled={busy}
                enterButton='保存音色'
                onSearch={voice => run(() => save({ ...settings, localSpeech: { ...settings.localSpeech, voice } }))}
              />
            </Form.Item>
          </Space>
          <Typography.Paragraph type='secondary'>
            此区域只管理 system 引擎：使用运行机器安装的声音（例如 macOS 的 Tingting）。Edge 使用下方独立的 Edge 音色项，例如 zh-TW-HsiaoChenNeural，不受 system
            启停开关控制。
          </Typography.Paragraph>
        </Form>
      )}
      <Space direction='vertical' style={{ width: '100%', marginBottom: 16 }}>
        <Input.TextArea value={previewText} onChange={e => setPreviewText(e.target.value)} maxLength={200} showCount rows={2} aria-label='试听文本' />
        <Space wrap>
          <Button disabled={busy || !settings || !previewText.trim()} onClick={() => preview(settings?.activeVoice || '', '当前默认音色')}>
            试听默认音色
          </Button>
          <Typography.Text type='secondary'>试听使用已保存配置，远程合成可能消耗供应商额度。</Typography.Text>
        </Space>
        {audio && (
          <>
            <Typography.Text>
              {audio.name} · 实际引擎：{audio.engine}
              {audio.fallback ? ` · 已从 ${audio.fallback} 降级` : ''}
            </Typography.Text>
            <audio controls src={audio.url} />
          </>
        )}
      </Space>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder='搜索音色名称、ID或引擎' value={query} onChange={e => setQuery(e.target.value)} allowClear />
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
            { value: 'edge', label: 'Edge 音色' },
            { value: 'system', label: '系统音色' },
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
            { value: '', label: `使用配置文件 speech（${settings?.originalSpeech?.engine || 'auto'}）` },
            ...(settings?.voices || []).map(v => ({ value: v.id, label: v.name + (v.enabled === false ? '（已停用）' : ''), disabled: v.enabled === false }))
          ]}
        />
      </Space>
      <Space wrap style={{ marginBottom: 16 }}>
        <Button
          disabled={busy || !settings}
          onClick={() => {
            open(null);
            form.setFieldsValue({ name: 'Edge 晓臻（台湾）', speech: { engine: 'edge', fallback: true, edgeVoice: 'zh-TW-HsiaoChenNeural' } });
          }}
        >
          新增 Edge 音色
        </Button>
        <Button
          disabled={busy || !settings}
          onClick={() => {
            open(null);
            form.setFieldsValue({ name: '本机系统音色', speech: { engine: 'system', fallback: false } });
          }}
        >
          新增系统音色
        </Button>
      </Space>
      <Table
        rowKey='id'
        scroll={{ x: 950 }}
        loading={busy}
        dataSource={(settings?.voices || [])
          .filter(v => [v.id, v.name, String(v.speech.engine || 'auto')].some(value => value.toLowerCase().includes(query.toLowerCase())))
          .filter(
            v =>
              filter === 'all' ||
              (filter === 'edge' || filter === 'system'
                ? v.speech.engine === filter
                : filter === 'enabled'
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
                  {v.speech.engine === 'edge'
                    ? ` · ${String(v.speech.edgeVoice || 'zh-CN-XiaoyiNeural')}`
                    : v.speech.engine === 'system'
                      ? ` · ${String(settings?.localSpeech.voice || v.speech.systemVoice || '系统默认')}`
                      : ''}
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
            title: '允许降级',
            render: (_, v: Voice) => (
              <Switch
                checked={v.speech.fallback !== false}
                disabled={busy}
                onChange={fallback =>
                  settings &&
                  run(() =>
                    save({ ...settings, voices: settings.voices.map(item => (item.id === v.id ? { ...item, speech: { ...item.speech, fallback } } : item)) })
                  )
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
                <Button disabled={busy || v.enabled === false || !previewText.trim()} onClick={() => preview(v.id, v.name)}>
                  试听
                </Button>
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
        onCancel={closeEditor}
        maskClosable={false}
        confirmLoading={busy}
        onOk={() =>
          run(async () => {
            const values = await form.validateFields();
            const voice = { ...values, speech: { ...editing?.speech, ...values.speech } };
            for (const key of Object.keys(voice.speech)) if (voice.speech[key] === '') delete voice.speech[key];
            for (const field of ['ttsVoice', 'balanceUrl', 'probeUrl']) if (!voice[field]) delete voice[field];
            if (!settings) return;
            await save({ ...settings, voices: editing ? settings.voices.map(v => (v.id === editing.id ? voice : v)) : [...settings.voices, voice] });
            setDirty(false);
            setEditing(undefined);
          })
        }
      >
        <Form form={form} layout='vertical' disabled={busy} onValuesChange={() => setDirty(true)}>
          <Form.Item name='id' label='音色ID' rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }]}>
            <Input disabled={Boolean(editing)} />
          </Form.Item>
          <Form.Item name='name' label='名称' rules={[{ required: true }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name='enabled' label='启用' valuePropName='checked'>
            <Switch />
          </Form.Item>
          <Form.Item name={['speech', 'engine']} label='合成引擎' rules={[{ required: true }]}>
            <Select
              options={['auto', 'system', 'edge', 'openai', 'breeze', 'cosyvoice', 'gptsovits', 'http'].map(value => ({
                value,
                label:
                  (
                    { auto: '自动选择', system: '本机系统 TTS', edge: 'Edge TTS（联网）', openai: 'OpenAI 兼容接口（共享 media.tts）' } as Record<
                      string,
                      string
                    >
                  )[value] || value
              }))}
            />
          </Form.Item>
          <Form.Item name={['speech', 'fallback']} label='失败后允许降级' valuePropName='checked'>
            <Switch />
          </Form.Item>
          {engine === 'system' && (
            <Form.Item name={['speech', 'systemVoice']} label='系统音色名称（全局本地音色名称优先）'>
              <Input />
            </Form.Item>
          )}
          {engine === 'edge' && (
            <Form.Item name={['speech', 'edgeVoice']} label='Edge 声音 ID（支持自定义）' rules={[{ required: true, whitespace: true }]}>
              <Input placeholder='例如 zh-TW-HsiaoChenNeural（台湾晓臻）' />
            </Form.Item>
          )}
          {['breeze', 'cosyvoice', 'gptsovits'].includes(engine) && (
            <Form.Item name={['speech', 'url']} label='服务地址' rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          )}
          {['breeze', 'cosyvoice', 'gptsovits', 'http'].includes(engine) && (
            <Form.Item name={['speech', 'apiKey']} label='API Key（保留占位符即保留原密钥）' rules={[{ required: engine === 'breeze' }]}>
              <Input.Password autoComplete='new-password' />
            </Form.Item>
          )}
          {engine === 'breeze' && (
            <>
              <Form.Item name={['speech', 'voiceId']} label='供应商音色 ID' rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name={['speech', 'instruction']} label='语气指令'>
                <Input />
              </Form.Item>
            </>
          )}
          {engine === 'cosyvoice' && (
            <Form.Item name={['speech', 'speaker']} label='说话人'>
              <Input placeholder='中文女' />
            </Form.Item>
          )}
          {engine === 'gptsovits' && (
            <>
              <Form.Item name={['speech', 'referenceAudio']} label='服务端参考音频路径' rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name={['speech', 'referenceText']} label='参考音频文本'>
                <Input />
              </Form.Item>
            </>
          )}
          {engine === 'http' && (
            <Form.Item name={['speech', 'urlTemplate']} label='URL 模板（必须包含 {text}）' rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          )}
          {['breeze', 'gptsovits'].includes(engine) && (
            <Form.Item name={['speech', 'language']} label='语言'>
              <Input placeholder='zh' />
            </Form.Item>
          )}
          {['cosyvoice', 'gptsovits'].includes(engine) && (
            <Form.Item name={['speech', 'sampleRate']} label='采样率'>
              <InputNumber min={8000} max={48000} placeholder='22050' />
            </Form.Item>
          )}
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
    </Layout.Content>
  );
}
