import { Alert, Empty, Modal, Space, Typography } from 'antd';
import type { ReactNode } from 'react';

export function Feedback({ kind = 'info', children }: { kind?: 'info' | 'success' | 'error' | 'warning'; children: ReactNode }) {
  return <Alert type={kind} showIcon title={children} />;
}

export function EmptyState({ icon, title, description, action }: { icon?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <Empty
      image={icon ? <span style={{ fontSize: 32 }}>{icon}</span> : Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Space orientation='vertical'>
          <Typography.Text strong>{title}</Typography.Text>
          {description && <Typography.Text type='secondary'>{description}</Typography.Text>}
        </Space>
      }
    >
      {action}
    </Empty>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  onClose,
  onConfirm
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} title={title} onCancel={onClose} onOk={onConfirm} okText={confirmLabel} cancelText='取消'>
      <Typography.Paragraph>{description}</Typography.Paragraph>
    </Modal>
  );
}
