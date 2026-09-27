import type { GuideKey, Ratio } from '../model';

interface ToolbarProps {
  guides: Record<GuideKey, boolean>;
  ratio: string;
  hasDocument: boolean;
  onImport: (file: File) => void;
  onDemo: () => void;
  onToggleGuide: (guide: GuideKey) => void;
  onRatio: (ratio: Ratio) => void;
  onCompare: () => void;
  compareOpen: boolean;
  onExportWorkspace: () => void;
  onImportWorkspace: (file: File) => void;
}

const guideLabels: Array<[GuideKey, string, string]> = [
  ['thirds', '三分网格', '▦'],
  ['center', '中心线', '＋'],
  ['diagonal', '对角线', '／'],
  ['golden', '黄金区域', '◌'],
];

export function Toolbar(props: ToolbarProps) {
  return (
    <aside className="toolbar">
      <div className="toolbar-top">
        <label className="import-button">
          <span className="button-icon">＋</span> 导入图片
          <input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onImport(file); event.target.value = ''; }} />
        </label>
        <button className="quiet-button" onClick={props.onDemo}>示例图</button>
      </div>

      <div className="control-group">
        <div className="section-label"><span>辅助层</span><small>GUIDES</small></div>
        <div className="guide-grid">
          {guideLabels.map(([key, label, icon]) => (
            <button key={key} className={`guide-button ${props.guides[key] ? 'active' : ''}`} onClick={() => props.onToggleGuide(key)} aria-pressed={props.guides[key]}>
              <span>{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>

      <div className="control-group">
        <div className="section-label"><span>裁切比例</span><small>FORMAT</small></div>
        <div className="ratio-row">
          {(['free', '1:1', '4:5', '16:9'] as Ratio[]).map((item) => <button key={item} className={props.ratio === item ? 'active' : ''} onClick={() => props.onRatio(item)}>{item === 'free' ? '自由' : item}</button>)}
        </div>
      </div>

      <button className={`compare-button ${props.compareOpen ? 'active' : ''}`} onClick={props.onCompare}><span>◫</span> {props.compareOpen ? '返回工作台' : '打开前后对比'}</button>

      <div className="control-group workspace-file-group">
        <div className="section-label"><span>工作台文件</span><small>TRANSFER</small></div>
        <button className="workspace-button primary" onClick={props.onExportWorkspace} disabled={!props.hasDocument} title={props.hasDocument ? '导出当前工作台' : '载入图片后才能导出'}>
          <span>↥</span> 导出工作台
        </button>
        <label className={`workspace-button ${props.hasDocument ? 'warn' : ''}`}>
          <span>↧</span> 导入工作台
          <input type="file" accept=".framesense.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onImportWorkspace(file); event.target.value = ''; }} />
        </label>
        <small className="workspace-file-hint">文件包含图片、辅助层、主体与裁切方案，可在其他设备还原。</small>
      </div>
    </aside>
  );
}
