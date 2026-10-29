import { useRef, useState } from 'react';
import { HolderOutlined } from '@ant-design/icons';
import { Button } from 'antd';

export default function EndpointDragHandle({ id, disabled, onMove }: { id: string; disabled: boolean; onMove: (target: string) => void }) {
  const start = useRef<{ at: number; x: number; y: number } | null>(null);
  const [target, setTarget] = useState('');
  return (
    <Button
      size='small'
      type='text'
      icon={<HolderOutlined />}
      disabled={disabled}
      aria-label={`长按拖动 ${id} 调整顺序`}
      title={target ? `释放移到 ${target} 的位置` : '长按300毫秒后拖动，释放排序'}
      style={{ touchAction: 'none', cursor: 'grab', color: target ? '#1677ff' : undefined }}
      onPointerDown={event => {
        start.current = { at: Date.now(), x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!start.current) return;
        if (Date.now() - start.current.at < 300) {
          if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 8) start.current = null;
          return;
        }
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-endpoint-id]');
        setTarget(row?.getAttribute('data-endpoint-id') || '');
      }}
      onPointerUp={event => {
        const held = start.current && Date.now() - start.current.at >= 300;
        start.current = null;
        setTarget('');
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (held && target && target !== id) onMove(target);
      }}
      onPointerCancel={() => {
        start.current = null;
        setTarget('');
      }}
    />
  );
}
