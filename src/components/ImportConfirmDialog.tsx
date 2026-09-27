import { useEffect } from 'react';
import type { PendingImport } from '../model';

interface ImportConfirmDialogProps {
  pending: PendingImport;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatExportedAt(value: string | null): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString();
}

export function ImportConfirmDialog({ pending, onConfirm, onCancel }: ImportConfirmDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const { document, fileName, exportedAt } = pending;
  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" onPointerDown={(event) => event.stopPropagation()}>
        <p className="eyebrow">IMPORT WORKSPACE</p>
        <h2 id="import-dialog-title">导入将替换当前工作区</h2>
        <p className="modal-text">
          文件 <strong>「{fileName}」</strong> 校验通过。继续导入会<strong>整体替换</strong>当前正在编辑的全部内容，
          包括当前图片、辅助层、主体标记、当前裁切状态和已保存的裁切方案；此操作无法撤销。
        </p>
        <dl className="import-summary">
          <div><dt>图片</dt><dd>{document.image?.name ?? '—'}</dd></div>
          <div><dt>导出时间</dt><dd>{formatExportedAt(exportedAt)}</dd></div>
          <div><dt>辅助层</dt><dd>{Object.values(document.guides).filter(Boolean).length} 个开启</dd></div>
          <div><dt>裁切方案</dt><dd>{document.variants.length} 个</dd></div>
        </dl>
        <p className="modal-text subtle">当前内容只会在你确认后被覆盖；选择「取消」则一切保持原样。</p>
        <div className="modal-actions">
          <button className="quiet-button" onClick={onCancel}>取消</button>
          <button className="primary-button" onClick={onConfirm} autoFocus>替换并导入</button>
        </div>
      </div>
    </div>
  );
}
