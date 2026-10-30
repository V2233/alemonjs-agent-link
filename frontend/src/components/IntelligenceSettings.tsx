import { useEffect, useState } from 'react';
import { Alert, Button, Card, Select, Space } from 'antd';
const call = async (body?: unknown) => {
  const response = await fetch('./api/admin/intelligence', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '操作失败');
  return result.data;
};
export default function IntelligenceSettings() {
  const [sessions, setSessions] = useState<{ platform: string; channelId: string; level?: string }[]>([]);
  const [target, setTarget] = useState<number>();
  const [level, setLevel] = useState('默认');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    call()
      .then(setSessions)
      .catch(e => setError(e.message));
  }, []);
  return (
    <Card title='会话智能程度' style={{ marginBottom: 20 }}>
      <p>按已记录会话设置多步工具执行程度；无有效 Key 的普通会话仍使用标准档。保留服务端工具上限。</p>
      {error && <Alert type='error' title={error} />}
      <Space wrap>
        <Select
          aria-label='目标会话'
          style={{ minWidth: 260 }}
          value={target}
          placeholder='选择会话'
          options={sessions.map((s, i) => ({ value: i, label: s.platform + ' · ' + s.channelId }))}
          onChange={i => {
            setTarget(i);
            setLevel(sessions[i].level || '默认');
          }}
        />
        <Select
          aria-label='智能程度'
          value={level}
          onChange={setLevel}
          options={['默认', '轻快', '标准', '深度', '专研'].map(value => ({ value, label: value }))}
        />
        <Button
          loading={busy}
          disabled={target === undefined}
          onClick={async () => {
            if (target === undefined) return;
            setBusy(true);
            setError('');
            try {
              setSessions(await call({ ...sessions[target], level }));
            } catch (e) {
              setError(e instanceof Error ? e.message : '保存失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </Space>
    </Card>
  );
}
