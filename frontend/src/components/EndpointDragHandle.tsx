import { useEffect, useRef, useState } from 'react';
import { HolderOutlined } from '@ant-design/icons';
import { Button } from 'antd';

export default function EndpointDragHandle({ id, disabled, onMove }: { id: string; disabled: boolean; onMove: (target: string) => void }) {
  const session = useRef<{ pointer: number; active: boolean; timer: ReturnType<typeof setTimeout>; button: HTMLButtonElement; x: number; y: number } | null>(
    null
  );
  const highlighted = useRef<Element | null>(null);
  const [active, setActive] = useState(false);
  const [target, setTarget] = useState('');
  const clearHighlight = () => {
    highlighted.current?.classList.remove('endpoint-drop-target');
    highlighted.current = null;
  };
  const hit = (x: number, y: number) => {
    const row = document.elementFromPoint(x, y)?.closest('[data-endpoint-id]');
    const value = row?.getAttribute('data-endpoint-id') || '';
    clearHighlight();
    if (row && value !== id) {
      row.classList.add('endpoint-drop-target');
      highlighted.current = row;
    }
    setTarget(value);
    return value;
  };
  const cleanup = () => {
    const current = session.current;
    session.current = null;
    if (current) {
      clearTimeout(current.timer);
      if (current.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer);
    }
    clearHighlight();
    setActive(false);
    setTarget('');
  };
  useEffect(() => {
    if (disabled) cleanup();
    const cancel = () => cleanup();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      cleanup();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape);
    };
  }, [disabled]);
  return (
    <Button
      size='small'
      type='text'
      icon={<HolderOutlined />}
      disabled={disabled}
      aria-label={`长按拖动 ${id} 调整顺序`}
      aria-pressed={active}
      title={active ? (target && target !== id ? `释放移到 ${target} 的位置` : '拖拽已激活，请移到目标行后释放') : '长按300毫秒后拖动，释放排序'}
      style={{
        touchAction: 'none',
        userSelect: 'none',
        cursor: active ? 'grabbing' : 'grab',
        color: active ? '#1677ff' : undefined,
        background: active ? '#e6f4ff' : undefined
      }}
      onContextMenu={event => event.preventDefault()}
      onDragStart={event => event.preventDefault()}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        cleanup();
        const button = event.currentTarget;
        button.setPointerCapture(event.pointerId);
        const current = {
          pointer: event.pointerId,
          active: false,
          button,
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(() => {
            if (session.current !== current) return;
            current.active = true;
            setActive(true);
            hit(current.x, current.y);
          }, 300)
        };
        session.current = current;
      }}
      onPointerMove={event => {
        const current = session.current;
        if (!current || current.pointer !== event.pointerId) return;
        current.x = event.clientX;
        current.y = event.clientY;
        if (current.active) {
          event.preventDefault();
          hit(event.clientX, event.clientY);
        }
      }}
      onPointerUp={event => {
        const current = session.current;
        if (!current || current.pointer !== event.pointerId) return;
        const value = current.active ? hit(event.clientX, event.clientY) : '';
        cleanup();
        if (!disabled && value && value !== id) onMove(value);
      }}
      onPointerCancel={cleanup}
      onLostPointerCapture={cleanup}
    />
  );
}
