import { useEffect, useMemo, useState } from 'react';
import { DEPENDENCY_LABELS, loadDependencyIssues, type DependencyIssuesReport, type DependencyState } from '../../services/dependencyGovernance';

export default function DependencyIssues({ onOpen }: { onOpen: (slug: string) => void }) {
  const [report, setReport] = useState<DependencyIssuesReport | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<DependencyState | 'all'>('all');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    setReport(null); setError('');
    loadDependencyIssues().then(result => { if (alive) setReport(result); }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '依赖检查失败，请重试'); });
    return () => { alive = false; };
  }, [attempt]);
  const items = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (report?.items || []).filter(item => (status === 'all' || item.dependency.status === status) && (!term || [item.name, item.slug, item.dependency.name, item.dependency.slug, ...(item.dependency.candidates || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)));
  }, [report, query, status]);
  return <section className="p-6 pt-4 flex flex-col gap-4" aria-label="依赖问题">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-base font-semibold">依赖问题</h2><p className="text-xs text-t3 mt-1 leading-6">检查当前版本引用的外部技能。请由资源负责人修正清单并发布新版本。</p></div>
      <button className="btn-ghost shrink-0" disabled={!report && !error} onClick={() => setAttempt(value => value + 1)}>重新检查</button>
    </div>
    {error ? <div role="alert" className="card p-4 text-sm text-danger flex items-center justify-between gap-4"><span>{error}</span><button className="btn-ghost" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : !report ? <p role="status" className="text-sm text-t3 py-8">正在检查资源依赖…</p> : <>
      {report.errors.length > 0 && <div role="alert" className="rounded-xl border border-danger/30 bg-dangerSoft/40 p-4 text-sm"><p className="font-medium text-danger">部分资源检查失败，以下结果不完整</p><ul className="mt-2 space-y-1 text-xs">{report.errors.map((item, index) => <li key={`${item.slug}-${index}`} className="break-words"><code>{item.slug}</code>：{item.message}</li>)}</ul></div>}
      {!!report.warnings?.length && <details className="card p-4 text-xs text-t2"><summary className="cursor-pointer">{report.warnings.length} 条检查提示</summary><ul className="mt-3 space-y-2 max-h-[180px] overflow-y-auto">{report.warnings.map((item, index) => <li key={`${item.slug}-${index}`} className="break-words"><code>{item.slug}</code>：{item.message}</li>)}</ul></details>}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-t2 flex items-center gap-2">依赖状态<select value={status} onChange={event => setStatus(event.target.value as DependencyState | 'all')} className="h-9 rounded-lg border border-line bg-card text-t1 px-3"><option value="all">全部状态</option>{Object.entries(DEPENDENCY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <input aria-label="搜索依赖问题" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索资源、依赖名称或标识" className="h-9 w-[300px] rounded-lg border border-line bg-card px-3 text-xs" />
        <span className="ml-auto text-xs text-t3">已检查 {report.scanned} 个资源 · {items.length} 条结果</span>
      </div>
      {items.length === 0 ? <div className="card py-10 text-sm text-center text-t3">{report.items.length ? '没有符合筛选条件的依赖问题' : report.errors.length ? '已完成检查的资源中未发现依赖问题，仍需处理上述检查失败项' : '当前版本未发现依赖问题'}</div> : <div className="card overflow-x-auto"><table className="w-full text-left text-xs min-w-[760px]"><thead className="bg-soft text-t3"><tr><th className="px-4 py-3 font-medium">引用资源</th><th className="px-4 py-3 font-medium">外部依赖</th><th className="px-4 py-3 font-medium">状态</th><th className="px-4 py-3 font-medium">操作</th></tr></thead><tbody>{items.map((item, index) => <tr key={`${item.slug}-${item.dependency.id}-${index}`} className="border-t border-line align-top">
        <td className="px-4 py-4 max-w-[260px]"><div className="font-medium text-sm break-words">{item.name}</div><code className="block text-t3 mt-1 break-all">{item.slug}</code><div className="text-t3 mt-2">{item.kind === 'agent' ? '智能体' : 'AI 技能'} · {item.version} · {item.status === 'disabled' ? '已停用' : '启用中'}</div></td>
        <td className="px-4 py-4 max-w-[340px]"><div className="font-medium break-words">{item.dependency.name}</div><code className="block text-t3 mt-1 break-all">{item.dependency.slug || '未指定标识'}</code><div className="text-t3 mt-2">{item.dependency.required ? '必需依赖' : '可选依赖'} · 清单 ID：{item.dependency.id}</div>{!!item.dependency.candidates?.length && <p className="mt-2 break-all text-t2">候选标识：{item.dependency.candidates.join('、')}</p>}</td>
        <td className="px-4 py-4 whitespace-nowrap"><span className={`pill ${item.dependency.status === 'planned' ? 'bg-soft text-t2' : 'bg-dangerSoft text-danger'}`}>{DEPENDENCY_LABELS[item.dependency.status]}</span></td>
        <td className="px-4 py-4"><button aria-label={`查看${item.name}`} className="btn-ghost !text-xs whitespace-nowrap" onClick={() => onOpen(item.slug)}>查看资源</button></td>
      </tr>)}</tbody></table></div>}
    </>}
  </section>;
}
