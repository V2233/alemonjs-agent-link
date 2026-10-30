import { useState } from 'react';
import { Alert, Button, Card, List, Space, Tag, Typography } from 'antd';

type Check = { id: string; label: string; state: 'ready' | 'disabled' | 'missing' | 'invalid'; detail: string };
type Report = { checkedAt: number; notice: string; checks: Check[] };
const labels = { ready: '本地检查通过', disabled: '已关闭', missing: '待处理', invalid: '配置无效' };
const colors = { ready: 'green', disabled: 'default', missing: 'gold', invalid: 'red' };

export default function BiliDiagnostics() {
  const [report, setReport] = useState<Report>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inspect = async () => {
    setBusy(true);
    setError(false);
    setReport(undefined);
    try {
      const response = await fetch('./api/admin/hobbies/diagnostics', { method: 'POST', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('检查失败');
      const result = await response.json();
      setReport(result.data);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title='B站阅读环境检查' style={{ marginTop: 16 }}>
      <Typography.Paragraph type='secondary'>
        检查已保存并加载的配置和本机视频工具。不会访问 B站或调用模型；平台登录有效性和识别质量需要实际阅读验证。
      </Typography.Paragraph>
      <Button onClick={() => void inspect()} loading={busy}>
        检查阅读环境
      </Button>
      {error && <Alert type='error' showIcon title='检查未完成，请稍后重试' style={{ marginTop: 12 }} />}
      {report && (
        <>
          <Typography.Paragraph type='secondary' style={{ marginTop: 12 }}>
            检查时间：{new Date(report.checkedAt).toLocaleString()}。修改或保存配置后，请重新检查。
          </Typography.Paragraph>
          <List
            dataSource={report.checks}
            renderItem={item => (
              <List.Item>
                <Space direction='vertical' size={4}>
                  <Space wrap>
                    <Typography.Text strong>{item.label}</Typography.Text>
                    <Tag color={colors[item.state]}>{labels[item.state]}</Tag>
                  </Space>
                  <Typography.Text>{item.detail}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
          <Typography.Paragraph type='secondary'>{report.notice}</Typography.Paragraph>
        </>
      )}
    </Card>
  );
}
