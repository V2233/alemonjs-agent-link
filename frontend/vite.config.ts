import react from '@vitejs/plugin-react-swc';
import { readFileSync } from 'fs';
import { fileURLToPath, URL } from 'url';
import { defineConfig } from 'vite';
const NODE_ENV = process.env.NODE_ENV === 'development';
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')) as { version?: string };
const __PORT__ = 17178;
export default defineConfig({
  base: NODE_ENV ? '/' : './',
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${__PORT__}/app/api/`,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0')
  },
  plugins: [
      // React SWC 编译
      react(),

  ],
  resolve: {
    alias: [
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url))
      }
    ]
  },
  esbuild: {
    drop: NODE_ENV ? [] : ['console', 'debugger']
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    },
    minify: 'terser',
    terserOptions: {
      compress: NODE_ENV
        ? {}
        : {
            drop_console: true,
            drop_debugger: true
          }
    },
    rollupOptions: {
      output: {
        dir: '../dist',
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name].[ext]',
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/antd/') || id.includes('/@ant-design/') || id.includes('/@rc-component/')) return 'antd';
          if (id.includes('/echarts') || id.includes('/zrender/')) return 'charts';
          if (id.includes('/@uiw/react-markdown-preview/') || id.includes('/rehype-')) return 'markdown';
        }
      }
    }
  }
});
