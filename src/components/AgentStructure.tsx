import type { ReactNode } from 'react';
import { RESOLUTION_LABELS, type AgentGraph, type PackageComponent, type PackageDependency } from '../services/agentStructure';

interface Props {
  graph: AgentGraph;
  name: string;
  onComponent: (component: PackageComponent) => void;
  onDependency: (dependency: PackageDependency) => void;
}

/** A target's namespace and availability come from the gateway, including package-local scripts. */
export default function AgentStructure({ graph, name, onComponent, onDependency }: Props) {
  const used = new Set(graph.steps.flatMap(step => step.targets));
  const target = (ref: string): ReactNode => {
    const separator = ref.indexOf(':');
    const scope = ref.slice(0, separator); const id = ref.slice(separator + 1);
    const item = scope === 'component' ? graph.components.find(c => c.id === id) : graph.dependencies.find(d => d.id === id);
    if (!item) return <div key={ref} className="rounded-lg border border-line p-3 text-xs text-t2">{ref} · 未解析的引用</div>;
    const component = scope === 'component' ? item as PackageComponent : null;
    const dependency = scope === 'dependency' ? item as PackageDependency : null;
    const available = item.status === 'ready' && (!!component || !!dependency?.slug);
    const label = component ? (component.kind === 'script' ? '包内脚本' : '包内技能') : graph.source === 'legacy' ? '关联技能' : dependency?.required ? '必需依赖' : '可选依赖';
    const body = <>
      <span className="flex items-start justify-between gap-2"><span className="font-semibold break-words">{item.name}</span><span className="pill bg-soft text-t2 !text-[10px] shrink-0">{label}</span></span>
      <span className="block text-[11px] text-t2 font-mono break-all mt-1">{component?.path || dependency?.slug || item.id}</span>
      <span className={`block text-[11px] mt-1 ${available ? 'text-accentText' : 'text-t2'}`}>{component && item.status === 'missing' ? '包内文件缺失' : RESOLUTION_LABELS[item.status]}</span>
      {dependency?.status === 'ambiguous' && dependency.candidates?.length ? <span className="block text-[11px] text-t2 mt-1">候选：{dependency.candidates.join('、')}</span> : null}
    </>;
    const cls = 'rounded-lg border border-line p-3 text-left text-xs min-w-0';
    return available ? <button key={ref} type="button" className={`${cls} hover:border-accent hover:bg-accentSoft/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`} onClick={() => component ? onComponent(component) : dependency && onDependency(dependency)}>{body}</button>
      : <div key={ref} className={`${cls} bg-soft/40`}>{body}</div>;
  };
  const otherTargets = [...graph.components.map(c => `component:${c.id}`), ...graph.dependencies.map(d => `dependency:${d.id}`)].filter(ref => !used.has(ref));
  return <section className="rounded-xl border border-line p-4 flex flex-col flex-1 min-h-0 overflow-hidden" aria-label="智能体结构">
    <div className="flex items-center justify-between gap-3 mb-3 shrink-0"><h3 className="text-sm font-semibold">智能体结构</h3><span className="text-[11px] text-t2">包内组件 {graph.components.length} · 外部依赖 {graph.dependencies.length}</span></div>
    <div role="group" aria-label="智能体结构内容" tabIndex={0} className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] pr-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
    <div className="rounded-lg bg-accentSoft border border-accent/25 px-3 py-2 mb-4"><div className="text-xs font-semibold">{name}</div><div className="text-[11px] text-t2 mt-1">主编排 · {graph.entry} · {graph.version}</div></div>
    <div className="grid grid-cols-2 gap-x-4 gap-y-5 items-start">
      {graph.steps.map((step, index) => <div key={step.id} className="min-w-0 [overflow-wrap:anywhere]">
        <div className="text-xs font-medium mb-2">{index + 1}. {step.task}{step.executor === 'self' && <span className="ml-2 text-t2 font-normal">主技能执行</span>}</div>
        {(step.input || step.output) && <p className="text-[11px] text-t2 mb-2">{step.input || '—'} → {step.output || '—'}</p>}
        <div className="grid grid-cols-1 gap-2">{step.targets.map(target)}</div>
      </div>)}
      {otherTargets.length > 0 && <div className="col-span-2 min-w-0"><h4 className="text-xs font-medium mb-2">{graph.steps.length ? '其他包内组件与依赖' : '组件与依赖'}</h4><div className="grid grid-cols-2 gap-2">{otherTargets.map(target)}</div></div>}
      {!graph.steps.length && !otherTargets.length && <p className="col-span-2 text-xs text-t2">尚未声明组件与分派关系，可在包清单中补充。</p>}
    </div>
    {graph.warnings.length > 0 && <details className="mt-4 border-t border-line pt-3 text-xs text-t2"><summary className="cursor-pointer">结构检查提示（{graph.warnings.length}）</summary><ul className="mt-2 list-disc pl-4 space-y-1">{graph.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
    </div>
  </section>;
}
