import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { getToken } from '../services/api';
import { ZbModal } from '../components/ZbModal';

/* =====================================================================
 * KbExplorer —— 知识库融合视图（API 直连 · 方案 A）
 * 后端 /api/kb/*（BFF）→ MxsDoc；v2 主题设计语言（白卡分层 + 品牌紫点缀）。
 * 浏览/搜索/预览/下载 + 写操作（上传/新建目录/重命名/删除/批量操作）；
 * Office 在线编辑与移动等低频操作走「经典视图」（iframe SSO）。
 * 权限由 MxsDoc 按会话用户校验（本部门负责人可写），错误信息直接透传。
 * ===================================================================== */

type Repo = { id: number | string; name: string; tier?: 'public' | 'dept' | 'private'; invited?: boolean; readShared?: boolean; canWrite?: boolean; canManage?: boolean; canDownload?: boolean; quota?: { gb: number; used: number | null } };
type Entry = { name: string; type: 'dir' | 'file'; size: number; docId: number | string; pid: number; level: number; path: string; latestEditTime: number };
type Crumb = { name: string; docId: string; path: string };
type Hit = { reposId: number | string; repos: string; name: string; path: string; size: number; preview?: string; sources?: string[]; semScore?: number };
type Preview = { name: string; url: string; reposId: string; dirPath: string } | null;
/* 写操作弹窗：新建目录 / 重命名 / 删除确认；chain = 条目所在父目录的面包屑链
 * （目录树化后 ⋯ 菜单可能在任意深度的行上，rename/delete 的 path 必须用该链而非当前目录） */
type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: Entry; chain: Crumb[] }
  | { kind: 'delete'; entry: Entry; chain: Crumb[] }
  | { kind: 'move'; entry: Entry; chain: Crumb[] }
  | { kind: 'history'; entry: Entry }
  /* 批量：items 一律来自当前目录列表（同父目录），delete/move/sync 逐条串行复用单条 API */
  | { kind: 'delete-batch'; items: Entry[] }
  | { kind: 'move-batch'; items: Entry[] }
  | null;
/* 目录树子目录缓存：status=ready 带缓存 dirs；loading=懒加载中；err=加载失败 */
type Kids = { status: 'ready'; dirs: Entry[] } | { status: 'loading' } | { status: 'err'; msg: string };
/* 树节点 key：库根='root'，其余=目录 docId */
const keyOf = (chain: Crumb[]) => (chain.length ? String(chain[chain.length - 1].docId) : 'root');
/* 移动选择器的导航层：name/docId/level 取自节点，path 为该节点原样 path 字段（父路径） */
type NavNode = { name: string; docId: string; level: number; path: string };
type MenuRow = string | null; // 打开中的 ⋮ 菜单（行 key）

const fmtSize = (n: number) => {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};
const fmtTime = (t: number) => {
  if (!t) return '—';
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
const typeStyle = (name: string): { bg: string; label: string } => {
  const e = ext(name);
  if (['doc', 'docx', 'wps'].includes(e)) return { bg: 'bg-[#EDEDFF] text-[#5046E5]', label: 'W' };
  if (['xls', 'xlsx', 'csv'].includes(e)) return { bg: 'bg-[#E9F9EF] text-[#16A34A]', label: 'X' };
  if (['ppt', 'pptx'].includes(e)) return { bg: 'bg-[#FFF1E6] text-[#EA580C]', label: 'P' };
  if (e === 'pdf') return { bg: 'bg-[#FDEBEC] text-[#E11D48]', label: 'PDF' };
  if (['md', 'txt', 'json'].includes(e)) return { bg: 'bg-[#EEF2FF] text-[#4F46E5]', label: 'T' };
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(e)) return { bg: 'bg-[#E0F2FE] text-[#0284C7]', label: 'IMG' };
  if (['zip', 'rar', '7z', 'gz'].includes(e)) return { bg: 'bg-[#F1F5F9] text-[#64748B]', label: 'ZIP' };
  return { bg: 'bg-soft text-t3', label: '?' };
};
const previewable = (name: string) =>
  ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'md', 'txt',
   'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext(name));

async function kbApi(path: string): Promise<any> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  const r = await fetch(path, { headers, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j?.message || j?.msg || `请求失败（${r.status}）`);
  return j;
}
async function kbPost(path: string, body: any): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j?.message || j?.msg || `操作失败（${r.status}）`);
  return j;
}
const fileUrl = (kind: 'preview' | 'download', reposId: string | number, dirPath: string, name: string) =>
  `/api/kb/${kind}?reposId=${reposId}&path=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken() || '')}`;

/* ---------------- 小图标（内联 SVG） ---------------- */
const IcSearch = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="9" r="6" /><path d="m17.5 17.5-4-4" /></svg>
);
const IcFolder = () => (
  <svg className="shrink-0" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#E8930C" strokeWidth="1.6" strokeLinejoin="round"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.6 1.8H16A1.5 1.5 0 0 1 17.5 7.3v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
);
const IcEye = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" /><circle cx="10" cy="10" r="2.4" /></svg>
);
const IcDl = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5" /><path d="M3.5 14.5V16a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-1.5" /></svg>
);
const IcBack = () => (
  <svg className="shrink-0" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 5 7 10l4.5 5" /></svg>
);
const IcMore = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" /></svg>
);
const IcPlus = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 4.5v11M4.5 10h11" /></svg>
);
const IcUp = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15V6m0 0 3.5 3.5M10 6 6.5 9.5" /><path d="M3.5 4V3a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 16.5 3v1" /></svg>
);
const IcEnter = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 10H13m0 0-3.5-3.5M13 10l-3.5 3.5" /><path d="M13.5 4.5H16a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5h-2.5" /></svg>
);
const IcFolderUp = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h3.2l1.5 1.7H16A1.5 1.5 0 0 1 17.5 8.2v6.3A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" /><path d="M10 13V8.8m0 0 2.2 2.2M10 8.8 7.8 11" /></svg>
);
const IcCheckSq = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="14" height="14" rx="3.5" /><path d="m7 10.2 2.1 2.1L13.4 7.6" /></svg>
);

export default function KbExplorer({ meName, onGuide }: { meName: string; onGuide?: () => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [cur, setCur] = useState<{ id: string; name: string } | null>(null);
  const [crumb, setCrumb] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [listErr, setListErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(() => {
    try {
      const v = localStorage.getItem('kb-search-q');
      if (v) { localStorage.removeItem('kb-search-q'); return v; }
    } catch {}
    return '';
  });
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searchMode, setSearchMode] = useState<'dual' | 'keyword'>('keyword');
  const [preview, setPreview] = useState<Preview>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [dialog, setDialogState] = useState<Dialog>(null);
  /* ZbModal 初始焦点：mkdir/rename 两个输入框共用（原 autoFocus 语义） */
  const dialogInputRef = useRef<HTMLInputElement>(null);
  const [inputVal, setInputVal] = useState('');
  const [menu, setMenu] = useState<MenuRow>(null);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  /* 移动弹窗导航链（首元素为仓库根哨兵）；subDirs 为当前层子目录 */
  const [navChain, setNavChain] = useState<NavNode[]>([]);
  const [subDirs, setSubDirs] = useState<Entry[] | null>(null);
  const [subError, setSubError] = useState('');
  const [histItems, setHistItems] = useState<{ commitId: string; commitMsg: string; commitTime: number; commitUser: string }[] | null>(null);
  const [kbStats, setKbStats] = useState<{ total: number; byRepo: { repos: string; c: number }[]; lastBuiltAt: string } | null>(null);
  const [repoCanWrite, setCanWrite] = useState(false); // 当前库写权限（本部门负责人=true）
  const canWrite = repoCanWrite && !busy;
  /* 三类库（v2）：权限元数据与自助管理弹窗状态 */
  const [v2, setV2] = useState(false);
  const [hasPrivate, setHasPrivate] = useState(false);
  const [permInfo, setPermInfo] = useState<{ tier?: string; readShared?: boolean; canManage?: boolean; canDownload?: boolean; isPrivateMine?: boolean }>({});
  const [cfgRepo, setCfgRepoState] = useState<Repo | null>(null);
  const [cfgSel, setCfgSel] = useState<Set<string>>(new Set());
  const [cfgDl, setCfgDl] = useState(true);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [people, setPeople] = useState<{ dept: string; users: { username: string; name: string }[] }[] | null>(null);
  /* 部门库「共享可见（只读）」：readDepts 多选 + 是否 admin 可改 + 本库归属部门（勾选器排除自身） */
  const [cfgReadDepts, setCfgReadDepts] = useState<Set<string>>(new Set());
  const [cfgIsAdmin, setCfgIsAdmin] = useState(false);
  const [cfgDept, setCfgDept] = useState('');
  const [depts, setDepts] = useState<string[]>([]);
  const [syncItem, setSyncItemState] = useState<{ name: string; path: string; isDir: boolean } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  /* 批量操作：模式开关 + 勾选集（行 docId）；进行中进度（弹窗按钮/操作条文案）；syncBatch=批量同步对象 */
  const [batch, setBatch] = useState(false);
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState<{ done: number; total: number } | null>(null);
  const [syncBatch, setSyncBatchState] = useState<Entry[] | null>(null);
  const repoEpoch = useRef(0);
  const listRequest = useRef(0);
  const permRequest = useRef(0);
  const locationRequest = useRef(0);
  const treeRequests = useRef<Record<string, number>>({});
  const previewRequest = useRef(0);
  const previewController = useRef<AbortController>();
  const modalSession = useRef(0);
  const moveSession = useRef(0);
  const targetRequest = useRef(0);
  const cfgSession = useRef(0);
  const uploadSession = useRef(0);
  // Capture before the first await. Writes keep their original payload, but may
  // update this screen only while that navigation and modal session still owns it.
  const captureContext = (modalOwned = true) => {
    const repo = repoEpoch.current, location = locationRequest.current;
    const modal = modalSession.current, cfg = cfgSession.current, target = targetRequest.current;
    return () => repo === repoEpoch.current && location === locationRequest.current
      && (!modalOwned || modal === modalSession.current && cfg === cfgSession.current && target === targetRequest.current);
  };
  const setDialog = (next: Dialog) => {
    modalSession.current++; moveSession.current++; targetRequest.current++;
    setBatchBusy(null); setSubDirs(null); setSubError(''); setDialogState(next);
  };
  const setCfgRepo = (next: Repo | null) => {
    cfgSession.current++;
    setCfgBusy(false); setCfgRepoState(next);
  };
  const setSyncItem = (next: typeof syncItem) => {
    modalSession.current++; setSyncBusy(false); setSyncItemState(next);
  };
  const setSyncBatch = (next: Entry[] | null) => {
    modalSession.current++; setSyncBatchState(next);
  };
  const clearNavigationDialogs = () => {
    setDialog(null); setCfgRepo(null); setCfgBusy(false);
    setMenu(null); setSyncItem(null); setSyncBatch(null); setSyncBusy(false);
    setBatch(false); setBatchSel(new Set()); setBatchBusy(null); setUploading(null);
    previewRequest.current++; previewController.current?.abort(); setPreview(null);
  };
  useEffect(() => () => {
    repoEpoch.current++; listRequest.current++; permRequest.current++; locationRequest.current++; previewRequest.current++;
    modalSession.current++; moveSession.current++; targetRequest.current++; cfgSession.current++;
    previewController.current?.abort();
  }, []);
  const autoSearched = useRef(false);
  const documentHandoff = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  /* 目录面板宽度：拖中间分隔条调整（180px ~ min(480px, 容器45%)），localStorage 记忆，双击分隔条复位 */
  const DIR_W_DEF = 260, DIR_W_MIN = 180, DIR_W_KEY = 'kb-dir-w';
  const twopaneRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dirW, setDirW] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem(DIR_W_KEY) || '');
    return Number.isFinite(v) && v >= DIR_W_MIN ? v : DIR_W_DEF;
  });
  const clampDirW = (w: number) => {
    const max = Math.min(480, twopaneRef.current ? twopaneRef.current.clientWidth * 0.45 : 480);
    return Math.round(Math.max(DIR_W_MIN, Math.min(max, w)));
  };
  const applyDirW = (w: number, save: boolean) => {
    const c = clampDirW(w);
    setDirW(c);
    if (save) { try { localStorage.setItem(DIR_W_KEY, String(c)); } catch {} }
  };
  /* 窗口尺寸变化后重新夹取（小窗口下记忆的宽度可能超上限） */
  useEffect(() => {
    const onResize = () => setDirW((w) => clampDirW(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const onDividerDown = (e: RPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId); // 捕获后 move/up 都落分隔条，扫过目录行不触发 hover
    document.body.classList.add('kb-dragging');     // 全局 col-resize 光标 + 禁止选中文字
    e.preventDefault();
  };
  const onDividerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    applyDirW(e.clientX - (twopaneRef.current?.getBoundingClientRect().left ?? 0), true);
  };
  const onDividerUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove('kb-dragging');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

  /* 目录树（懒加载展开）：treeOpen=展开态；kids=各节点子目录缓存。
   * 点行=导航（loadDir 会把当前层子目录写入缓存并展开），再点当前已展开目录=折叠；点箭头=仅展开/收起。 */
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const [kids, setKids] = useState<Record<string, Kids>>({});
  const fetchKids = useCallback((key: string, chain: Crumb[]) => {
    const epoch = repoEpoch.current;
    const request = treeRequests.current[key] = (treeRequests.current[key] || 0) + 1;
    const current = () => epoch === repoEpoch.current && request === treeRequests.current[key];
    setKids((k) => ({ ...k, [key]: { status: 'loading' } }));
    const last = chain[chain.length - 1];
    const param = last
      ? `reposId=${cur!.id}&docId=${last.docId}&path=${encodeURIComponent(last.path)}&name=${encodeURIComponent(last.name)}`
      : `reposId=${cur!.id}`;
    kbApi(`/api/kb/list?${param}`)
      .then((j) => { if (current()) setKids((k) => ({ ...k, [key]: { status: 'ready', dirs: ((j.entries || []) as Entry[]).filter((e) => e.type === 'dir') } })); })
      .catch((e: Error) => { if (current()) setKids((k) => ({ ...k, [key]: { status: 'err', msg: e.message || '加载失败' } })); });
  }, [cur]);
  const toggleTree = (key: string, chain: Crumb[]) => {
    const willOpen = !treeOpen[key];
    setTreeOpen((o) => ({ ...o, [key]: willOpen }));
    if (willOpen && (!kids[key] || kids[key].status === 'err')) fetchKids(key, chain);
  };
  /* 导航后面板滚动到当前节点 */
  useEffect(() => {
    if (!cur) return;
    document.querySelector(`[data-node="${keyOf(crumb)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [crumb, cur]);

  const flash = (msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), kind === 'err' ? 4200 : 2600);
  };

  useEffect(() => {
    kbApi('/api/kb/repos')
      .then((j) => { setRepos(j.repos || []); setV2(!!j.v2); setHasPrivate(!!j.hasPrivate); })
      .catch((e: Error) => setLoadErr(e.message || '加载失败'));
    kbApi('/api/kb/stats').then(setKbStats).catch(() => {});
  }, []);


  const loadDir = useCallback(async (reposId: string, chain: Crumb[]) => {
    if (!reposId) return;
    const request = ++listRequest.current;
    const epoch = repoEpoch.current;
    const current = () => request === listRequest.current && epoch === repoEpoch.current;
    const key = keyOf(chain);
    const treeRequest = treeRequests.current[key] = (treeRequests.current[key] || 0) + 1;
    setBusy(true);
    setEntries(null);
    setListErr('');
    setBatchSel(new Set()); /* 换目录 / 操作后刷新都重置勾选：批量操作只作用于当前目录列表 */
    try {
      const parent = chain.length ? chain[chain.length - 1] : null;
      const param = parent
        ? `reposId=${reposId}&docId=${parent.docId}&path=${encodeURIComponent(parent.path)}&name=${encodeURIComponent(parent.name)}`
        : `reposId=${reposId}`;
      const j = await kbApi(`/api/kb/list?${param}`);
      if (!current()) return;
      setEntries(j.entries || []);
      /* 导航即展开：当前层子目录直接写入树缓存（复用本响应，不额外请求） */
      if (treeRequest === treeRequests.current[key]) setKids((k) => ({ ...k, [key]: { status: 'ready', dirs: (j.entries || []).filter((e: Entry) => e.type === 'dir') } }));
      setTreeOpen((o) => ({ ...o, [key]: true }));
      return (j.entries || []) as Entry[];
    } catch (e: any) {
      if (!current()) return;
      setEntries([]);
      setListErr(e?.message || '目录加载失败');
    } finally {
      if (current()) setBusy(false);
    }
  }, []);

  const refreshRepos = () => {
    const current = captureContext(false);
    kbApi('/api/kb/repos')
      .then((j) => { if (current()) { setRepos(j.repos || []); setV2(!!j.v2); setHasPrivate(!!j.hasPrivate); } })
      .catch(() => {});
  };
  const probePerm = (id: string) => {
    const request = ++permRequest.current;
    const epoch = repoEpoch.current;
    const current = () => request === permRequest.current && epoch === repoEpoch.current;
    setCanWrite(false);
    setPermInfo({ canDownload: false });
    kbApi(`/api/kb/perm?reposId=${id}`)
      .then((j) => { if (current()) { setCanWrite(!!j.canWrite); setPermInfo(j); } })
      .catch(() => { if (current()) { setCanWrite(false); setPermInfo({ canDownload: false }); } });
  };
  const initializeRepo = (r: Repo) => {
    repoEpoch.current++; listRequest.current++;
    const location = ++locationRequest.current;
    treeRequests.current = {};
    const id = String(r.id);
    setCur({ ...r, id, name: r.name }); /* 保留 tier 等元数据：⚙ 弹窗按库类型分化依赖它 */
    setCrumb([]);
    setHits(null);
    setEntries(null);
    setTreeOpen({});   /* 换库重置目录树展开态与缓存 */
    setKids({});
    clearNavigationDialogs();
    probePerm(id);
    return location;
  };
  const openRepo = (r: Repo) => {
    initializeRepo(r);
    void loadDir(String(r.id), []);
  };
  const leaveRepo = () => {
    repoEpoch.current++; listRequest.current++; permRequest.current++; locationRequest.current++;
    setCur(null); setHits(null); setBusy(false); setCanWrite(false);
    clearNavigationDialogs();
  };
  const gotoCrumb = (i: number) => {
    locationRequest.current++;
    clearNavigationDialogs();
    const chain = i < 0 ? [] : crumb.slice(0, i + 1);
    setCrumb(chain);
    setHits(null);
    loadDir(cur!.id, chain);
  };
  /* 树行导航：按行自身的绝对链跳转（gotoCrumb 是相对当前 crumb 截断，树行可能不在当前路径上） */
  const goChain = (chain: Crumb[]) => {
    locationRequest.current++;
    clearNavigationDialogs();
    setCrumb(chain);
    setHits(null);
    loadDir(cur!.id, chain);
  };

  const doSearch = async () => {
    const kw = q.trim();
    if (!kw) return;
    locationRequest.current++;
    clearNavigationDialogs();
    const request = ++listRequest.current;
    setBusy(true);
    setListErr('');
    try {
      const j = await kbApi(`/api/kb/search?q=${encodeURIComponent(kw)}`);
      if (request !== listRequest.current) return;
      setHits(j.items || []);
      setSearchMode(j.mode === 'dual' ? 'dual' : 'keyword');
    } catch (e: any) {
      if (request !== listRequest.current) return;
      setListErr(e?.message || '搜索失败');
    } finally {
      if (request === listRequest.current) setBusy(false);
    }
  };

  /* 首页全局搜索命中承接：初始 q 非空时自动检索一次 */
  useEffect(() => {
    if (q.trim() && !autoSearched.current) {
      autoSearched.current = true;
      doSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 首页冲刺条承接：直接打开指定文档预览（按名称在Platform库检索定位） */
  useEffect(() => {
    try {
      const raw = localStorage.getItem('kb-open-doc') || documentHandoff.current;
      if (!raw) return;
      documentHandoff.current = raw;
      localStorage.removeItem('kb-open-doc');
      const { q: docQ } = JSON.parse(raw);
      const navigation = locationRequest.current, intent = previewRequest.current;
      kbApi(`/api/kb/search?q=${encodeURIComponent(docQ)}`)
        .then((j) => {
          if (navigation !== locationRequest.current || intent !== previewRequest.current) return;
          const hit = (j.items || []).find((x: Hit) => x.name.includes('开发指南'));
          if (hit) openPreview(hit.reposId, (hit.path || '').replace(/\/+$/, ''), hit.name);
        })
        .catch(() => {});
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closePreview = () => {
    previewRequest.current++;
    previewController.current?.abort();
    setPreview(null);
  };
  const openPreview = (reposId: string | number, dirPath: string, name: string) => {
    const request = ++previewRequest.current;
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setPreview({ name, url: '', reposId: String(reposId), dirPath });
    const url = fileUrl('preview', reposId, dirPath, name);
    fetch(url, { headers: { Authorization: 'Bearer ' + (getToken() || '') }, signal: controller.signal })
      .then((r) => {
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.includes('application/json')) return r.json().then((j) => Promise.reject(new Error(j?.message || '该文件暂无法预览，请下载查看')));
        if (request === previewRequest.current) setPreview({ name, url, reposId: String(reposId), dirPath });
      })
      .catch((e: any) => { if (request === previewRequest.current) setPreview({ name, url: 'error:' + (e?.message || '预览失败'), reposId: String(reposId), dirPath }); });
  };

  /* ---------------- 写操作 ---------------- */
  const dirPathStr = crumb.map((c) => c.name).join('/');
  const doMkdir = async () => {
    const name = inputVal.trim();
    if (!name || !cur) return;
    const current = captureContext();
    try {
      await kbPost('/api/kb/mkdir', { reposId: cur.id, path: dirPathStr, name });
      if (!current()) return;
      setDialog(null);
      setInputVal('');
      flash('目录已创建');
      loadDir(cur.id, crumb);
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '新建目录失败', 'err');
    }
  };
  const doRename = async () => {
    const d = dialog && dialog.kind === 'rename' ? dialog : null;
    const entry = d?.entry || null;
    const pchain = d?.chain || [];
    if (!entry || !cur) return;
    const dstName = inputVal.trim();
    if (!dstName || dstName === entry.name) { setDialog(null); return; }
    const parentPath = pchain.map((c) => c.name).join('/');   /* 条目真实父路径（树行可能在任意深度） */
    const current = captureContext();
    try {
      await kbPost('/api/kb/rename', {
        reposId: cur.id, docId: entry.docId, pid: entry.pid, level: entry.level,
        type: entry.type, path: parentPath, name: entry.name, dstName,
      });
      if (!current()) return;
      setDialog(null);
      setInputVal('');
      flash('已重命名');
      /* 刷新来源父层树缓存；改名节点若在当前路径上，同步面包屑名称 */
      if (keyOf(pchain) === keyOf(crumb)) loadDir(cur.id, crumb);
      else if (kids[keyOf(pchain)]) fetchKids(keyOf(pchain), pchain);
      if (crumb.some((c) => String(c.docId) === String(entry.docId))) {
        setCrumb(crumb.map((c) => (String(c.docId) === String(entry.docId) ? { ...c, name: dstName } : c)));
      }
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '重命名失败', 'err');
    }
  };
  const doDelete = async () => {
    const d = dialog && dialog.kind === 'delete' ? dialog : null;
    const entry = d?.entry || null;
    const pchain = d?.chain || [];
    if (!entry || !cur) return;
    const parentPath = pchain.map((c) => c.name).join('/');
    const current = captureContext();
    try {
      await kbPost('/api/kb/delete', { reposId: cur.id, path: parentPath, name: entry.name, type: entry.type });
      if (!current()) return;
      setDialog(null);
      flash('已删除（同名重传有 2 小时防误删锁，急用可到经典视图解锁）');
      /* 删的是当前路径上的目录（祖先/自身）→ 回退到其父级；否则刷新来源父层 */
      const idx = crumb.findIndex((c) => String(c.docId) === String(entry.docId));
      if (idx >= 0) gotoCrumb(idx - 1);
      else if (keyOf(pchain) === keyOf(crumb)) loadDir(cur.id, crumb);
      else if (kids[keyOf(pchain)]) fetchKids(keyOf(pchain), pchain);
      /* 清掉被删节点的展开态与缓存残留 */
      setTreeOpen((o) => { const n = { ...o }; delete n[String(entry.docId)]; return n; });
      setKids((k) => { const n = { ...k }; delete n[String(entry.docId)]; return n; });
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '删除失败', 'err');
    }
  };

  const doMove = async () => {
    const d = dialog && dialog.kind === 'move' ? dialog : null;
    const entry = d?.entry || null;
    const pchain = d?.chain || [];
    if (!entry || !cur || subDirs === null || subError) return;
    const dst = navChain[navChain.length - 1];
    const dstPathStr = navChain.slice(1).map((c) => c.name + '/').join('');
    const current = captureContext();
    try {
      await kbPost('/api/kb/move', {
        reposId: cur.id, docId: entry.docId, type: entry.type,
        srcPid: entry.pid, srcLevel: entry.level, srcPath: entry.path, srcName: entry.name,
        dstPid: dst.docId, dstLevel: dst.level + 1, dstPath: dstPathStr, dstName: entry.name,
      });
      if (!current()) return;
      setDialog(null);
      flash('已移动');
      /* 刷新来源/目标两处树缓存；移动的是当前路径上的目录则回退到父级 */
      if (keyOf(pchain) === keyOf(crumb)) loadDir(cur.id, crumb);
      else if (kids[keyOf(pchain)]) fetchKids(keyOf(pchain), pchain);
      const dstChain: Crumb[] = navChain.slice(1).map((n) => ({ name: n.name, docId: n.docId, path: n.path }));
      if (kids[keyOf(dstChain)]) fetchKids(keyOf(dstChain), dstChain);
      const idx = crumb.findIndex((c) => String(c.docId) === String(entry.docId));
      if (idx >= 0) gotoCrumb(idx - 1);
      setTreeOpen((o) => { const n = { ...o }; delete n[String(entry.docId)]; return n; });
      setKids((k) => { const n = { ...k }; delete n[String(entry.docId)]; return n; });
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '移动失败', 'err');
    }
  };
  /* 移动弹窗：加载某一层的子目录（仅目录） */
  const loadSubDirs = useCallback(async (reposId: string, node: NavNode) => {
    const session = moveSession.current, request = ++targetRequest.current, epoch = repoEpoch.current;
    const current = () => session === moveSession.current && request === targetRequest.current && epoch === repoEpoch.current;
    setSubDirs(null);
    setSubError('');
    try {
      const param = node.docId === '0'
        ? `reposId=${reposId}`
        : `reposId=${reposId}&docId=${node.docId}&path=${encodeURIComponent(node.path)}&name=${encodeURIComponent(node.name)}`;
      const j = await kbApi(`/api/kb/list?${param}`);
      if (!current()) return;
      setSubDirs((j.entries || []).filter((e: Entry) => e.type === 'dir'));
    } catch (error: any) {
      if (!current()) return;
      setSubError(error?.message || '目标目录加载失败，请重试');
    }
  }, []);
  const openMove = (entry: Entry, chain: Crumb[] = []) => {
    setMenu(null);
    setDialog({ kind: 'move', entry, chain });
    const root: NavNode = { name: cur!.name, docId: '0', level: -1, path: '' };
    setNavChain([root]);
    loadSubDirs(cur!.id, root);
  };

  /* 搜索结果定位：按 path 逐级下钻设置面包屑并加载（每层一次 list 请求） */
  const gotoPath = async (reposId: string, dirPath: string) => {
    const repo = repos?.find((r) => String(r.id) === reposId);
    if (!repo) return;
    const location = initializeRepo(repo);
    const segs = dirPath.split('/').filter(Boolean);
    const chain: Crumb[] = [];
    let contents = await loadDir(reposId, chain);
    for (const seg of segs) {
      if (location !== locationRequest.current || !contents) return;
      const node = contents.find((e) => e.name === seg && e.type === 'dir');
      if (!node) break;
      chain.push({ name: node.name, docId: String(node.docId), path: node.path || '' });
      setCrumb([...chain]);
      contents = await loadDir(reposId, chain);
    }
  };

  /* ---- 三类库自助管理（v2） ---- */
  const doPrivCreate = async () => {
    const current = captureContext();
    try {
      const j = await kbPost('/api/kb/priv-create', {});
      if (!current()) return;
      flash('已创建私有库：' + (j.name || '') + '（默认仅自己可见）');
      refreshRepos();
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '创建失败', 'err');
    }
  };
  const openCfg = async (r: Repo) => {
    setCfgRepo(r);
    const current = captureContext();
    setCfgSel(new Set());
    setCfgReadDepts(new Set());
    setCfgIsAdmin(false);
    setCfgDept('');
    setCfgBusy(true);
    try {
      if (!people) {
        const pj = await kbApi('/api/kb/people');
        if (!current()) return;
        setPeople(pj.groups || null);
        setDepts(pj.depts || []);
      }
      const j = await kbApi(`/api/kb/repo-config?reposId=${r.id}`);
      if (!current()) return;
      const list = (r.tier === 'private' ? j.whitelist : j.maintainers) || [];
      setCfgSel(new Set(list.map((x: any) => x.username)));
      setCfgDl(j.allowDownload !== false);
      setCfgReadDepts(new Set(j.readDepts || []));
      setCfgIsAdmin(!!j.isAdmin);
      setCfgDept(j.dept || r.name.replace(/知识库$/, ''));
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '配置读取失败', 'err');
      setCfgRepo(null);
    } finally {
      if (!current()) return;
      setCfgBusy(false);
    }
  };
  const saveCfg = async () => {
    if (!cfgRepo) return;
    const current = captureContext();
    try {
      if (cfgRepo.tier === 'private') {
        await kbPost('/api/kb/priv-share', { reposId: cfgRepo.id, whitelist: [...cfgSel], allowDownload: cfgDl });
        if (!current()) return;
      } else {
        await kbPost('/api/kb/repo-config', {
          reposId: cfgRepo.id, maintainers: [...cfgSel],
          /* 共享部门仅 admin 可改；非 admin 不传该字段（服务端保留原值并拒绝越权修改） */
          ...(cfgRepo.tier === 'dept' && cfgIsAdmin ? { readDepts: [...cfgReadDepts] } : {}),
        });
        if (!current()) return;
      }
      flash('已保存');
      setCfgRepo(null);
      refreshRepos();
      if (cur) probePerm(cur.id);
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '保存失败', 'err');
    }
  };
  const doPrivDelete = async () => {
    if (!cfgRepo) return;
    const nm = String(prompt('删除私有库不可恢复。输入库全名确认：') || '');
    if (!nm) return;
    const current = captureContext();
    try {
      await kbPost('/api/kb/priv-delete', { reposId: cfgRepo.id, confirm: nm });
      if (!current()) return;
      flash('私有库已删除');
      setCfgRepo(null);
      if (cur && String(cur.id) === String(cfgRepo.id)) leaveRepo();
      refreshRepos();
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '删除失败', 'err');
    }
  };
  const doSyncPub = async () => {
    if (!syncItem || !cur) return;
    setSyncBusy(true);
    const current = captureContext();
    try {
      const j = await kbPost('/api/kb/sync-pub', { reposId: cur.id, path: syncItem.path, name: syncItem.name, isDir: syncItem.isDir });
      if (!current()) return;
      flash(`已同步到公开库${j.files > 1 ? `（${j.files} 个文件）` : ''}`);
      setSyncItem(null);
    } catch (e: any) {
      if (!current()) return;
      flash(e?.message || '同步失败', 'err');
    } finally {
      if (!current()) return;
      setSyncBusy(false);
    }
  };

  /* ---------------- 批量操作（同步到公开库 / 移动 / 删除） ----------------
   * 逐条串行复用单条 API（避免并发压 MxsDoc）；失败逐项收集、汇总提示，单项失败不中断后续。 */
  const runBatch = async (items: Entry[], op: (e: Entry) => Promise<void>, current: () => boolean) => {
    const fail: { name: string; msg: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      if (current()) setBatchBusy({ done: i, total: items.length });
      try { await op(items[i]); } catch (e: any) { fail.push({ name: items[i].name, msg: e?.message || '失败' }); }
    }
    if (current()) setBatchBusy(null);
    return { ok: items.length - fail.length, fail };
  };
  const failText = (fail: { name: string; msg: string }[]) =>
    fail.length ? `，${fail.length} 项失败：${fail.slice(0, 3).map((f) => `${f.name}（${f.msg}）`).join('、')}${fail.length > 3 ? ' 等' : ''}` : '';
  /* 批量删除/移动后的统一刷新：清理涉及目录的树缓存/展开态；命中当前路径则回退到最浅命中层的父级 */
  const refreshAfterBatch = (items: Entry[]) => {
    let backIdx = -2;
    for (const e of items) {
      if (e.type === 'dir') {
        setTreeOpen((o) => { const n = { ...o }; delete n[String(e.docId)]; return n; });
        setKids((k) => { const n = { ...k }; delete n[String(e.docId)]; return n; });
      }
      const idx = crumb.findIndex((c) => String(c.docId) === String(e.docId));
      if (idx >= 0 && (backIdx === -2 || idx < backIdx)) backIdx = idx;
    }
    if (backIdx >= 0) gotoCrumb(backIdx - 1);
    else loadDir(cur!.id, crumb);
  };
  const toggleSel = (e: Entry) => {
    if (batchBusy) return;
    setBatchSel((prev) => { const n = new Set(prev); n.has(String(e.docId)) ? n.delete(String(e.docId)) : n.add(String(e.docId)); return n; });
  };
  const selAll = (on: boolean) => {
    if (batchBusy) return;
    setBatchSel(on ? new Set((entries || []).map((e) => String(e.docId))) : new Set());
  };
  const doSyncPubBatch = async () => {
    if (!syncBatch || !cur || batchBusy) return;
    const current = captureContext();
    const { ok, fail } = await runBatch(syncBatch, (e) =>
      kbPost('/api/kb/sync-pub', { reposId: cur.id, path: dirPathStr, name: e.name, isDir: e.type === 'dir' }), current);
    if (!current()) return;
    setSyncBatch(null);
    flash(fail.length ? `同步成功 ${ok} 项${failText(fail)}` : `已同步 ${ok} 项到公开库`, fail.length ? 'err' : 'ok');
  };
  const doBatchDelete = async () => {
    const d = dialog && dialog.kind === 'delete-batch' ? dialog : null;
    const items = d?.items || [];
    if (!items.length || !cur || batchBusy) return;
    const current = captureContext();
    const { ok, fail } = await runBatch(items, (e) =>
      kbPost('/api/kb/delete', { reposId: cur.id, path: dirPathStr, name: e.name, type: e.type }), current);
    if (!current()) return;
    setDialog(null);
    flash(`已删除 ${ok} 项（同名重传有 2 小时防误删锁）${failText(fail)}`, fail.length ? 'err' : 'ok');
    refreshAfterBatch(items);
  };
  const doBatchMove = async () => {
    const d = dialog && dialog.kind === 'move-batch' ? dialog : null;
    const items = d?.items || [];
    if (!items.length || !cur || batchBusy || subDirs === null || subError) return;
    const dst = navChain[navChain.length - 1];
    const dstPathStr = navChain.slice(1).map((c) => c.name + '/').join('');
    const current = captureContext();
    const { ok, fail } = await runBatch(items, (e) => kbPost('/api/kb/move', {
      reposId: cur.id, docId: e.docId, type: e.type,
      srcPid: e.pid, srcLevel: e.level, srcPath: e.path, srcName: e.name,
      dstPid: dst.docId, dstLevel: dst.level + 1, dstPath: dstPathStr, dstName: e.name,
    }), current);
    if (!current()) return;
    setDialog(null);
    flash(`已移动 ${ok} 项${failText(fail)}`, fail.length ? 'err' : 'ok');
    const dstChain: Crumb[] = navChain.slice(1).map((n) => ({ name: n.name, docId: n.docId, path: n.path }));
    if (kids[keyOf(dstChain)]) fetchKids(keyOf(dstChain), dstChain);
    refreshAfterBatch(items);
  };
  const openBatchMove = (items: Entry[]) => {
    if (!items.length || !cur) return;
    setDialog({ kind: 'move-batch', items });
    const root: NavNode = { name: cur.name, docId: '0', level: -1, path: '' };
    setNavChain([root]);
    loadSubDirs(cur.id, root);
  };

  const openHistory = async (entry: Entry) => {
    setMenu(null);
    setDialog({ kind: 'history', entry });
    setHistItems(null);
    const current = captureContext();
    try {
      const j = await kbApi(`/api/kb/history?reposId=${cur!.id}&path=${encodeURIComponent(dirPathStr)}&name=${encodeURIComponent(entry.name)}`);
      if (!current()) return;
      setHistItems(j.items || []);
    } catch {
      if (!current()) return;
      setHistItems([]);
    }
  };

  /* 上传：逐文件 XHR（MxsDoc multipart 协议，checkSum 留空由服务端容错）；displayName 供文件夹上传展示相对路径 */
  const uploadOne = (file: File, reposId: string, dirPath: string, current: () => boolean, displayName?: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('reposId', reposId);
      fd.append('path', dirPath ? dirPath + '/' : '');
      fd.append('name', file.name);
      fd.append('filePath', file.name);
      fd.append('size', String(file.size));
      fd.append('checkSum', '');
      fd.append('uploadFile', file);
      fd.append('commitMsg', `SkillHarbor 工作台上传（${meName}）`);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/kb/upload?reposId=' + encodeURIComponent(reposId));
      xhr.setRequestHeader('Authorization', 'Bearer ' + (getToken() || ''));
      xhr.upload.onprogress = (ev) => {
        if (current() && ev.lengthComputable) setUploading({ name: displayName || file.name, pct: Math.round((ev.loaded / ev.total) * 100) });
      };
      xhr.onload = () => {
        try {
          const j = JSON.parse(xhr.responseText);
          if (xhr.status === 200 && j.ok) resolve();
          else reject(new Error(j?.message || j?.msg || `上传失败（${xhr.status}）`));
        } catch {
          reject(new Error('上传响应异常'));
        }
      };
      xhr.onerror = () => reject(new Error('网络异常，上传中断'));
      xhr.send(fd);
    });
  const onPickFiles = async (fl: FileList | null) => {
    if (!fl || !fl.length || !cur) return;
    const navigationCurrent = captureContext(false), session = ++uploadSession.current;
    const current = () => navigationCurrent() && session === uploadSession.current;
    for (const f of Array.from(fl)) {
      try {
        if (current()) setUploading({ name: f.name, pct: 0 });
        await uploadOne(f, cur.id, dirPathStr, current);
        if (current()) flash(`已上传：${f.name}`);
      } catch (e: any) {
        if (current()) flash(`${f.name}：${e?.message || '上传失败'}`, 'err');
      }
    }
    if (!current()) return;
    setUploading(null);
    if (fileInput.current) fileInput.current.value = '';
    loadDir(cur.id, crumb);
  };

  /* 上传文件夹：逐段 mkdir 建目录链。MxsDoc addDoc 对已存在目录返回「正在新增/已存在」类失败（
   * 实测不建副本、不覆盖），视为可用继续；其他错误如实中断。 */
  const ensureDirChain = async (reposId: string, base: string, rel: string) => {
    let acc = base;
    for (const seg of rel.split('/').filter(Boolean)) {
      const next = acc ? `${acc}/${seg}` : seg;
      try {
        await kbPost('/api/kb/mkdir', { reposId, path: acc, name: seg });
      } catch (e: any) {
        if (!/存在|正在新增/.test(String(e?.message || ''))) throw e;
      }
      acc = next;
    }
  };
  /* webkitRelativePath =「所选文件夹/子路径/文件名」：所选文件夹本体成为当前层的新目录，结构原样保留 */
  const onPickFolder = async (fl: FileList | null) => {
    if (!fl || !fl.length || !cur) return;
    const navigationCurrent = captureContext(false), session = ++uploadSession.current;
    const current = () => navigationCurrent() && session === uploadSession.current;
    const list = Array.from(fl);
    const relDirs = new Set<string>();
    for (const f of list) {
      const rel = f.webkitRelativePath || '';
      if (rel.includes('/')) relDirs.add(rel.slice(0, rel.lastIndexOf('/')));
    }
    const sorted = [...relDirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    let done = 0;
    try {
      for (const rd of sorted) {
        if (current()) setUploading({ name: `创建目录 ${rd}`, pct: 0 });
        await ensureDirChain(cur.id, dirPathStr, rd);
      }
      for (const f of list) {
        const rel = f.webkitRelativePath || '';
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const target = dir ? (dirPathStr ? `${dirPathStr}/${dir}` : dir) : dirPathStr;
        if (current()) setUploading({ name: rel || f.name, pct: 0 });
        await uploadOne(f, cur.id, target, current, rel || f.name);
        done++;
      }
      if (current()) flash(`文件夹已上传：${done}/${list.length} 个文件 · 目录 ${sorted.length} 个`);
    } catch (e: any) {
      if (!current()) return;
      flash(`上传中断：${e?.message || '失败'}（已完成 ${done}/${list.length} 个文件，重选该文件夹重传即可续传覆盖）`, 'err');
    }
    if (!current()) return;
    setUploading(null);
    if (dirInput.current) dirInput.current.value = '';
    loadDir(cur.id, crumb);
  };

  const dirs = useMemo(() => (entries || []).filter((e) => e.type === 'dir'), [entries]);
  const files = useMemo(() => (entries || []).filter((e) => e.type === 'file'), [entries]);
  /* 移动弹窗复用：单对象/批量统一为 items 数组（批量条目同父目录，「已在目标目录」校验取首个即可） */
  const moveItems = dialog && dialog.kind === 'move' ? [dialog.entry]
    : dialog && dialog.kind === 'move-batch' ? dialog.items : null;
  const selEntries = useMemo(() => [...dirs, ...files].filter((e) => batchSel.has(String(e.docId))), [dirs, files, batchSel]);

  /* 目录树递归渲染：chain=根到本节点的面包屑链（含节点自身，entry=null 为库根本身）。
   * 点行=导航（loadDir 顺带写入子目录缓存），再点当前已展开目录=折叠；点箭头=仅展开/收起（首次展开懒加载）。
   * 空目录展开后不渲染占位（箭头已 invisible 表意叶子）；加载中/出错仍如实显示。
   * 注意：rename/delete/move 弹窗的 chain 约定是「父目录链」（见 dialog 类型注释），
   * 这里传入时须 slice(0,-1) 去掉自身——否则 MxsDoc 会按「自己/自己」找文件报不存在。 */
  const renderNode = (name: string, chain: Crumb[], entry: Entry | null) => {
    const key = keyOf(chain);
    const open = !!treeOpen[key];
    const ks = kids[key];
    const childDirs = ks && ks.status === 'ready' ? ks.dirs : [];
    const isLeaf = ks && ks.status === 'ready' && childDirs.length === 0;
    return (
      <div className="relative" data-node={key} key={key}>
        <div
          className={`group/row relative w-full flex items-center gap-1 h-9 pl-2 pr-8 rounded-lg text-[13px] cursor-pointer transition-colors ${key === keyOf(crumb) ? 'bg-accentSoft text-accentText font-semibold' : 'text-t2 hover:bg-soft hover:text-t1'}`}
          title={name}
          onClick={() => {
            /* 再点当前已展开的目录=折叠（面板停留原地）；其余情况导航（loadDir 自动展开该层） */
            if (open && keyOf(crumb) === key) setTreeOpen((o) => ({ ...o, [key]: false }));
            else goChain(chain);
          }}
        >
          <button
            className={`w-5 h-5 shrink-0 rounded-md flex items-center justify-center text-t3 hover:text-t1 hover:bg-line/60 transition-transform duration-150 ${isLeaf ? 'invisible' : ''} ${open ? 'rotate-90' : ''}`}
            title="展开/收起"
            onClick={(e) => { e.stopPropagation(); toggleTree(key, chain); }}
          >
            <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 4.5 13 10l-5.5 5.5" /></svg>
          </button>
          <IcFolder />
          <span className="truncate" title={name}>{name}</span>
          {/* ⋯ 锚在行内而非节点外层：外层含展开子树，top-1/2 会随子树增高下沉（悬停也只认本行） */}
          {canWrite && entry && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md opacity-0 group-hover/row:opacity-100 transition-opacity text-t3 hover:text-t1 hover:bg-line/60 flex items-center justify-center"
              onClick={(e) => { e.stopPropagation(); setMenu(menu === 'd' + entry.docId ? null : 'd' + entry.docId); }}
            ><IcMore /></button>
          )}
        </div>
        {menu === 'd' + String(entry?.docId ?? '') && entry && (
          <div className="absolute right-1 top-9 z-30 bg-card border border-line rounded-xl shadow-[0_8px_24px_rgba(16,18,35,0.14)] py-1 w-32 text-[12.5px]" onClick={(e) => e.stopPropagation()}>
            {v2 && permInfo.tier === 'dept' && (
              <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => { setMenu(null); setSyncItem({ name: entry.name, path: chain.map((c) => c.name).join('/'), isDir: true }); }}>同步到公开库…</button>
            )}
            <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => openMove(entry, chain.slice(0, -1))}>移动到…</button>
            <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => { setMenu(null); setInputVal(entry.name); setDialog({ kind: 'rename', entry, chain: chain.slice(0, -1) }); }}>重命名</button>
            <button className="w-full text-left px-3 py-1.5 hover:bg-soft text-[#DC2626]" onClick={() => { setMenu(null); setDialog({ kind: 'delete', entry, chain: chain.slice(0, -1) }); }}>删除目录</button>
          </div>
        )}
        {open && (
          ks && ks.status === 'loading' ? (
            <div className="flex items-center gap-2 pl-9 pr-2 py-1 text-[11.5px] text-t3"><span className="kb-spin" />正在加载子目录…</div>
          ) : ks && ks.status === 'err' ? (
            <div className="pl-9 pr-2 py-1 text-[11.5px] text-warn">{ks.msg}</div>
          ) : childDirs.length === 0 ? null : (
            <div className="ml-[15px] border-l border-line/90">
              {childDirs.map((d) => renderNode(d.name, [...chain, { name: d.name, docId: String(d.docId), path: d.path || '' }], d))}
            </div>
          )
        )}
      </div>
    );
  };

  if (loadErr)
    return (
      <div className="card flex-1 flex flex-col items-center justify-center gap-3 text-center">
        <span className="w-12 h-12 rounded-[12px] bg-warnSoft text-warn flex items-center justify-center text-xl font-semibold">!</span>
        <p className="text-sm text-t2">{loadErr}</p>
        <button className="btn-primary" onClick={() => location.reload()}>重试</button>
      </div>
    );
  if (!repos) return <div className="card flex-1 flex items-center justify-center text-t3 text-sm">正在加载知识库…</div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 relative" onClick={() => setMenu(null)}>
      {/* toast（Portal 挂 body + z-[70]：压过 z-50 的写操作弹窗遮罩，报错不会被弹窗盖住） */}
      {toast && createPortal(
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-xl text-[13px] shadow-lg max-w-[70%] truncate ${toast.kind === 'err' ? 'bg-[#FDE8E8] text-[#B91C1C]' : 'bg-[#ECFDF5] text-[#047857]'}`}>
          {toast.msg}
        </div>,
        document.body
      )}

      {/* ===== 顶栏 ===== */}
      <div className="card px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-[13px] min-w-0">
          <button className={`hover:text-accentText font-semibold ${cur ? 'text-t2 font-normal' : 'text-t1'}`} onClick={leaveRepo}>
            知识库
          </button>
          {cur && (
            <>
              <span className="text-t3">/</span>
              <button className="hover:text-accentText font-semibold" onClick={() => gotoCrumb(-1)}>{cur.name}</button>
              {crumb.map((c, i) => (
                <span key={i} className="flex items-center gap-1.5 min-w-0">
                  <span className="text-t3">/</span>
                  <button className={i === crumb.length - 1 ? 'font-semibold text-t1' : 'text-t2 hover:text-accentText'} onClick={() => gotoCrumb(i)}>{c.name}</button>
                </span>
              ))}
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 h-8 rounded-[9px] border border-line bg-soft px-2.5 w-56 text-[12.5px] text-t3 focus-within:border-accentText/50 focus-within:bg-card transition-colors">
            <IcSearch />
            <input
              className="bg-transparent outline-none w-full text-t1 placeholder:text-t3"
              placeholder="搜索全部知识库…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
          </div>
          <button className="btn-ghost !text-[12.5px] !py-1.5" onClick={() => onGuide?.()} title="在 WorkBuddy 中用自然语言检索知识库的配置指引">
            在 WorkBuddy 里问知识库
          </button>
        </div>
      </div>

      {/* ===== 主区域 ===== */}
      {hits !== null ? (
        <div className="card flex-1 min-h-0 overflow-auto">
          <div className="px-4 py-3 border-b border-line text-[12px] text-t3">
            「{q}」的搜索结果 · {hits.length} 条 · 关键词{searchMode === 'dual' ? '+语义' : ''}检索
            <button className="ml-3 text-accentText hover:underline" onClick={() => setHits(null)}>返回浏览</button>
          </div>
          {hits.length === 0 && <div className="py-14 text-center text-sm text-t3">没有匹配的文档（注：上传于全文索引开启前的文件不入索引）</div>}
          {hits.map((h, i) => (
            <div key={i} className="px-4 py-3 border-b border-line last:border-0 hover:bg-soft/60 flex items-center gap-3 group">
              <span className={`w-8 h-8 rounded-[8px] flex items-center justify-center text-[10px] font-bold shrink-0 ${typeStyle(h.name).bg}`}>{typeStyle(h.name).label}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate flex items-center gap-1.5">
                  <span className="truncate">{h.name}</span>
                  {h.sources?.includes('semantic') && (
                    <span className="pill bg-accentSoft text-accentText shrink-0 !text-[10px] !px-1.5" title={h.sources?.includes('keyword') ? '关键词+语义双命中' : '语义命中'}>语义</span>
                  )}
                </div>
                <div className="text-[11px] text-t3 mt-0.5 truncate">
                  {h.repos} · /{h.path}{h.path ? '/' : ''}{h.name} · {fmtSize(h.size)}
                </div>
                {h.preview && <div className="text-[11px] text-t3/90 mt-1 line-clamp-2 opacity-80">{h.preview}</div>}
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button className="btn-ghost !px-2.5 !py-1.5 !text-[11.5px]" title="在目录中查看" onClick={() => gotoPath(String(h.reposId), h.path || '')}>定位</button>
                {previewable(h.name) && (
                  <button className="btn-ghost !px-2.5 !py-1.5" onClick={() => openPreview(h.reposId, h.path || '', h.name)}><IcEye /></button>
                )}
                {(repos?.find((x) => String(x.id) === String(h.reposId))?.canDownload ?? true) !== false && (
                  <a className="btn-ghost !px-2.5 !py-1.5" href={fileUrl('download', h.reposId, h.path || '', h.name)}><IcDl /></a>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : !cur ? (
        <div className="flex-1 min-h-0 overflow-auto">
          {kbStats && (
            <div className="card px-4 py-3 mb-3.5 flex items-center gap-5 flex-wrap text-[12.5px]">
              <span className="font-semibold text-t1">库况概览</span>
              <span>已索引文档 <b className="text-accentText font-mono">{kbStats.total}</b> 份</span>
              {kbStats.byRepo.slice(0, 5).map((r) => (
                <span key={r.repos} className="text-t3">{r.repos}库 <b className="text-t1 font-mono">{r.c}</b></span>
              ))}
              {kbStats.byRepo.length > 5 && <span className="text-t3">…共 {kbStats.byRepo.length} 库</span>}
              <span className="ml-auto text-[11px] text-t3">语义索引更新于 {kbStats.lastBuiltAt || '—'}</span>
            </div>
          )}
          {v2 && !hasPrivate && (
            <div className="flex justify-end mb-2.5">
              <button className="btn-primary !text-[12.5px] !py-1.5" onClick={doPrivCreate}>＋ 新建我的私有库</button>
            </div>
          )}
          <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
            {repos.map((r) => (
              <div key={r.id} className="relative group/card">
              <button onClick={() => openRepo(r)} className="card !p-4 w-full text-left transition-all hover:-translate-y-[2px] hover:shadow-[0_6px_20px_rgba(16,18,35,0.09)] group">
                <span className="w-10 h-10 rounded-[10px] bg-accentSoft text-accentText flex items-center justify-center"><IcFolder /></span>
                <div className="mt-2.5 text-[14px] font-semibold group-hover:text-accentText transition-colors flex items-center gap-1.5 flex-wrap">
                  {r.name}
                  {v2 && r.tier && (
                    <span className={`pill !text-[10px] !px-1.5 ${r.tier === 'public' ? 'bg-[#E6F7F1] text-[#059669]' : r.readShared ? 'bg-accentSoft text-accentText' : r.tier === 'dept' ? 'bg-[#E8F0FE] text-[#1A73E8]' : 'bg-warnSoft text-warn'}`}>
                      {r.tier === 'public' ? '全员' : r.readShared ? '共享' : r.tier === 'dept' ? '本部门' : '私有'}
                    </span>
                  )}
                  {v2 && r.invited && <span className="pill bg-dangerSoft text-danger !text-[10px] !px-1.5">受邀</span>}
                  {v2 && r.canWrite !== undefined && (
                    <span className={`pill !text-[10px] !px-1.5 ${r.canWrite === false ? 'bg-soft text-t3' : 'bg-accentSoft text-accentText'}`}>
                      {r.canWrite === false ? '仅浏览' : '可维护'}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11.5px] text-t3">
                  模板 / 方法论 / 案例 / 政策法规…
                  {kbStats && (() => { const c = (kbStats.byRepo.find((x) => r.name.startsWith(x.repos)) || {}).c ?? 0;
                    return c > 0
                      ? <span className="ml-1 text-accentText">· {c} 份</span>
                      : <span className="ml-1 pill bg-warnSoft text-warn !text-[10px] !px-1.5">待初始化</span>; })()}
                </div>
                <div className="mt-2.5 pt-2.5 border-t border-dashed border-line text-[11px] text-accentText opacity-0 group-hover:opacity-100 transition-opacity">进入浏览 →</div>
              </button>
              {v2 && r.canManage && (
                <button
                  className="btn-ghost !px-2 !py-0.5 !text-[11px] absolute right-3 top-3 opacity-0 group-hover/card:opacity-100 transition-opacity"
                  onClick={() => openCfg(r)}
                >{r.tier === 'private' ? '共享' : '权限'}</button>
              )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-t3 mt-4">由 MxsDoc 提供 API 支撑 · {meName} 的公开库 / 本部门库 / 共享与已授权库可见 · 私有库默认仅自己可见</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex" ref={twopaneRef}>
          {/* 左：目录树（懒加载展开；点名字导航/点箭头仅展开；宽度拖下方分隔条调整） */}
          <div className="card kb-dirpanel shrink-0 p-2.5 overflow-auto" style={{ width: dirW }}>
            <div className="text-[10.5px] font-bold text-t3 tracking-widest px-2 pb-1.5 pt-1">目录</div>
            {renderNode(cur!.name, [], null)}
          </div>

          {/* 中：拖拽分隔条 —— 拖动调目录宽度 / 双击复位 / 宽度记忆 localStorage */}
          <div
            className="kb-divider"
            title="拖动调整目录宽度 · 双击恢复默认"
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            onPointerCancel={onDividerUp}
            onDoubleClick={() => applyDirW(DIR_W_DEF, true)}
          />

          {/* 右：文件表 + 工具条 */}
          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            {v2 && permInfo.tier === 'private' && !permInfo.isPrivateMine && (
              <div className="text-[12px] px-3.5 py-2 rounded-[10px] bg-warnSoft text-warn">同事共享的私有库 · 仅共享名单可见 · 由库主人维护</div>
            )}
            {v2 && permInfo.readShared && (
              <div className="text-[12px] px-3.5 py-2 rounded-[10px] bg-accentSoft text-accentText">跨部门共享库 · 只读（可浏览/下载，不可修改）· 由库负责人维护</div>
            )}
            <div className="flex items-center gap-2">
              {v2 && permInfo.canManage && (
                <button className="btn-ghost !text-[12.5px] !py-1.5" onClick={() => openCfg(cur)}>
                  ⚙ {permInfo.tier === 'private' ? '共享设置' : '库权限'}
                </button>
              )}
              {canWrite && (
                <>
                  <button className="btn-ghost !text-[12.5px] !py-1.5" onClick={() => { setInputVal(''); setDialog({ kind: 'mkdir' }); }}><IcPlus /> 新建目录</button>
                  <button className="btn-ghost !text-[12.5px] !py-1.5" onClick={() => dirInput.current?.click()} disabled={!!uploading} title="选择本地文件夹，保留子目录结构整体上传"><IcFolderUp /> 上传文件夹</button>
                  <button className="btn-primary !text-[12.5px] !py-1.5 !px-3.5" onClick={() => fileInput.current?.click()} disabled={!!uploading}><IcUp /> 上传文件</button>
                </>
              )}
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onPickFiles(e.target.files)} />
              <input ref={dirInput} type="file" multiple className="hidden" {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => onPickFolder(e.target.files)} />
              {uploading && (
                <div className="flex items-center gap-2 flex-1 min-w-0 text-[12px] text-t3">
                  <span className="truncate max-w-[200px]">{uploading.name}</span>
                  <div className="h-1.5 flex-1 max-w-[220px] rounded-full bg-soft overflow-hidden">
                    <div className="h-full bg-accentText transition-all" style={{ width: `${uploading.pct}%` }} />
                  </div>
                  <span className="font-mono">{uploading.pct}%</span>
                </div>
              )}
              {canWrite ? (
                <button
                  className={`ml-auto btn-ghost !text-[12.5px] !py-1.5 ${batch ? '!bg-accentSoft !text-accentText' : ''}`}
                  disabled={!!batchBusy}
                  onClick={() => { setBatch((b) => !b); setBatchSel(new Set()); }}
                  title="勾选多个文件/目录，批量同步到公开库、移动或删除"
                ><IcCheckSq /> 批量操作</button>
              ) : (
                <span className="ml-auto text-[11px] text-t3 pr-1">{permInfo.readShared ? '该库由其他部门共享 · 仅可浏览/下载' : '当前库为只读（跨部门库 / 共享的私有库）'} · 维护请联系库负责人</span>
              )}
            </div>
            {batch && canWrite && (
              <div className="flex items-center gap-2 flex-wrap text-[12.5px] px-3.5 py-2 rounded-[10px] bg-accentSoft border border-accentText/20">
                <span className="font-semibold text-accentText">批量操作</span>
                <span className="text-t2">已选 <b className="font-mono text-t1">{selEntries.length}</b> / {dirs.length + files.length} 项</span>
                <button className="btn-ghost !text-[12px] !py-1 !px-2.5" disabled={!!batchBusy || dirs.length + files.length === 0} onClick={() => selAll(selEntries.length < dirs.length + files.length)}>
                  {selEntries.length > 0 && selEntries.length === dirs.length + files.length ? '全不选' : '全选'}
                </button>
                <span className="w-px h-4 bg-accentText/20" />
                {v2 && permInfo.tier === 'dept' && (
                  <button className="btn-ghost !text-[12px] !py-1 !px-2.5" disabled={!selEntries.length || !!batchBusy} onClick={() => setSyncBatch(selEntries)}>同步到公开库</button>
                )}
                <button className="btn-ghost !text-[12px] !py-1 !px-2.5" disabled={!selEntries.length || !!batchBusy} onClick={() => openBatchMove(selEntries)}>移动</button>
                <button className="btn-ghost !text-[12px] !py-1 !px-2.5 !text-[#DC2626]" disabled={!selEntries.length || !!batchBusy} onClick={() => setDialog({ kind: 'delete-batch', items: selEntries })}>删除</button>
                {batchBusy && <span className="text-t2">处理中 {Math.min(batchBusy.done + 1, batchBusy.total)}/{batchBusy.total}…</span>}
                <button className="btn-ghost !text-[12px] !py-1 !px-2.5 ml-auto" disabled={!!batchBusy} onClick={() => { setBatch(false); setBatchSel(new Set()); }}>退出批量</button>
              </div>
            )}
            <div className="card flex-1 min-w-0 overflow-auto relative">
              {busy && <div className="absolute inset-x-0 top-0 h-0.5 bg-accentSoft overflow-hidden z-10"><div className="h-full w-1/3 bg-accentText animate-pulse" /></div>}
              {listErr && <div className="m-4 text-[13px] text-warn">{listErr}</div>}
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[11px] text-t3 tracking-wide">
                    <th className="px-4 py-3 font-semibold">
                      {batch ? (
                        <label className="flex items-center gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            className="w-4 h-4 accent-accentText cursor-pointer"
                            checked={dirs.length + files.length > 0 && selEntries.length === dirs.length + files.length}
                            ref={(el) => { if (el) el.indeterminate = selEntries.length > 0 && selEntries.length < dirs.length + files.length; }}
                            disabled={!!batchBusy || dirs.length + files.length === 0}
                            onChange={(e) => selAll(e.target.checked)}
                          />
                          名称
                        </label>
                      ) : '名称'}
                    </th>
                    <th className="px-3 py-3 font-semibold w-24">大小</th>
                    <th className="px-3 py-3 font-semibold w-32">更新时间</th>
                    <th className="px-4 py-3 font-semibold w-28 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {dirs.map((d) => {
                    const dchain: Crumb[] = [...crumb, { name: d.name, docId: String(d.docId), path: d.path || '' }];
                    return (
                      <tr key={'d' + String(d.docId)} className={`border-t border-line/70 hover:bg-soft/60 group ${batch && batchSel.has(String(d.docId)) ? 'bg-accentSoft/40' : ''}`}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {batch && (
                              <input
                                type="checkbox"
                                className="w-4 h-4 accent-accentText cursor-pointer shrink-0"
                                checked={batchSel.has(String(d.docId))}
                                disabled={!!batchBusy}
                                onChange={() => toggleSel(d)}
                              />
                            )}
                            <button className="flex items-center gap-2.5 min-w-0 text-left" onClick={() => goChain(dchain)} title="打开目录">
                              <span className="w-8 h-8 rounded-[8px] bg-[#FFF6E4] flex items-center justify-center shrink-0"><IcFolder /></span>
                              <span className="text-[13px] font-medium truncate hover:text-accentText" title={d.name}>{d.name}</span>
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-[12px] text-t3">—</td>
                        <td className="px-3 py-2.5 text-[12px] text-t3">{fmtTime(d.latestEditTime)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity relative">
                            <button className="btn-ghost !px-2 !py-1" title="打开" onClick={() => goChain(dchain)}><IcEnter /></button>
                            {canWrite && (
                              <button
                                className="btn-ghost !px-2 !py-1"
                                title="更多"
                                onClick={(e) => { e.stopPropagation(); setMenu(menu === 't' + d.docId ? null : 't' + d.docId); }}
                              ><IcMore /></button>
                            )}
                            {canWrite && menu === 't' + d.docId && (
                              <div className="absolute right-0 top-9 z-30 bg-card border border-line rounded-xl shadow-[0_8px_24px_rgba(16,18,35,0.14)] py-1 w-28 text-[12.5px]">
                                {v2 && permInfo.tier === 'dept' && (
                                  <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => { setMenu(null); setSyncItem({ name: d.name, path: dirPathStr, isDir: true }); }}>同步到公开库…</button>
                                )}
                                <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => openMove(d, crumb)}>移动到…</button>
                                <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => { setMenu(null); setInputVal(d.name); setDialog({ kind: 'rename', entry: d, chain: crumb }); }}>重命名</button>
                                <button className="w-full text-left px-3 py-1.5 hover:bg-soft text-[#DC2626]" onClick={() => { setMenu(null); setDialog({ kind: 'delete', entry: d, chain: crumb }); }}>删除目录</button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {files.map((f) => {
                    const ts = typeStyle(f.name);
                    return (
                      <tr key={String(f.docId)} className={`border-t border-line/70 hover:bg-soft/60 group ${batch && batchSel.has(String(f.docId)) ? 'bg-accentSoft/40' : ''}`}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {batch && (
                              <input
                                type="checkbox"
                                className="w-4 h-4 accent-accentText cursor-pointer shrink-0"
                                checked={batchSel.has(String(f.docId))}
                                disabled={!!batchBusy}
                                onChange={() => toggleSel(f)}
                              />
                            )}
                            <button className="flex items-center gap-2.5 min-w-0 text-left" onClick={() => previewable(f.name) && openPreview(cur.id, dirPathStr, f.name)}>
                              <span className={`w-8 h-8 rounded-[8px] flex items-center justify-center text-[9.5px] font-bold shrink-0 ${ts.bg}`}>{ts.label}</span>
                              <span className={`text-[13px] truncate ${previewable(f.name) ? 'font-medium hover:text-accentText' : 'text-t2'}`} title={String(f.name)}>{f.name}</span>
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-[12px] text-t3">{fmtSize(f.size)}</td>
                        <td className="px-3 py-2.5 text-[12px] text-t3">{fmtTime(f.latestEditTime)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity relative">
                            {previewable(f.name) && (
                              <button className="btn-ghost !px-2 !py-1" title="预览" onClick={() => openPreview(cur.id, dirPathStr, f.name)}><IcEye /></button>
                            )}
                            {permInfo.canDownload !== false && (
                              <a className="btn-ghost !px-2 !py-1" title="下载" href={fileUrl('download', cur.id, dirPathStr, f.name)}><IcDl /></a>
                            )}
                            <button
                              className="btn-ghost !px-2 !py-1"
                              title="更多"
                              onClick={(e) => { e.stopPropagation(); setMenu(menu === 'f' + f.docId ? null : 'f' + f.docId); }}
                            ><IcMore /></button>
                            {menu === 'f' + f.docId && (
                              <div className="absolute right-0 top-9 z-30 bg-card border border-line rounded-xl shadow-[0_8px_24px_rgba(16,18,35,0.14)] py-1 w-28 text-[12.5px]">
                                {v2 && canWrite && permInfo.tier === 'dept' && (
                                  <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => { setMenu(null); setSyncItem({ name: f.name, path: dirPathStr, isDir: false }); }}>同步到公开库…</button>
                                )}
                                <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => openHistory(f)}>历史版本</button>
                                {canWrite && <>
                                  <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => openMove(f, crumb)}>移动到…</button>
                                  <button className="w-full text-left px-3 py-1.5 hover:bg-soft" onClick={() => { setMenu(null); setInputVal(f.name); setDialog({ kind: 'rename', entry: f, chain: crumb }); }}>重命名</button>
                                  <button className="w-full text-left px-3 py-1.5 hover:bg-soft text-[#DC2626]" onClick={() => { setMenu(null); setDialog({ kind: 'delete', entry: f, chain: crumb }); }}>删除</button>
                                </>}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!busy && !listErr && files.length === 0 && dirs.length === 0 && <div className="py-16 text-center text-sm text-t3">空目录</div>}
            </div>
          </div>
        </div>
      )}

      {/* ===== 写操作弹窗（ZbModal：Portal 挂 body，压过 sticky 顶栏） ===== */}
      <ZbModal
        open={!!dialog}
        onClose={() => setDialog(null)}
        label={dialog ? ({ mkdir: '新建目录', rename: '重命名', delete: '删除', move: '移动', history: '历史版本', 'delete-batch': '批量删除', 'move-batch': '批量移动' } as Record<string, string>)[dialog.kind] || '操作' : '操作'}
        maxWidth="w-[400px]"
        className="!border-0 shadow-[0_24px_56px_rgba(16,18,35,0.28)] p-5"
        focusRef={dialogInputRef}
      >
        {dialog && (
          <>
            {dialog.kind === 'mkdir' && (
              <>
                <div className="text-[14.5px] font-semibold mb-1">新建目录</div>
                <div className="text-[12px] text-t3 mb-3.5">位置：{cur?.name} / {dirPathStr || '（库根）'}</div>
                <input
                  ref={dialogInputRef}
                  className="w-full h-10 rounded-[10px] border border-line bg-soft px-3 text-[13.5px] outline-none focus:border-accentText/60 focus:bg-card transition-colors"
                  placeholder="目录名称"
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doMkdir()}
                />
                <div className="flex justify-end gap-2 mt-4">
                  <button className="btn-ghost" onClick={() => setDialog(null)}>取消</button>
                  <button className="btn-primary" onClick={doMkdir} disabled={!inputVal.trim()}>创建</button>
                </div>
              </>
            )}
            {dialog.kind === 'rename' && (
              <>
                <div className="text-[14.5px] font-semibold mb-1">重命名</div>
                <div className="text-[12px] text-t3 mb-3.5 truncate">对象：{dialog.entry.name}</div>
                <input
                  ref={dialogInputRef}
                  className="w-full h-10 rounded-[10px] border border-line bg-soft px-3 text-[13.5px] outline-none focus:border-accentText/60 focus:bg-card transition-colors"
                  value={inputVal}
                  onChange={(e) => setInputVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doRename()}
                />
                <div className="flex justify-end gap-2 mt-4">
                  <button className="btn-ghost" onClick={() => setDialog(null)}>取消</button>
                  <button className="btn-primary" onClick={doRename} disabled={!inputVal.trim() || inputVal.trim() === dialog.entry.name}>确定</button>
                </div>
              </>
            )}
            {dialog.kind === 'history' && (
              <>
                <div className="text-[14.5px] font-semibold mb-1">历史版本</div>
                <div className="text-[12px] text-t3 mb-3 truncate">对象：{dialog.entry.name}</div>
                <div className="h-64 overflow-auto border border-line rounded-xl bg-soft/50">
                  {histItems === null && <div className="text-[12px] text-t3 p-3">加载中…</div>}
                  {histItems !== null && histItems.length === 0 && (
                    <div className="text-[12px] text-t3 p-3">暂无历史记录（仅一个版本）</div>
                  )}
                  {histItems !== null && histItems.map((h, i) => (
                    <div key={h.commitId} className="flex items-center gap-3 px-3 py-2.5 border-b border-line/60 last:border-0">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${i === 0 ? 'bg-accentSoft text-accentText' : 'bg-soft text-t3'}`}>{histItems.length - i}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] truncate">{h.commitMsg || '（无备注）'}</div>
                        <div className="text-[11px] text-t3 mt-0.5">{h.commitUser} · {fmtTime(h.commitTime)}</div>
                      </div>
                      {i === 0 && <span className="pill bg-[#ECFDF5] text-[#059669] shrink-0 !text-[10px]">当前版</span>}
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-t3 mt-3 leading-relaxed">
                  覆盖上传同名文件即产生新版本；回滚到旧版请在「经典视图」的文件历史中操作。
                </div>
                <div className="flex justify-end gap-2 mt-3">
                  <button className="btn-ghost" onClick={() => setDialog(null)}>关闭</button>
                </div>
              </>
            )}
            {moveItems && (
              <>
                <div className="text-[14.5px] font-semibold mb-1">移动</div>
                <div className="text-[12px] text-t3 mb-3 truncate">
                  对象：{dialog.kind === 'move-batch'
                    ? `已选 ${moveItems.length} 项（${moveItems.filter((x) => x.type === 'dir').length} 个目录 / ${moveItems.filter((x) => x.type === 'file').length} 个文件）`
                    : moveItems[0].name}
                </div>
                <div className="text-[11.5px] text-t3 mb-1.5">
                  移动到：
                  {navChain.map((n, i) => (
                    <span key={i}>
                      {i > 0 && ' / '}
                      <button
                        disabled={!!batchBusy}
                        className={i === navChain.length - 1 ? 'text-t1 font-semibold' : 'text-accentText hover:underline'}
                        onClick={() => { const c = navChain.slice(0, i + 1); setNavChain(c); loadSubDirs(cur!.id, c[c.length - 1]); }}
                      >{n.name}</button>
                    </span>
                  ))}
                </div>
                <div className="h-56 overflow-auto border border-line rounded-xl bg-soft/50 p-2">
                  {subError ? <div role="alert" className="text-[12px] text-warn p-2">{subError} <button disabled={!!batchBusy} className="underline" onClick={() => loadSubDirs(cur!.id, navChain[navChain.length - 1])}>重试</button></div> : subDirs === null && <div className="text-[12px] text-t3 p-2">加载中…</div>}
                  {subDirs !== null && subDirs.length === 0 && <div className="text-[12px] text-t3 p-2">（无子目录，可直接移动到当前位置）</div>}
                  {subDirs !== null && subDirs.map((d) => (
                    <button
                      key={String(d.docId)}
                      disabled={!!batchBusy}
                      className="w-full flex items-center gap-2 h-9 px-2 rounded-lg text-[13px] text-t2 hover:bg-soft hover:text-t1 transition-colors"
                      onClick={() => { const c = [...navChain, { name: d.name, docId: String(d.docId), level: d.level, path: d.path || '' }]; setNavChain(c); loadSubDirs(cur!.id, c[c.length - 1]); }}
                    >
                      <IcFolder />
                      <span className="truncate">{d.name}</span>
                      {moveItems.some((it) => String(d.docId) === String(it.docId)) && <span className="ml-auto text-[10.5px] text-t3 shrink-0">（源目录）</span>}
                    </button>
                  ))}
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button className="btn-ghost" disabled={!!batchBusy} onClick={() => setDialog(null)}>取消</button>
                  <button
                    className="btn-primary"
                    disabled={!!batchBusy || subDirs === null || !!subError || String(navChain[navChain.length - 1]?.docId) === String(moveItems[0].pid)}
                    onClick={dialog.kind === 'move' ? doMove : doBatchMove}
                  >
                    {batchBusy
                      ? `移动中 ${Math.min(batchBusy.done + 1, batchBusy.total)}/${batchBusy.total}…`
                      : String(navChain[navChain.length - 1]?.docId) === String(moveItems[0].pid)
                        ? '已在目标目录'
                        : dialog.kind === 'move-batch' ? `移动 ${moveItems.length} 项到这里` : '移动到这里'}
                  </button>
                </div>
              </>
            )}
            {dialog.kind === 'delete' && (
              <>
                <div className="text-[14.5px] font-semibold mb-1 text-[#B91C1C]">删除{dialog.entry.type === 'dir' ? '目录' : '文件'}</div>
                <div className="text-[12.5px] text-t2 leading-relaxed mt-2">
                  确认删除 <b className="text-t1 break-all">{dialog.entry.name}</b>？
                  {dialog.entry.type === 'dir' && ' 该目录及其全部内容将被删除（受 2 小时防误删锁保护）。'}
                  {dialog.entry.type === 'file' && ' 删除后同名文件 2 小时内不可重传（防误删锁，急用可到经典视图解锁）。'}
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button className="btn-ghost" onClick={() => setDialog(null)}>取消</button>
                  <button className="inline-flex items-center rounded-[10px] px-4 py-2 text-[13px] font-semibold bg-[#DC2626] text-white hover:bg-[#B91C1C] transition-colors" onClick={doDelete}>删除</button>
                </div>
              </>
            )}
            {dialog.kind === 'delete-batch' && (
              <>
                <div className="text-[14.5px] font-semibold mb-1 text-[#B91C1C]">删除已选项</div>
                <div className="text-[12.5px] text-t2 leading-relaxed mt-2">
                  确认删除已选 <b className="text-t1 font-mono">{dialog.items.length}</b> 项（{dialog.items.filter((x) => x.type === 'dir').length} 个目录 / {dialog.items.filter((x) => x.type === 'file').length} 个文件）？
                  目录将连同全部内容删除；删除后同名文件 2 小时内不可重传（防误删锁，急用可到经典视图解锁）。
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button className="btn-ghost" disabled={!!batchBusy} onClick={() => setDialog(null)}>取消</button>
                  <button
                    className="inline-flex items-center rounded-[10px] px-4 py-2 text-[13px] font-semibold bg-[#DC2626] text-white hover:bg-[#B91C1C] transition-colors disabled:opacity-60"
                    disabled={!!batchBusy}
                    onClick={doBatchDelete}
                  >
                    {batchBusy ? `删除中 ${Math.min(batchBusy.done + 1, batchBusy.total)}/${batchBusy.total}…` : `删除 ${dialog.items.length} 项`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </ZbModal>

      {/* ===== 库权限 / 共享设置弹窗（三类库自助管理） ===== */}
      <ZbModal open={!!cfgRepo} onClose={() => setCfgRepo(null)} label="库权限" maxWidth="w-[440px]" className="!border-0 shadow-[0_24px_56px_rgba(16,18,35,0.28)] p-5 max-h-[86vh] overflow-auto">
        {cfgRepo && (
          <>
            <div className="text-[14.5px] font-semibold mb-1">{cfgRepo.tier === 'private' ? '共享设置' : '库权限'}</div>
            <div className="text-[12px] text-t3 mb-3.5">
              {cfgRepo.tier === 'private'
                ? '默认仅自己（同部门也不可见）· 共享后只读' + (cfgDl ? '' : ' · 不可下载')
                : `仅${cfgDept || cfgRepo.name.replace(/知识库$/, '')}成员可见 · 维护人员可上传管理${cfgReadDepts.size ? ` · ${cfgReadDepts.size} 个共享部门只读` : ''}`}
            </div>
            {cfgBusy ? (
              <div className="text-[12.5px] text-t3 py-8 text-center">加载中…</div>
            ) : (
              <>
                <div className="text-[12px] text-t2 mb-1.5">{cfgRepo.tier === 'private' ? '共享给' : '维护人员'}</div>
                <div className="h-60 overflow-auto border border-line rounded-xl bg-soft/50 p-2.5">
                  {(people || []).map((g) => (
                    <div key={g.dept}>
                      <div className="text-[11px] text-t3 mt-2 mb-1">{g.dept}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {g.users.map((p) => {
                          const on = cfgSel.has(p.username);
                          return (
                            <button
                              key={p.username}
                              className={`pill !text-[12px] !px-2.5 !py-1 border transition-colors ${on ? 'bg-accentSoft text-accentText border-accentText/40 font-medium' : 'bg-card text-t2 border-line hover:text-t1'}`}
                              onClick={() => setCfgSel((prev) => { const n = new Set(prev); on ? n.delete(p.username) : n.add(p.username); return n; })}
                            >{on ? '✓ ' : ''}{p.name}</button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {!people && <div className="text-[12px] text-t3 p-2">人员目录加载中…</div>}
                </div>
                {cfgRepo.tier === 'private' && (
                  <label className="flex items-center gap-2 text-[12.5px] text-t2 mt-2.5 cursor-pointer">
                    <input type="checkbox" checked={cfgDl} onChange={(e) => setCfgDl(e.target.checked)} />
                    允许被共享者下载（关闭则仅在线预览）
                  </label>
                )}
                {cfgRepo.tier === 'dept' && (
                  <>
                    <div className="text-[12px] text-t2 mb-1.5 mt-3">共享可见部门（只读）</div>
                    {cfgIsAdmin ? (
                      <>
                        <div className="flex flex-wrap gap-1.5">
                          {depts.filter((d) => d !== cfgDept).map((d) => {
                            const on = cfgReadDepts.has(d);
                            return (
                              <button
                                key={d}
                                className={`pill !text-[12px] !px-2.5 !py-1 border transition-colors ${on ? 'bg-accentSoft text-accentText border-accentText/40 font-medium' : 'bg-card text-t2 border-line hover:text-t1'}`}
                                onClick={() => setCfgReadDepts((prev) => { const n = new Set(prev); on ? n.delete(d) : n.add(d); return n; })}
                              >{on ? '✓ ' : ''}{d}</button>
                            );
                          })}
                        </div>
                        <div className="text-[11px] text-t3 mt-1">该部门成员可浏览、预览、下载本库内容；不可上传、修改或删除。</div>
                      </>
                    ) : (
                      <div className="text-[12px] text-t3">
                        {cfgReadDepts.size ? [...cfgReadDepts].join('、') + '（只读）' : '未共享给其他部门'}
                        <span className="ml-1">· 仅管理员可设置</span>
                      </div>
                    )}
                  </>
                )}
                <div className="text-[11.5px] text-t3 mt-2.5">
                  {cfgRepo.tier === 'private'
                    ? `保存后：你与 ${cfgSel.size} 名共享成员可见`
                    : `保存后：${cfgSel.size} 名维护人员可上传管理${cfgReadDepts.size ? ` · ${[...cfgReadDepts].join('、')}只读可见` : ''}`}
                </div>
                <div className="flex justify-between items-center mt-4">
                  {cfgRepo.tier === 'private' && (
                    <button className="text-[12px] text-danger hover:underline" onClick={doPrivDelete}>删除私有库…</button>
                  )}
                  <span className="flex-1" />
                  <button className="btn-ghost" onClick={() => setCfgRepo(null)}>取消</button>
                  <button className="btn-primary ml-2" onClick={saveCfg}>保存</button>
                </div>
              </>
            )}
          </>
        )}
      </ZbModal>

      {/* ===== 同步到公开库确认弹窗（单条 / 批量） ===== */}
      <ZbModal
        open={!!(syncItem || syncBatch) && !!cur}
        onClose={() => { if (!batchBusy) { setSyncItem(null); setSyncBatch(null); } }}
        label="同步到公开库"
        maxWidth="w-[420px]"
        className="!border-0 shadow-[0_24px_56px_rgba(16,18,35,0.28)] p-5"
        dismissible={!batchBusy}
      >
        {(syncItem || syncBatch) && cur && (
          <>
            <div className="text-[14.5px] font-semibold mb-1">同步到公开库</div>
            {syncBatch ? (
              <div className="text-[12px] text-t3 mb-3.5">
                已选 {syncBatch.length} 项（{syncBatch.filter((x) => x.type === 'dir').length} 个目录 / {syncBatch.filter((x) => x.type === 'file').length} 个文件）·
                复制到 公司公开库/{cur.name.replace(/知识库$/, '')}/{dirPathStr ? dirPathStr + '/' : ''} · 全员可见
              </div>
            ) : (
              <div className="text-[12px] text-t3 mb-3.5">复制到 公司公开库/{cur.name.replace(/知识库$/, '')}/{syncItem!.path ? syncItem!.path + '/' : ''}{syncItem!.name} · 全员可见</div>
            )}
            <div className="text-[12px] text-t2 leading-relaxed border border-line rounded-xl bg-soft/50 p-3">
              · 复制不移动，部门库原件保留<br />· 重复同步覆盖并自动留版本<br />· 发布记录审计，公开库负责人可下架
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-ghost" disabled={!!batchBusy} onClick={() => { setSyncItem(null); setSyncBatch(null); }}>取消</button>
              <button
                className="btn-primary"
                disabled={!!batchBusy || (!syncBatch && syncBusy)}
                onClick={syncBatch ? doSyncPubBatch : doSyncPub}
              >
                {batchBusy
                  ? `同步中 ${Math.min(batchBusy.done + 1, batchBusy.total)}/${batchBusy.total}…`
                  : syncBatch ? `同步 ${syncBatch.length} 项` : syncBusy ? '同步中…' : '同步'}
              </button>
            </div>
          </>
        )}
      </ZbModal>

      {/* ===== 预览弹窗 ===== */}
      <ZbModal open={!!preview} onClose={closePreview} label="只读预览" maxWidth="w-full max-w-[1120px]" className="!border-0 shadow-[0_24px_56px_rgba(16,18,35,0.28)] p-0 h-full max-h-[780px] flex flex-col overflow-hidden">
        {preview && (
          <>
            <div className="h-12 px-4 flex items-center gap-2.5 border-b border-line shrink-0">
              <span className={`w-7 h-7 rounded-[7px] flex items-center justify-center text-[9px] font-bold ${typeStyle(preview.name).bg}`}>{typeStyle(preview.name).label}</span>
              <span className="text-[13.5px] font-semibold truncate">{preview.name}</span>
              <span className="pill bg-[#ECFDF5] text-[#059669] shrink-0 !text-[11px]">只读预览</span>
              <div className="ml-auto flex items-center gap-1.5">
                {(permInfo.canDownload !== false) && (
                  <a className="btn-ghost !text-[12px] !py-1.5" href={fileUrl('download', preview.reposId, preview.dirPath, preview.name)}><IcDl /> 下载</a>
                )}
                <button className="w-8 h-8 rounded-lg hover:bg-[#FDE8E8] hover:text-[#DC2626] text-t2 flex items-center justify-center text-sm" onClick={closePreview}>✕</button>
              </div>
            </div>
            <div className="flex-1 bg-[#EDEEF4] min-h-0">
              {!preview.url ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-t3 text-sm">
                  <span className="w-8 h-8 rounded-full border-2 border-accentSoft border-t-accentText animate-spin" />
                  正在转换为 PDF（首次约 10-30 秒）…
                </div>
              ) : preview.url.startsWith('error:') ? (
                <div className="w-full h-full flex items-center justify-center text-[13px] text-warn px-8 text-center">{preview.url.slice(6)}</div>
              ) : (
                <iframe src={preview.url} title={preview.name} className="w-full h-full border-0" />
              )}
            </div>
          </>
        )}
      </ZbModal>
    </div>
  );
}
