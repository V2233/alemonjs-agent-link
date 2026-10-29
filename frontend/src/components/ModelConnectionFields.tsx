import { useEffect, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Form, Input, Select, Space } from 'antd';
import type { FormInstance } from 'antd';
export default function ModelConnectionFields({ form, providers = [], addresses = [] }: { form: FormInstance; providers?: string[]; addresses?: string[] }) {
  const baseUrl = Form.useWatch('baseUrl', form);
  const apiKey = Form.useWatch('apiKey', form);
  const provider = Form.useWatch('provider', form);
  const model = Form.useWatch('model', form);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const serial = useRef(0);
  useEffect(() => {
    serial.current++;
    setModels([]);
    setError('');
    setBusy(false);
  }, [baseUrl, apiKey, provider]);
  const load = async () => {
    const ticket = ++serial.current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('./api/admin/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseUrl || (provider === 'deepseek-official' ? 'https://api.deepseek.com' : ''), apiKey }),
        signal: AbortSignal.timeout(15000)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '模型列表查询失败');
      if (ticket !== serial.current) return;
      setModels(result.data);
      if (!result.data.length) setError('供应商返回空模型列表，请核对地址和密钥权限。');
    } catch (e) {
      if (ticket === serial.current) setError(e instanceof Error ? e.message : '查询失败');
    } finally {
      if (ticket === serial.current) setBusy(false);
    }
  };
  return (
    <>
      <Form.Item name='provider' label='供应商' rules={[{ required: true }]}>
        <AutoComplete
          options={[...new Set(['deepseek-official', 'openai-compatible', ...providers])].map(value => ({ value }))}
          placeholder='选择或输入供应商'
          filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())}
        />
      </Form.Item>
      <Form.Item name='baseUrl' label='请求地址' rules={[{ required: true }]}>
        <AutoComplete
          options={[...new Set(['https://api.deepseek.com', 'https://api.openai.com/v1', ...addresses])].filter(Boolean).map(value => ({ value }))}
          placeholder='选择或输入完整 API 基础地址'
        />
      </Form.Item>
      <Form.Item name='apiKey' label='API Key'>
        <Input.Password autoComplete='off' />
      </Form.Item>
      <Space style={{ marginBottom: 12 }}>
        <Button loading={busy} disabled={!apiKey} onClick={load}>
          获取模型列表
        </Button>
      </Space>
      {error && <Alert type='warning' showIcon title={error} style={{ marginBottom: 12 }} />}
      <Form.Item name='model' label='模型' rules={[{ required: true }]}>
        <Select
          showSearch
          placeholder='先获取模型列表，再选择模型'
          options={[...new Set([...models, ...(model ? [model] : [])])].map(value => ({
            value,
            label: models.includes(value) ? value : `${value}（当前配置）`
          }))}
        />
      </Form.Item>
    </>
  );
}
