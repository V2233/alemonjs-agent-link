import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Breadcrumb, Button, Drawer, Flex, Grid, Layout, Menu, Space, Typography } from 'antd';
import { MenuOutlined, RobotOutlined, SwapOutlined } from '@ant-design/icons';
import './workspace.css';

export default function AdminLayout() {
  const screens = Grid.useBreakpoint();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const titles: Record<string, string> = {
    '/personas': '人设',
    '/knowledge': '知识库',
    '/dictionary': '热词词典',
    '/events': '事件库',
    '/rotation': '额度轮转',
    '/work-model': '工作模型'
  };
  const menu = (
    <Menu
      mode='inline'
      selectedKeys={[location.pathname]}
      items={[
        { key: '/personas', label: '人设' },
        { key: '/knowledge', label: '知识库' },
        { key: '/dictionary', label: '热词词典' },
        { key: '/events', label: '事件库' },
        { key: '/work-model', label: '工作模型', icon: <RobotOutlined /> },
        { key: '/rotation', label: '额度轮转', icon: <SwapOutlined /> }
      ]}
      onClick={({ key }) => {
        navigate(key);
        setOpen(false);
      }}
    />
  );
  return (
    <Layout className='workspace-shell'>
      {screens.lg && (
        <Layout.Sider width={248} theme='light' className='workspace-sider'>
          <Link to='/personas' style={{ textDecoration: 'none' }}>
            <Flex align='center' gap={12} className='workspace-brand'>
              <Avatar shape='square' style={{ background: '#6558dd' }} icon={<RobotOutlined />} />
              <Typography.Title level={4} style={{ margin: 0 }}>
                AgentLink
              </Typography.Title>
            </Flex>
          </Link>
          {menu}
        </Layout.Sider>
      )}
      <Drawer title='工作台' placement='left' open={open} onClose={() => setOpen(false)}>
        {menu}
      </Drawer>
      <Layout style={{ minWidth: 0 }}>
        <Layout.Header className='workspace-header'>
          <Space>
            {!screens.lg && <Button icon={<MenuOutlined />} aria-label='打开工作台菜单' onClick={() => setOpen(true)} />}
            <Breadcrumb items={[{ title: '工作台' }, { title: titles[location.pathname] || '工作台' }]} />
          </Space>
        </Layout.Header>
        <Outlet />
      </Layout>
    </Layout>
  );
}
