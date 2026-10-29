import { useUnsavedNavigation } from './useUnsavedNavigation';
import { useEffect, useState } from 'react';
import { App, Alert, Button, Collapse, Drawer, Form, Input, Layout, Space, Select, Table, Tag, Typography } from 'antd';

type Entry = {
  id: string;
  revision?: string;
  name?: string;
  prompt?: string;
  details?: Record<string, string>;
  privateRules?: string;
  socialRules?: string;
  additions?: string;
  builtin?: boolean;
  question?: string;
  answer?: string;
  origin?: string;
  keywords?: string[];
  tags?: string[];
  hits?: number;
  score?: number;
  error?: string;
  updatedAt?: number;
  scope?: string;
  kind?: string;
};
const detailHints: Record<string, string> = {
  家庭关系: '成员姓名、年龄、职业、相处方式、独居原因与联系安排；区分角色家庭和平台主人',
  工作简历: '按年龄阶段填写培训、岗位、职责、成果和转岗原因；对齐收入与工作时间',
  穿着习惯: '常穿的搭配、材质、场景变化与小配饰',
  饮食习惯: '主食、每日大致饭量、几顿与时间、口味和吃饭小习惯；虚构TOKEN食量与真实用量分开',
  居住习惯: '空间布局、收纳、清洁、睡眠环境与居家偏好',
  出行习惯: '常去的地方、交通偏好、随身物件与行程节奏；不当作已经发生的经历',

  情绪机制: '触发点 → 外在表现 → 持续多久 → 如何恢复；分别描述开心、生气和低落',
  语言指纹: '句式、语气词、常用与禁用表达；对新人、熟人和认真求助分别怎样说',
  关系网络: '重要对象、关系定位、亲疏边界；区分虚构背景与真实互动',
  作息表: '注明时区，按时间段写精神状态和表达习惯；不作为自动执行计划',
  欲望与恐惧: '最想得到什么、害怕失去什么、两者冲突时怎样选择',
  缺陷与成长弧: '当前缺点、容易犯的错、改变的契机与仍然保留的小毛病'
};
type Session = { platform: string; channelId: string; personaId?: string; effectivePersonaId: string; mode: string };
export default function ContentPage({ kind }: { kind: 'personas' | 'knowledge' }) {
  const [preview, setPreview] = useState('');
  const [detailFields, setDetailFields] = useState<string[]>([]);
  const persona = kind === 'personas';
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Entry[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Entry>();
  const [platform, setPlatform] = useState('');
  const [channelId, setChannelId] = useState('');
  const [form] = Form.useForm();
  const [appliedScope, setAppliedScope] = useState({ platform: '', channelId: '' });
  const [mode, setMode] = useState<string>();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Entry[]>();
  const [appendText, setAppendText] = useState('');
  const [editingDirty, setEditingDirty] = useState(false);
  useUnsavedNavigation(open && (editingDirty || Boolean(appendText)));
  const call = async (path: string, body?: unknown) => {
    const response = await fetch('./api/admin/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '操作失败');
    return data.data;
  };
  const operate = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      await call(path, body);
      message.success('已更新');
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const request = async (body?: unknown) => {
    const query = !persona && platform && channelId ? '?' + new URLSearchParams({ platform, channelId }) : '';
    const response = await fetch('./api/admin/' + kind + query, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '操作失败');
    return data;
  };
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const [result, currentSessions] = await Promise.all([request(), call('sessions')]);
      setSessions(currentSessions);
      setRows(result.data);
      setAppliedScope({ platform, channelId });
      setMatches(undefined);
      if (persona) {
        setMode((await call('persona-style')).mode);
        setDetailFields(await call('persona-detail-fields'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setRows([]);
    setPlatform('');
    setChannelId('');
    void load();
  }, [kind]);
  const edit = (row?: Entry) => {
    setAppendText('');
    setEditingDirty(false);
    setSelected(row);
    form.resetFields();
    form.setFieldsValue(row || {});
    setOpen(true);
  };
  const selectedSession = sessions.find(item => item.platform === platform && item.channelId === channelId);
  const applyPersona = async (id?: string) => {
    if (!selectedSession) return;
    if (
      !(await modal.confirm({ title: id ? '将此人设应用到所选会话？' : '恢复所选会话的默认人设？', content: '将结束当前话题并清空近期上下文，开始新话题。' }))
    )
      return;
    if (await operate('persona-selection', { platform, channelId, id })) await load();
  };
  const deleteKnowledge = async (row: Entry) => {
    if (!(await modal.confirm({ title: '删除这条问答？', content: row.question + '。删除后不再参与知识检索。' }))) return;
    if (
      await operate('knowledge/edit', {
        id: row.id,
        updatedAt: row.updatedAt,
        scope: row.scope === 'global' ? 'global' : 'session',
        ...appliedScope,
        action: 'delete'
      })
    )
      await load();
  };
  return (
    <Layout.Content className='workspace-content'>
      <Space className='workspace-page-heading' style={{ width: '100%', justifyContent: 'space-between' }} size={16} wrap>
        <Typography.Title level={2} style={{ margin: 0 }}>
          {persona ? '人设' : '问答库'}
        </Typography.Title>
        <Space>
          <Button onClick={load} loading={busy}>
            刷新
          </Button>
          <Button type='primary' onClick={() => edit()}>
            {persona ? '创建人设' : '添加问答'}
          </Button>
        </Space>
      </Space>
      {persona && (
        <Space style={{ marginBottom: 16 }}>
          <Typography.Text>默认表达程度</Typography.Text>
          <Select
            aria-label='默认表达程度'
            style={{ width: 120 }}
            value={mode}
            disabled={busy}
            options={['活跃', '个性', '工作', '专业'].map(value => ({ value, label: value }))}
            onChange={async value => {
              await operate('persona-style', { mode: value });
              setMode((await call('persona-style')).mode);
            }}
          />
        </Space>
      )}
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          aria-label='选择会话'
          style={{ width: 320 }}
          showSearch
          optionFilterProp='label'
          value={platform ? JSON.stringify([platform, channelId]) : ''}
          disabled={busy}
          options={[
            { value: '', label: persona ? '选择要应用人设的会话' : '全局知识' },
            ...sessions.map(item => ({ value: JSON.stringify([item.platform, item.channelId]), label: item.platform + ' · ' + item.channelId }))
          ]}
          onChange={value => {
            const [nextPlatform, nextChannel] = value ? JSON.parse(value) : ['', ''];
            setPlatform(nextPlatform);
            setChannelId(nextChannel);
          }}
          notFoundContent='暂无已记录会话'
        />
        {persona ? (
          selectedSession && (
            <>
              <Tag>当前人设：{rows.find(row => row.id === selectedSession.effectivePersonaId)?.name || selectedSession.effectivePersonaId}</Tag>
              <Button disabled={busy || !selectedSession.personaId} onClick={() => applyPersona()}>
                恢复默认
              </Button>
            </>
          )
        ) : (
          <>
            <Button disabled={busy} onClick={load}>
              查看
            </Button>
            <Tag>{appliedScope.platform ? appliedScope.platform + ' / ' + appliedScope.channelId : '全局知识'}</Tag>
          </>
        )}
      </Space>
      {!persona && (
        <Space wrap style={{ marginBottom: 16 }}>
          <Input aria-label='检索试验问题' placeholder='输入问题，验证知识匹配' value={query} onChange={e => setQuery(e.target.value)} />
          <Button
            disabled={busy || !query.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                setMatches(await call('knowledge/search', { query, ...appliedScope }));
              } catch (e) {
                message.error(e instanceof Error ? e.message : '检索失败');
              } finally {
                setBusy(false);
              }
            }}
          >
            检索试验
          </Button>
          {matches && <Button onClick={() => setMatches(undefined)}>返回列表</Button>}
        </Space>
      )}
      {error && <Alert type='error' showIcon title={error} style={{ marginBottom: 16 }} />}
      {persona && (
        <Space style={{ marginBottom: 16 }} wrap>
          <Button
            disabled={busy}
            onClick={async () => {
              try {
                const result = await call('persona-preview', { platform, channelId });
                setPreview(result.prompt);
              } catch (e) {
                message.error(String(e));
              }
            }}
          >
            预览已保存的群聊设定
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              try {
                const result = await call('persona-preview', { platform, channelId, private: true, owner: true });
                setPreview(result.prompt);
              } catch (e) {
                message.error(String(e));
              }
            }}
          >
            预览已保存的主人私聊设定
          </Button>
          <Typography.Text type='secondary'>按所选会话或默认人设合并；不包含未保存修改。</Typography.Text>
        </Space>
      )}
      <Drawer title='最终人设预览' open={Boolean(preview)} onClose={() => setPreview('')} size={720}>
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{preview}</Typography.Paragraph>
      </Drawer>
      <Table<Entry>
        rowKey='id'
        loading={busy}
        dataSource={matches || rows}
        scroll={{ x: 650 }}
        columns={
          persona
            ? [
                { title: '人设', dataIndex: 'name' },
                { title: '来源', render: (_, row) => <Tag>{row.builtin ? '预设' : '自定义'}</Tag> },
                { title: '标签', render: (_, row) => row.tags?.join('、') },
                {
                  title: '操作',
                  render: (_, row) => (
                    <Space>
                      <Button disabled={busy || Boolean(row.error)} onClick={() => edit(row)}>
                        编辑
                      </Button>
                      <Button disabled={busy || !selectedSession || Boolean(row.error)} onClick={() => applyPersona(row.id)}>
                        应用到会话
                      </Button>
                    </Space>
                  )
                }
              ]
            : [
                { title: '问题', dataIndex: 'question' },
                { title: '来源', dataIndex: 'origin', render: value => ({ builtin: '内置', learned: '学习', explicit: '手动' })[value as string] || value },
                { title: matches ? '匹配分数' : '命中', dataIndex: matches ? 'score' : 'hits' },
                {
                  title: '操作',
                  render: (_, row) => (
                    <Space>
                      <Button disabled={busy} onClick={() => edit(row)}>
                        编辑
                      </Button>
                      <Button danger disabled={busy} onClick={() => deleteKnowledge(row)}>
                        删除
                      </Button>
                    </Space>
                  )
                }
              ]
        }
        pagination={{ pageSize: 15 }}
      />
      <Drawer
        title={persona ? (selected ? '编辑人设' : '创建人设') : selected ? '编辑问答' : '添加问答'}
        open={open}
        onClose={async () => {
          if (busy) return;
          if ((editingDirty || appendText) && !(await modal.confirm({ title: '放弃未保存的修改？' }))) return;
          setOpen(false);
        }}
        size={640}
        extra={
          <Button
            type='primary'
            loading={busy}
            onClick={async () => {
              try {
                const values = await form.validateFields();
                if (persona && appendText.trim()) {
                  message.warning('请先点击“追加”保存追加设定，再保存人物档案。');
                  return;
                }
                if (persona && Object.values(values.details || {}).join('').length > 10000) {
                  message.error('人物细节累计不能超过10000字');
                  return;
                }
                setBusy(true);
                if (!persona && selected) {
                  await call('knowledge/edit', {
                    ...values,
                    keywords: selected.keywords,
                    tags: selected.tags,
                    kind: selected.kind,
                    id: selected.id,
                    updatedAt: selected.updatedAt,
                    scope: selected.scope === 'global' ? 'global' : 'session',
                    ...appliedScope,
                    action: 'save'
                  });
                } else {
                  await request(
                    persona
                      ? { revision: selected?.revision || '', ...selected, ...values }
                      : { ...values, scope: appliedScope.platform ? 'session' : 'global', ...appliedScope }
                  );
                }
                message.success('已保存');
                setOpen(false);
                await load();
              } catch (e) {
                if (e instanceof Error) {
                  setError(e.message);
                  message.error(e.message);
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        }
      >
        <Form disabled={busy} form={form} onValuesChange={() => setEditingDirty(true)} layout='vertical'>
          {persona ? (
            <>
              <Form.Item name='id' label='编号' rules={[{ required: true }, { pattern: /^[a-z][a-z0-9-]{0,63}$/, message: '使用小写字母开头的编号' }]}>
                <Input disabled={Boolean(selected)} />
              </Form.Item>
              <Form.Item name='name' label='名称' rules={[{ required: true, max: 40 }]}>
                <Input />
              </Form.Item>
              <Form.Item name='prompt' label='基础角色设定（保留）' rules={[{ required: true, max: 12000 }]}>
                <Input.TextArea autoSize={{ minRows: 8 }} />
              </Form.Item>
              <Alert type='info' title='人物细节是补充，不替代基础设定和追加设定。留空会沿用基础设定；作息仅用于人物表达。' style={{ marginBottom: 16 }} />
              <Collapse
                style={{ marginBottom: 16 }}
                items={[
                  {
                    key: 'details',
                    label: '人物档案 · 生活与性格细节（累计最多10000字）',
                    forceRender: true,
                    children: detailFields.map(field => (
                      <Form.Item key={field} name={['details', field]} label={field} rules={[{ max: 1200 }]}>
                        <Input.TextArea
                          autoSize={{ minRows: 2, maxRows: 8 }}
                          maxLength={1200}
                          showCount
                          placeholder={detailHints[field] || `补充${field}，不填写则保留基础设定`}
                        />
                      </Form.Item>
                    ))
                  }
                ]}
              />
              <Form.Item name='privateRules' label='私聊规则'>
                <Input.TextArea rows={3} />
              </Form.Item>
              <Form.Item name='socialRules' label='群聊规则'>
                <Input.TextArea rows={3} />
              </Form.Item>
              {selected?.additions && <Typography.Paragraph>追加设定：{selected.additions}</Typography.Paragraph>}
            </>
          ) : (
            <>
              <Form.Item name='question' label='问题' rules={[{ required: true, min: 2, max: 300, whitespace: true }]}>
                <Input.TextArea rows={3} />
              </Form.Item>
              <Form.Item name='answer' label='标准答案' rules={[{ required: true, max: 1200, whitespace: true }]}>
                <Input.TextArea autoSize={{ minRows: 8 }} />
              </Form.Item>
            </>
          )}
        </Form>
        {persona && selected && (
          <Space orientation='vertical' style={{ width: '100%' }}>
            <Input.TextArea
              aria-label='追加人设内容'
              value={appendText}
              maxLength={4000}
              rows={3}
              placeholder='追加设定'
              onChange={e => setAppendText(e.target.value)}
            />
            <Space>
              <Button
                disabled={busy || !appendText.trim()}
                onClick={async () => {
                  if (!(await operate('persona-additions', { id: selected.id, text: appendText }))) return;
                  setAppendText('');
                  const updated = await call('personas');
                  setRows(updated);
                  setSelected(updated.find((item: Entry) => item.id === selected.id));
                }}
              >
                追加
              </Button>
              <Button
                danger
                disabled={busy || !selected.additions}
                onClick={async () => {
                  if (!(await modal.confirm({ title: '清空此人设的追加设定？' }))) return;
                  if (!(await operate('persona-additions', { id: selected.id, clear: true }))) return;
                  setSelected({ ...selected, additions: '' });
                  await load();
                }}
              >
                清空追加
              </Button>
            </Space>
          </Space>
        )}
      </Drawer>
    </Layout.Content>
  );
}
