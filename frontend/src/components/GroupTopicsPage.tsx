import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Layout, Modal, Popconfirm, Space, Switch, Table, Typography, App } from 'antd';

type Profile = {
  runs?: { stage: string; reason: string; at: number }[];
  activity?: { reason: string; analyzed_at: number; collected_at: number };
  id: string;
  platform: string;
  botId: string;
  channelId: string;
  positioning: string;
  tags: string[];
  blockedTags: string[];
  enabled: boolean;
  shareOut: boolean;
  receiveShared: boolean;
};
type Topic = { id: string; origin: string; summary: string; tags: string[]; sourceUrl?: string; publishedAt: number };
const request = async (path = '', body?: unknown) => {
  const response = await fetch('./api/admin/group-topics' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '操作失败');
  return result.data;
};
const split = (value = '') => value.split(/[,，\s]+/u).filter(Boolean);
export default function GroupTopicsPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<'profile' | 'news' | null>(null);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<{ topic: Topic; score: number }[] | null>(null);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const load = async () => {
    const data = await request();
    setProfiles(data.profiles);
    setTopics(data.topics);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(load);
  }, []);
  const edit = (profile?: Profile) => {
    form.resetFields();
    setEditing(Boolean(profile));
    form.setFieldsValue(
      profile
        ? { ...profile, tags: profile.tags.join(','), blockedTags: profile.blockedTags.join(',') }
        : { platform: 'qq', enabled: false, shareOut: false, receiveShared: false }
    );
    setEditor('profile');
  };
  const remove = (kind: string, id: string) =>
    run(async () => {
      await request('/remove', { kind, id });
      await load();
    });
  return (
    <Layout.Content className='workspace-content'>
      <Typography.Title level={2}>群话题库</Typography.Title>
      <Alert
        type='info'
        showIcon
        title='管理群定位、共享权限和候选内容。群消息自动建档、分析主题并周期采集；可纠正或关闭。定时发送尚未接通。视频只有搜索元数据，新闻由录入者核实。'
      />
      {error && <Alert type='error' showIcon title={error} />}
      <Space style={{ margin: '16px 0' }}>
        <Button disabled={busy} onClick={() => run(load)}>
          刷新
        </Button>
        <Button disabled={busy} onClick={() => edit()}>
          新增群档案
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            form.resetFields();
            setEditor('news');
          }}
        >
          录入新闻
        </Button>
      </Space>
      <Card title='群档案'>
        <Table
          rowKey='id'
          dataSource={profiles}
          loading={busy}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '群', render: (_, p: Profile) => `${p.platform} / ${p.channelId}` },
            { title: '定位', dataIndex: 'positioning' },
            {
              title: '处理状态',
              render: (_, p: Profile) => (
                <details>
                  <summary>{p.activity?.reason || '等待群消息'}</summary>
                  {p.runs?.map((run, i) => (
                    <div key={i}>
                      {new Date(run.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · {run.stage} · {run.reason}
                    </div>
                  ))}
                </details>
              )
            },
            { title: '标签', render: (_, p: Profile) => p.tags.join('、') },
            {
              title: '权限',
              render: (_, p: Profile) => `冒泡${p.enabled ? '开' : '关'} / 输出${p.shareOut ? '开' : '关'} / 接收${p.receiveShared ? '开' : '关'}`
            },
            {
              title: '操作',
              render: (_, p: Profile) => (
                <Space wrap>
                  <Button disabled={busy} onClick={() => edit(p)}>
                    编辑
                  </Button>
                  <Button disabled={busy} onClick={() => run(async () => setPreview(await request('/candidates?id=' + encodeURIComponent(p.id))))}>
                    候选
                  </Button>
                  <Button
                    disabled={busy || !p.enabled}
                    onClick={() =>
                      run(async () => {
                        const result = await request('/collect', { id: p.id });
                        message.success(`新增 ${result.added} 条线索`);
                        await load();
                      })
                    }
                  >
                    采集
                  </Button>
                  <Popconfirm title='删除档案及该群提供的话题？' onConfirm={() => remove('profile', p.id)}>
                    <Button danger disabled={busy}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              )
            }
          ]}
        />
      </Card>
      <Card title='有效话题' style={{ marginTop: 16 }}>
        <Table
          rowKey='id'
          dataSource={topics}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '摘要', dataIndex: 'summary' },
            { title: '类型', render: (_, t: Topic) => ({ news: '人工新闻', 'public-video': '视频线索', 'human-discussion': '群讨论' })[t.origin] || t.origin },
            { title: '标签', render: (_, t: Topic) => t.tags.join('、') },
            {
              title: '来源',
              render: (_, t: Topic) =>
                t.sourceUrl ? (
                  <a href={t.sourceUrl} target='_blank' rel='noreferrer'>
                    原文
                  </a>
                ) : (
                  '匿名讨论'
                )
            },
            {
              title: '操作',
              render: (_, t: Topic) => (
                <Popconfirm title='删除这条话题？' onConfirm={() => remove('topic', t.id)}>
                  <Button danger disabled={busy}>
                    删除
                  </Button>
                </Popconfirm>
              )
            }
          ]}
        />
      </Card>
      <Modal title={editor === 'profile' ? '群档案' : '录入已核实的公开新闻'} open={Boolean(editor)} onCancel={() => !busy && setEditor(null)} footer={null}>
        <Form
          form={form}
          layout='vertical'
          onFinish={values =>
            run(async () => {
              await request(editor === 'profile' ? '/profile' : '/news', {
                ...values,
                tags: split(values.tags),
                ...(editor === 'profile' ? { blockedTags: split(values.blockedTags) } : {})
              });
              setEditor(null);
              await load();
              message.success('已保存');
            })
          }
        >
          {editor === 'profile' ? (
            <>
              {['platform', 'botId', 'channelId', 'positioning'].map((name, i) => (
                <Form.Item key={name} name={name} label={['平台', '机器人 ID', '群 ID', '群定位'][i]} rules={[{ required: true, whitespace: true }]}>
                  <Input disabled={editing && i < 3} maxLength={300} />
                </Form.Item>
              ))}
              <Form.Item name='blockedTags' label='禁忌标签（逗号分隔）'>
                <Input />
              </Form.Item>
              {['enabled', 'shareOut', 'receiveShared'].map((name, i) => (
                <Form.Item key={name} name={name} label={['允许冒泡', '允许输出匿名话题', '接收其他群话题'][i]} valuePropName='checked'>
                  <Switch />
                </Form.Item>
              ))}
            </>
          ) : (
            <>
              {['url', 'date', 'summary'].map((name, i) => (
                <Form.Item
                  key={name}
                  name={name}
                  label={['HTTPS 原文链接', '发布日期 YYYY-MM-DD（今天或昨天）', '已核实的事实摘要'][i]}
                  rules={[{ required: true }]}
                >
                  <Input.TextArea autoSize maxLength={name === 'summary' ? 1200 : 2048} />
                </Form.Item>
              ))}
            </>
          )}
          <Form.Item name='tags' label='兴趣／主题标签（逗号分隔）' rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Button type='primary' htmlType='submit' loading={busy}>
            保存
          </Button>
        </Form>
      </Modal>
      <Modal title='本群候选（百分比为标签相似度）' open={preview !== null} onCancel={() => setPreview(null)} footer={null}>
        {preview?.length ? (
          preview.map(({ topic, score }) => (
            <Card key={topic.id} size='small' title={`${Math.round(score * 100)}% · ${topic.tags.join('、')}`}>
              {topic.summary}
            </Card>
          ))
        ) : (
          <Typography.Text>暂无候选，请检查权限、标签和来源时效。</Typography.Text>
        )}
      </Modal>
    </Layout.Content>
  );
}
