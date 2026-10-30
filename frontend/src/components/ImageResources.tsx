import { useState } from 'react';
import { Alert, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { imageResources, type ImageResource } from './image-resources';

export default function ImageResources({ disabled, onAdd }: { disabled: boolean; onAdd: (name: string, baseUrl: string) => void }) {
  const [query, setQuery] = useState('');
  return (
    <Space direction='vertical' style={{ width: '100%' }}>
      <Alert
        type='info'
        showIcon
        title='国内外生图服务 · 2026-10-31 核查'
        description='含需要注册的服务。收录不代表已接通；填写配置后需补充本人密钥和模型，保存并试生成。费用、模型权限和地区限制以平台为准。'
      />
      <Input.Search
        aria-label='搜索生图服务资源'
        placeholder='搜索服务、国内/海外、模型或接入方式'
        value={query}
        allowClear
        onChange={e => setQuery(e.target.value)}
      />
      <Table<ImageResource>
        rowKey='id'
        size='small'
        scroll={{ x: 850 }}
        pagination={{ pageSize: 5 }}
        dataSource={imageResources.filter(item =>
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
            title: '模型与接入状态',
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
                {item.baseUrl && (
                  <Button size='small' disabled={disabled} onClick={() => onAdd(item.name, item.baseUrl!)}>
                    填写配置
                  </Button>
                )}
              </Space>
            )
          }
        ]}
      />
    </Space>
  );
}
