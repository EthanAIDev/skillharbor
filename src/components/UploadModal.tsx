import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type UploadRow, type MyOnlineTool, type MyOnlineSkill } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { BASE_TAGS } from '../data/tools';
import { SKILL_CATEGORIES } from '../data/skills';
import { baseUsers } from '../data/users';
import { getPackPrompt, LINK_PUBLISH_GUIDANCE, type PackResourceKind } from '../data/packPrompts';
import { ZbModal, type ZbModalProps } from './ZbModal';
import UploadAnalysis from './UploadAnalysis';
import PackagePreview from './PackagePreview';
import PackageRepairEditor from './PackageRepairEditor';
import type { ResourceType, UploadReport } from '../services/packageAssistance';
import { isSmartAnalysis, smartUpload, type AnalyzeRequest, type SmartAnalysis, type SmartDraftMetadata, type SmartUploadRow } from '../services/smartUpload';

interface Props {
  onClose: () => void;
  initialMode?: Mode;
  initialUploadId?: string;
  embedded?: boolean;
  footerTarget?: HTMLElement | null;
  onDraftChange?: (id: string) => void;
  onMetadataChange?: (meta: SmartDraftMetadata) => void;
  automaticAnalysis?: boolean;
}

function UploadFrame({ embedded, children, ...props }: ZbModalProps & { embedded?: boolean }) {
  return embedded ? <div className="flex-1 min-h-0 flex flex-col overflow-hidden pt-4">{children}</div> : <ZbModal {...props}>{children}</ZbModal>;
}
function LegacyFooter({ target, children }: { target?: HTMLElement | null; children: ReactNode }) {
  return target ? createPortal(children, target) : <>{children}</>;
}

/** One public form; retain the low-level named form export for existing integrations. */
export default function UploadModal(props: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const handledDraft = useRef<string>();
  const onDraftChange = useCallback((id: string) => {
    handledDraft.current = id;
    props.onDraftChange?.(id);
    const current = locationRef.current;
    const params = new URLSearchParams(current.search);
    if (id) params.set('uploadId', id); else params.delete('uploadId');
    if (!params.has('upload')) params.set('upload', props.initialMode === 'records' ? 'records' : '1');
    const search = `?${params.toString()}`;
    if (search !== current.search) navigate({ pathname: current.pathname, search, hash: current.hash }, { replace: true });
  }, [navigate, props.onDraftChange, props.initialMode]);
  return <LegacyUploadModal {...props} automaticAnalysis onDraftChange={onDraftChange}
    initialUploadId={props.initialUploadId === handledDraft.current ? undefined : props.initialUploadId} />;
}

type Kind = 'web' | 'skill' | 'service' | 'file' | 'link';
type Mode = 'wizard' | 'records';
/** 单页向导：填写信息提交（类型单选卡进页面即选定）→ 共用成功页；包类型仍由内容识别兜底纠偏 */
type Screen = 'edit' | 'done';

/** 类型名（记录展示 / 绑定列表 / 类型卡统一口径） */
const KIND_LABEL: Record<string, string> = { web: '网页工具', skill: 'AI 技能', service: '服务端应用', link: '链接地址', file: '客户端程序' };

/** 类型单选卡（原第①步「选择方式」合并进填写页）：驱动表单分支与「更新已有」列表；默认网页工具 */
const TYPES: { k: Kind; icon: string; name: string; desc: string }[] = [
  { k: 'web', icon: '🌐', name: '网页工具', desc: 'HTML / 前端 zip，平台静态托管' },
  { k: 'file', icon: '💻', name: '客户端程序', desc: 'exe / 安装包，整包下载分发' },
  { k: 'service', icon: '⚙️', name: '服务端应用', desc: 'Dockerfile / 启动脚本，容器部署' },
  { k: 'skill', icon: '🧠', name: '智能体 / AI 技能', desc: '主技能与子技能整体打包，自动识别' },
  { k: 'link', icon: '🔗', name: '链接地址', desc: '已部署在外部，填 URL 即可' },
];
const TYPE_OF: Record<string, { k: Kind; icon: string; name: string; desc: string }> = Object.fromEntries(TYPES.map((t) => [t.k, t]));

/** 复制文本：门户为 http 环境，clipboard API 不可用时回退 execCommand */
async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch { /* 非 secure context → 走兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Radix traps focus inside the dialog; a textarea in body loses its selection.
    const container = previousFocus?.closest('[role="dialog"]') || document.body;
    container.appendChild(ta);
    try {
      ta.focus({ preventScroll: true });
      ta.select();
      return document.execCommand('copy');
    } finally {
      ta.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
  } catch {
    return false;
  }
}

/** Copy the instructions for the currently selected resource and publication mode. */
function PackPromptButton({ kind, mode, className = '' }: { kind: PackResourceKind; mode: 'new' | 'update'; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      <button
        type="button"
        title={`复制${TYPE_OF[kind].name}的打包提示词`}
        className="text-accentText hover:underline text-left"
        aria-live="polite"
        onClick={async () => {
          const okc = await copyText(getPackPrompt(kind, mode));
          setCopied(okc);
        }}
      >
        {copied ? '已复制，粘贴到 WorkBuddy / Trae 即可' : '复制打包提示词'}
      </button>
      {!copied && <span className="text-t3">发给 WorkBuddy / Trae，帮你完成打包</span>}
    </span>
  );
}

const STEPS = ['填写信息 · 提交', '完成'];

const VERDICT: Record<string, { label: string; cls: string }> = {
  ok: { label: '✓ 可直接部署', cls: 'bg-okSoft text-ok' },
  warn: { label: '⚠ 可部署 · 有提醒项', cls: 'bg-warnSoft text-warn' },
  fail: { label: '✗ 解析失败', cls: 'bg-dangerSoft text-danger' },
};

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: '未提交', cls: 'bg-soft text-t3' },
  pending: { label: '待审核', cls: 'bg-warnSoft text-warn' },
  online: { label: '已上线', cls: 'bg-okSoft text-ok' },
  rejected: { label: '已驳回', cls: 'bg-dangerSoft text-danger' },
  deploying: { label: '正在发布', cls: 'bg-warnSoft text-warn' },
  deploy_failed: { label: '发布失败', cls: 'bg-dangerSoft text-danger' },
  offline: { label: '已下线', cls: 'bg-soft text-t3' },
};

const fmtDT = (t: number) => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/* 部门清单兜底值（接口不可达时用静态名册短名） */
const FALLBACK_DEPTS = [...new Set(baseUsers.map((u) => u.deptShort).filter(Boolean))];
const DEPT_ALL = '全部';

/** 「更新已有」绑定项 */
interface BindItem {
  v: string;
  name: string;
  kindLabel: string;
  tail: string;
  version: string;
  desc: string;
  tags: string[];
  departments: string[];
  category?: string;
  /** 已通过审核但未上架技能中心：置灰不可选（更新依赖线上 slug 升版本） */
  disabled?: boolean;
}

/** 名称归一化（忽略空格 / 分隔符 / 全半角括号）后与本人已上线记录匹配：先精确，再双向包含（≥4 字）；置灰项不参与 */
const normName = (s: string) => String(s || '').toLowerCase().replace(/[\s\-_·.。()（）]/g, '');
const matchOnline = (cands: string[], list: { v: string; name: string; disabled?: boolean }[]): { v: string; name: string } | null => {
  for (const c of cands) {
    const n = normName(c);
    const hit = n && list.find((t) => !t.disabled && normName(t.name) === n);
    if (hit) return hit;
  }
  for (const c of cands) {
    const n = normName(c);
    if (n.length < 4) continue;
    const hit = list.find((t) => {
      if (t.disabled) return false;
      const tn = normName(t.name);
      return tn.length >= 2 && (tn.includes(n) || n.includes(tn));
    });
    if (hit) return hit;
  }
  return null;
};

/** 两步引导线：current=1/2 表示当前步，3 表示全部完成（成功页） */
function Stepper({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2.5 pr-11 shrink-0">
      {STEPS.map((s, i) => {
        const n = i + 1;
        const done = n < current;
        const act = n === current;
        return (
          <div key={s} className="flex items-center gap-2.5 flex-1 last:flex-none">
            <span
              className={`w-[22px] h-[22px] rounded-full flex items-center justify-center text-[11px] font-mono font-semibold shrink-0 border ${
                act ? 'bg-accent border-accent text-primaryForeground' : done ? 'bg-okSoft border-transparent text-ok' : 'bg-soft border-line text-t3'
              }`}
            >
              {done ? '✓' : n}
            </span>
            <span className={`text-xs whitespace-nowrap ${act ? 'text-t1 font-semibold' : done ? 'text-t2' : 'text-t3'}`}>{s}</span>
            {n < STEPS.length && <span className={`flex-1 h-0.5 rounded ${done ? 'bg-ok' : 'bg-line'}`} />}
          </div>
        );
      })}
    </div>
  );
}

/** 适用部门多选下拉：单行触发框，已选按实测宽度自适应装入，放不下折叠为「+N」 */
function DeptPicker({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: string[] }) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState(value.length);
  const boxRef = useRef<HTMLDivElement>(null);

  /* 宽度钳制链内按实测累计宽度截断：短名多装几个、长名少装，永不撑爆（首枚保底） */
  const fold = useCallback(() => {
    const box = boxRef.current;
    if (!box || !box.clientWidth) return;
    const chips = Array.from(box.querySelectorAll<HTMLElement>('[data-chip]'));
    if (chips.length < 2) return setKeep(chips.length);
    const avail = box.clientWidth - 26;
    const widths = chips.map((c) => c.offsetWidth + 6);
    if (widths.reduce((a, b) => a + b, 0) <= avail) return setKeep(chips.length);
    let used = 0;
    let k = 0;
    for (let i = 0; i < chips.length; i++) {
      if (used + widths[i] + 44 <= avail || (i === 0 && widths[i] <= avail)) {
        used += widths[i];
        k++;
      } else break;
    }
    setKeep(Math.max(1, k));
  }, []);

  useLayoutEffect(() => {
    fold();
  }, [value, options, fold]);
  useEffect(() => {
    window.addEventListener('resize', fold);
    return () => window.removeEventListener('resize', fold);
  }, [fold]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const toggle = (d: string) => {
    const next = d === DEPT_ALL ? (value.includes(DEPT_ALL) ? [] : [DEPT_ALL]) : value.filter((x) => x !== DEPT_ALL).includes(d) ? value.filter((x) => x !== DEPT_ALL && x !== d) : [...value.filter((x) => x !== DEPT_ALL), d];
    setKeep(next.length); // 先全量展示，布局后再折叠（隐藏项测宽为 0）
    onChange(next);
  };

  const shown = value.slice(0, keep);
  const rest = value.length - shown.length;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={value.length ? `已选：${value.join('、')}` : ''}
        className="w-full min-w-0 flex items-center gap-1.5 h-[34px] rounded-[10px] border border-line bg-card dark:bg-card px-2.5 text-[11.5px] overflow-hidden hover:border-accent transition-colors"
      >
        {value.length ? (
          <>
            {shown.map((d) => (
              <span
                key={d}
                data-chip=""
                className="inline-flex items-center gap-1 rounded-md bg-accentSoft px-1.5 py-px text-accentText whitespace-nowrap shrink-0"
              >
                {d}
                <i
                  className="not-italic opacity-70 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(d);
                  }}
                >
                  ✕
                </i>
              </span>
            ))}
            {rest > 0 && <span className="inline-flex items-center rounded-md bg-soft border border-line px-1.5 py-px text-t2 whitespace-nowrap shrink-0">+{rest}</span>}
          </>
        ) : (
          <span className="text-t3">请选择适用部门（可多选）</span>
        )}
        <svg className="ml-auto w-3 h-3 text-t3 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[38px] z-20 rounded-xl border border-line bg-card dark:bg-card p-2 shadow-[0_14px_36px_rgba(15,20,25,.16)]">
          <div className="grid grid-cols-2 gap-x-2">
            {[DEPT_ALL, ...options].map((d) => {
              const on = value.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggle(d)}
                  className={`${d === DEPT_ALL ? 'col-span-2 border-b border-line rounded-none mb-1 pb-1.5' : ''} flex items-center gap-2 text-[11.5px] text-left px-2 py-1 rounded-lg hover:bg-soft dark:hover:bg-soft ${on ? 'text-accentText font-medium' : 'text-t2'}`}
                >
                  <span className={`w-[13px] h-[13px] rounded-[4px] border-[1.5px] flex items-center justify-center text-[9px] text-white shrink-0 ${on ? 'bg-accent border-accent' : 'border-[#C9C6DC]'}`}>{on ? '✓' : ''}</span>
                  {d === DEPT_ALL ? '全部（对所有部门可见）' : d}
                </button>
              );
            })}
          </div>
          <div className="flex items-center border-t border-line mt-1.5 pt-1.5 text-[10.5px] text-t3">
            <span>已选 {value.length} 项</span>
            <span className="flex-1" />
            <button type="button" className="text-accentText hover:underline" onClick={() => { setKeep(0); onChange([]); }}>
              清空
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecordRow({ m, onResume }: { m: UploadRow; onResume?: (m: UploadRow) => void }) {
  const st = STATUS[m.status] || STATUS.draft;
  const resumable = m.status === 'draft' || m.status === 'rejected';
  return (
    <div className="flex items-center gap-3 border-b border-line last:border-0 py-3">
      {m.iconUrl ? (
        <img src={m.iconUrl} alt="" className="w-9 h-9 rounded-lg object-cover border border-line shrink-0" />
      ) : (
        <span className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-semibold shrink-0" style={{ background: m.iconBg || '#EEEAFE', color: '#17161F' }}>
          {m.icon || m.name?.slice(0, 2) || '工'}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate">{m.name || m.filename || '未命名'}</div>
        <div className="text-[11px] text-t3 mt-0.5">
          {m.report?.structure?.kind === 'agent' ? '智能体' : KIND_LABEL[m.kind] || m.kind} · {fmtDT(m.submittedAt || m.createdAt)}
          {m.status === 'rejected' && m.rejectReason ? ` · 驳回原因：${m.rejectReason}` : ''}
          {m.status === 'online' && m.deployedUrl ? ` · ${m.deployedUrl}` : ''}
          {m.status === 'online' && m.kind === 'skill' ? (m.publishSlug ? ' · 已上架技能中心' : ' · 待上架技能中心') : ''}
          {m.status === 'draft' ? ' · 上传已保存，尚未提交审核' : ''}
          {m.status === 'draft' && m.report?.verdict === 'fail' ? ` · 需修正：${m.report.assistance?.errors[0] || m.report.lines.find((line) => line.startsWith('✗')) || '包检查未通过'}` : ''}
          {m.status === 'deploy_failed' ? ` · 失败原因：${m.deployError || '发布服务暂不可用，请联系管理员重试'}` : ''}
        </div>
      </div>
      {resumable && onResume && (
        <button type="button" className="text-xs text-accentText hover:underline shrink-0" onClick={() => onResume(m)}>
          {m.status === 'draft' ? '继续提交 →' : '修改后重新提交 →'}
        </button>
      )}
      <span className={`pill font-normal shrink-0 ${st.cls}`}>{st.label}</span>
    </div>
  );
}

/** 发布资源：资源意图与实际部署渠道分开；包修正与审核提交共用草稿。 */
export function LegacyUploadModal({ onClose, initialMode = 'wizard', initialUploadId, embedded = false, footerTarget, onDraftChange, onMetadataChange, automaticAnalysis = false }: Props) {
  const nav = useNavigate();
  const { session } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [screen, setScreen] = useState<Screen>('edit');
  const [kind, setKind] = useState<Kind>('web');
  const [uploadId, setUploadId] = useState('');
  const [submissionRevision, setSubmissionRevision] = useState<number | undefined>();
  useEffect(() => { if (uploadId) onDraftChange?.(uploadId); }, [uploadId, onDraftChange]);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [resourceType, setResourceType] = useState<ResourceType>('tool');
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairMounted, setRepairMounted] = useState(false);
  const [repairDirty, setRepairDirty] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const resumeRef = useRef<(row: UploadRow) => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const requestEpoch = useRef(0);
  const analysisController = useRef<AbortController>();
  const [analysis, setAnalysis] = useState<SmartAnalysis | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [draftMessage, setDraftMessage] = useState('');
  const requestedClassification = useRef<{ type: ResourceType; kind: Kind }>();
  const autoMetadata = useRef({ name: '', desc: '' });
  const analysisTarget = useRef('');
  const analyzeRef = useRef<(id: string, body: AnalyzeRequest, uploadKind?: Kind) => Promise<void>>(async () => {});
  const metadataRef = useRef<SmartDraftMetadata>();
  const analysisIntent = useRef<AnalyzeRequest>({});
  useEffect(() => () => { requestEpoch.current++; analysisController.current?.abort(); }, []);
  const [fname, setFname] = useState('');
  const [busy, setBusy] = useState(false);
  const [parseErr, setParseErr] = useState('');
  const [meta, setMeta] = useState({ name: '', desc: '', icon: '', url: '' });
  const [tags, setTags] = useState<string[]>([]);
  const [skillCategory, setSkillCategory] = useState(SKILL_CATEGORIES[0]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [departments, setDepartments] = useState<string[]>([DEPT_ALL]);
  const [deptOptions, setDeptOptions] = useState<string[]>(FALLBACK_DEPTS);
  const [iconUrl, setIconUrl] = useState('');
  const [iconBg, setIconBg] = useState('');
  const [toolCategory, setToolCategory] = useState('');
  const [iconMode, setIconMode] = useState<'text' | 'web'>('text');
  const [iconMsg, setIconMsg] = useState('');
  const [submitErr, setSubmitErr] = useState('');
  const [mine, setMine] = useState<UploadRow[] | null>(null);
  /* 版本类型与绑定：新建资源 / 更新已有（仅本人名下已上线记录；选定后基本信息自动带入，名称锁定） */
  const [myOnline, setMyOnline] = useState<{ tools?: MyOnlineTool[]; skills?: MyOnlineSkill[] } | null>(null);
  const [updateMode, setUpdateMode] = useState<'new' | 'update'>('new');
  const [updateTarget, setUpdateTarget] = useState('');
  const [updateNote, setUpdateNote] = useState('');
  useEffect(() => {
    setDraftMessage('');
    if (uploadId) onMetadataChange?.({
      name: meta.name, desc: meta.desc, updateNote,
      icon: meta.icon.trim().slice(0, 2) || meta.name.trim().slice(0, 2) || '工',
      iconUrl: iconMode === 'web' ? iconUrl : '', iconBg,
      url: kind === 'link' ? meta.url.trim() : '',
      tags, departments, category: kind === 'skill' ? skillCategory : toolCategory,
    });
  }, [uploadId, meta.name, meta.desc, meta.icon, meta.url, updateNote, iconMode, iconUrl, iconBg, tags, departments, skillCategory, toolCategory, kind, onMetadataChange]);
  const [updateVersion, setUpdateVersion] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const shotRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  /* 材料：截图 ≤2 / 说明书 1（随会话提交） */
  const [shotFiles, setShotFiles] = useState<{ name: string; url: string }[]>([]);
  const [docFile, setDocFile] = useState<{ name: string; size: string } | null>(null);
  const [parseOpen, setParseOpen] = useState(false);
  const [matBusy, setMatBusy] = useState('');
  /* 更新已有：基本信息默认折叠（mdOpen 展开）；解析自动匹配更新对象（autoTarget）；改选其他项需二次确认（warnTarget） */
  const [mdOpen, setMdOpen] = useState(false);
  const [autoTarget, setAutoTarget] = useState('');
  const [warnTarget, setWarnTarget] = useState('');
  /* 解析识别与所选类型不一致时的纠偏提示（类型自动切换的说明条） */
  const [fixMsg, setFixMsg] = useState('');

  const loadMine = () => {
    api.uploads.mine().then((r) => {
      if (r.ok) setMine(r.rows || []);
    });
    api.uploads.myOnline().then((m) => setMyOnline(m)).catch(() => {});
  };
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);
  useEffect(() => {
    if (session) {
      if (!initialUploadId) loadMine();
      else api.uploads.myOnline().then(setMyOnline).catch(() => {});
      api.meta.departments().then((r) => {
        if (r.ok && r.departments?.length) setDeptOptions(r.departments);
      }).catch(() => {});
    }
  }, [session?.username]);

  useEffect(() => {
    if (!initialUploadId || !session?.username) return;
    let active = true;
    resetRef.current();
    setBusy(false);
    api.uploads.mine().then((result) => {
      if (!active) return;
      if (!result.ok) { setResumeError(result.message || '无法读取草稿，请重试'); return; }
      setMine(result.rows || []);
      const item = (result.rows || []).find((item: UploadRow) => item.id === initialUploadId && item.u === session.username);
      if (!item) { setResumeError('该草稿不存在或不属于当前账号'); return; }
      if (!['draft', 'rejected'].includes(item.status)) { setResumeError('该记录已进入审核或发布流程，不能继续编辑'); return; }
      resumeRef.current(item);
    }).catch(() => { if (active) setResumeError('无法读取草稿，请重试'); });
    return () => { active = false; };
  }, [initialUploadId, session?.username]);

  // 未登录：引导登录后回来继续上传
  if (!session) {
    return (
      <ZbModal open onClose={onClose} label="登录提示" maxWidth="max-w-[400px]" className="p-8 text-center">
          <div className="text-base font-semibold mb-2">上传工具需要先登录</div>
          <p className="text-xs text-t3 mb-6">登录后可上传自己的工具，并在「上传记录」随时查看审核进度</p>
          <button
            className="btn-primary w-full h-11 !text-sm"
            onClick={() => {
              try {
                sessionStorage.setItem('skillharbor-pending', JSON.stringify({ type: 'upload' }));
              } catch { /* ignore */ }
              onClose();
              nav('/login', { state: { from: '/' } });
            }}
          >
            去登录 →
          </button>
      </ZbModal>
    );
  }

  const resetEditState = () => {
    requestEpoch.current++;
    analysisController.current?.abort();
    setAnalysis(null); setAnalysisBusy(false); setAnalysisError(''); setDraftMessage('');
    requestedClassification.current = undefined;
    autoMetadata.current = { name: '', desc: '' }; analysisTarget.current = ''; analysisIntent.current = {};
    setRepairOpen(false); setRepairMounted(false); setRepairDirty(false); setResumeError('');
    setReport(null);
    setParseErr('');
    setUploadId('');
    setFname('');
    setUpdateMode('new');
    setUpdateTarget('');
    setUpdateNote('');
    setUpdateVersion('');
    setShotFiles([]);
    setDocFile(null);
    setParseOpen(false);
    setMeta({ name: '', desc: '', icon: '', url: '' });
    setSubmissionRevision(undefined);
    setTags([]);
    setSkillCategory(SKILL_CATEGORIES[0]);
    setDepartments([DEPT_ALL]);
    setIconUrl('');
    setIconBg('');
    setToolCategory('');
    setIconMode('text');
    setIconMsg('');
    setSubmitErr('');
    setMdOpen(false);
    setAutoTarget('');
    setWarnTarget('');
    setFixMsg('');
  };
  resetRef.current = resetEditState;

  /** 「重新上传」：作废当前解析会话（解锁类型卡），并清掉纠偏提示与更新绑定——绑定依附于已解析内容，内容作废即失效 */
  const clearParsed = () => {
    if (busy || matBusy) return;
    onDraftChange?.('');
    requestEpoch.current++;
    analysisController.current?.abort();
    setAnalysis(null); setAnalysisBusy(false); setAnalysisError(''); setDraftMessage('');
    requestedClassification.current = undefined; analysisTarget.current = ''; analysisIntent.current = {};
    const previousAuto = autoMetadata.current;
    setMeta(current => ({ ...current, name: current.name === previousAuto.name ? '' : current.name, desc: current.desc === previousAuto.desc ? '' : current.desc }));
    autoMetadata.current = { name: '', desc: '' };
    setRepairOpen(false); setRepairMounted(false); setRepairDirty(false);
    shotFiles.forEach((f) => { if (f.url.startsWith('blob:')) URL.revokeObjectURL(f.url); });
    setShotFiles([]);
    setDocFile(null);
    setParseErr('');
    setReport(null);
    setUploadId('');
    setFname('');
    setFixMsg('');
    setUpdateMode('new');
    setUpdateTarget('');
    setAutoTarget('');
    setWarnTarget('');
  };

  /** 包解析会话存在期间类型锁定（识别结果即部署事实；「重新上传」清会话后解锁；链接无包不锁） */
  const typeLocked = kind !== 'link' && !!uploadId;

  /** 类型单选卡切换：重置编辑态后按新类型展开表单；链接走 parseOnly 建会话（无文件）。
   *  包解析会话存在期间锁定（类型以识别结果为准，重新上传后解锁） */
  const pickType = (k: Kind) => {
    if (k === kind || typeLocked || busy || matBusy) return;
    onDraftChange?.('');
    resetEditState();
    setKind(k);
    if (k === 'link') {
      setBusy(true);
      api.uploads.parseOnly().then((r) => {
        if (r.ok) {
          setUploadId(r.id);
          setReport(r.report);
        } else setParseErr(r.message || '初始化失败');
      }).catch(() => setParseErr('网络连接中断，请重试')).finally(() => setBusy(false));
    }
  };

  /* 继续上传（成功页 → 回到填写页，类型回到默认） */
  const restartWizard = () => {
    onDraftChange?.('');
    resetEditState();
    setKind('web');
    setResourceType('tool');
    setScreen('edit');
  };

  /* 草稿和驳回记录共用原包与报告；历史上已清理的文件仍需重新上传。 */
  const resumeRecord = (m: UploadRow) => {
    if (busy || matBusy) return;
    resetEditState();
    setMode('wizard');
    setKind(m.kind);
    setSubmissionRevision(m.packageRevision ?? m.report?.assistance?.revision ?? 0);
    setResourceType(m.resourceType || (m.kind === 'skill' ? m.report?.structure?.kind || 'skill' : 'tool'));
    setScreen('edit');
    const skillName = (m.report?.lines || []).map((l) => /^✓ 技能名称：(.+)$/.exec(l)?.[1]).find(Boolean) || '';
    if (m.sourceAvailable !== false || m.kind === 'link') {
      setUploadId(m.id);
      setReport(m.report || null);
      setFname(m.filename || '');
    } else {
      setParseErr('原上传文件已不可用，请重新上传文件包；已保留原表单信息');
    }
    setMeta({
      name: m.name || skillName,
      desc: m.desc && m.desc !== '（待补充）' ? m.desc : '',
      icon: m.icon || '',
      url: m.kind === 'link' ? m.url || '' : '',
    });
    const savedTags = Array.isArray(m.tags) ? m.tags : [];
    setTags(savedTags);
    setCustomTags(savedTags.filter((t) => !BASE_TAGS.includes(t)));
    if (m.kind === 'skill' && m.category) setSkillCategory(m.category);
    setToolCategory(m.kind !== 'skill' ? m.category || '' : '');
    setIconBg(m.iconBg || '');
    setDepartments(m.departments?.length ? m.departments : [DEPT_ALL]);
    if (m.iconUrl) {
      setIconUrl(m.iconUrl);
      setIconMode('web');
    }
    if (m.updateOf) {
      setUpdateMode('update');
      setAutoTarget(m.updateOf);
      setUpdateTarget(m.updateOf);
      setUpdateNote(m.updateNote || '');
      setUpdateVersion(m.updateVersion || '');
    } else {
      /* 与新上传同规则：解析名 / 原名匹配本人已上线记录 → 自动进「更新已有」（名称锁定为线上名、标签部门带入，
       * 防 draft 按无前缀解析名提交成近似重名新技能）；无命中且标签为空（draft 表单从未存过）预选首个基础标签，恢复即可提交。
       * 此刻 state.kind 仍是 null（记录列表页），绑定列表须按记录的 m.kind 显式构建再传入 */
      const cands = [skillName, m.name].filter(Boolean) as string[];
      const items = buildBindItems(m.kind);
      const hit = matchOnline(cands, items);
      if (hit && !automaticAnalysis) {
        setUpdateMode('update');
        setAutoTarget(hit.v);
        setMdOpen(false);
        setWarnTarget('');
        pickUpdateTarget(hit.v, items);
      } else if (!savedTags.length) {
        setTags([BASE_TAGS[0]]);
      }
    }
    if (automaticAnalysis && m.kind !== 'link' && m.sourceAvailable !== false) {
      const saved = (m as SmartUploadRow).smartAnalysis;
      analysisTarget.current = m.updateOf || '';
      analysisIntent.current = m.updateOf ? { updateOf: m.updateOf } : {};
      if (isSmartAnalysis(saved) && saved.revision === (m.packageRevision || 0) && ((m.kind === 'skill') === (saved.kind !== 'tool'))) {
        setAnalysis(saved);
        analysisIntent.current = saved.updateOf ? { updateOf: saved.updateOf } : saved.newResource ? { newResource: true } : {};
        if (saved.updateOf) { setUpdateMode('update'); setUpdateTarget(saved.updateOf); }
        if (saved.kind) setResourceType(saved.kind);
      } else if (saved && !isSmartAnalysis(saved)) {
        setAnalysisError('保存的解析结果格式异常，请重新解析');
      } else void analyzeRef.current(m.id, { revision: m.packageRevision || 0, ...(m.updateOf ? { updateOf: m.updateOf } : {}) }, m.kind);
    }
  };

  resumeRef.current = resumeRecord;

  const bumpVersion = (v?: string) => {
    const parts = String(v || '1.0.0').split('.').map((x) => parseInt(x, 10) || 0);
    parts[2] = (parts[2] || 0) + 1;
    return parts.join('.');
  };
  /* 「更新已有」绑定项构建：含自动带入的基本信息（名称锁定，其余可改）；仅本人名下已上线记录。
   * 按类型严格过滤：技能 → 已上架技能（未上架置灰展示）；工具 → 卡片类型与所选一致的同子类记录（网页/客户端/服务端/链接不互通）。
   * 独立成函数并接受 kind：解析回调里 setKind 刚入队、state.kind 仍是旧值，须按识别结果显式构建传入（曾因此带入静默失效） */
  const buildBindItems = (k: string): BindItem[] =>
    k === 'skill'
      ? (myOnline?.skills || []).map((s): BindItem => ({
          v: s.pendingPublish ? 'pending:' + (s.id || s.name) : 'skill:' + s.slug,
          name: s.name,
          kindLabel: 'AI 技能',
          tail: s.pendingPublish ? '已通过审核 · 待上架技能中心' : s.onlineAt + ' 上线',
          version: s.version || '',
          desc: s.desc || '',
          tags: s.tags || [],
          departments: s.departments || [],
          category: s.category || '',
          disabled: !!s.pendingPublish,
        }))
      : (myOnline?.tools || []).filter((t) => t.kind === k).map((t): BindItem => ({
          v: 'tool:' + t.id,
          name: t.name,
          kindLabel: KIND_LABEL[t.kind] || '工具',
          tail: t.updatedAt ? '更新于 ' + t.updatedAt : t.onlineAt + ' 上线',
          version: '',
          desc: t.desc || '',
          tags: t.tags || [],
          departments: t.departments || [],
        }));
  const baseBindList = buildBindItems(kind);
  const confirmedTarget: BindItem | null = automaticAnalysis && analysis?.updateOf && analysis.updateOf === updateTarget && !baseBindList.some(item => item.v === updateTarget)
    ? { v: updateTarget, name: analysis.resource.name, kindLabel: kind === 'skill' ? 'AI 技能' : '工具', tail: '已确认的本人资源', version: updateVersion, desc: meta.desc, tags, departments } : null;
  const bindList = confirmedTarget ? [...baseBindList, confirmedTarget] : baseBindList;
  /** 类型卡徽标：本人名下该类型可更新的已上线数（技能只数已上架；0 不显示，避免噪音） */
  const myCount = (k: string) => (k === 'skill' ? (myOnline?.skills || []).filter((s) => !s.pendingPublish).length : (myOnline?.tools || []).filter((t) => t.kind === k).length);
  /** 空态引导：其他类型下名下有记录时，指名道姓告诉用户点哪张卡 */
  const otherKinds = TYPES.filter((t) => t.k !== kind && myCount(t.k) > 0);
  const bindSel = bindList.find((x) => x.v === updateTarget);
  const isUpdate = updateMode === 'update' && !!bindSel;

  const pickUpdateTarget = (v: string, listOverride?: BindItem[]) => {
    setUpdateTarget(v);
    const t = (listOverride || bindList).find((x) => x.v === v);
    if (!t || t.disabled) return;
    if (t) {
      /* 基本信息（功能描述 / 标签 / 适用部门）自动带入，可修改；名称锁定 */
      setMeta((m) => ({ ...m, name: t.name, desc: t.desc }));
      setTags(t.tags || []);
      setDepartments(t.departments?.length ? t.departments : [DEPT_ALL]);
      if (t.category) setSkillCategory(t.category);
      if (t.version) setUpdateVersion(bumpVersion(t.version));
    }
  };

  /* 改选更新对象：与解析自动匹配不一致时拦截，二次确认后才生效 */
  const onUpdateTargetChange = (v: string) => {
    if (automaticAnalysis && (analysisBusy || repairDirty)) return;
    if (v && autoTarget && v !== autoTarget && v !== updateTarget) {
      setWarnTarget(v);
      return;
    }
    setWarnTarget('');
    pickUpdateTarget(v);
    if (v) reanalyzeTarget(v);
  };

  const classify = (actualType: ResourceType, actualKind: Kind) => {
    setResourceType(actualType);
    const requested = requestedClassification.current;
    if (!requested) return;
    const labels = { agent: '智能体', skill: 'AI 技能', tool: '工具' };
    const typeMismatch = requested.type !== actualType;
    const channelMismatch = actualType === 'tool' && requested.type === 'tool' && requested.kind !== actualKind;
    setFixMsg(typeMismatch || channelMismatch
      ? `分类不一致：你选择「${labels[requested.type]}${requested.type === 'tool' ? ` · ${KIND_LABEL[requested.kind]}` : ''}」，包内容识别为「${labels[actualType]}${actualType === 'tool' ? ` · ${KIND_LABEL[actualKind]}` : ''}」。已按实际内容调整，请核对是否上传了正确的文件包。`
      : '');
  };

  const acceptAnalysis = (value: SmartAnalysis, nextReport: UploadReport | undefined, revision: number, uploadKind: Kind) => {
    const previousTarget = analysisTarget.current;
    const previousAuto = autoMetadata.current;
    const target = value.updateOf || '';
    setAnalysis({ ...value, revision });
    setAnalysisError('');
    setSubmissionRevision(revision);
    if (nextReport && value.status !== 'question') setReport(nextReport);
    classify(value.kind, uploadKind);
    setMeta(current => ({ ...current,
      name: target || !current.name.trim() || current.name === previousAuto.name ? value.resource.name.slice(0, 30) : current.name,
      desc: !current.desc.trim() || current.desc === previousAuto.desc ? value.resource.description.slice(0, 300) : current.desc,
    }));
    autoMetadata.current = { name: value.resource.name.slice(0, 30), desc: value.resource.description.slice(0, 300) };
    if (target) {
      setUpdateMode('update'); setUpdateTarget(target); setAutoTarget(target);
      const display = value.displayMetadata;
      if (display && previousTarget !== target) {
        if (Array.isArray(display.tags)) { setTags(display.tags); setCustomTags(display.tags.filter(tag => !BASE_TAGS.includes(tag))); }
        if (Array.isArray(display.departments)) setDepartments(display.departments.length ? display.departments : [DEPT_ALL]);
        if (typeof display.category === 'string') { if (uploadKind === 'skill') setSkillCategory(display.category); else setToolCategory(display.category); }
        if (typeof display.icon === 'string') setMeta(current => ({ ...current, icon: display.icon! }));
        setIconUrl(display.iconUrl || ''); setIconBg(display.iconBg || ''); setIconMode(display.iconUrl ? 'web' : 'text');
      }
      if (nextReport?.structure?.version) setUpdateVersion(nextReport.structure.version);
      analysisIntent.current = { updateOf: target };
    } else if (value.newResource || value.status === 'ready') {
      setUpdateMode('new'); setUpdateTarget('');
      analysisIntent.current = { newResource: true };
    }
    analysisTarget.current = target;
    if (value.status === 'ready') { setRepairDirty(false); setRepairMounted(false); setRepairOpen(false); }
  };

  const analyzePackage = async (id: string, body: AnalyzeRequest, uploadKind: Kind = kind) => {
    const epoch = ++requestEpoch.current;
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    setAnalysis(null); setAnalysisBusy(true); setAnalysisError(''); setDraftMessage('');
    analysisIntent.current = { ...(body.newResource ? { newResource: true } : {}), ...(body.updateOf ? { updateOf: body.updateOf } : {}) };
    try {
      const result = await smartUpload.analyze(id, body, controller.signal);
      if (epoch !== requestEpoch.current) return;
      if (!result.ok || !isSmartAnalysis(result.analysis)) throw new Error(result.message || '解析结果格式异常，请重新解析');
      let value = result.analysis;
      const revision = result.revision ?? value.revision;
      if (!Number.isInteger(revision) || revision! < (body.revision || 0)) throw new Error('解析结果已过期，请同步草稿后重新解析');
      if ((uploadKind === 'skill') !== (value.kind !== 'tool')) throw new Error('解析分类与实际文件类型不一致，请重新上传核对');
      if ((body.updateOf && value.updateOf !== body.updateOf) || (body.newResource && value.updateOf)) throw new Error('发布对象发生变化，请重新确认新建或更新的资源');
      if (value.updateOf && value.displayMetadata === undefined && analysisTarget.current !== value.updateOf) {
        const owned = myOnline || await api.uploads.myOnline();
        if (epoch !== requestEpoch.current) return;
        const item = value.updateOf.startsWith('skill:') ? owned.skills?.find(item => `skill:${item.slug}` === value.updateOf) : owned.tools?.find(item => `tool:${item.id}` === value.updateOf);
        if (!item) throw new Error('无法读取要更新资源的展示设置，请重新解析');
        value = { ...value, displayMetadata: item };
      }
      acceptAnalysis(value, result.report, revision!, uploadKind);
    } catch (error) {
      if (epoch === requestEpoch.current) setAnalysisError(error instanceof Error ? error.message : '包内容解析中断，请重试');
    } finally {
      if (epoch === requestEpoch.current) setAnalysisBusy(false);
    }
  };
  analyzeRef.current = analyzePackage;

  const retryAnalysis = async () => {
    if (!uploadId || busy || matBusy || analysisBusy || repairDirty) return;
    const epoch = ++requestEpoch.current;
    const intent = { ...analysisIntent.current };
    setAnalysis(null); setAnalysisBusy(true); setAnalysisError('');
    try {
      const result = await api.uploads.mine();
      if (epoch !== requestEpoch.current) return;
      if (!result.ok) throw new Error(result.message || '无法同步草稿，请稍后重试');
      const record = (result.rows || []).find((item: UploadRow) => item.id === uploadId && item.u === session.username) as SmartUploadRow | undefined;
      if (!record) throw new Error('该草稿不存在或不属于当前账号');
      if (!['draft', 'rejected'].includes(record.status)) throw new Error('该记录已进入审核或发布流程，不能继续编辑');
      if (record.sourceAvailable === false) throw new Error('原文件已不可用，请重新上传文件包');
      const latest = record.smartAnalysis;
      const revision = record.packageRevision || 0;
      const sameTarget = intent.updateOf ? latest?.updateOf === intent.updateOf : !latest?.updateOf;
      if (isSmartAnalysis(latest) && latest.status === 'ready' && latest.revision === revision && sameTarget && ((kind === 'skill') === (latest.kind !== 'tool'))) acceptAnalysis(latest, record.report, revision, kind);
      else await analyzePackage(uploadId, { revision, ...intent });
    } catch (error) {
      if (epoch === requestEpoch.current) setAnalysisError(error instanceof Error ? error.message : '无法同步草稿，请重试');
    } finally { if (epoch === requestEpoch.current) setAnalysisBusy(false); }
  };

  const saveDraft = async () => {
    if (!uploadId || !metadataRef.current || busy || analysisBusy || matBusy) return;
    const epoch = requestEpoch.current;
    const controller = new AbortController();
    analysisController.current = controller;
    setMatBusy('draft'); setDraftMessage(''); setSubmitErr('');
    try {
      const result = await smartUpload.saveDraft(uploadId, { ...metadataRef.current, revision: submissionRevision ?? 0 }, controller.signal);
      if (epoch !== requestEpoch.current) return;
      if (!result.ok) setSubmitErr(result.message || '草稿保存失败，请重试');
      else setDraftMessage('草稿已保存');
    } catch { if (epoch === requestEpoch.current) setSubmitErr('草稿保存中断，请重试'); }
    finally { if (epoch === requestEpoch.current) setMatBusy(''); }
  };

  const reanalyzeTarget = (target: string) => {
    if (!automaticAnalysis || !uploadId || kind === 'link') return;
    if (repairDirty || analysisBusy) return;
    void analyzePackage(uploadId, { revision: submissionRevision ?? 0, ...(target ? { updateOf: target } : { newResource: true }) });
  };

  const doFile = async (f: File) => {
    if (!kind || busy || matBusy || analysisBusy) return;
    if (f.size > 150 * 1024 * 1024) { setParseErr(`文件 ${(f.size / 1024 / 1024).toFixed(0)}MB，超过 150MB 上限，请精简压缩包后重新上传`); return; }
    setBusy(true); setParseErr(''); setFname(f.name); setDraftMessage('');
    requestedClassification.current = { type: resourceType, kind };
    const epoch = ++requestEpoch.current;
    try {
      // The selected classification is intent, never evidence about the package's contents.
      const r = automaticAnalysis ? await api.uploads.parse(f, 'auto') : await api.uploads.parse(f, 'auto', resourceType);
      if (epoch !== requestEpoch.current) return;
      if (!r.ok || !r.id) { setParseErr(r.message || '解析失败，请检查文件'); return; }
      const detected = (r.detected && r.detected !== 'auto' ? r.detected : r.kind) as Kind;
      const actualKind = detected || kind;
      setKind(actualKind); setUploadId(r.id);
      const revision = r.revision ?? r.report?.assistance?.revision ?? 0;
      setSubmissionRevision(revision); setReport(r.report);
      const identified = actualKind === 'skill' ? r.report?.structure?.kind : 'tool';
      if (identified) classify(identified, actualKind);
      else if (actualKind === 'skill' && resourceType === 'tool') setResourceType('skill');
      const items = buildBindItems(actualKind);
      const hit = matchOnline(Array.isArray(r.parsedNames) ? r.parsedNames : [], items);
      if (!automaticAnalysis && hit) {
        setUpdateMode('update'); setAutoTarget(hit.v); setMdOpen(false); setWarnTarget(''); pickUpdateTarget(hit.v, items);
      }
      setBusy(false);
      if (automaticAnalysis) {
        const explicitTarget = updateMode === 'update' && items.some(item => item.v === updateTarget && !item.disabled) ? updateTarget : '';
        await analyzePackage(r.id, { revision, ...(explicitTarget ? { updateOf: explicitTarget } : {}) }, actualKind);
      }
    } catch { if (epoch === requestEpoch.current) setParseErr('上传连接中断（网络异常），请重试'); }
    finally { if (epoch === requestEpoch.current) setBusy(false); }
  };

  const fetchIcon = async () => {
    if (!/^https?:\/\//.test(meta.url.trim())) {
      setIconMsg('请先填写正确的 http(s) 地址');
      return;
    }
    setIconMsg('正在获取网页图标…');
    const r = await api.uploads.icon(meta.url.trim());
    if (r.ok && r.iconUrl) {
      setIconUrl(r.iconUrl);
      setIconMode('web');
      setIconMsg('已使用网页图标');
    } else {
      setIconMsg(r.message || '未能获取，可使用文字图标');
    }
  };

  /* 材料操作（截图 ≤2 张 / 说明书 1 份，随会话提交） */
  const upShot = async (f: File) => {
    if (!uploadId || busy || matBusy) return;
    if (shotFiles.length >= 2) return;
    if (f.size > 5 * 1024 * 1024) { setParseErr('截图单张不超过 5MB'); return; }
    setMatBusy('shot');
    try {
      const r = await api.uploads.material(uploadId, 'shot', f);
      if (r.ok) {
        const url = URL.createObjectURL(f);
        setShotFiles((v) => [...v, { name: f.name, url }].slice(0, 2));
      } else setParseErr(r.message || '截图上传失败');
    } catch { setParseErr('截图上传连接中断，请重试'); }
    finally { setMatBusy(''); }
  };
  const delShot = async (i: number) => {
    if (!uploadId || busy || matBusy) return;
    setMatBusy('shot');
    try {
      const r = await api.uploads.materialDel(uploadId, 'shot', i + 1);
      if (r.ok) setShotFiles((v) => v.filter((_, x) => x !== i));
      else setParseErr(r.message || '截图删除失败，请重试');
    } catch { setParseErr('截图删除连接中断，请重试'); }
    finally { setMatBusy(''); }
  };
  const upDoc = async (f: File) => {
    if (!uploadId || busy || matBusy) return;
    if (f.size > 20 * 1024 * 1024) { setParseErr('说明书不超过 20MB'); return; }
    setMatBusy('doc');
    try {
      const r = await api.uploads.material(uploadId, 'doc', f);
      if (r.ok) setDocFile({ name: f.name, size: (f.size / 1024 / 1024).toFixed(1) + ' MB' });
      else setParseErr(r.message || '说明书上传失败');
    } catch { setParseErr('说明书上传连接中断，请重试'); }
    finally { setMatBusy(''); }
  };
  const delDoc = async () => {
    if (!uploadId || busy || matBusy) return;
    setMatBusy('doc');
    try {
      const r = await api.uploads.materialDel(uploadId, 'doc');
      if (r.ok) setDocFile(null);
      else setParseErr(r.message || '说明书删除失败，请重试');
    } catch { setParseErr('说明书删除连接中断，请重试'); }
    finally { setMatBusy(''); }
  };

  const analysisReady = !automaticAnalysis || kind === 'link' || (!analysisBusy && !analysisError && analysis?.status === 'ready' && analysis.revision === submissionRevision && (updateMode === 'update' ? !!updateTarget && analysis.updateOf === updateTarget : !analysis.updateOf));
  metadataRef.current = { name: meta.name, desc: meta.desc, updateNote,
    icon: meta.icon.trim().slice(0, 2) || meta.name.trim().slice(0, 2) || '工',
    iconUrl: iconMode === 'web' ? iconUrl : '', iconBg, url: kind === 'link' ? meta.url.trim() : '',
    tags, departments, category: kind === 'skill' ? skillCategory : toolCategory,
  };
  const submitAll = async () => {
    if (busy || matBusy || repairDirty || report?.verdict === 'fail' || !analysisReady) return;
    setSubmitErr('');
    if (updateMode === 'update' && !isUpdate) { setSubmitErr('请选择要更新的已有资源'); return; }
    /* 缺什么点提交时明说，不再靠按钮禁用静默拦截（曾因恢复 draft 标签为空，按钮点了没任何反馈） */
    if (kind !== 'link' && (!uploadId || !report)) {
      setSubmitErr('请先上传并解析文件');
      return;
    }
    if (kind === 'link' && !uploadId) {
      setSubmitErr('链接上传会话未就绪，请重新选择链接类型后重试');
      return;
    }
    if (kind === 'link' && !/^https?:\/\//.test(meta.url.trim())) {
      setSubmitErr('请填写正确的 http(s) 访问地址');
      return;
    }
    if (!meta.name.trim()) {
      setSubmitErr('请在右侧「完善信息」区填写名称');
      return;
    }
    /* 更新提交沿用原记录的业务标签（有则带入）：网关直传技能等无历史标签时不强制补选——
     * 线上卡片/筛选不依赖标签改写，卡住更新反而违背「更新只改增量」的预期 */
    if (!tags.length && !isUpdate) {
      setSubmitErr('请在右侧「完善信息」区选择至少 1 个业务标签');
      return;
    }
    if (isUpdate && !updateNote.trim()) {
      setSubmitErr('更新提交必须填写更新说明');
      return;
    }
    if (isUpdate && kind === 'skill' && report?.structure?.source !== 'manifest' && !updateVersion.trim()) {
      setSubmitErr('请填写目标版本号');
      return;
    }
    setBusy(true);
    try {
      const r = await api.uploads.submit(uploadId, {
        name: meta.name.trim(),
        desc: meta.desc.trim(),
        icon: meta.icon.trim().slice(0, 2) || meta.name.trim().slice(0, 2) || '工',
        iconUrl: iconMode === 'web' ? iconUrl : '',
        iconBg,
        url: kind === 'link' ? meta.url.trim() : '',
        category: kind === 'skill' ? skillCategory : toolCategory,
        tags,
        departments: departments.length ? departments : [DEPT_ALL],
        updateOf: isUpdate ? updateTarget : '',
        updateNote: isUpdate ? updateNote.trim() : '',
        updateVersion: kind === 'skill' && report?.structure?.source === 'manifest' ? report.structure.version : isUpdate && kind === 'skill' ? updateVersion.trim() : '',
        revision: Math.max(submissionRevision ?? 0, report?.assistance?.revision ?? 0),
      });
      if (r.ok) {
        setScreen('done');
        loadMine();
      } else {
        if (automaticAnalysis && kind !== 'link' && r.status === 409) {
          setAnalysis(null);
          setAnalysisError(r.message || '草稿内容已更新，请重新解析并核对后提交审核');
        } else setSubmitErr(r.message || '提交失败');
      }
    } catch { setSubmitErr('提交连接中断，请重试'); }
    finally { setBusy(false); }
  };

  const tagCandidates = [...BASE_TAGS, ...customTags];
  const addCustomTag = () => {
    const t = newTag.trim().slice(0, 8);
    if (!t) return;
    if (!tagCandidates.includes(t)) setCustomTags((v) => [...v, t]);
    setTags((v) => (v.includes(t) ? v : [...v, t]));
    setNewTag('');
  };

  const counts = {
    pending: mine?.filter((m) => m.status === 'pending').length || 0,
    online: mine?.filter((m) => m.status === 'online').length || 0,
    rejected: mine?.filter((m) => m.status === 'rejected').length || 0,
  };
  const parsedOk = !!report && report.verdict !== 'fail';
  /* 表单就绪度仅用于按钮视觉弱化提示；缺项时点击提交由 submitAll 逐项报错（不再静默禁用） */
  const canSubmit =
    !!meta.name.trim() &&
    (isUpdate || tags.length > 0) &&
    (kind === 'link' ? /^https?:\/\//.test(meta.url.trim()) : parsedOk);
  const ownerHint = `负责人：${session.name} · ${session.dept}（自动带入）`;
  const footHint =
    kind === 'skill'
      ? `${ownerHint} · 解析通过即可提交 · 审核通过后自动上架技能中心，WorkBuddy 同步可用`
      : kind === 'link'
        ? `${ownerHint} · 地址必填 · 截图 / 说明书可选 · 提交后管理员审核，通过即自动上线`
        : kind === 'file'
          ? `${ownerHint} · 将作为「客户端程序」上线，同事点「打开工具」即下载整包`
          : kind === 'service'
            ? `${ownerHint} · 平台按包内 Dockerfile / 启动脚本容器化部署（端口读环境变量 PORT）· 提交后管理员审核`
            : `${ownerHint} · A 必传 · B / C 可选 · 提交后管理员审核，通过即自动上线`;

  return (
    <UploadFrame embedded={embedded} open onClose={onClose} label="发布资源" maxWidth="w-[1040px] max-w-[calc(100vw-32px)]" className="p-0 h-[760px] max-h-[calc(100vh-48px)] flex flex-col overflow-hidden">
      {/* 桌面表单：两列内容独立滚动，审核操作固定在底栏。 */}
        {!embedded && <button aria-label="关闭上传窗口" onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft text-lg z-10">
          ✕
        </button>}

        {/* 头部：标题 + 当前类型胶囊 + 上传记录（带记录图标） */}
        <div className={`${embedded ? 'hidden' : 'flex'} items-center gap-2.5 px-6 pt-4 pb-2.5 pr-16 shrink-0`}>
          <h2 className="text-base font-semibold">{mode === 'records' ? '上传记录' : '发布资源'}</h2>
          {mode === 'records' ? (
            <span className="pill bg-soft text-t2 font-normal">{mine?.length ?? 0} 条</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accentSoft py-0.5 pl-2 pr-3 text-xs font-semibold text-accentText shrink-0">
              {kind === 'skill' ? report?.structure?.kind === 'agent' || resourceType === 'agent' ? '智能体' : 'AI 技能' : TYPE_OF[kind].name}
            </span>
          )}
          <span className="flex-1" />
          {mode === 'records' ? (
            <button className="btn-primary !text-xs !h-8" onClick={() => setMode('wizard')}>继续上传 →</button>
          ) : (
            <button className="inline-flex items-center gap-1.5 text-xs text-accentText hover:underline" onClick={() => { setMode('records'); loadMine(); }}>
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="2.5" y="1.5" width="9" height="11" rx="1.6" />
                <path d="M4.8 4.5h4.4M4.8 7h4.4M4.8 9.5h2.6" strokeLinecap="round" />
              </svg>
              上传记录
            </button>
          )}
        </div>

        {/* 引导线 + 类型单选卡（编辑页显示；成功页只剩引导线） */}
        {mode === 'wizard' && (
          <div className="px-6 pb-3 shrink-0 flex flex-col gap-2.5">
            <Stepper current={screen === 'edit' ? 1 : 3} />
            {screen === 'edit' && (
              <>
                <div role="group" className="grid grid-cols-3 gap-2" aria-label="资源类型">
                  {([{ value: 'agent', name: '智能体', desc: '编排任务、包内组件与平台依赖' }, { value: 'skill', name: 'AI 技能', desc: '单项能力，保留现有 SKILL.md 格式' }, { value: 'tool', name: '工具', desc: '网页、服务、客户端或链接' }] as const).map((item) => <button key={item.value} type="button" disabled={typeLocked || busy || !!matBusy} aria-pressed={resourceType === item.value} onClick={() => { onDraftChange?.(''); resetEditState(); setResourceType(item.value); setKind(item.value === 'tool' ? 'web' : 'skill'); }} className={`rounded-xl border px-4 py-2 text-left disabled:opacity-60 ${resourceType === item.value ? 'border-accent bg-accentSoft' : 'border-line hover:bg-soft'}`}><span className="block text-sm font-semibold">{item.name}</span><span className="block mt-1 text-[11px] text-t3">{item.desc}</span></button>)}
                </div>
                {resourceType === 'tool' && <div role="group" className="grid grid-cols-4 gap-2" aria-label="工具部署方式">
                  {TYPES.filter((item) => item.k !== 'skill').map((t) => {
                    const on = t.k === kind;
                    const lock = typeLocked && !on;
                    return (
                      <button
                        key={t.k}
                        type="button"
                        disabled={lock || busy || !!matBusy}
                        title={lock ? '已按上传内容识别类型，点「重新上传」后可再选' : undefined}
                        onClick={() => pickType(t.k)}
                        aria-pressed={on}
                        className={`relative rounded-xl border-[1.5px] px-2.5 py-[7px] text-left transition-colors ${on ? 'border-accent bg-accentSoft' : 'border-line hover:border-accent hover:bg-soft'} ${lock ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        {!!myCount(t.k) && (
                          <span title={`你名下已上线 ${myCount(t.k)} 项，可在「更新已有」中更新`} className="absolute -top-[7px] -right-[6px] min-w-[17px] h-[17px] px-1 rounded-full bg-accent text-primaryForeground text-[10px] font-semibold flex items-center justify-center leading-none border-2 border-card">{myCount(t.k)}</span>
                        )}
                        <div className={`text-[12.5px] font-semibold flex items-center gap-1.5 ${on ? 'text-accentText' : ''}`}>
                          <span className="truncate">{t.icon} {t.name}</span>
                          {on && <span className="ml-auto text-[9px] shrink-0">●</span>}
                        </div>
                        <div className="text-[10px] text-t3 leading-[1.45] mt-px">{t.desc}</div>
                      </button>
                    );
                  })}
                </div>
                }
                {fixMsg && <div role="alert" className="rounded-lg bg-warnSoft text-warn px-3 py-1.5 text-[11.5px] leading-relaxed">{fixMsg}</div>}
              </>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 px-6 pb-4 flex flex-col">
          {resumeError && <div role="alert" className="mb-3 rounded-lg bg-dangerSoft text-danger p-3 text-xs">{resumeError}</div>}
          {/* ===== 上传记录视图 ===== */}
          {mode === 'records' ? (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="pill bg-warnSoft text-warn font-normal">待审核 {counts.pending}</span>
                <span className="pill bg-okSoft text-ok font-normal">已上线 {counts.online}</span>
                <span className="pill bg-dangerSoft text-danger font-normal">已驳回 {counts.rejected}</span>
                <span className="flex-1" />
                <span className="text-[11px] text-t3">驳回会写明原因，可修改后重新提交</span>
              </div>
              <div className="flex-1 min-h-0 rounded-xl border border-line px-4 overflow-y-auto">
                {!mine?.length ? (
                  <div className="h-full flex items-center justify-center text-sm text-t3">
                    还没有上传记录，点击右上角「继续上传」发布你的第一个资源
                  </div>
                ) : (
                  mine.map((m) => <RecordRow key={m.id} m={m} onResume={resumeRecord} />)
                )}
              </div>
            </div>
          ) : (
          <>
          {/* ===== 填写信息提交（单页：类型单选卡 + 四类同构一页填完） ===== */}
          {screen === 'edit' && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="grid flex-1 min-h-0 gap-4" style={{ gridTemplateColumns: '54% 1fr' }}>
                {/* 左列：A 主文件 / 链接 · B 截图 · C 说明书（AI 技能：A + 解析日志） */}
                <div className="min-w-0 min-h-0 flex flex-col gap-2.5 overflow-y-auto pr-1">
                  {/* A */}
                  <div className={`rounded-[14px] border border-line p-3.5 shrink-0 `}>
                    {/* Keep the upload heading separate from the prompt action and its helper text. */}
                    <div className="mb-2.5 flex flex-col gap-1">
                      <div className="flex items-center gap-2 text-[12.5px] font-semibold min-w-0">
                        <span className="w-[18px] h-[18px] rounded-full bg-accentSoft text-accentText text-[11px] flex items-center justify-center shrink-0">A</span>
                        <span className="min-w-0 truncate">{kind === 'link' ? '访问地址（必填 · 自动校验连通）' : kind === 'skill' ? 'SKILL.md / 压缩包（必传 · 自动解析）' : kind === 'service' ? '应用包（必传 · 检测 Dockerfile / 启动脚本，容器化部署）' : kind === 'file' ? '应用压缩包（必传 · 同事点「打开工具」即下载整包）' : '网页包（必传 · 静态托管上线）'}</span>
                        {kind !== 'link' && parsedOk && <span className="ml-auto text-[10.5px] text-ok bg-okSoft rounded-full px-2.5 py-px font-normal shrink-0">✓ {analysisReady ? '已解析' : '文件已接收'}</span>}
                      </div>
                      {kind !== 'link' && (
                        <div className="pl-[26px] min-w-0">
                          <PackPromptButton key={`${kind}:${updateMode}`} kind={kind} mode={updateMode} className="text-[11px] font-normal" />
                        </div>
                      )}
                    </div>
                    {kind === 'link' ? (
                      <div className="flex flex-col gap-2">
                        <input
                          value={meta.url}
                          onChange={(e) => setMeta((m) => ({ ...m, url: e.target.value }))}
                          placeholder="http://…（部署在其他服务器上的工具地址）"
                          className="w-full h-[38px] rounded-[10px] border border-line bg-card dark:bg-card px-3 text-[13px] font-mono outline-none focus:border-accent"
                        />
                        <p className="text-[11px] leading-relaxed text-t3">{LINK_PUBLISH_GUIDANCE}</p>
                        <div className="flex items-center gap-2 text-[11px]">
                          <button className="text-accentText hover:underline disabled:opacity-50" onClick={fetchIcon} disabled={!/^https?:\/\//.test(meta.url.trim())}>获取网页图标</button>
                          {iconUrl && <img src={iconUrl} alt="" className="w-5 h-5 rounded border border-line" />}
                          <span className="text-t3">{iconMsg || '将作为卡片备用图标（无截图时显示）'}</span>
                        </div>
                      </div>
                    ) : parsedOk ? (
                      <div className="rounded-[12px] border border-ok bg-okSoft px-3 py-2">
                        <div className="flex items-center gap-2.5 text-[12.5px]">
                          <span className="w-5 h-5 rounded-full bg-ok text-white text-[11px] flex items-center justify-center shrink-0">✓</span>
                          <span className="truncate">{analysisReady ? '解析成功' : '文件已接收'}：{fname || '文件已接收'}</span>
                          {kind !== 'skill' && (
                            <button className="ml-auto text-[11px] text-t3 hover:text-t1 shrink-0" onClick={() => setParseOpen((v) => !v)}>{parseOpen ? '▴ 收起' : '▾ 解析详情'}</button>
                          )}
                          <button disabled={busy || !!matBusy} className="text-[11.5px] text-t3 hover:text-t1 shrink-0 disabled:opacity-50" onClick={clearParsed}>重新上传</button>
                        </div>
                        {parseOpen && kind !== 'skill' && (
                          <div className="mt-2 border-t border-dashed border-line pt-2 font-mono text-[11px] leading-[1.8] text-t2 whitespace-pre-line">
                            {report?.lines.map((l, i) => <div key={i}>{l}</div>)}
                          </div>
                        )}
                      </div>
                    ) : report ? (
                      /* 解析未通过（error 规则命中）：明确展示失败原因与修复指引，不再静默回落上传框 */
                      <div className="rounded-[12px] border border-danger bg-dangerSoft px-3 py-2.5">
                        <div className="flex items-center gap-2.5 text-[12.5px]">
                          <span className="w-5 h-5 rounded-full bg-danger text-white text-[11px] flex items-center justify-center shrink-0">✗</span>
                          <span className="font-medium text-danger truncate">解析未通过：{fname || '文件已接收'}</span>
                          <button className="ml-auto text-[11px] text-t3 hover:text-t1 shrink-0" onClick={() => setParseOpen((v) => !v)}>{parseOpen ? '▴ 收起' : '▾ 解析详情'}</button>
                          <button className="text-[11.5px] text-t3 hover:text-t1 shrink-0" onClick={clearParsed}>重新上传</button>
                        </div>
                        <div className="mt-1.5 text-[12px] text-danger leading-[1.7]">
                          {(report.rules || []).filter((r) => r.level === 'error').slice(0, 2).map((r) => (
                            <div key={r.id} className="truncate" title={r.fix ? `${r.msg} —— ${r.fix}` : r.msg}>
                              {r.msg}{r.fix ? ` —— ${r.fix}` : ''}
                            </div>
                          ))}
                          {!(report.rules || []).some((r) => r.level === 'error') && (report.assistance?.errors[0] || report.lines.find((l) => l.startsWith('✗')) || '解析失败，请检查文件内容')}
                          <p>草稿已保留，完成修正并重新检查后才能提交审核。</p>
                        </div>
                        {parseOpen && (
                          <div className="mt-2 border-t border-dashed border-line pt-2 font-mono text-[11px] leading-[1.8] text-t2 whitespace-pre-line">
                            {report.lines.map((l, i) => <div key={i}>{l}</div>)}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        role="button"
                        tabIndex={busy ? -1 : 0}
                        aria-label="上传主文件"
                        aria-disabled={busy}
                        onClick={() => { if (!busy) fileRef.current?.click(); }}
                        onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); } }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) doFile(f); }}
                        className={`rounded-[14px] border-2 border-dashed border-line hover:border-accent bg-soft dark:bg-card cursor-pointer text-center transition-colors ${kind === 'skill' ? 'flex-1 min-h-0 flex flex-col items-center justify-center gap-1.5' : 'py-5'}`}
                      >
                        <div className="text-2xl">{busy ? '⏳' : '📦'}</div>
                        <div className="mt-1 text-[13px] font-semibold">{busy ? '识别中，请稍候…' : '点击或拖拽上传'}</div>
                        <div className="mt-0.5 text-[11.5px] text-t3 font-mono">{kind === 'skill' ? 'SKILL.md 或包含主入口与子技能的 zip' : kind === 'file' ? 'exe / 安装程序 zip' : kind === 'service' ? '含 Dockerfile 或启动脚本的 zip' : 'zip / HTML'} · ≤ 150MB · 类型自动核对 · 仅在内网服务器解析</div>
                        <input
                          ref={fileRef}
                          type="file"
                          aria-label="主文件"
                          accept={kind === 'file' ? '.zip,.exe,.7z,.rar,.msi' : '.zip,.html,.md'}
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) doFile(f); e.currentTarget.value = ''; }}
                        />
                        {busy && <button type="button" className="mt-3 rounded text-xs text-accentText underline focus-ring" onClick={event => { event.stopPropagation(); requestEpoch.current++; setBusy(false); setFname(''); setParseErr(''); onDraftChange?.(''); }}>取消本次上传</button>}
                      </div>
                    )}
                    {parseErr && <div role="alert" className="mt-2 rounded-lg bg-dangerSoft text-danger text-xs px-3 py-2">{parseErr}</div>}
                  </div>

                  {automaticAnalysis && uploadId && kind !== 'link' && <UploadAnalysis analysis={analysis} busy={analysisBusy} error={analysisError}
                    disabled={busy || !!matBusy || repairDirty} onRetry={() => void retryAnalysis()}
                    onAnswer={(question, choice) => void analyzePackage(uploadId, { revision: submissionRevision ?? 0, ...analysisIntent.current, choices: { [question]: choice } })} onCopy={copyText} />}

                  {kind === 'skill' && uploadId && <div className="space-y-2 shrink-0">
                    <button type="button" disabled={analysisBusy} className="btn-ghost !text-xs" onClick={() => { setRepairMounted(true); setRepairOpen((value) => !value); }} aria-expanded={repairOpen}>{repairOpen ? '收起结构修正' : '修正智能体结构'}</button>
                    {repairDirty && <p className="text-xs text-warn">结构有未应用的修改，请预览并应用后提交审核。</p>}
                    <div hidden={!repairOpen}>{repairMounted && <PackageRepairEditor key={`${uploadId}:${updateTarget}`} uploadId={uploadId} assistance={report?.assistance} updateOf={isUpdate ? updateTarget : undefined} onDirty={setRepairDirty} onApplied={(result) => { if (result.report) setReport(result.report); setSubmitErr(''); if (automaticAnalysis) void analyzePackage(uploadId, { revision: result.assistance?.revision ?? result.report?.assistance?.revision ?? submissionRevision ?? 0, ...analysisIntent.current }); }} />}</div>
                  </div>}

                  {/* AI 技能：解析日志撑满剩余高度 */}
                  {kind === 'skill' && report && (
                    <div className="rounded-[14px] border border-line p-3.5 shrink-0 flex flex-col">
                      {report.structure && <div className="mb-3"><PackagePreview graph={report.structure} /></div>}
                      <div className="flex items-center gap-2 mb-2 text-[12.5px] font-semibold shrink-0">
                        <span className="w-[18px] h-[18px] rounded-full bg-accentSoft text-accentText text-[11px] flex items-center justify-center">≡</span>
                        解析日志
                        <span className={`ml-auto pill font-normal ${VERDICT[report!.verdict].cls}`}>{VERDICT[report!.verdict].label}</span>
                      </div>
                      <div className="shrink-0 rounded-xl bg-[#17161F] p-3.5 font-mono text-[11px] leading-[2] text-[#C9C5DC]">
                        {report!.lines.map((l, i) => <div key={i}>{l}</div>)}
                      </div>
                    </div>
                  )}

                  {/* B 截图（非技能） */}
                  {kind !== 'skill' && (
                    <div className="rounded-[14px] border border-line p-3.5 shrink-0">
                      <div className="flex items-center gap-2 mb-2.5 text-[12.5px] font-semibold">
                        <span className="w-[18px] h-[18px] rounded-full bg-accentSoft text-accentText text-[11px] flex items-center justify-center">B</span>
                        页面截图
                        <span className="ml-auto text-[10.5px] text-t3 bg-soft dark:bg-card border border-line rounded-full px-2 py-px font-normal">可选 2 张 · 首张为封面</span>
                      </div>
                      <div className="flex gap-3">
                        {shotFiles.map((f, i) => (
                          <div key={i} className="relative w-[118px] h-[84px] rounded-[10px] border border-line overflow-hidden shrink-0 group">
                            <img src={f.url} alt="" className="w-full h-full object-cover" />
                            {i === 0 && <span className="absolute left-1.5 top-1.5 rounded-md bg-accent px-[7px] py-px text-[10px] text-white z-[1]">封面</span>}
                            <button className="absolute right-1 top-1 w-5 h-5 rounded-md bg-black/55 text-white text-[11px] hidden group-hover:block z-[1]" onClick={() => delShot(i)}>✕</button>
                          </div>
                        ))}
                        {shotFiles.length < 2 && (
                          <button
                            className="w-[118px] h-[84px] rounded-[10px] border-2 border-dashed border-line bg-soft dark:bg-card text-t3 text-[11px] leading-[1.5] hover:border-accent hover:text-accentText shrink-0"
                            onClick={() => shotRef.current?.click()}
                            disabled={!uploadId || busy || !!matBusy}
                            title={!uploadId ? '请先上传主文件' : undefined}
                          >
                            {matBusy === 'shot' ? '上传中…' : <>＋ 添加{shotFiles.length ? '第 2 张' : '截图'}<br />（jpg / png · ≤5MB）</>}
                          </button>
                        )}
                        <input
                          ref={shotRef}
                          type="file"
                          accept=".jpg,.jpeg,.png,.webp"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) upShot(f); e.currentTarget.value = ''; }}
                        />
                      </div>
                    </div>
                  )}

                  {/* C 说明书（非技能） */}
                  {kind !== 'skill' && (
                    <div className="rounded-[14px] border border-line p-3.5 shrink-0">
                      <div className="flex items-center gap-2 mb-2.5 text-[12.5px] font-semibold">
                        <span className="w-[18px] h-[18px] rounded-full bg-accentSoft text-accentText text-[11px] flex items-center justify-center">C</span>
                        产品说明书
                        <span className="ml-auto text-[10.5px] text-t3 bg-soft dark:bg-card border border-line rounded-full px-2 py-px font-normal">可选 1 份 · 详情页可下载</span>
                      </div>
                      {docFile ? (
                        <div className="flex items-center gap-3 rounded-xl border border-ok bg-okSoft px-3 py-2">
                          <span className="w-8 h-8 rounded-[9px] bg-[#F9E4E4] text-danger text-[10.5px] font-bold flex items-center justify-center shrink-0">DOC</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold truncate">{docFile.name}</div>
                            <div className="text-[11px] text-t3 mt-0.5">{docFile.size} · 已上传</div>
                          </div>
                          <button className="text-t3 hover:text-t1" onClick={delDoc}>✕</button>
                        </div>
                      ) : (
                        <button
                          className="w-full flex items-center gap-3 rounded-xl border-2 border-dashed border-line bg-soft dark:bg-card px-3 py-2 text-[12.5px] text-t3 hover:border-accent hover:text-accentText"
                          onClick={() => docRef.current?.click()}
                          disabled={!uploadId || busy || !!matBusy}
                          title={!uploadId ? '请先上传主文件' : undefined}
                        >
                          <span className="w-8 h-8 rounded-[9px] bg-card dark:bg-soft border border-line flex items-center justify-center text-[15px]">＋</span>
                          {matBusy === 'doc' ? '上传中…' : '上传说明书（pdf / docx / zip · ≤20MB）'}
                        </button>
                      )}
                      <input
                        ref={docRef}
                        type="file"
                        accept=".pdf,.doc,.docx,.zip"
                        className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) upDoc(f); e.currentTarget.value = ''; }}
                      />
                    </div>
                  )}
                </div>

                {/* 右列 D：完善信息 */}
                <div className="min-w-0 min-h-0 flex flex-col gap-2.5 rounded-[14px] border border-line p-4 overflow-hidden">
                  <div className="flex items-center gap-2 text-[12.5px] font-semibold shrink-0">
                    <span className="w-[18px] h-[18px] rounded-full bg-accentSoft text-accentText text-[11px] flex items-center justify-center">D</span>
                    完善信息
                    <span className="ml-auto flex gap-1.5">
                      <button
                        type="button"
                        className={`pill border transition-colors ${updateMode === 'new' ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft dark:bg-card border-line text-t2'}`}
                        aria-pressed={updateMode === 'new'} disabled={analysisBusy || (automaticAnalysis && repairDirty)}
                        onClick={() => { if (!automaticAnalysis && updateTarget && report?.assistance) setRepairDirty(true); const changed = updateMode !== 'new' || !!updateTarget; setUpdateMode('new'); setUpdateTarget(''); setWarnTarget(''); if (changed) reanalyzeTarget(''); }}
                      >
                        新建资源
                      </button>
                      <button
                        type="button"
                        className={`pill border transition-colors ${updateMode === 'update' ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft dark:bg-card border-line text-t2'}`}
                        aria-pressed={updateMode === 'update'} disabled={analysisBusy || (automaticAnalysis && repairDirty)}
                        onClick={() => { setUpdateMode('update'); if (autoTarget && !updateTarget) { pickUpdateTarget(autoTarget); reanalyzeTarget(autoTarget); } }}
                      >
                        更新已有
                      </button>
                    </span>
                  </div>

                  {/* 头部（D + 全新/更新切换）固定；更新面板与表单进同一滚动区：
                      更新态展开「修改基本信息」后内容超高可滚，普通态空间充裕时表单照常铺满 */}
                  <div className="flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
                  {/* 更新已有：基本信息自动带入并默认折叠，仅绑定 + 更新说明；点「修改基本信息」展开 */}
                  {updateMode === 'update' && (
                    <div className="rounded-xl border border-dashed border-accent bg-accentSoft dark:bg-accentSoft/40 p-3 flex flex-col gap-2.5 shrink-0">
                      <div>
                        <label className="block text-[11.5px] text-t2 mb-1">选择要更新的{kind === 'skill' ? '技能' : '工具'}（仅本人已上线 · 与所选类型一致）</label>
                        <select
                          aria-label="要更新的资源"
                          disabled={analysisBusy || (automaticAnalysis && repairDirty)}
                          value={updateTarget}
                          onChange={(e) => onUpdateTargetChange(e.target.value)}
                          className="w-full h-8 rounded-lg border border-line bg-card dark:bg-card px-2 text-xs outline-none focus:border-accent"
                        >
                          <option value="">选择要更新的{kind === 'skill' ? '技能' : '工具'}…</option>
                          {bindList.length === 0 && <option value="" disabled>该类型下暂无你名下已上线的记录</option>}
                          {bindList.map((t) => (
                            <option key={t.v} value={t.v} disabled={t.disabled}>{t.name}（{t.tail}）{t.disabled ? ' · 暂不能在此更新（未上架技能中心）' : ''}</option>
                          ))}
                        </select>
                        {bindList.length === 0 && otherKinds.length > 0 && (
                          <div className="text-[11px] text-t3 leading-relaxed mt-1.5">
                            该类型下暂无你名下已上线的记录；你在其他类型名下有：
                            <button type="button" className="text-accentText hover:underline mx-0.5" onClick={() => pickType(otherKinds[0].k)}>{otherKinds[0].name} ×{myCount(otherKinds[0].k)}</button>
                            {otherKinds.slice(1).map((t) => <span key={t.k}> · {t.name} ×{myCount(t.k)}</span>)}
                            ，点上方对应类型卡即可更新
                          </div>
                        )}
                      </div>
                      {autoTarget && updateTarget === autoTarget && (
                        <div className="text-[11px] text-accentText leading-relaxed">
                          ⚡ 已根据解析内容自动匹配更新对象（名称一致）；如非本意可改选或切回「新建资源」，改选会要求二次确认
                        </div>
                      )}
                      {warnTarget && (
                        <div className="rounded-lg bg-warnSoft text-warn px-2.5 py-2 text-[11px] leading-relaxed">
                          解析内容更匹配《{bindList.find((x) => x.v === autoTarget)?.name || '—'}》，确定要改为更新
                          《{bindList.find((x) => x.v === warnTarget)?.name || '—'}》吗？
                          <div className="flex gap-2 mt-1.5">
                            <button type="button" className="h-6 px-2.5 rounded-md bg-warn text-bg text-[11px]" onClick={() => { const v = warnTarget; setWarnTarget(''); pickUpdateTarget(v); reanalyzeTarget(v); }}>
                              确认更新
                            </button>
                            <button type="button" className="h-6 px-2.5 rounded-md bg-card dark:bg-card border border-line text-t2 text-[11px]" onClick={() => setWarnTarget('')}>
                              用匹配项
                            </button>
                          </div>
                        </div>
                      )}
                      {bindSel && kind === 'skill' && (
                        <div className="text-[11px] text-t3 leading-relaxed">
                          当前版本 v{bindSel.version || '—'} → 提交通过后自动升为{' '}
                          <input
                            value={report?.structure?.source === 'manifest' ? report.structure.version : updateVersion}
                            readOnly={report?.structure?.source === 'manifest'}
                            onChange={(e) => setUpdateVersion(e.target.value.slice(0, 20))}
                            className="w-[70px] h-6 rounded-md bg-soft dark:bg-card border border-line px-1.5 text-center font-mono text-[11px] outline-none focus:border-accent text-t1"
                          />{' '}
                          {report?.structure?.source === 'manifest' ? '（由包清单确定，修改后重新上传）' : '（可修改）'}
                        </div>
                      )}
                      <div>
                        <label className="block text-[11.5px] text-t2 mb-1">更新说明 <span className="text-danger">*</span>（审核人与版本历史可见）</label>
                        <input
                          aria-label="更新说明"
                          value={updateNote}
                          onChange={(e) => setUpdateNote(e.target.value.slice(0, 200))}
                          className="w-full h-[34px] rounded-[10px] border border-line bg-card dark:bg-card px-3 text-[12.5px] outline-none focus:border-accent"
                          placeholder="本次更新改了什么？例如：补充多语种模板，修正日期字段解析"
                        />
                      </div>
                      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-card dark:bg-card px-2.5 py-2 text-[11px] text-t2">
                        名称与基本信息已自动带入 · 名称锁定
                        <button
                          type="button"
                          className="ml-auto rounded-lg bg-accentSoft text-accentText px-2.5 py-1 text-[11px] font-semibold hover:opacity-85 whitespace-nowrap"
                          onClick={() => setMdOpen((v) => !v)}
                        >
                          {mdOpen ? '收起基本信息 ▴' : '修改基本信息 ▾'}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className={`flex flex-col gap-2.5 flex-1 min-h-0 ${updateMode === 'update' && !mdOpen ? 'hidden' : ''}`}>
                    <div>
                      <label className="block text-[11.5px] text-t2 mb-1">
                        资源名称 {isUpdate ? <span className="text-accentText">（自动带入 · 锁定）</span> : '*'}
                      </label>
                      <input
                        aria-label="资源名称"
                        value={meta.name}
                        onChange={(e) => setMeta({ ...meta, name: e.target.value.slice(0, 30) })}
                        disabled={isUpdate}
                        placeholder={kind === 'skill' ? '例如：六网融合场景清单编制' : '例如：站点选址评分工具'}
                        className="w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-3 text-[13px] outline-none focus:border-accent text-t1 placeholder:text-t3 disabled:opacity-70"
                      />
                    </div>
                    {kind === 'skill' && (
                      <div>
                        <label className="block text-[11.5px] text-t2 mb-1">技能分类 *（上架技能中心与首页筛选使用）</label>
                        <select
                          aria-label="技能分类"
                          value={skillCategory}
                          onChange={(e) => setSkillCategory(e.target.value)}
                          className="w-full h-9 rounded-[10px] bg-soft dark:bg-card border border-line px-3 text-[13px] outline-none focus:border-accent text-t1"
                        >
                          {!SKILL_CATEGORIES.includes(skillCategory) && <option value={skillCategory}>{skillCategory}</option>}
                          {SKILL_CATEGORIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="flex-1 min-h-[60px] flex flex-col">
                      <label className="block text-[11.5px] text-t2 mb-1">项目描述 *</label>
                      <textarea
                        aria-label="项目描述"
                        value={meta.desc}
                        onChange={(e) => setMeta({ ...meta, desc: e.target.value.slice(0, 300) })}
                        placeholder={'介绍这个工具：解决什么问题、核心功能、怎么使用（步骤/注意事项）、适用场景。\n将展示在工具详情页「项目描述」，写得越清楚同事越会用。'}
                        className="w-full flex-1 min-h-[44px] rounded-[10px] bg-soft dark:bg-card border border-line px-3 py-2 text-[13px] leading-[1.5] outline-none focus:border-accent text-t1 placeholder:text-t3 resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11.5px] text-t2 mb-1">适用部门（可多选 · 勾「全部」即全部门适用）</label>
                      <DeptPicker value={departments} onChange={setDepartments} options={deptOptions} />
                    </div>
                    <div>
                      <label className="block text-[11.5px] text-t2 mb-1">业务标签 *（至少选 1 个 · 最多 4 个）</label>
                      <div className="flex flex-wrap gap-1.5">
                        {tagCandidates.map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setTags((v) => (v.includes(t) ? v.filter((x) => x !== t) : [...v, t].slice(0, 4)))}
                            aria-pressed={tags.includes(t)}
                            className={`pill border transition-colors ${tags.includes(t) ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft dark:bg-card border-line text-t2 hover:border-accent'}`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <input
                          value={newTag}
                          onChange={(e) => setNewTag(e.target.value.slice(0, 8))}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCustomTag())}
                          className="flex-1 h-7 rounded-lg border border-line bg-card dark:bg-card px-2.5 text-[11.5px] outline-none focus:border-accent"
                          placeholder="自定义标签，回车添加"
                        />
                        <button type="button" className="btn-ghost !text-[11.5px] !h-7" onClick={addCustomTag}>添加</button>
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              </div>

              {/* 统一底栏：左下提示 · 右下提交审核 */}
              <LegacyFooter target={footerTarget}><div className={`${footerTarget ? 'w-full' : 'mt-3 pt-3 border-t border-line'} flex items-center gap-3 shrink-0`}>
                {submitErr && <span role="alert" className="text-xs text-danger shrink-0">{submitErr}</span>}
                {draftMessage && <span role="status" className="text-xs text-ok shrink-0">{draftMessage}</span>}
                <span className="flex-1" />
                <span className="text-[11.5px] text-t3 truncate hidden xl:inline">{footHint}</span>
                {automaticAnalysis && <button type="button" className="btn-ghost focus-ring !text-xs !h-9" disabled={!uploadId || busy || analysisBusy || !!matBusy || repairDirty} onClick={() => void saveDraft()}>{matBusy === 'draft' ? '保存中…' : '保存草稿'}</button>}
                <button className={`btn-primary !text-xs !h-9 ${canSubmit ? '' : 'opacity-70'}`} disabled={busy || !!matBusy || report?.verdict === 'fail' || repairDirty || !analysisReady} onClick={submitAll}>
                  {busy ? '提交中…' : '提交审核 →'}
                </button>
              </div></LegacyFooter>
            </div>
          )}

          {/* ===== 提交审核 · 共用成功页 ===== */}
          {screen === 'done' && (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
              <span className="w-14 h-14 rounded-full bg-okSoft text-ok flex items-center justify-center text-2xl">✓</span>
              <div className="text-[15px] font-semibold">已提交，等待管理员审核</div>
              <p className="text-xs text-t3 leading-[1.9] max-w-[520px]">
                管理员会确认资源类型并审核，通过后自动部署上线（网页 / 服务型工具）或上架技能中心（智能体 / AI 技能），可在「上传记录」查看进度；如被驳回会写明原因，可修改后重新提交。<br />
                {isUpdate ? '更新通过后自动替换部署（工具）或升版本上架技能中心（技能），历史统计与评价保留。' : ''}
                项目包由平台保存，结构识别可调用现有 AI 网关；审核通过后按资源类型上线。
              </p>
              <div className="text-[11px] text-t2 bg-soft dark:bg-card border border-line rounded-[10px] px-4 py-2 leading-[1.8]">
                <b className="text-t1">继续上传</b> = 回到填写页开始下一次提交（类型回到默认「网页工具」）；已提交内容可在「上传记录」查看审核进度
              </div>
              <LegacyFooter target={footerTarget}><div className={`flex items-center gap-2.5 ${footerTarget ? 'justify-end' : 'mt-1'}`}>
                <button className="h-9 px-4 rounded-[10px] bg-accentSoft text-accentText text-xs hover:opacity-90 transition-opacity" onClick={restartWizard}>继续上传 →</button>
                <button className="btn-ghost !text-xs !h-9" onClick={() => { setMode('records'); loadMine(); }}>查看上传记录</button>
                <button className="btn-primary !text-xs !h-9" onClick={onClose}>完成</button>
              </div></LegacyFooter>
            </div>
          )}
          </>
          )}
        </div>
    </UploadFrame>
  );
}
