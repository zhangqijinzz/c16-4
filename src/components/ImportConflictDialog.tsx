import { useEffect } from 'react';
import type { PendingImport } from '../model';

interface ImportConflictDialogProps {
  pending: PendingImport;
  currentImageName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatExportedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知日期';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ImportConflictDialog({ pending, currentImageName, onConfirm, onCancel }: ImportConflictDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" role="presentation" onPointerDown={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" onPointerDown={(event) => event.stopPropagation()}>
        <p className="eyebrow">IMPORT WORKSPACE</p>
        <h2 id="import-dialog-title">导入会替换当前工作台</h2>
        <p className="modal-text">
          当前打开的是 <strong>{currentImageName}</strong>。导入后，图片、辅助层、主体标记、裁切方案和当前裁切状态都会被文件中的版本替换，且此操作无法撤销。
        </p>
        <div className="modal-summary">
          <p className="modal-summary-label">文件内工作台（导出于 {formatExportedAt(pending.exportedAt)}）</p>
          <ul>
            <li><span>图片</span><strong>{pending.imageName}</strong></li>
            <li><span>裁切方案</span><strong>{pending.variants} 个</strong></li>
            <li><span>开启的辅助层</span><strong>{pending.guidesEnabled} 个</strong></li>
            <li><span>主体标记</span><strong>{pending.hasSubject ? '有' : '无'}</strong></li>
          </ul>
        </div>
        <div className="modal-actions">
          <button className="quiet-button" onClick={onCancel} autoFocus>取消，保留当前工作台</button>
          <button className="danger-button" onClick={onConfirm}>替换当前工作台</button>
        </div>
      </div>
    </div>
  );
}
