import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { loadSkills } from '../services/skillsGateway';
import type { Skill } from '../types';
import type { AgentManifest, ManifestComponent, ManifestDependency, PackageAssistance, PreparePackageResponse } from '../services/packageAssistance';
import PackagePreview from './PackagePreview';

interface Props {
  uploadId: string;
  assistance?: PackageAssistance;
  updateOf?: string;
  onApplied: (result: PreparePackageResponse) => void;
  onDirty: (dirty: boolean) => void;
}
const field = 'w-full rounded-lg border border-line bg-card px-2.5 py-2 text-xs outline-none focus:border-accent disabled:opacity-60';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// Failed inspections can return a parseable but schema-invalid original manifest.
// Preserve it until the user explicitly requests regeneration; never silently filter invalid rows.
const editable = (value: unknown): boolean => {
  if (!object(value)) return false;
  if (value.schemaVersion !== 1 || !['agent', 'skill'].includes(String(value.kind))) return false;
  if (['id', 'version', 'entry'].some((key) => value[key] !== undefined && typeof value[key] !== 'string')) return false;
  const components = value.components;
  const dependencies = value.dependencies;
  const steps = value.steps;
  return (components === undefined || (Array.isArray(components) && components.every((item) => object(item) && typeof item.id === 'string' && typeof item.path === 'string' && ['skill', 'script'].includes(String(item.kind)) && (item.name === undefined || typeof item.name === 'string'))))
    && (dependencies === undefined || (Array.isArray(dependencies) && dependencies.every((item) => object(item) && typeof item.id === 'string' && (item.name === undefined || typeof item.name === 'string') && (item.slug === undefined || typeof item.slug === 'string'))))
    && (steps === undefined || (Array.isArray(steps) && steps.every((step) => object(step) && (step.targets === undefined || (Array.isArray(step.targets) && step.targets.every((target) => typeof target === 'string'))))));
};

/** All paths are relative to the server-selected package root. Only structured manifest fields change. */
export default function PackageRepairEditor({ uploadId, assistance, updateOf, onApplied, onDirty }: Props) {
  const [source, setSource] = useState(assistance);
  const updateId = updateOf?.startsWith('skill:') ? updateOf.slice(6) : undefined;
  const withIdentity = (value: AgentManifest | null): AgentManifest | null => value && updateId ? { ...value, id: updateId } : value;
  const [manifest, setManifest] = useState<AgentManifest | null>(() => withIdentity(assistance?.manifest || null));
  const [entry, setEntry] = useState(typeof assistance?.manifest?.entry === 'string' ? assistance.manifest.entry : '');
  const [preview, setPreview] = useState<PackageAssistance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [componentChoices, setComponentChoices] = useState<Record<string, string>>({});
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (updateId && assistance?.manifest && assistance.manifest.id !== updateId) onDirty(true);
    loadSkills(true).then((items) => { if (mounted.current) setSkills(items); }).catch(() => { if (mounted.current) setCatalogError('平台技能列表加载失败，请重新打开修正区后重试'); });
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    if (assistance) return;
    let active = true;
    setBusy(true);
    api.uploads.prepare(uploadId, { updateOf: updateOf || '' }).then((result) => {
      if (!active) return;
      if (!result.ok || !result.assistance) { setError(result.message || '无法读取包结构，请重试'); return; }
      setSource(result.assistance);
      setManifest(withIdentity(result.assistance.manifest));
      setEntry(typeof result.assistance.manifest?.entry === 'string' ? result.assistance.manifest.entry : '');
    }).catch(() => { if (active) setError('读取失败，请重试'); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [uploadId, assistance, updateOf]);

  const invalidate = () => {
    sequence.current++;
    setBusy(false);
    setPreview(null);
    setMessage('');
    setError('');
    onDirty(true);
  };
  const change = (patch: Partial<AgentManifest>) => {
    invalidate();
    setManifest((current) => current ? { ...current, ...patch } : current);
  };
  const setComponent = (index: number, patch: Partial<ManifestComponent>) => change({ components: (manifest?.components || []).map((item, i) => i === index ? { ...item, ...patch } : item) });
  const setDependency = (index: number, patch: Partial<ManifestDependency>) => change({ dependencies: (manifest?.dependencies || []).map((item, i) => i === index ? { ...item, ...patch } : item) });
  const replaceWithComponent = (dependencyId: string) => {
    const componentId = componentChoices[dependencyId];
    if (!manifest?.components?.some((item) => item.id === componentId) || !manifest.dependencies?.some((item) => item.id === dependencyId)) return;
    const from = `dependency:${dependencyId}`;
    const to = `component:${componentId}`;
    change({
      dependencies: manifest.dependencies.filter((item) => item.id !== dependencyId),
      steps: manifest.steps?.map((step) => {
        if (!object(step) || !Array.isArray(step.targets) || !step.targets.includes(from)) return step;
        return { ...step, targets: [...new Set(step.targets.map((target) => target === from ? to : target))] };
      }),
    });
    setComponentChoices((choices) => { const next = { ...choices }; delete next[dependencyId]; return next; });
  };
  const request = async (mode: 'generate' | 'preview' | 'apply') => {
    const ticket = ++sequence.current;
    setBusy(true); setError(''); setMessage('');
    if (mode !== 'apply') setPreview(null);
    else onDirty(true);
    try {
      const result = await api.uploads.prepare(uploadId, {
        ...(mode === 'generate' ? { entry, ...(malformed ? { regenerate: true } : {}) } : { manifest: manifest! }),
        updateOf: updateOf || '',
        ...(mode === 'apply' ? { apply: true, revision: preview?.revision } : {}),
      });
      if (!mounted.current || ticket !== sequence.current) return;
      if (!result.ok || !result.assistance) {
        setError(result.message || '校验失败，请重试'); setPreview(null); return;
      }
      const next = result.assistance;
      setSource(next);
      if (mode === 'generate') {
        setManifest(withIdentity(next.manifest)); setEntry(next.manifest?.entry || entry); onDirty(true);
      }
      setPreview(mode === 'generate' && updateId && next.manifest?.id !== updateId ? null : next);
      if (mode === 'apply') {
        if (next.errors.length || !result.report || result.report.verdict === 'fail') {
          setError('仍有校验问题，尚未完成修正'); onDirty(true); return;
        }
        setManifest(next.manifest || manifest);
        onApplied(result); onDirty(false); setMessage('已应用，上传包已重新检查');
      }
    } catch { if (mounted.current && ticket === sequence.current) { setError('连接中断，请重新校验'); setPreview(null); } }
    finally { if (mounted.current && ticket === sequence.current) setBusy(false); }
  };
  const download = () => {
    if (!preview?.manifestYaml || preview.errors.length) return;
    const url = URL.createObjectURL(new Blob([preview.manifestYaml], { type: 'application/yaml;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'agent.yaml'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const errors = preview?.errors || source?.errors || [];
  const warnings = preview?.warnings || source?.warnings || [];
  const malformed = !!manifest && !editable(manifest);
  const components = !malformed ? manifest?.components || [] : [];
  const dependencies = !malformed ? manifest?.dependencies || [] : [];
  const selectedSkills = skills.filter((skill) => skill.slug && (!search || `${skill.name} ${skill.slug}`.toLowerCase().includes(search.toLowerCase())));
  const referenced = (namespace: string, id: string) => (manifest?.steps || []).some((step) => typeof step === 'object' && step !== null && 'targets' in step && Array.isArray(step.targets) && step.targets.includes(`${namespace}:${id}`));
  return <section aria-label="智能体结构修正" className="rounded-xl border border-accent/40 bg-card p-4 space-y-4">
    <div><h3 className="text-sm font-semibold">修正入口与依赖</h3><p className="mt-1 text-xs leading-relaxed text-t3">文件路径相对包根目录 {source?.root || '／'}。保留原文及步骤引用；应用后重新检查完整上传包。</p></div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <label className="block space-y-1.5 text-xs text-t2"><span>主入口</span><select aria-label="主入口" className={field} value={entry} disabled={busy} onChange={(e) => { setEntry(e.target.value); invalidate(); if (manifest) setManifest({ ...manifest, entry: e.target.value }); }}>
      <option value="">请选择主技能文件，不会自动猜测</option>
      {entry && !source?.candidates.some((candidate) => candidate.path === entry) && <option value={entry}>{entry}（原清单入口）</option>}
      {source?.candidates.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.name} · {candidate.path}</option>)}
    </select></label>
    {malformed && <div role="alert" className="rounded-lg bg-dangerSoft p-3 space-y-2 text-xs text-danger">
      <p>清单字段格式错误，可重新选择入口生成清单</p>
      <p>原清单仍保留在上传包中。重新生成会重新识别关系，原有手工关系可能需要补充；请核对组件、依赖和步骤后再应用。</p>
      {typeof manifest?.id === 'string' && <p>原 ID：{manifest.id}</p>}
      {typeof manifest?.version === 'string' && <p>原版本：{manifest.version}</p>}
    </div>}
    {(!manifest || malformed) && <button type="button" className="btn-primary !text-xs" disabled={!entry || busy} onClick={() => request('generate')}>{malformed ? '重新生成清单草案' : '生成清单草案'}</button>}
    {manifest && !malformed && <>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1.5 text-xs text-t2"><span>稳定 ID</span><input aria-label="稳定 ID" className={`${field} font-mono`} value={manifest.id || ''} readOnly={!!updateOf} onChange={(e) => change({ id: e.target.value })} /><span className="block text-[11px] text-t3">{updateOf ? '更新沿用已有资源 ID' : '首次发布后保持不变'}</span></label>
        <label className="space-y-1.5 text-xs text-t2"><span>版本</span><input aria-label="版本" className={`${field} font-mono`} value={manifest.version || ''} onChange={(e) => change({ version: e.target.value })} /></label>
      </div>
      <div className="space-y-2"><h4 className="text-xs font-semibold">包内组件</h4>
        {components.map((item, index) => <div key={index} className="rounded-lg border border-line p-2.5 space-y-2">
          <div className="flex items-center justify-between text-[11px]"><code>{item.id}</code><button type="button" className="text-danger disabled:text-t3" disabled={referenced('component', item.id)} title={referenced('component', item.id) ? '步骤正在引用此组件，需保留' : undefined} onClick={() => change({ components: components.filter((_, i) => i !== index) })}>移除组件</button></div>
          <input aria-label={`组件 ${item.id} 的名称`} className={field} value={item.name || ''} placeholder="可读名称" onChange={(e) => setComponent(index, { name: e.target.value })} />
          <select aria-label={`组件 ${item.id} 的路径`} className={`${field} font-mono`} value={item.path} onChange={(e) => { const file = source?.files.find((file) => file.path === e.target.value); setComponent(index, { path: e.target.value, kind: file?.kind === 'script' ? 'script' : 'skill' }); }}>
            <option value="">请选择包内路径</option>
            {!source?.files.some((file) => file.path === item.path) && <option value={item.path}>{item.path}（原路径）</option>}
            {source?.files.filter((file) => file.kind !== 'file').map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
          </select>
        </div>)}
        <button type="button" className="text-xs text-accentText" onClick={() => { let n = components.length + 1; while (components.some((item) => item.id === `component-${n}`)) n++; change({ components: [...components, { id: `component-${n}`, name: '', kind: 'skill', path: '', visibility: 'internal' }] }); }}>＋ 添加包内组件</button>
      </div>
      <div className="space-y-2"><h4 className="text-xs font-semibold">平台依赖</h4>
        <p className="text-[11px] leading-relaxed text-t3">必需：不可缺失；可选：不阻断；待建设：明确尚未实现。</p>
        <input aria-label="搜索平台技能" className={field} placeholder="搜索名称或准确 slug" value={search} onChange={(e) => setSearch(e.target.value)} />
        {catalogError && <p role="alert" className="text-xs text-danger">{catalogError}</p>}
        {dependencies.map((item, index) => <div key={index} className="rounded-lg border border-line p-2.5 space-y-2">
          <div className="flex items-center justify-between text-[11px]"><code>{item.id}</code><button type="button" className="text-danger disabled:text-t3" disabled={referenced('dependency', item.id)} title={referenced('dependency', item.id) ? '步骤正在引用此依赖，需保留' : undefined} onClick={() => change({ dependencies: dependencies.filter((_, i) => i !== index) })}>移除依赖</button></div>
          <input aria-label={`依赖 ${item.id} 的名称`} className={field} value={item.name || ''} placeholder="可读名称" onChange={(e) => setDependency(index, { name: e.target.value })} />
          <select aria-label={`依赖 ${item.id} 的要求`} className={field} value={item.status === 'planned' ? 'planned' : item.required === false ? 'optional' : 'required'} onChange={(e) => setDependency(index, { required: e.target.value === 'required', status: e.target.value === 'planned' ? 'planned' : undefined })}>
            <option value="required">必需</option><option value="optional">可选</option><option value="planned">待建设</option>
          </select>
          {item.status === 'planned' ? <label className="block space-y-1.5 text-xs text-t2">
            <span>未来技能的固定 slug</span>
            <input aria-label={`依赖 ${item.id} 的未来 slug`} className={`${field} font-mono`} value={item.slug || ''} placeholder="例如：future-review" onChange={(e) => setDependency(index, { slug: e.target.value })} />
            <span className="block text-[11px] leading-relaxed text-t3">可填写尚未上架的技能标识，建设完成后沿用此 slug。</span>
          </label> : <select aria-label={`依赖 ${item.id} 的平台技能`} className={field} value={item.slug || ''} onChange={(e) => setDependency(index, { slug: e.target.value })}>
            <option value="">请选择平台上的准确技能</option>
            {item.slug && !selectedSkills.some((skill) => skill.slug === item.slug) && <option value={item.slug}>{item.slug}（当前引用，待校验）</option>}
            {selectedSkills.map((skill) => <option key={skill.slug} value={skill.slug}>{skill.name} · {skill.slug}</option>)}
          </select>}
          <div className="border-t border-line pt-2 space-y-2">
            <label className="block space-y-1.5 text-xs text-t2"><span>改用包内组件</span>
              <select aria-label={`依赖 ${item.id} 改用包内组件`} className={field} value={componentChoices[item.id] || ''} disabled={busy || !components.length} onChange={(e) => setComponentChoices((choices) => ({ ...choices, [item.id]: e.target.value }))}>
                <option value="">按文件路径选择具体组件</option>
                {components.map((component) => <option key={component.id} value={component.id}>{component.name || component.id} · {component.path || '尚未选择路径'} · {component.id}</option>)}
              </select>
            </label>
            <p className="text-[11px] leading-relaxed text-t3">确认后，所有步骤中对此依赖的引用将改为所选组件，并移除此平台依赖。</p>
            <button type="button" className="btn-ghost !text-xs" aria-label={`替换依赖 ${item.id} 的全部引用`} disabled={busy || !components.some((component) => component.id === componentChoices[item.id])} onClick={() => replaceWithComponent(item.id)}>替换全部引用</button>
          </div>
        </div>)}
        <button type="button" className="text-xs text-accentText" onClick={() => { let n = dependencies.length + 1; while (dependencies.some((item) => item.id === `dependency-${n}`)) n++; change({ dependencies: [...dependencies, { id: `dependency-${n}`, name: '', source: 'registry', required: true }] }); }}>＋ 添加平台依赖</button>
      </div>
      {!!manifest.steps?.length && <p className="text-xs text-t3">保留 {manifest.steps.length} 个原有步骤及 target 引用。已被步骤引用的组件和依赖不能直接移除。</p>}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <button type="button" className="btn-ghost !text-xs" disabled={busy || !entry} onClick={() => request('preview')}>预览校验</button>
        <button type="button" className="btn-primary !text-xs" disabled={busy || !preview || !!preview.errors.length || preview.needsSelection || preview.revision === undefined} onClick={() => request('apply')}>应用并重新检查</button>
        {preview?.manifestYaml && !preview.errors.length && <button type="button" className="text-xs text-accentText" onClick={download}>下载 agent.yaml</button>}
      </div>
    </>}
    {busy && <p role="status" className="text-xs text-t3">正在检查包结构…</p>}
    {!!errors.length && <div className="rounded-lg bg-dangerSoft p-3 text-xs text-danger space-y-1" role="alert">{errors.map((item, i) => <p key={i}>{item}</p>)}</div>}
    {!!warnings.length && <div className="rounded-lg bg-warnSoft p-3 text-xs text-warn space-y-1">{warnings.map((item, i) => <p key={i}>{item}</p>)}</div>}
    {preview && !malformed && !errors.length && !message && <p className="text-xs text-ok">预览校验通过，点击应用后才会更新上传包。</p>}
    {message && <p role="status" className="text-xs text-ok">{message}</p>}
    {preview?.inspection?.structure && <PackagePreview graph={preview.inspection.structure} />}
  </section>;
}
