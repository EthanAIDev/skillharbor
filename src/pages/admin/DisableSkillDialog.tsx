import { useEffect, useRef, useState } from 'react';
import { ZbModal } from '../../components/ZbModal';
import { api } from '../../services/api';
import { loadDependents, type DependentsReport } from '../../services/dependencyGovernance';

interface Props { slug: string; name: string; onClose: () => void; onDisabled: () => void }
export default function DisableSkillDialog({ slug, name, onClose, onDisabled }: Props) {
  const [report, setReport] = useState<DependentsReport | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let alive = true;
    setReport(null); setError(''); setActionError('');
    loadDependents(slug).then(result => { if (alive) setReport(result); }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '依赖影响查询失败，请重试'); });
    return () => { alive = false; };
  }, [slug, attempt]);
  const canDisable = !!report && report.slug === slug && report.errors.length === 0 && !error && !busy;
  const disable = async () => {
    if (!canDisable || submitting.current) return;
    submitting.current = true; setBusy(true); setActionError('');
    try {
      const result = await api.gateway.setStatus(slug, 'disabled');
      if (!result || result.ok === false || result.detail) throw new Error(result?.message || (typeof result?.detail === 'string' ? result.detail : '请求失败，请重试'));
      onDisabled();
    } catch (reason) { setActionError('操作失败：' + (reason instanceof Error ? reason.message : '网络连接中断，请重试')); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <ZbModal open onClose={() => { if (!busy) onClose(); }} dismissible={!busy} label="停用资源影响确认" maxWidth="max-w-[760px]" className="max-h-[90vh] flex flex-col overflow-hidden">
    <div className="shrink-0 flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">停用「{name}」</h2><code className="block text-xs text-t3 mt-1 break-all">{slug}</code></div><button aria-label="关闭停用确认" disabled={busy} onClick={onClose} className="btn-ghost shrink-0">✕</button></div>
    <p className="shrink-0 text-sm text-t2 mt-4 leading-6">停用后，该资源将从门户和后续技能同步中隐藏。请先确认以下引用关系。</p>
    <div className="min-h-0 overflow-y-auto overscroll-contain mt-4 space-y-3 pr-1">
      {error ? <div role="alert" className="rounded-xl bg-dangerSoft/40 p-4 text-sm"><p className="text-danger">{error}</p><p className="text-t2 mt-2">影响检查未完成，暂时无法停用。</p><button className="btn-ghost mt-2" onClick={() => setAttempt(value => value + 1)}>重试检查</button></div> : !report || report.slug !== slug ? <p role="status" className="text-sm text-t3 py-6">正在检查引用此资源的智能体与技能…</p> : <>
        {!!report.errors.length && <div role="alert" className="rounded-xl border border-danger/30 bg-dangerSoft/40 p-4 text-sm"><p className="font-medium text-danger">部分资源检查失败，暂时无法停用</p><ul className="mt-2 space-y-1 text-xs">{report.errors.map((item, index) => <li key={`${item.slug}-${index}`} className="break-words"><code>{item.slug}</code>：{item.message}</li>)}</ul><button className="btn-ghost mt-2" onClick={() => setAttempt(value => value + 1)}>重试检查</button></div>}
        {!!report.warnings?.length && <details className="rounded-xl bg-soft p-3 text-xs text-t2"><summary className="font-medium cursor-pointer">其他结构检查提示（{report.warnings.length}）</summary><ul className="mt-2 space-y-1">{report.warnings.map((item, index) => <li key={`${item.slug}-${index}`} className="break-words"><code>{item.slug}</code>：{item.message}</li>)}</ul></details>}
        {report.items.length ? <><p className="text-sm font-medium">发现 {new Set(report.items.map(item => item.slug)).size} 个引用资源，{report.items.length} 条引用关系</p>{report.items.map((item, index) => <div key={`${item.slug}-${item.dependencyId}-${index}`} className="rounded-xl border border-line p-4 text-xs"><div className="flex justify-between items-start gap-3"><div className="min-w-0"><p className="text-sm font-medium break-words">{item.name}</p><code className="block text-t3 mt-1 break-all">{item.slug}</code></div><span className="pill bg-soft text-t2 shrink-0">{item.status === 'disabled' ? '已停用' : '启用中'}</span></div><p className="text-t3 mt-2">{item.kind === 'agent' ? '智能体' : 'AI 技能'} · {item.version} · {item.required ? '必需依赖' : '可选依赖'} · 清单 ID：{item.dependencyId}</p>{item.resolution === 'ambiguous' && <p className="text-danger mt-2">可能引用：该资源是多个候选之一，需要核对清单中的准确标识。</p>}{item.selfReference && <p className="text-t2 mt-2">这是资源自身的引用。</p>}{!!item.steps?.length && <ul className="mt-2 space-y-1 text-t2">{item.steps.map((step, stepIndex) => <li key={`${step.id}-${stepIndex}`} className="break-words">步骤 {step.id}：{step.task}</li>)}</ul>}</div>)}</> : !report.errors.length && <p className="rounded-xl bg-soft p-4 text-sm text-t2">当前已检查的资源中，没有发现对此资源的引用。</p>}
      </>}
    </div>
    {actionError && <p role="alert" className="shrink-0 text-sm text-danger mt-4">{actionError}</p>}
    <div className="shrink-0 border-t border-line pt-4 mt-4 flex items-center justify-end gap-3"><button className="btn-ghost" disabled={busy} onClick={onClose}>取消</button><button className="btn-primary !bg-danger disabled:opacity-50" disabled={!canDisable} onClick={disable}>{busy ? '停用中…' : '确认停用'}</button></div>
  </ZbModal>;
}
