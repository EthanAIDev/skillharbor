import { RESOLUTION_LABELS, type AgentGraph } from '../services/agentStructure';

export default function PackagePreview({ graph }: { graph: AgentGraph }) {
  return <section aria-label="上传包结构预览" className="rounded-xl border border-line p-3 text-xs space-y-3">
    <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">识别为{graph.kind === 'agent' ? '智能体' : 'AI 技能'}</h3><span className="text-t2">{graph.version}</span></div>
    <p className="text-t2 break-all">主入口：{graph.entry}</p>
    {graph.source === 'legacy' && <p className="text-t2">根据现有文件和调度表识别。请核对下方关系；需要明确入口或关系时，可添加包清单。</p>}
    <div><h4 className="font-medium mb-1">包内组件（{graph.components.length}）</h4>{graph.components.length ? <ul className="space-y-1 text-t2">{graph.components.map(c => <li key={c.id} className="break-all">{c.kind === 'script' ? '脚本' : '技能'} · {c.name} <span className="font-mono">{c.path}</span>{c.status === 'missing' && ' · 文件缺失'}</li>)}</ul> : <p className="text-t2">无</p>}</div>
    <div><h4 className="font-medium mb-1">外部依赖（{graph.dependencies.length}）</h4>{graph.dependencies.length ? <ul className="space-y-1 text-t2">{graph.dependencies.map(d => <li key={d.id} className="break-all">{d.name} · {RESOLUTION_LABELS[d.status]}{d.slug ? `（${d.slug}）` : ''}</li>)}</ul> : <p className="text-t2">无</p>}</div>
    {graph.warnings.length > 0 && <ul className="space-y-1 text-warn">{graph.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
  </section>;
}
