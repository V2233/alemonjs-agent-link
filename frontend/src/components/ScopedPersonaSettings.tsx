import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space } from 'antd';
const call = async (path: string, body?: unknown) => {
  const response = await fetch('./api/admin/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '操作失败');
  return result.data;
};
export default function ScopedPersonaSettings() {
  const [sessions, setSessions] = useState<{ platform: string; channelId: string }[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [target, setTarget] = useState<number>();
  const [field, setField] = useState<string>();
  const [details, setDetails] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => {
    Promise.all([call('sessions'), call('persona-detail-fields')])
      .then(([s, f]) => {
        setSessions(s);
        setFields(f);
      })
      .catch(e => setError(e.message));
  }, []);
  return (
    <Card title='个人／群专属人设' style={{ marginBottom: 20 }}>
      <p>编辑所选会话的独立细节，不修改全局模板。对应指令：/人设 编辑 字段 内容。</p>
      {error && <Alert type='error' title={error} />}
      <Space direction='vertical' style={{ width: '100%' }}>
        <Select
          aria-label='人设目标会话'
          style={{ minWidth: 280 }}
          disabled={busy}
          value={target}
          placeholder='选择会话'
          options={sessions.map((s, i) => ({ value: i, label: s.platform + ' · ' + s.channelId }))}
          onChange={async i => {
            const v = ++version.current;
            setTarget(i);
            setField(undefined);
            setText('');
            setDetails({});
            setBusy(true);
            setError('');
            try {
              const d = await call('scoped-persona/read', sessions[i]);
              if (v === version.current) setDetails(d);
            } catch (e) {
              setError(e instanceof Error ? e.message : '读取失败');
              setTarget(undefined);
            } finally {
              setBusy(false);
            }
          }}
        />
        <Select
          aria-label='专属人设字段'
          style={{ minWidth: 200 }}
          disabled={busy || target === undefined}
          value={field}
          placeholder='选择字段'
          options={fields.map(value => ({ value, label: value }))}
          onChange={value => {
            setField(value);
            setText(details[value] || '');
          }}
        />
        <Input.TextArea
          aria-label='专属人设内容'
          rows={4}
          maxLength={1200}
          disabled={busy || !field}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder='留空清除此字段的专属设置'
        />
        <Button
          loading={busy}
          disabled={target === undefined || !field}
          onClick={async () => {
            if (target === undefined || !field) return;
            setBusy(true);
            setError('');
            try {
              const next = { ...details };
              if (text.trim()) next[field] = text.trim();
              else delete next[field];
              setDetails(await call('scoped-persona', { ...sessions[target], details: next, expected: details }));
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          保存本会话细节
        </Button>
      </Space>
    </Card>
  );
}
