import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MyOnlineSkill, type UploadRow } from '../services/api';

type ResourceType = 'agent' | 'skill' | 'tool' | 'unknown';
type OnlineResult = Awaited<ReturnType<typeof api.uploads.myOnline>> & { ok?: boolean; message?: string };
type Resource = {
  key: string; name: string; description: string; type: ResourceType; status: UploadRow['status'];
  upload?: UploadRow; online?: MyOnlineSkill; updatedAt?: number | string;
};
const TYPES: Record<ResourceType, string> = { agent: '智能体', skill: 'AI 技能', tool: '工具', unknown: '类型待确认' };
const STATES: Record<UploadRow['status'], { label: string; style: string }> = {
  draft: { label: '草稿', style: 'bg-soft text-t2' },
  pending: { label: '待审核', style: 'bg-warnSoft text-warn' },
  rejected: { label: '已驳回', style: 'bg-warnSoft text-warn' },
  deploying: { label: '发布中', style: 'bg-accentSoft text-accentText' },
  deploy_failed: { label: '发布失败', style: 'bg-warnSoft text-warn' },
  online: { label: '已上线', style: 'bg-okSoft text-ok' },
  offline: { label: '已下线', style: 'bg-soft text-t3' },
};

function timestamp(value?: number | string) {
  const result = value ? new Date(value).getTime() : 0;
  return Number.isFinite(result) ? result : 0;
}
function formatTime(value?: number | string) {
  if (!timestamp(value)) return '—';
  return new Date(value!).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function message(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

export default function MyResources() {
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [online, setOnline] = useState<OnlineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [type, setType] = useState<ResourceType | 'all'>('all');
  const [status, setStatus] = useState<UploadRow['status'] | 'all'>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErrors([]);
    Promise.allSettled([api.uploads.mine(), api.uploads.myOnline()]).then(([mineResult, onlineResult]) => {
      if (!active) return;
      const failures: string[] = [];
      const mine = mineResult.status === 'fulfilled' ? mineResult.value : null;
      const mineValid = mine?.ok !== false && Array.isArray(mine?.rows);
      if (mineValid) setUploads(mine.rows);
      else {
        setUploads([]);
        failures.push(`上传记录加载失败：${mineResult.status === 'rejected' ? message(mineResult.reason) : mine?.message || '返回数据不完整，请重试'}`);
      }
      const current: OnlineResult | null = onlineResult.status === 'fulfilled' ? onlineResult.value : null;
      if (current?.ok !== false && Array.isArray(current?.skills)) {
        // Only supplement a successful owner-scoped upload list, so a failed request cannot look complete.
        setOnline(mineValid ? current : null);
      } else {
        setOnline(null);
        failures.push(`线上资源加载失败：${onlineResult.status === 'rejected' ? message(onlineResult.reason) : current?.message || '返回数据不完整，请重试'}`);
      }
      setErrors(failures);
      setLoading(false);
    });
    return () => { active = false; };
  }, [attempt]);

  const resources = useMemo(() => {
    const skills = online?.skills || [];
    const list: Resource[] = uploads.map(upload => {
      // Every upload stays distinct. Names and update-target slugs do not identify this submission.
      const current = upload.kind === 'skill' && upload.publishSlug
        ? skills.find(skill => skill.slug === upload.publishSlug && !skill.pendingPublish) : undefined;
      const updatedAt = Math.max(upload.createdAt || 0, upload.submittedAt || 0, upload.approvedAt || 0, upload.rejectedAt || 0,
        timestamp((upload as UploadRow & { updatedAt?: number | string }).updatedAt));
      return {
        key: `upload:${upload.id}`, name: upload.name || upload.filename || '未命名资源', description: upload.desc || '',
        type: upload.kind === 'skill' ? upload.report?.structure?.kind || current?.kind || 'skill' : 'tool',
        status: upload.status, upload, online: current, updatedAt,
      };
    });
    for (const skill of skills) {
      // A pending entry is already in uploads. A missing slug is not a reliable resource identity.
      if (!skill.slug || skill.pendingPublish || uploads.some(upload => upload.kind === 'skill' && upload.publishSlug === skill.slug)) continue;
      list.push({
        key: `skill:${skill.slug}`, name: skill.name, description: skill.desc || '', type: skill.kind || 'unknown',
        status: skill.status === 'disabled' || skill.status === 'offline' ? 'offline' : 'online',
        online: skill, updatedAt: skill.updatedAt || skill.onlineAt,
      });
    }
    return list.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
  }, [uploads, online]);

  const filtered = resources.filter(resource => {
    const text = [resource.name, resource.description, resource.upload?.filename, resource.upload?.updateNote,
      resource.upload?.publishSlug, resource.online?.slug, resource.upload?.id].join(' ').toLocaleLowerCase();
    return (type === 'all' || resource.type === type) && (status === 'all' || resource.status === status)
      && text.includes(query.trim().toLocaleLowerCase());
  });
  const filteredActive = type !== 'all' || status !== 'all' || !!query.trim();
  const clear = () => { setType('all'); setStatus('all'); setQuery(''); };
  const sourceLabel = online?.gatewayAvailable === false ? '上传快照（技能中心暂不可用）'
    : online?.gatewayAvailable === true ? '技能中心实时' : '技能中心记录';

  return (
    <section className="px-5 lg:px-8 pt-6 pb-10 flex flex-col gap-5" aria-labelledby="my-resources-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="my-resources-title" className="text-xl font-semibold">我的资源</h1>
          <p className="text-xs text-t3 mt-1.5 leading-relaxed">查看你提交的智能体、AI 技能和工具，跟进审核与发布进度。</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => setAttempt(value => value + 1)} disabled={loading} className="rounded-lg border border-line px-3 py-2 text-xs text-t2 hover:bg-soft disabled:opacity-50">刷新</button>
          <Link to="/?upload=1" className="btn-primary">发布资源</Link>
        </div>
      </div>

      <div className="card p-4 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[180px] flex flex-col gap-1.5 text-xs text-t2">
          搜索我的资源
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="名称、说明或资源标识"
            className="h-9 rounded-lg border border-line bg-card px-3 text-[13px] text-t1 focus:outline-none focus:ring-2 focus:ring-accent/30" />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-t2">
          资源类型
          <select value={type} onChange={event => setType(event.target.value as typeof type)} className="h-9 min-w-[130px] rounded-lg border border-line bg-card px-3 text-[13px] text-t1">
            <option value="all">全部类型</option>
            {Object.entries(TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-t2">
          资源状态
          <select value={status} onChange={event => setStatus(event.target.value as typeof status)} className="h-9 min-w-[130px] rounded-lg border border-line bg-card px-3 text-[13px] text-t1">
            <option value="all">全部状态</option>
            {Object.entries(STATES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
          </select>
        </label>
        {filteredActive && <button onClick={clear} className="h-9 px-3 rounded-lg border border-line text-xs text-t2 hover:bg-soft">清除筛选</button>}
      </div>

      {loading ? <div className="card p-10 text-center text-sm text-t3" role="status">正在加载我的资源…</div> : <>
        {errors.length > 0 && <div role="alert" className="rounded-xl border border-warn/30 bg-warnSoft p-4 text-sm text-warn flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0"><p className="font-medium">部分资源暂时无法读取</p>{errors.map(error => <p key={error} className="mt-1 text-xs break-words">{error}</p>)}</div>
          <button onClick={() => setAttempt(value => value + 1)} className="rounded-lg border border-warn/40 px-3 py-2 text-xs font-medium shrink-0">重试加载</button>
        </div>}
        {online?.gatewayAvailable === false && <div role="status" className="rounded-xl bg-warnSoft p-4 text-xs text-warn flex flex-wrap items-center justify-between gap-3">
          <p>技能中心暂不可用，当前展示上传快照；线上版本和直传资源可能不完整。</p>
          <button onClick={() => setAttempt(value => value + 1)} className="rounded-lg border border-warn/40 px-3 py-2">重试同步</button>
        </div>}
        {resources.length > 0 && <div className="flex flex-wrap justify-between gap-2 text-xs text-t3">
          <span>显示 {filtered.length} / {resources.length} 条记录</span>
          <span>每次提交单独保留 · 按最近更新时间排序</span>
        </div>}
        <div className="flex flex-col gap-3">
          {filtered.map(resource => {
            const upload = resource.upload;
            const state = STATES[resource.status];
            const version = upload?.report?.structure?.source === 'manifest' ? upload.report.structure.version : upload?.updateVersion;
            const failure = resource.status === 'rejected' ? upload?.rejectReason : resource.status === 'deploy_failed' ? upload?.deployError : undefined;
            return <article key={resource.key} aria-label={resource.name} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex gap-3 min-w-0 flex-1">
                  <span aria-hidden className="w-10 h-10 shrink-0 rounded-[10px] bg-accentSoft text-accentText flex items-center justify-center text-sm font-semibold">{resource.type === 'agent' ? '智' : resource.type === 'tool' ? '工' : '技'}</span>
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold break-words">{resource.name}</h2>
                    <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1.5 text-[11px] text-t3">
                      <span>{TYPES[resource.type]}</span><span aria-hidden>·</span>
                      <span>{upload ? upload.updateOf ? '更新' : '新建' : '技能中心记录'}</span>
                      {upload && <><span aria-hidden>·</span><span>上传记录</span></>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center flex-wrap gap-3">
                  <span className={`pill ${state.style}`}>{state.label}</span>
                  {upload && ['draft', 'rejected'].includes(upload.status) && <Link className="rounded-lg border border-line px-3 py-1.5 text-xs text-accentText hover:bg-accentSoft" to={`/?upload=1&uploadId=${encodeURIComponent(upload.id)}`}>继续编辑</Link>}
                </div>
              </div>
              {resource.description && <p className="mt-3 text-xs text-t2 break-words leading-relaxed">{resource.description}</p>}
              <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-3 text-xs">
                <div><dt className="text-t3">更新时间{upload ? '（上传记录）' : ''}</dt><dd className="mt-1 text-t2">{formatTime(resource.updatedAt)}</dd></div>
                <div><dt className="text-t3">提交版本</dt><dd className="mt-1 font-mono text-t2 break-all">{version || '—'}</dd></div>
                <div><dt className="text-t3">{resource.online && online?.gatewayAvailable === false ? '快照版本' : '线上版本'}</dt><dd className="mt-1 font-mono text-t2 break-all">{resource.online?.version || '—'}</dd>{resource.online && <dd className="mt-1 text-[10px] text-t3">{sourceLabel}</dd>}</div>
                <div><dt className="text-t3">更新说明</dt><dd className="mt-1 text-t2 break-words whitespace-pre-wrap">{upload?.updateNote || '—'}</dd></div>
              </dl>
              {upload && ['rejected', 'deploy_failed'].includes(upload.status) && <div className="mt-4 rounded-lg bg-warnSoft px-3 py-2.5 text-xs text-warn leading-relaxed">
                <div className="font-medium">{upload.status === 'rejected' ? '驳回原因' : '发布失败原因'}</div>
                <p className="mt-1 break-words whitespace-pre-wrap">{failure || '未提供原因，请联系管理员'}</p>
              </div>}
              <p className="mt-3 text-[10px] text-t3 break-all">{upload ? `提交编号：${upload.id}` : `资源标识：${resource.online?.slug}`}{upload?.publishSlug ? ` · 资源标识：${upload.publishSlug}` : ''}</p>
            </article>;
          })}
        </div>
        {filtered.length === 0 && errors.length === 0 && online?.gatewayAvailable !== false && <div className="card py-12 px-5 text-center">
          <p className="text-sm text-t2">{resources.length ? '没有符合筛选条件的资源' : '还没有发布过资源'}</p>
          <p className="text-xs text-t3 mt-2">{resources.length ? '试试其他关键字，或调整资源类型和状态。' : '发布智能体、AI 技能或工具后，可以在这里查看进度并继续编辑草稿。'}</p>
        </div>}
      </>}
    </section>
  );
}
