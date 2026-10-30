import { useState } from 'react';
import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { voiceResources, type VoiceResource } from './voice-resources';

export default function VoiceResources({ disabled, onAdd }: { disabled: boolean; onAdd: (name: string, voice: string) => void }) {
  const [query, setQuery] = useState('');
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Alert
        type='info'
        showIcon
        title='含需要注册的服务；收录不代表已接通或已试听'
        description='大肥鱼线索优先列出。价格、免费额度和音色权限以登录后的平台为准。添加音色模板后仍需配置对应服务并保存；不会自动替换当前默认声音。'
      />
      <Input.Search
        aria-label='搜索语音服务资源'
        placeholder='搜索服务、国内/海外、大肥鱼、注册或接入方式'
        allowClear
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <Table<VoiceResource>
        rowKey='id'
        size='small'
        scroll={{ x: 850 }}
        pagination={{ pageSize: 5 }}
        dataSource={voiceResources.filter(item =>
          [item.name, item.region, item.registration, item.note, item.integration].join(' ').toLowerCase().includes(query.trim().toLowerCase())
        )}
        columns={[
          {
            title: '服务 / 注册',
            width: 230,
            render: (_, item) => (
              <>
                <Typography.Text strong>{item.name}</Typography.Text>
                <br />
                <Tag>{item.region}</Tag>
                <div>{item.registration}</div>
              </>
            )
          },
          {
            title: '音色与接入状态',
            render: (_, item) => (
              <>
                {item.note}
                <Typography.Paragraph type='secondary'>{item.integration}</Typography.Paragraph>
              </>
            )
          },
          {
            title: '地址 / 添加',
            width: 180,
            render: (_, item) => (
              <Space direction='vertical'>
                <Typography.Link href={item.url} target='_blank' rel='noopener noreferrer'>
                  官网 / 注册入口
                </Typography.Link>
                <Typography.Link href={item.docs} target='_blank' rel='noopener noreferrer'>
                  文档 / 来源
                </Typography.Link>
                {item.voices?.map(voice => (
                  <Button key={voice.id} size='small' disabled={disabled} onClick={() => onAdd(voice.name, voice.id)}>
                    添加 {voice.name}
                  </Button>
                ))}
              </Space>
            )
          }
        ]}
      />
    </Space>
  );
}
