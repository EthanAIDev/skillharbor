import { useEffect, useMemo, useState } from 'react';
import { tools as staticTools, DEPT_STYLES, BASE_TAGS } from '../../data/tools';
import { TYPE_LABELS, type Tool } from '../../types';
import { useUsage, applyUsageResets } from '../../hooks/useUsage';
import { api } from '../../services/api';
import { ZbModal } from '../../components/ZbModal';

type Status = 'online' | 'offline';

interface Row extends Tool {
  status: Status;
  source: 'builtin' | 'upload' | 'manual';
  updatedAt?: string;
  updatedNote?: string;
}

interface EditState {
  row: Row;
  name: string;
  desc: string;
  url: string;
  icon: string;
  tags: string[];
  departments: string[];
}

/** 手动添加工具弹窗状态（S3 拦截外置数据库包后的出路：管理员自行部署后登记卡片） */
interface ManualState {
  name: string;
  type: string;
  url: string;
  desc: string;
  icon: string;
  tags: string[];
  departments: string[];
}

const KIND_OF_TYPE: Record<string, string> = { external: '外部链接', local: '网页应用', coze: 'Coze 应用', download: '文件工具', service: '服务应用' };

/** 工具管理：内置 + 员工上传全量名册，编辑 / 上下架 / 清零 / 删除 */
export default function ToolsAdmin() {
  const { getUsage } = useUsage();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tab, setTab] = useState<'all' | Status>('all');
  const [q, setQ] = useState('');
  const [toast, setToast] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [manual, setManual] = useState<ManualState | null>(null);
  const [busy, setBusy] = useState(false);
  /* 适用部门选项：员工名册短名（与上传弹窗同源），接口不可达时仅展示当前值 */
  const [deptOptions, setDeptOptions] = useState<string[]>([]);
  useEffect(() => {
    api.meta.departments().then((r) => {
      if (r.ok && r.departments?.length) setDeptOptions(r.departments);
    }).catch(() => {});
  }, []);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 2600);
  };

  const load = () => {
    api.adminTools.list().then((r) => {
      if (!r.ok) return;
      applyUsageResets(r.usageReset);
      const overrides = r.builtinOverrides || {};
      const offline = r.builtinOffline || [];
      /* 已删除（软删除）的内置工具不再入册；上传类 deleted 的已被服务端过滤 */
      const deleted = r.builtinDeleted || [];
      const extras = r.extra || [];
      const builtins: Row[] = staticTools
        .filter((t) => !deleted.includes(t.id))
        .map((t) => ({
          ...t,
          ...(overrides[t.id] || {}),
          type: t.type,
          status: (offline.includes(t.id) ? 'offline' : 'online') as Status,
          source: 'builtin' as const,
        }));
      const uploads: Row[] = extras.map((t) => ({
        id: t.id,
        name: t.name,
        desc: t.desc || '',
        department: t.department || '—',
        departments: t.departments || [],
        owner: t.owner || '—',
        url: t.url || '',
        type: (t.type as Tool['type']) || 'external',
        icon: t.icon || '工',
        iconUrl: t.iconUrl || '',
        iconBg: t.iconBg || '',
        tags: t.tags || [],
        usage: t.usage || 0,
        likes: t.likes || 0,
        status: (t.status === 'offline' ? 'offline' : 'online') as Status,
        source: t.manual ? 'manual' as const : 'upload' as const,
        updatedAt: t.updatedAt,
        updatedNote: t.updatedNote,
      }));
      setRows([...uploads, ...builtins]);
    });
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const list = rows || [];
    const kw = q.trim();
    return list.filter((r) => {
      const okTab = tab === 'all' || r.status === tab;
      const okQ = !kw || r.name.includes(kw) || r.owner.includes(kw) || r.department.includes(kw);
      return okTab && okQ;
    });
  }, [rows, tab, q]);

  const counts = {
    all: (rows || []).length,
    online: (rows || []).filter((r) => r.status === 'online').length,
    offline: (rows || []).filter((r) => r.status === 'offline').length,
  };

  const setStatus = async (row: Row) => {
    const to: Status = row.status === 'online' ? 'offline' : 'online';
    if (to === 'offline' && !confirm(`确认下架「${row.name}」？首页即时隐藏，统计与评价保留，可随时重新上架。`)) return;
    const r = await api.adminTools.setStatus(row.id, to);
    flash(r.ok ? r.message : r.message || '操作失败');
    load();
  };

  const resetOne = async (row: Row) => {
    if (!confirm(`确认清零「${row.name}」的累计使用次数显示？首页 / 详情将立即显示为 0，统计看板的原始记录保留。`)) return;
    const r = await api.adminTools.resetUsage(row.id);
    flash(r.ok ? r.message : r.message || '操作失败');
    load();
  };

  /* 删除（软删除）：二次确认后调用；记录留在服务端，必要时可恢复 */
  const removeOne = async (row: Row) => {
    const svcNote = row.type === 'service' && row.source === 'upload' ? '，服务容器将停止' : '';
    if (!confirm(`确认删除「${row.name}」？删除后首页与工具管理列表即时隐藏${svcNote}。软删除：记录、统计与评价保留，必要时可恢复。`)) return;
    const r = await api.adminTools.remove(row.id);
    flash(r.ok ? r.message : r.message || '操作失败');
    load();
  };

  const resetAll = async () => {
    if (!counts.online) return flash('当前没有已上线工具');
    if (!confirm(`确认批量清零全部 ${counts.online} 个已上线工具的累计使用次数显示？统计看板的原始记录保留。`)) return;
    setBusy(true);
    const r = await api.adminTools.resetAllUsage();
    setBusy(false);
    flash(r.ok ? r.message : r.message || '操作失败');
    load();
  };

  /* 适用部门切换：勾「全部」即全部门适用并清空单选；取消到空回落「全部」 */
  const toggleDept = (d: string) => {
    if (!edit) return;
    if (d === '全部') { setEdit({ ...edit, departments: ['全部'] }); return; }
    let next = edit.departments.includes(d)
      ? edit.departments.filter((x) => x !== d)
      : [...edit.departments.filter((x) => x !== '全部'), d];
    if (!next.length) next = ['全部'];
    setEdit({ ...edit, departments: next });
  };

  const saveEdit = async () => {
    if (!edit) return;
    setBusy(true);
    const patch: Record<string, unknown> = {
      name: edit.name.trim().slice(0, 30),
      desc: edit.desc.trim().slice(0, 300),
      icon: edit.icon.trim().slice(0, 2),
      tags: edit.tags,
      departments: edit.departments,
    };
    if (edit.row.source === 'builtin' && edit.row.type === 'external') patch.url = edit.url.trim();
    if (edit.row.source !== 'builtin') patch.url = edit.url.trim();
    const r = await api.adminTools.edit(edit.row.id, patch);
    setBusy(false);
    if (!r.ok) return flash(r.message || '保存失败');
    flash('已保存');
    setEdit(null);
    load();
  };

  const toggleManualDept = (d: string) => {
    if (!manual) return;
    if (d === '全部') { setManual({ ...manual, departments: ['全部'] }); return; }
    let next = manual.departments.includes(d)
      ? manual.departments.filter((x) => x !== d)
      : [...manual.departments.filter((x) => x !== '全部'), d];
    if (!next.length) next = ['全部'];
    setManual({ ...manual, departments: next });
  };

  const saveManual = async () => {
    if (!manual) return;
    setBusy(true);
    const r = await api.adminTools.manual({
      name: manual.name.trim(),
      url: manual.url.trim(),
      type: manual.type,
      desc: manual.desc.trim(),
      icon: manual.icon.trim(),
      tags: manual.tags,
      departments: manual.departments,
    });
    setBusy(false);
    if (!r.ok) return flash(r.message || '添加失败');
    flash(r.message || '已添加');
    setManual(null);
    load();
  };

  return (
    <div className="p-6 flex flex-col gap-4 relative">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        {(
          [
            ['all', `全部 ${counts.all}`],
            ['online', `上线 ${counts.online}`],
            ['offline', `已下架 ${counts.offline}`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`tab ${tab === k ? 'tab-active' : 'tab-idle'}`}>
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          className="btn-primary !text-xs !h-[34px] whitespace-nowrap"
          onClick={() => setManual({ name: '', type: 'service', url: '', desc: '', icon: '', tags: [], departments: ['全部'] })}
        >
          ＋ 手动添加工具
        </button>
        <button
          className="btn-ghost !text-xs !h-[34px] whitespace-nowrap"
          disabled={busy || !counts.online}
          onClick={resetAll}
        >
          批量清零使用次数
        </button>
        <div className="w-[220px] h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line flex items-center px-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称 / 负责人 / 部门…"
            className="w-full bg-transparent outline-none text-xs placeholder:text-t3"
          />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex bg-soft dark:bg-[#16151F] border-b border-line min-w-[1000px]">
          <span className="th flex-1 min-w-[220px]">工具</span>
          <span className="th w-[92px]">类型</span>
          <span className="th w-[80px] hidden lg:block">负责人</span>
          <span className="th w-[96px] hidden lg:block">部门</span>
          <span className="th w-[92px]">来源</span>
          <span className="th w-[80px]">状态</span>
          <span className="th w-[92px]">累计使用</span>
          <span className="th w-[176px]">操作</span>
        </div>
        {(filtered || []).map((r) => {
          const deptStyle = DEPT_STYLES[r.department];
          return (
            <div key={r.id} className="flex items-center border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03] min-w-[1000px]">              <div className="td flex-1 min-w-[220px]">
                <div className="flex items-center gap-2.5">
                  {r.iconUrl ? (
                    <img src={r.iconUrl} alt="" className="w-7 h-7 rounded-md object-cover border border-line shrink-0" />
                  ) : (
                    <span
                      className={`w-7 h-7 rounded-md ${deptStyle?.bg || 'bg-accentSoft'} flex items-center justify-center text-[13px] font-semibold ${deptStyle?.fg || 'text-accentText'} shrink-0`}
                      style={r.iconBg && !deptStyle ? { background: r.iconBg, color: '#17161F' } : undefined}
                    >
                      {r.icon}
                    </span>
                  )}
                  <span className="font-medium text-t1 truncate">{r.name}</span>
                </div>
                {r.updatedAt ? (
                  <div className="text-[10px] text-t3 mt-0.5 pl-[38px]">更新于 {r.updatedAt}{r.updatedNote ? ` · ${r.updatedNote}` : ''}</div>
                ) : null}
              </div>
              <span className="td w-[92px] text-t2">{KIND_OF_TYPE[r.type] || TYPE_LABELS[r.type]}</span>
              <span className="td w-[80px] hidden lg:block">{r.owner}</span>
              <span className="td w-[96px] hidden lg:block">{r.department}</span>
              <span className="td w-[92px]">
                <span className={`pill font-normal ${r.source === 'builtin' ? 'bg-soft text-t3' : r.source === 'manual' ? 'bg-warnSoft text-warn' : 'bg-accentSoft text-accentText'}`}>
                  {r.source === 'builtin' ? '内置' : r.source === 'manual' ? '手动登记' : '员工上传'}
                </span>
              </span>
              <span className="td w-[80px]">
                <span className={`pill font-normal ${r.status === 'online' ? 'bg-okSoft text-ok' : 'bg-soft text-t3'}`}>
                  {r.status === 'online' ? '上线' : '已下架'}
                </span>
              </span>
              <span className="td w-[92px] font-mono text-t1">{getUsage(r.id, r.usage).toLocaleString()}</span>
              <span className="td w-[176px] whitespace-nowrap text-xs">
                <button
                  className="text-accentText hover:underline mr-2"
                  onClick={() => setEdit({ row: r, name: r.name, desc: r.desc || '', url: r.url || '', icon: r.icon || '', tags: r.tags || [], departments: r.departments?.length ? r.departments : ['全部'] })}
                >
                  编辑
                </button>
                <button className="text-t3 hover:text-t1 mr-2" onClick={() => setStatus(r)}>
                  {r.status === 'online' ? '下架' : '上架'}
                </button>
                <button className="text-t3 hover:text-t1 mr-2" onClick={() => resetOne(r)}>
                  清零
                </button>
                <button className="text-t3 hover:text-danger" onClick={() => removeOne(r)}>
                  删除
                </button>
              </span>
            </div>
          );
        })}
        {rows && filtered.length === 0 && <div className="p-12 text-center text-sm text-t3">当前筛选下没有工具</div>}
        {!rows && <div className="p-12 text-center text-sm text-t3">加载中…</div>}
      </div>

      <div className="text-xs text-t3 leading-relaxed">
        来源说明：内置 = 平台预置；员工上传 = 经审核中心通过后自动上线，后续更新走审核中心「更新版本」通道；手动登记 = 管理员自行部署后手动添加（如被 S3 拦截的外置数据库工具），编辑可改访问地址。
        「编辑」弹窗可改名称 / 描述 / 图标 / 标签 / 适用部门（外部链接与手动登记类可改 URL）；下架即时隐藏，统计与评价保留，可随时重新上架。
        「清零」将该工具的累计使用次数显示归零（单个），「批量清零使用次数」作用于全部已上线工具；两者均不影响统计看板的原始记录。
        「删除」为软删除：首页与本名册即时消失（服务型工具连同容器停止，镜像与数据保留），记录、统计与评价不受影响，需要恢复时由管理员清除删除标记即可。
      </div>

      {/* 手动添加工具弹窗 */}
      <ZbModal open={!!manual} onClose={() => setManual(null)} label="手动添加工具" maxWidth="max-w-[440px]" className="p-5 flex flex-col gap-3.5 max-h-[88vh] overflow-y-auto">
        {manual && (
          <>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold">手动添加工具</h3>
              <span className="flex-1" />
              <button className="text-t3 hover:text-t1 text-lg" onClick={() => setManual(null)}>✕</button>
            </div>
            <p className="text-[10.5px] text-t3 leading-relaxed bg-soft rounded-lg p-2.5">
              适用场景：上传包被「外置数据库/缓存依赖（S3）」拦截、但确属正当需求的工具——由管理员取得部署包在服务器上自行部署后，在此登记卡片。手动登记的工具不参与平台的部署 / 版本 / 回滚生命周期，上下架只切换卡片显隐。
            </p>
            <label className="text-xs text-t2">
              名称（必填）
              <input
                value={manual.name}
                onChange={(e) => setManual({ ...manual, name: e.target.value.slice(0, 30) })}
                placeholder="如：合同管理系统"
                className="mt-1 w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1"
              />
            </label>
            <label className="text-xs text-t2">
              访问地址（必填 · 部署完成后的入口 URL）
              <input
                value={manual.url}
                onChange={(e) => setManual({ ...manual, url: e.target.value })}
                placeholder="http://10.0.0.x:端口"
                className="mt-1 w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1 font-mono"
              />
            </label>
            <div>
              <div className="text-xs text-t2 mb-1.5">类型</div>
              <div className="flex items-center gap-2 flex-wrap">
                {(['service', 'external', 'local', 'download'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setManual({ ...manual, type: k })}
                    className={`pill border transition-colors ${
                      manual.type === k ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
                    }`}
                  >
                    {KIND_OF_TYPE[k] || k}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-t3 mt-1">自行部署的带后端系统选「服务应用」。</p>
            </div>
            <label className="text-xs text-t2">
              项目描述
              <textarea
                value={manual.desc}
                onChange={(e) => setManual({ ...manual, desc: e.target.value.slice(0, 300) })}
                rows={2}
                placeholder="一句话说明用途（建议注明「管理员部署」与负责人）"
                className="mt-1 w-full rounded-xl bg-soft dark:bg-card border border-line px-3 py-2 text-sm outline-none focus:border-accent text-t1 resize-none"
              />
            </label>
            <label className="text-xs text-t2">
              图标（最多 2 字，留空取名称前两字）
              <input
                value={manual.icon}
                onChange={(e) => setManual({ ...manual, icon: e.target.value.slice(0, 2) })}
                className="mt-1 w-24 h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm text-center outline-none focus:border-accent text-t1"
              />
            </label>
            <div>
              <div className="text-xs text-t2 mb-1.5">标签（最多 4 个）</div>
              <div className="flex items-center gap-2 flex-wrap">
                {[...new Set([...BASE_TAGS, ...manual.tags])].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setManual({ ...manual, tags: manual.tags.includes(t) ? manual.tags.filter((x) => x !== t) : [...manual.tags, t].slice(0, 4) })}
                    className={`pill border transition-colors ${
                      manual.tags.includes(t) ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-t2 mb-1.5">适用部门（首页按此筛选）</div>
              <div className="flex items-center gap-2 flex-wrap">
                {[...new Set(['全部', ...deptOptions, ...manual.departments])].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleManualDept(d)}
                    className={`pill border transition-colors ${
                      manual.departments.includes(d) ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2.5 justify-end mt-1">
              <button className="btn-ghost !text-xs" onClick={() => setManual(null)}>取消</button>
              <button
                className="btn-primary !text-xs"
                disabled={busy || !manual.name.trim() || !manual.url.trim()}
                onClick={saveManual}
              >
                {busy ? '添加中…' : '添加并上线'}
              </button>
            </div>
          </>
        )}
      </ZbModal>

      {/* 编辑弹窗 */}
      <ZbModal open={!!edit} onClose={() => setEdit(null)} label="编辑工具" maxWidth="max-w-[440px]" className="p-5 flex flex-col gap-3.5">
        {edit && (
          <>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold">编辑工具</h3>
              <span className="pill bg-soft text-t3 font-normal">{edit.row.source === 'builtin' ? '内置' : '员工上传'}</span>
              <span className="flex-1" />
              <button className="text-t3 hover:text-t1 text-lg" onClick={() => setEdit(null)}>✕</button>
            </div>
            <label className="text-xs text-t2">
              名称
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value.slice(0, 30) })}
                className="mt-1 w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1"
              />
            </label>
            <label className="text-xs text-t2">
              项目描述
              <textarea
                value={edit.desc}
                onChange={(e) => setEdit({ ...edit, desc: e.target.value.slice(0, 300) })}
                rows={2}
                className="mt-1 w-full rounded-xl bg-soft dark:bg-card border border-line px-3 py-2 text-sm outline-none focus:border-accent text-t1 resize-none"
              />
            </label>
            {(edit.row.source !== 'builtin') && (
              <label className="text-xs text-t2">
                链接地址{edit.row.source === 'manual' ? '（手动登记可改）' : ''}
                <input
                  value={edit.url}
                  onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                  placeholder="http://… 或 /files/uploads/…"
                  className="mt-1 w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1 font-mono"
                />
              </label>
            )}
            <label className="text-xs text-t2">
              图标（最多 2 字）
              <input
                value={edit.icon}
                onChange={(e) => setEdit({ ...edit, icon: e.target.value.slice(0, 2) })}
                className="mt-1 w-24 h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm text-center outline-none focus:border-accent text-t1"
              />
            </label>
            <div>
              <div className="text-xs text-t2 mb-1.5">标签（最多 4 个）</div>
              <div className="flex items-center gap-2 flex-wrap">
                {[...new Set([...BASE_TAGS, ...edit.tags])].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEdit({ ...edit, tags: edit.tags.includes(t) ? edit.tags.filter((x) => x !== t) : [...edit.tags, t].slice(0, 4) })}
                    className={`pill border transition-colors ${
                      edit.tags.includes(t) ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-t2 mb-1.5">适用部门（首页按此筛选，未设置过按归属部门）</div>
              <div className="flex items-center gap-2 flex-wrap">
                {[...new Set(['全部', ...deptOptions, ...edit.departments])].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDept(d)}
                    className={`pill border transition-colors ${
                      edit.departments.includes(d) ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-t3 mt-1">勾「全部」即全部门适用；勾具体部门即只在所选部门下可见（默认全部）。</p>
            </div>
            <div className="flex gap-2.5 justify-end mt-1">
              <button className="btn-ghost !text-xs" onClick={() => setEdit(null)}>取消</button>
              <button className="btn-primary !text-xs" disabled={busy || !edit.name.trim()} onClick={saveEdit}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </>
        )}
      </ZbModal>
    </div>
  );
}
