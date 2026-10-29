import { detectRuntimeMode, ensureRuntimeAPI } from '@/api/web-api';
import 'antd/dist/reset.css';
import '@/main.typings';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import router from './route';

// 统一入口：
// - desktop: 使用桌面容器注入的全局 API
// - web: 使用 HTTP /api 兼容层
// - unknown: 非浏览器环境，不初始化
window.__ALEMONJS_RUNTIME_MODE__ = detectRuntimeMode();
ensureRuntimeAPI();

const root = createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#6558dd', borderRadius: 8, colorBgLayout: '#f7f8fb' } }}>
      <App>
        <RouterProvider router={router} />
      </App>
    </ConfigProvider>
  </React.StrictMode>
);
