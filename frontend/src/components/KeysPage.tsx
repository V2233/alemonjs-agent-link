import { useEffect, useState } from 'react';
import { Alert, Button, Layout, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

type KeyRow = {
  id: string;
  ownerId: string;
  platform: string | null;
  userId: string | null;
  purpose: string;
  number: number | null;
  apiKey: string;
  auth: string;
  enabled: boolean;
  reason: string;
  grantRecords: number;
};
export default function KeysPage() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    fetch('./api/admin/keys', { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok || result.code !== 200) throw new Error(result.message || '读取钥匙列表失败');
        if (!controller.signal.aborted) setRows(result.data.keys);
      })
      .catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [refresh]);
  return (
    <Layout.Content className='workspace-content'>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={2}>钥匙列表</Typography.Title>
        <Button icon={<ReloadOutlined />} loading={busy} onClick={() => setRefresh(value => value + 1)}>
          刷新
        </Button>
      </Space>
      <Typography.Paragraph type='secondary'>
        用户绑定的个人钥匙与群聊钥匙库，包含停用项。钥匙统一显示为 ***，不读取明文。旧记录未保存用户账号时显示用户标识；授权记录数量包含尚未清理的历史记录。
      </Typography.Paragraph>
      {error && <Alert type='error' showIcon message={error} style={{ marginBottom: 16 }} />}
      <Table<KeyRow>
        rowKey='id'
        loading={busy}
        dataSource={rows}
        scroll={{ x: 800 }}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: '用户',
            dataIndex: 'userId',
            render: (value, row) => value || <Typography.Text title={row.ownerId}>旧记录 · {row.ownerId.slice(0, 12)}</Typography.Text>
          },
          { title: '平台', dataIndex: 'platform', render: value => value || '未记录' },
          { title: '用途', dataIndex: 'purpose', render: value => (value === 'personal' ? '个人钥匙' : '群聊钥匙库') },
          { title: '钥匙编号', dataIndex: 'number', render: value => value ?? '—' },
          { title: '钥匙', dataIndex: 'apiKey', render: value => <Typography.Text code>{value}</Typography.Text> },
          { title: '类型', dataIndex: 'auth', render: value => (value === 'account' ? '账号授权' : 'API Key') },
          { title: '授权记录数', dataIndex: 'grantRecords' },
          { title: '状态', dataIndex: 'enabled', render: value => <Tag color={value ? 'green' : 'default'}>{value ? '启用' : '停用'}</Tag> },
          { title: '停用原因', dataIndex: 'reason', render: value => ({ manual: '手动停用', balance: '余额不足', auth: '认证失败' })[value as string] || '—' }
        ]}
      />
    </Layout.Content>
  );
}
