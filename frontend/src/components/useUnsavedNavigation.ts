import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { App } from 'antd';

export function useUnsavedNavigation(dirty: boolean) {
  const { modal } = App.useApp();
  const asking = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked' || asking.current) return;
    asking.current = true;
    void (async () => {
      try {
        const leave = await modal.confirm({ title: '离开当前页面？', content: '尚未保存的修改将丢失。', okText: '离开', cancelText: '继续编辑' });
        if (leave) blocker.proceed?.();
        else blocker.reset?.();
      } finally {
        asking.current = false;
      }
    })();
  }, [blocker, modal]);
}
