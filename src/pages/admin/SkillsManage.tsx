import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type GwSkillRow, type GwSkillDetail, type GwVersion } from '../../services/api';
import { SKILL_GATEWAY_URL } from '../../data/skills';
import GatewayLogsAdmin from './GatewayLogsAdmin';
import SkillsAlerts from './SkillsAlerts';
import DependencyIssues from './DependencyIssues';
import DisableSkillDialog from './DisableSkillDialog';
import { ZbModal } from '../../components/ZbModal';
import PackagePreview from '../../components/PackagePreview';
import type { AgentGraph } from '../../services/agentStructure';
import { copyText } from '../../lib/copyText';

const CATEGORIES = ['规划咨询', '文档办公', '数据分析', '其他'];
/** 网关 MCP 端口 8765：由控制台地址推导（去端口后拼 MCP 端口），与原控制台「接入配置」一致 */
const GW_MCP_URL = SKILL_GATEWAY_URL.replace(/:\d+\/?$/, '') + ':8765/mcp';

const shortTime = (s?: string) => (s ? s.slice(5, 16) : '—');
const kb = (n?: number) => (n === undefined ? '—' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

/** 壳技能 stub（与门户 /api/skill-stubs 同源逻辑）：不含方法论，仅引导 load_skill */
function stubContent(d: GwSkillDetail) {
  const name = d.display_name || d.name || d.slug;
  const desc = String(d.description || '').replace(/\s*\n+\s*/g, ' ').trim();
  return [
    '---',
    `name: ${name}`,
    `description: ${desc}`,
    '---',
    '',
    `# ${name}（${d.slug} · 壳技能）`,
    '',
    '完整工作流存放于内网「Skill Center」，本文件不含任何方法论内容。',
    '',
    '执行规则：',
    `1. 第一步调用 MCP 工具 load_skill，参数 slug="${d.slug}"，获取完整 SKILL.md；`,
    '2. 严格按返回的完整流程执行任务；',
    '3. 流程中要求加载参考文件时，调用 read_reference / read_asset 按需拉取；',
    `4. 交付完成后调用 report_output 记录交付（参数 slug="${d.slug}", summary=交付物摘要）。`,
    '',
  ].join('\n');
}

function CopyBlock({ title, hint, text }: { title: string; hint: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    request.current++; locked.current = false;
    setCopied(false); setError(''); setBusy(false);
    return () => { request.current++; };
  }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (locked.current) return;
    locked.current = true;
    const ticket = ++request.current;
    setBusy(true); setCopied(false); setError('');
    const ok = await copyText(text, () => ticket === request.current);
    if (ticket !== request.current) return;
    locked.current = false; setBusy(false); setCopied(ok);
    if (!ok) setError('复制失败，请选中下方内容手动复制');
  };
  return (
    <div className="card p-4 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[10px] text-t3">{hint}</span>
        <span className="flex-1" />
        <button className="btn-ghost shrink-0 whitespace-nowrap !text-[11px] !h-7" disabled={busy} onClick={copy}>{copied ? '已复制' : busy ? '复制中…' : '复制'}</button>
      </div>
      <pre className="rounded-xl bg-[#17161F] p-3.5 font-mono text-[11px] leading-[1.8] text-[#C9C5DC] overflow-auto max-h-[240px] whitespace-pre-wrap break-all">{text}</pre>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** 调用统计 · 近 14 日趋势（自绘柱状，零依赖） */
function TrendBars({ data }: { data: { date: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-1.5 h-[140px]">
      {data.map((d) => (
        <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${d.date} · ${d.count} 次`}>
          <span className="text-[10px] font-mono text-t3">{d.count || ''}</span>
          <div
            className="w-full rounded-t-[4px] bg-accent/80 dark:bg-accent/60 min-h-[2px]"
            style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }}
          />
          <span className="text-[9px] font-mono text-t3 truncate w-full text-center">{d.date}</span>
        </div>
      ))}
      {data.length === 0 && <div className="w-full text-center text-xs text-t3 py-10">暂无调用数据</div>}
    </div>
  );
}

type DetailTab = 'versions' | 'stats' | 'files' | 'access';

interface UploadForm {
  file: File | null;
  name: string;
  category: string;
  owner: string;
  version: string;
  note: string;
  effective: 'now' | 'pending';
}
const newUploadForm = (): UploadForm => ({ file: null, name: '', category: CATEGORIES[0], owner: '', version: '1.0.0', note: '', effective: 'now' });
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

export type SkillsManageTab = 'skills' | 'dependencies' | 'logs' | 'alerts';

interface Props {
  tab: SkillsManageTab;
  onTab: (t: SkillsManageTab) => void;
  onAlertsChange: () => void;
  initialLogSkill?: string;
}

/** 技能管理：技能库 / 调用日志 / 告警 三页签（网关控制台能力并入；接入清单在「服务运维」页） */
export default function SkillsManage({ tab, onTab, onAlertsChange, initialLogSkill }: Props) {
  const [rows, setRows] = useState<GwSkillRow[] | null>(null);
  const [mcpAlive, setMcpAlive] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<{ skills_total?: number; skills_enabled?: number; calls_7d?: number; total_calls?: number } | null>(null);
  const [openAlerts, setOpenAlerts] = useState(0);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [statusTab, setStatusTab] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [kindTab, setKindTab] = useState<'all' | 'agent' | 'skill'>('all');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<GwSkillDetail | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('versions');
  const [detailBusy, setDetailBusy] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCat, setEditCat] = useState('');
  const [editOwner, setEditOwner] = useState('');
  /* 技能「适用部门」（门户本地配置）：名册短名清单 + 当前编辑技能已勾选集合 */
  const [deptOptions, setDeptOptions] = useState<string[]>([]);
  const [editDepts, setEditDepts] = useState<string[]>([]);
  const [skillTrend, setSkillTrend] = useState<{ date: string; count: number }[] | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [upForm, setUpForm] = useState<UploadForm>(newUploadForm);
  const [upBusy, setUpBusy] = useState(false);
  const [upGraph, setUpGraph] = useState<AgentGraph | null>(null);
  const [upInspectBusy, setUpInspectBusy] = useState(false);
  const [upInspectError, setUpInspectError] = useState('');
  const inspectRequest = useRef(0);
  const legacyVersion = useRef('1.0.0');
  const [actionBusy, setActionBusy] = useState(false);
  const [disableTarget, setDisableTarget] = useState<GwSkillRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(''), 4500);
  };
  const gwError = (r: any) => r?.message || (r?.detail ? (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : '请求失败，请重试');
  const failed = (r: any) => !r || r.ok === false || !!r.detail;
  useEffect(() => () => { inspectRequest.current++; }, []);

  const closeUpload = () => {
    if (upBusy) return;
    inspectRequest.current++;
    setShowUpload(false);
    setUpForm(newUploadForm());
    setUpGraph(null);
    setUpInspectError('');
    setUpInspectBusy(false);
    legacyVersion.current = '1.0.0';
  };

  const inspectFile = async (file: File) => {
    if (upBusy) return;
    const request = ++inspectRequest.current;
    setMsg('');
    setUpGraph(null);
    setUpInspectError('');
    setUpInspectBusy(false);
    setUpForm(form => ({ ...form, file, version: legacyVersion.current, name: form.name || file.name.replace(/\.zip$/i, '').slice(0, 30) }));
    if (!/\.zip$/i.test(file.name)) { setUpInspectError('请选择 zip 技能包'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setUpInspectError('文件超过 150 MiB，请精简压缩包后重新选择'); return; }
    setUpInspectBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api.gateway.inspectSkill(form);
      if (request !== inspectRequest.current) return;
      if (failed(result)) { setUpInspectError('预检失败：' + gwError(result)); return; }
      const graph = result.structure as AgentGraph | undefined;
      if (!graph || typeof graph.version !== 'string' || !Array.isArray(graph.components) || !Array.isArray(graph.dependencies) || !Array.isArray(graph.warnings)) {
        setUpInspectError('预检返回的包结构不完整，请重试');
        return;
      }
      setUpGraph(graph);
      setUpForm(form => ({ ...form, version: graph.source === 'manifest' ? graph.version : legacyVersion.current }));
      if (Array.isArray(result.errors) && result.errors.length) setUpInspectError('预检未通过：' + result.errors.join('；'));
    } catch {
      if (request === inspectRequest.current) setUpInspectError('预检网络连接中断，请重试');
    } finally {
      if (request === inspectRequest.current) setUpInspectBusy(false);
    }
  };

  const load = () => {
    setErr('');
    api.gateway.health().then((h) => setMcpAlive(!!h?.mcp_alive)).catch(() => setMcpAlive(false));
    Promise.all([api.gateway.skills(), api.gateway.overview(), api.gateway.alerts({ status: 'open' })])
      .then(([sk, ov, al]) => {
        if (Array.isArray(sk)) setRows(sk);
        else setErr('技能中心返回格式异常');
        setOverview(ov || null);
        setOpenAlerts(Array.isArray(al) ? al.length : 0);
      })
      .catch(() => setErr('技能中心不可达，请稍后重试'));
  };
  useEffect(load, []);

  // 适用部门选项与既有配置：员工名册短名（与上传「适用部门」同源），静态清单兜底
  const skillDeptMapRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    api.meta.departments().then((r) => {
      if (r.ok && r.departments?.length) setDeptOptions(r.departments);
    }).catch(() => {});
    api.skillDepartments.all().then((r) => {
      if (r.ok && r.map) skillDeptMapRef.current = r.map;
    }).catch(() => {});
  }, []);

  const toggleEditDept = (d: string) => {
    setEditDepts((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev.filter((x) => x !== '全部'), d],
    );
  };

  const kindRows = useMemo(() => (rows || []).filter(s => kindTab === 'all' || (s.kind || 'skill') === kindTab), [rows, kindTab]);
  const filtered = useMemo(() => {
    const list = kindRows;
    const kw = q.trim();
    return list.filter((s) => {
      const okTab = statusTab === 'all' || (s.status || 'enabled') === statusTab;
      const okQ = !kw || (s.display_name || s.name).includes(kw) || s.slug.includes(kw);
      return okTab && okQ;
    });
  }, [kindRows, statusTab, q]);

  const counts = {
    all: kindRows.length,
    enabled: kindRows.filter((s) => (s.status || 'enabled') === 'enabled').length,
    disabled: kindRows.filter((s) => s.status === 'disabled').length,
  };

  const toggle = async (s: GwSkillRow) => {
    if (actionBusy) return;
    if ((s.status || 'enabled') === 'enabled') { setDisableTarget(s); return; }
    setActionBusy(true);
    try {
      const r = await api.gateway.setStatus(s.slug, 'enabled');
      if (failed(r)) return flash('操作失败：' + gwError(r));
      load();
      flash(`已启用「${s.display_name || s.name}」`);
    } catch { flash('操作失败：网络连接中断，请重试'); }
    finally { setActionBusy(false); }
  };

  const remove = async (s: GwSkillRow) => {
    if (actionBusy) return;
    if (!window.confirm(`确定删除技能「${s.display_name || s.name}」？\n将删除全部版本与文件（${s.slug}），不可恢复。`)) return;
    setActionBusy(true);
    try {
      const r = await api.gateway.removeSkill(s.slug);
      if (failed(r)) return flash('删除失败：' + gwError(r));
      load();
      flash('已删除');
    } catch { flash('删除失败：网络连接中断，请重试'); }
    finally { setActionBusy(false); }
  };

  const openDetail = (s: GwSkillRow, t: DetailTab = 'versions') => {
    setDetail({ ...s });
    setDetailTab(t);
    setEditName('');
    setEditCat('');
    setEditOwner('');
    setEditDepts(skillDeptMapRef.current[s.slug] || []);
    setSkillTrend(null);
    api.gateway
      .skill(s.slug)
      .then((d) => {
        if (failed(d)) { flash('加载失败：' + gwError(d)); setDetail(null); return; }
        setDetail(d);
        setEditName(d.display_name || '');
        setEditCat(d.category || '');
        setEditOwner(d.owner || '');
      })
      .catch(() => setDetail(null));
    api.gateway.skillTrend(s.slug, 14).then((tr) => Array.isArray(tr) && setSkillTrend(tr)).catch(() => setSkillTrend([]));
  };

  const saveMeta = async () => {
    if (!detail || detailBusy) return;
    setDetailBusy(true);
    try {
      const [r, rd] = await Promise.all([
        api.gateway.setMeta(detail.slug, { display_name: editName.trim(), category: editCat, owner: editOwner.trim() }),
        api.skillDepartments.save(detail.slug, editDepts),
      ]);
      if (!failed(rd)) skillDeptMapRef.current[detail.slug] = editDepts;
      if (failed(r) || failed(rd)) {
        const failures = [failed(r) ? '基本信息：' + gwError(r) : '', failed(rd) ? '适用部门：' + gwError(rd) : ''].filter(Boolean);
        return flash('保存未全部完成，' + failures.join('；') + '。请重试');
      }
      load();
      openDetail({ ...detail, display_name: editName.trim(), owner: editOwner.trim() });
      flash('基本信息已更新');
    } catch { flash('保存失败：网络连接中断，请重试'); }
    finally { setDetailBusy(false); }
  };

  const rollback = async (version: string) => {
    if (!detail || detailBusy) return;
    if (!window.confirm(`确定回滚到 ${version}？当前版本将被替换为该历史版本，全员下次调用即生效。`)) return;
    setDetailBusy(true);
    try {
      const r = await api.gateway.rollback(detail.slug, version);
      if (failed(r)) return flash('回滚失败：' + gwError(r));
      load();
      openDetail(detail);
      flash(`已回滚到 ${version}`);
    } catch { flash('回滚失败：网络连接中断，请重试'); }
    finally { setDetailBusy(false); }
  };

  const submitUpload = async () => {
    if (upBusy || upInspectBusy) return;
    if (!upForm.file) return flash('请选择技能包 zip 文件');
    if (!upGraph || upInspectError) return flash('请先通过技能包预检');
    const version = upGraph.source === 'manifest' ? upGraph.version : upForm.version.trim();
    if (!/^v?\d+(?:\.\d+){0,3}[a-zA-Z0-9.-]*$/.test(version)) return flash('版本号格式如 1.0.1 或 v1.0.1-preview');
    setUpBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', upForm.file);
      fd.append('version', version);
      fd.append('note', upForm.note.trim() || '管理员直传');
      fd.append('effective', upForm.effective);
      if (upForm.name.trim()) fd.append('display_name', upForm.name.trim());
      if (upForm.category) fd.append('category', upForm.category);
      if (upForm.owner.trim()) fd.append('owner', upForm.owner.trim());
      const r = await api.gateway.uploadSkill(fd);
      if (failed(r)) return flash('上传失败：' + gwError(r));
      setShowUpload(false);
      inspectRequest.current++;
      setUpForm(newUploadForm());
      setUpGraph(null);
      setUpInspectError('');
      legacyVersion.current = '1.0.0';
      load();
      flash('已上传技能包：' + (upForm.effective === 'now' ? '立即生效，WorkBuddy 下次调用即用新版' : '仅入库，需回滚切换时使用'));
    } catch { flash('上传失败：网络连接中断，请重试'); }
    finally { setUpBusy(false); }
  };

  const totalEnabled = (rows || []).filter(s => (s.status || 'enabled') === 'enabled').length;
  const totalDisabled = (rows || []).filter(s => s.status === 'disabled').length;
  const kpis = [
    { label: '资源总数', value: overview?.skills_total ?? (rows || []).length, sub: `全部类型 · 启用 ${overview?.skills_enabled ?? totalEnabled} · 停用 ${totalDisabled}` },
    { label: '累计调用', value: overview?.total_calls ?? '—', sub: `近 7 日 ${overview?.calls_7d ?? '—'} 次 MCP 调用` },
    { label: '待处理告警', value: openAlerts, sub: '点击查看告警页签', onClick: () => onTab('alerts'), danger: openAlerts > 0 },
    { label: '门户展示', value: totalEnabled, sub: '智能体与 AI 技能区同步' },
  ];

  const versions: GwVersion[] = detail?.versions || [];

  return (
    <div className="flex flex-col min-h-full">
      {/* 页签 */}
      <div className="px-6 pt-5 flex gap-2 items-center flex-wrap">
        {(
          [
            ['skills', '资源列表'],
            ['dependencies', '依赖问题'],
            ['logs', '调用日志'],
            ['alerts', `告警${openAlerts ? ` (${openAlerts})` : ''}`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => onTab(k)} className={`tab ${tab === k ? 'tab-active' : 'tab-idle'}`}>
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <span
          className={`pill font-normal ${mcpAlive === false ? 'bg-dangerSoft text-danger' : 'bg-okSoft text-ok'}`}
          title={mcpAlive === false ? 'MCP 供给服务无响应，WorkBuddy 将无法拉取技能' : 'WorkBuddy 技能拉取通道（8765 端口）运行正常'}
        >
          ● MCP 供给服务{mcpAlive === null ? '：检测中…' : mcpAlive ? '：正常' : '：异常'}
        </span>
        {tab === 'skills' && (
          <button className="btn-primary !text-xs !h-8" onClick={() => setShowUpload(true)}>＋ 上传技能包</button>
        )}
      </div>

      {tab === 'dependencies' && msg && !detail && <div role="status" className="mx-6 mt-4 card p-3 text-sm text-t1 bg-soft">{msg}</div>}
      {tab === 'logs' ? (
        <GatewayLogsAdmin key={initialLogSkill || 'logs'} initialSkill={initialLogSkill} />
      ) : tab === 'alerts' ? (
        <SkillsAlerts onChanged={onAlertsChange} />
      ) : tab === 'dependencies' ? (
        <DependencyIssues onOpen={slug => openDetail((rows || []).find(row => row.slug === slug) || { slug, name: slug })} />
      ) : (
        <div className="p-6 pt-4 flex flex-col gap-4">
          {err && (
            <div className="card p-4 text-sm text-danger bg-dangerSoft/40 flex items-center justify-between">
              <span>{err}</span>
              <button className="btn-primary" onClick={load}>重试</button>
            </div>
          )}
          {msg && !showUpload && !detail && <div role="status" className="card p-3 text-sm text-t1 bg-soft">{msg}</div>}

          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {kpis.map((k) => (
              <div
                key={k.label}
                onClick={k.onClick}
                className={`card p-4 ${k.onClick ? 'cursor-pointer hover:border-accentText/40' : ''}`}
              >
                <div className="text-xs text-t3">{k.label}</div>
                <div className={`text-[22px] font-semibold mt-1 font-mono ${k.danger ? 'text-danger' : ''}`}>{k.value}</div>
                <div className="text-[11px] text-t3 mt-0.5">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* 筛选 */}
          <div className="flex gap-2 flex-wrap items-center" role="group" aria-label="资源类型">
            {([['all', '全部类型'], ['agent', '智能体'], ['skill', 'AI 技能']] as const).map(([kind, label]) => (
              <button key={kind} aria-pressed={kindTab === kind} onClick={() => setKindTab(kind)} className={`tab ${kindTab === kind ? 'tab-active' : 'tab-idle'}`}>
                {label} {kind === 'all' ? (rows || []).length : (rows || []).filter(s => (s.kind || 'skill') === kind).length}
              </button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {(
              [
                ['all', `全部 ${counts.all}`],
                ['enabled', `启用中 ${counts.enabled}`],
                ['disabled', `已停用 ${counts.disabled}`],
              ] as const
            ).map(([k, label]) => (
              <button key={k} onClick={() => setStatusTab(k)} className={`tab ${statusTab === k ? 'tab-active' : 'tab-idle'}`}>
                {label}
              </button>
            ))}
            <span className="flex-1" />
            <div className="w-[220px] h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line flex items-center px-3">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索名称 / slug…"
                className="w-full bg-transparent outline-none text-xs placeholder:text-t3"
              />
            </div>
          </div>

          {/* 技能表格 */}
          <div className="card overflow-x-auto">
            <div className="flex bg-soft dark:bg-[#16151F] border-b border-line min-w-[980px]">
              <span className="th flex-1 min-w-[220px]">技能（中文名 · slug）</span>
              <span className="th w-[88px]">分类</span>
              <span className="th w-[80px]">上传人</span>
              <span className="th w-[110px]">版本</span>
              <span className="th w-[118px]">累计调用（近7日）</span>
              <span className="th w-[76px]">状态</span>
              <span className="th w-[126px]">更新时间</span>
              <span className="th w-[196px]">操作</span>
            </div>
            {filtered.map((s) => {
              const enabled = (s.status || 'enabled') === 'enabled';
              return (
                <div key={s.slug} className="flex items-center border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03] min-w-[980px]">
                  <div className="td flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2"><span className="font-medium text-t1 truncate">{s.display_name || s.name}</span><span className="pill bg-soft text-t2 !text-[10px] shrink-0">{s.kind === 'agent' ? '智能体' : 'AI 技能'}</span></div>
                    <div className="font-mono text-[10px] text-t3 truncate">{s.slug}</div>
                  </div>
                  <span className="td w-[88px] text-t2">{s.category || '未分类'}</span>
                  <span className="td w-[80px] text-t2">{s.owner || '—'}</span>
                  <span className="td w-[110px] font-mono text-[11px]">{s.current_version || '—'}</span>
                  {/* 调用次数（与首页同口径：累计=网关真实调用次数，近7日为辅助小字；原「7日 / 累计」挤一格易误读） */}
                  <span className="td w-[118px] leading-tight">
                    <span className="block font-mono text-[13px] font-semibold">
                      {(s.calls_total ?? 0).toLocaleString()} <span className="text-[10px] font-normal text-t3">次</span>
                    </span>
                    <span className="block text-[10px] text-t3 mt-0.5">近7日 {(s.calls_7d ?? 0).toLocaleString()}</span>
                  </span>
                  <span className="td w-[76px]">
                    <span className={`pill font-normal ${enabled ? 'bg-okSoft text-ok' : 'bg-soft text-t3'}`}>
                      {enabled ? '启用' : '停用'}
                    </span>
                  </span>
                  <span className="td w-[126px] font-mono text-[11px] text-t3">{shortTime(s.updated_at)}</span>
                  <span className="td w-[196px] whitespace-nowrap text-xs">
                    <button className="text-accentText hover:underline mr-2" onClick={() => openDetail(s)}>详情</button>
                    <button className="text-accentText hover:underline mr-2" onClick={() => openDetail(s, 'access')}>接入配置</button>
                    <button className="text-t3 hover:text-t1 mr-2 disabled:opacity-50" disabled={actionBusy} onClick={() => toggle(s)}>{enabled ? '停用' : '启用'}</button>
                    <button className="text-danger hover:underline disabled:opacity-50" disabled={actionBusy} onClick={() => remove(s)}>删除</button>
                  </span>
                </div>
              );
            })}
            {rows && filtered.length === 0 && <div className="p-12 text-center text-sm text-t3">当前筛选下没有技能</div>}
            {!rows && !err && <div className="p-12 text-center text-sm text-t3">加载中…</div>}
          </div>

          <div className="text-xs text-t3 leading-relaxed">
            停用前需检查引用关系；停用后门户资源卡片隐藏、WorkBuddy 壳技能下次同步移除。删除不可恢复。
            员工通过首页「发布资源」提交智能体或 AI 技能，审核通过后上架或更新版本；「上传技能包」为管理员直传通道，不经审核。
          </div>
        </div>
      )}

      {/* ===== 技能详情弹窗（四页签） ===== */}
      <ZbModal open={!!detail} onClose={() => { if (!detailBusy) setDetail(null); }} dismissible={!detailBusy} label="技能详情" maxWidth="w-[900px] max-w-full" className="max-h-[86vh] overflow-y-auto flex flex-col gap-4">
        {msg && <div role="status" className="rounded-lg p-3 text-xs text-t1 bg-soft">{msg}</div>}
        {detail && (
          <>
            <div className="flex items-center gap-3">
              <h3 className="text-[16px] font-semibold">{detail.display_name || detail.name}</h3>
              <span className={`pill font-normal ${(detail.status || 'enabled') === 'enabled' ? 'bg-okSoft text-ok' : 'bg-soft text-t3'}`}>
                {(detail.status || 'enabled') === 'enabled' ? '启用' : '停用'}
              </span>
              <span className="font-mono text-[11px] text-t3">{detail.slug}</span>
              <span className="font-mono text-[11px] text-t3">v{detail.current_version || '—'}</span>
              <span className="flex-1" />
              <button className="text-t3 hover:text-t1 text-lg leading-none" onClick={() => setDetail(null)}>×</button>
            </div>

            <div className="flex gap-2 border-b border-line">
              {(
                [
                  ['versions', '版本历史'],
                  ['stats', '调用统计'],
                  ['files', '文件清单'],
                  ['access', '接入配置'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setDetailTab(k)}
                  className={`px-3.5 pb-2.5 text-[13px] border-b-2 -mb-px transition-colors ${detailTab === k ? 'border-accent text-accentText font-medium' : 'border-transparent text-t3 hover:text-t1'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* 版本历史 + 基本信息 */}
            {detailTab === 'versions' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="card p-4">
                  <div className="text-[13px] font-semibold mb-2">版本历史 · {versions.length} 版</div>
                  {versions.map((v) => (
                    <div key={v.version} className="flex items-center gap-2 py-2 border-b border-line last:border-0">
                      <span className="font-mono text-xs font-medium w-[64px]">{v.version}</span>
                      <span className="text-[11px] text-t3 flex-1 min-w-0">
                        <span className="block truncate">{v.note || '—'}</span>
                        <span className="block text-[10px]">{v.file_count ?? '?'} 文件 · {shortTime(v.uploaded_at)} · {v.effective === 'pending' ? '仅入库' : '已生效'}</span>
                      </span>
                      {v.is_current ? (
                        <span className="pill bg-accentSoft text-accentText font-normal">当前</span>
                      ) : (
                        <button className="text-xs text-accentText hover:underline disabled:opacity-50" disabled={detailBusy} onClick={() => rollback(v.version)}>
                          回滚到此版
                        </button>
                      )}
                    </div>
                  ))}
                  {!versions.length && <div className="py-6 text-center text-xs text-t3">加载中…</div>}
                  <p className="text-[10px] text-t3 mt-2 leading-relaxed">员工更新提交经审核通过后自动升补丁号（如 v1.0.1 → v1.0.2）；「仅入库」版本需回滚切换后生效。</p>
                </div>
                <div className="flex flex-col gap-4">
                  <div className="card p-4 flex flex-col gap-3">
                    <div className="text-[13px] font-semibold">基本信息</div>
                    <label className="text-xs text-t3">
                      中文名（门户与 WorkBuddy 展示）
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="mt-1 w-full h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line px-3 text-xs text-t1 outline-none"
                      />
                    </label>
                    <label className="text-xs text-t3">
                      分类
                      <select
                        value={editCat}
                        onChange={(e) => setEditCat(e.target.value)}
                        className="mt-1 w-full h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line px-2 text-xs text-t1 outline-none"
                      >
                        <option value="">未分类</option>
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-t3">
                      上传人（技能归属，用于首页部门归属）
                      <input
                        value={editOwner}
                        onChange={(e) => setEditOwner(e.target.value)}
                        placeholder="员工姓名"
                        className="mt-1 w-full h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line px-3 text-xs text-t1 outline-none"
                      />
                    </label>
                    <div>
                      <div className="text-xs text-t3 mb-1.5">适用部门（首页按此筛选；未配置按上传人部门）</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {[...new Set(['全部', ...deptOptions, ...editDepts])].map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => toggleEditDept(d)}
                            className={`pill border transition-colors ${
                              editDepts.includes(d) ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
                            }`}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] text-t3 mt-1">勾「全部」即全部门适用；只勾具体部门即仅这些部门筛得到；全部不勾则回落上传人部门。</p>
                    </div>
                    <button className="btn-primary self-start" disabled={detailBusy} onClick={saveMeta}>
                      {detailBusy ? '保存中…' : '保存修改'}
                    </button>
                  </div>
                  <div className="card p-4 flex-1">
                    <div className="text-[13px] font-semibold mb-2">技能说明（SKILL.md 摘要）</div>
                    <div className="text-[11px] text-t2 leading-relaxed max-h-[180px] overflow-y-auto whitespace-pre-wrap">
                      {detail.description || '（无描述）'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 调用统计 */}
            {detailTab === 'stats' && (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="card p-4">
                    <div className="text-xs text-t3">累计调用</div>
                    <div className="text-[22px] font-semibold mt-1 font-mono">{detail.calls_total ?? 0}</div>
                  </div>
                  <div className="card p-4">
                    <div className="text-xs text-t3">近 7 日调用</div>
                    <div className="text-[22px] font-semibold mt-1 font-mono">{detail.calls_7d ?? 0}</div>
                  </div>
                  <div className="card p-4">
                    <div className="text-xs text-t3">当前版本</div>
                    <div className="text-[22px] font-semibold mt-1 font-mono">v{detail.current_version || '—'}</div>
                  </div>
                </div>
                <div className="card p-4">
                  <div className="text-[13px] font-semibold mb-3">近 14 日调用趋势（数据源：网关 /api/skills/&#123;slug&#125;/trend）</div>
                  {skillTrend ? <TrendBars data={skillTrend} /> : <div className="py-10 text-center text-xs text-t3">加载中…</div>}
                </div>
              </div>
            )}

            {/* 文件清单 */}
            {detailTab === 'files' && (
              <div className="card p-4">
                <div className="text-[13px] font-semibold mb-2">文件清单 · {(detail.files || []).length} 个</div>
                <div className="max-h-[360px] overflow-y-auto">
                  {(detail.files || []).map((f) => (
                    <div key={f.path} className="flex items-center gap-2 py-1.5 border-b border-line last:border-0">
                      <span className="font-mono text-[11px] text-t1 flex-1 truncate">{f.path}</span>
                      <span className="pill bg-soft text-t3 font-normal">{f.kind === 'references' ? '方法论参考' : f.kind === 'assets' ? '模板资产' : '主文件'}</span>
                      <span className="font-mono text-[10px] text-t3 w-[60px] text-right">{kb(f.size)}</span>
                    </div>
                  ))}
                  {!(detail.files || []).length && <div className="py-8 text-center text-xs text-t3">加载中…</div>}
                </div>
              </div>
            )}

            {/* 接入配置 */}
            {detailTab === 'access' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CopyBlock
                  title="员工端接入 · MCP 配置"
                  hint="写入 ~/.workbuddy/mcp.json"
                  text={`{\n  "mcpServers": {\n    "dt-skills": {\n      "url": "${GW_MCP_URL}"\n    }\n  }\n}`}
                />
                <CopyBlock title="员工端接入 · 壳技能 Stub" hint="安装到 ~/.workbuddy/skills/，内容不含方法论" text={stubContent(detail)} />
                <div className="md:col-span-2 rounded-xl bg-soft dark:bg-card px-4 py-3 text-[11px] text-t3 leading-relaxed">
                  当前网关为「免令牌 · 按 IP 统计」模式：内网直连即可，无需任何令牌；调用记录按来源 IP 归档，并在「调用日志」页按 IP-姓名对照显示使用人。
                  配置后重启 WorkBuddy，说出技能触发词即可自动拉取完整流程。
                </div>
              </div>
            )}
          </>
        )}
      </ZbModal>

      {/* ===== 管理员直传技能包弹窗 ===== */}
      <ZbModal open={showUpload} onClose={closeUpload} dismissible={!upBusy} label="上传技能包" maxWidth="max-w-[620px]" className="p-5 flex flex-col gap-3.5 max-h-[calc(100vh-48px)] overflow-y-auto">
        {showUpload && (
          <>
            <div className="flex items-center gap-2.5">
              <h3 className="text-[15px] font-semibold">上传技能包（管理员直传）</h3>
              <span className="flex-1" />
              <button aria-label="关闭上传技能包" disabled={upBusy} className="text-t3 hover:text-t1 text-lg" onClick={closeUpload}>✕</button>
            </div>
            <button
              disabled={upBusy}
              onClick={() => fileRef.current?.click()}
              className="rounded-xl border-2 border-dashed border-line hover:border-accent bg-soft dark:bg-card px-4 py-5 text-xs text-t2 text-left"
            >
              {upForm.file ? (
                <>已选择 <b className="font-mono text-t1">{upForm.file.name}</b>（点击重新选择）</>
              ) : (
                <>点击选择技能包 zip（含 SKILL.md 或 agent.yaml，≤ 150 MiB）</>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              aria-label="选择技能包"
              disabled={upBusy}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void inspectFile(file);
              }}
            />
            {upInspectBusy && <p role="status" className="text-xs text-t2">正在预检技能包…</p>}
            {upGraph && <PackagePreview graph={upGraph} />}
            {upInspectError && <div role="alert" className="rounded-lg p-3 text-xs text-danger bg-dangerSoft space-y-2">
              <p>{upInspectError}</p>
              {upForm.file && <button className="btn-ghost !text-xs" disabled={upInspectBusy || upBusy} onClick={() => void inspectFile(upForm.file!)}>重新预检</button>}
            </div>}
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-t2">
                中文名（可选）
                <input
                  value={upForm.name}
                  onChange={(e) => setUpForm({ ...upForm, name: e.target.value.slice(0, 30) })}
                  placeholder="门户与 WorkBuddy 展示名"
                  className="mt-1 w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-3 text-xs outline-none focus:border-accent text-t1"
                />
              </label>
              <label className="text-xs text-t2">
                分类
                <select
                  value={upForm.category}
                  onChange={(e) => setUpForm({ ...upForm, category: e.target.value })}
                  className="mt-1 w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-2 text-xs outline-none text-t1"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-t2">
                上传人（归属员工姓名）
                <input
                  value={upForm.owner}
                  onChange={(e) => setUpForm({ ...upForm, owner: e.target.value.slice(0, 12) })}
                  placeholder="留空则不记录归属"
                  className="mt-1 w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-3 text-xs outline-none focus:border-accent text-t1"
                />
              </label>
              <label className="text-xs text-t2">
                版本号 *
                <input
                  value={upForm.version}
                  readOnly={upGraph?.source === 'manifest'}
                  onChange={(e) => { legacyVersion.current = e.target.value; setUpForm({ ...upForm, version: e.target.value }); }}
                  placeholder="如 1.0.1 或 v1.0.1-preview"
                  className="mt-1 w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-3 text-xs outline-none focus:border-accent text-t1 font-mono"
                />
                {upGraph?.source === 'manifest' && <span className="block mt-1 text-[11px] text-t3">版本由 agent.yaml 指定；修改版本需重新打包。</span>}
              </label>
              <div className="text-xs text-t2">
                生效策略
                <div className="mt-1 flex gap-2">
                  {([['now', '立即生效'], ['pending', '仅入库待回滚']] as const).map(([v, l]) => (
                    <button
                      key={v}
                      onClick={() => setUpForm({ ...upForm, effective: v })}
                      className={`flex-1 h-9 rounded-[10px] border text-xs transition-colors ${upForm.effective === v ? 'border-accent bg-accentSoft text-accentText font-medium' : 'border-line text-t2'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <label className="text-xs text-t2">
              更新说明
              <input
                value={upForm.note}
                onChange={(e) => setUpForm({ ...upForm, note: e.target.value.slice(0, 120) })}
                placeholder="写入版本历史，全员可见"
                className="mt-1 w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-3 text-xs outline-none focus:border-accent text-t1"
              />
            </label>
            {msg && <div role="status" className="rounded-lg p-3 text-xs text-t1 bg-soft">{msg}</div>}
            <div className="flex gap-2.5 justify-end mt-1">
              <button className="btn-ghost !text-xs" disabled={upBusy} onClick={closeUpload}>取消</button>
              <button className="btn-primary !text-xs" disabled={upBusy || upInspectBusy || !upForm.file || !upGraph || !!upInspectError} onClick={submitUpload}>
                {upBusy ? '上传中…' : '上传'}
              </button>
            </div>
          </>
        )}
      </ZbModal>
      {disableTarget && <DisableSkillDialog key={disableTarget.slug} slug={disableTarget.slug} name={disableTarget.display_name || disableTarget.name} onClose={() => setDisableTarget(null)} onDisabled={() => {
        const name = disableTarget.display_name || disableTarget.name;
        setDisableTarget(null);
        load();
        flash(`已停用「${name}」：门户资源列表更新后隐藏，WorkBuddy 下次同步移除`);
      }} />}
    </div>
  );
}
