import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ToolCard from '../components/ToolCard';
import ToolModal from '../components/ToolModal';
import SkillModal from '../components/SkillModal';
import SkillGuideModal from '../components/SkillGuideModal';
import UploadModal from '../components/UploadModal';
import GlobalResourceSearch, { type ResourceTab } from '../components/GlobalResourceSearch';
import KnowledgeActivity from '../components/KnowledgeActivity';
import { tools as staticTools, departments, BASE_TAGS } from '../data/tools';
import { loadSkills, loadSkillDeptMap, skillStyle } from '../services/skillsGateway';
import { useUsage, applyUsageResets } from '../hooks/useUsage';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';
import type { Skill, Tool } from '../types';

/* ===== 排序 / NEW 标记 ===== */
type SortKey = 'newest' | 'hot' | 'rated';
const TOOL_SORTS: [SortKey, string][] = [
  ['newest', '最新上架'],
  ['hot', '最近热门'],
  ['rated', '评价最好'],
];
/* 技能中心无评分数据：只保留最新上架 / 最近热门 */
const SKILL_SORTS: [SortKey, string][] = [
  ['newest', '最新上架'],
  ['hot', '最近热门'],
];
const DAY_MS = 24 * 60 * 60 * 1000;

/* 智能体 / AI 技能 / AI 工具：localStorage 记住上次访问。 */
const LIB_TAB_KEY = 'skillharbor-libtab';
type LibTab = ResourceTab;
const isLibTab = (value: string | null): value is LibTab => value === 'tools' || value === 'agents' || value === 'skills';

/* 逐批追加资源；技能与智能体保持排序顺序，不在追加时重新分组。 */
const TOOLS_PAGE = 8;
const SKILLS_PAGE = 6;

/** "YYYY-MM-DD" / "YYYY-MM-DD HH:mm:ss" → 时间戳；解析失败返回 0 */
function parseDate(s?: string): number {
  if (!s) return 0;
  const t = new Date(s.length > 10 ? s.replace(' ', 'T') : s).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 工具首次上架时间：精确时间戳优先，回落日期字段 */
const toolListedAt = (t: Tool) => t.approvedAt || parseDate(t.onlineAt);
const skillListedAt = (s: Skill) => parseDate(s.createdAt) || parseDate(s.updatedAt);
/** 工具参与部门筛选/展示的口径：显式适用部门优先（含「全部」= 全部门适用），未设置回落归属部门（上传人部门） */
const applyDeptsOf = (t: Tool) => (t.departments?.length ? t.departments : [t.department]);

/** 筛选行：行首维度标签 + 药丸按钮组（归属部门 / 适用部门 / 业务标签 三行同构） */
function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-start gap-3">
      <span className="w-16 shrink-0 pt-[5px] text-xs text-t3">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-2">{children}</div>
    </div>
  );
}

function FilterOptions({ label, values, value, onChange }: { label: string; values: string[]; value: string; onChange: (value: string) => void }) {
  return <FilterRow label={label}>{values.map(option => (
    <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)} className={`tab ${value === option ? 'tab-active' : 'tab-idle'}`}>{option}</button>
  ))}</FilterRow>;
}

function scrollToLibrary() {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('library')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

/** 技能适用部门口径：管理端配置优先（['全部'] = 全部门适用），未配置回落归属部门（上传人部门） */
const skillApplyDeptsOf = (s: Skill, deptMap: Record<string, string>, applicable: Record<string, string[]>) =>
  applicable[s.slug || s.id]?.length ? applicable[s.slug || s.id] : deptMap[s.id || ''] ? [deptMap[s.id || '']] : [];
/** 上架 24h 内打 NEW（仅首次上架口径，按打开页面时的实时时间判断） */
const isNewListed = (listedAt: number) => listedAt > 0 && Date.now() - listedAt < DAY_MS;

function SortTabs({ value, onChange, options }: { value: SortKey; onChange: (k: SortKey) => void; options: [SortKey, string][] }) {
  return (
    <div role="group" aria-label="排序方式" className="flex items-center gap-1.5">
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={`pill border transition-colors ${
            value === k ? 'bg-accentSoft border-accent text-accentText font-medium' : 'bg-soft border-line text-t2 hover:border-accent'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}


export default function Home() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const catalogSearchRef = useRef<HTMLInputElement>(null);
  const [catalogSearchRequest, setCatalogSearchRequest] = useState(0);
  const [ownerDept, setOwnerDept] = useState('全部');
  const [dept, setDept] = useState('全部');
  const [tag, setTag] = useState('全部');
  const [skillTag, setSkillTag] = useState('全部');
  const [skillDept, setSkillDept] = useState('全部');
  const [skillApplyDept, setSkillApplyDept] = useState('全部');
  const [skillDepts, setSkillDepts] = useState<string[]>([]);
  const [skillApplyDepts, setSkillApplyDepts] = useState<string[]>([]);
  const [skillDeptMap, setSkillDeptMap] = useState<Record<string, string>>({});
  const [skillApplicable, setSkillApplicable] = useState<Record<string, string[]>>({});
  /* 瀑布流阶段式加载：已展示条数，滚动接近底部自动按页追加 */
  const [toolLimit, setToolLimit] = useState(TOOLS_PAGE);
  const [skillLimit, setSkillLimit] = useState(SKILLS_PAGE);
  const toolsSentinel = useRef<HTMLDivElement | null>(null);
  const skillsSentinel = useRef<HTMLDivElement | null>(null);
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  /* 最新上架（技能+工具按上架时间混排；普通计算避开声明顺序） */
  const latestItems = () => {
    const fromS = skills
      .map((x) => ({ tag: x.kind === 'agent' ? '智' : '技', cls: 'bg-accentSoft text-accentText', name: x.name, when: (x.createdAt || '').slice(5, 10), t: parseDate(x.createdAt) || 0, go: () => setActiveSkill(x) }))
      .filter((x) => x.t > 0);
    const fromT = tools
      .map((t) => ({ tag: '工', cls: 'bg-accentSoft text-accentText', name: t.name, when: '', t: toolListedAt(t) || 0, go: () => setActiveTool(t) }))
      .filter((x) => x.t > 0);
    return [...fromS, ...fromT].sort((a, b) => b.t - a.t).slice(0, 4);
  };
  /* 热度榜（工具使用 × 技能调用 Top4） */
  const hotRank = () => {
    const fromT = tools.map((t) => ({ name: t.name, n: `${getUsage(t.id, t.usage)} 次`, v: getUsage(t.id, t.usage), go: () => setActiveTool(t) }));
    const fromS = skills.map((x) => ({ name: x.name, n: `${x.usage} 次`, v: x.usage, go: () => setActiveSkill(x) }));
    return [...fromT, ...fromS].filter(item => item.v > 0).sort((a, b) => b.v - a.v).slice(0, 4);
  };
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState(false);
  const refreshSkills = async (force = false) => {
    setSkillsLoading(true); setSkillsError(false);
    try { setSkills(await loadSkills(true, force)); }
    catch { setSkillsError(true); }
    finally { setSkillsLoading(false); }
  };
  const [extraTools, setExtraTools] = useState<Tool[]>([]);
  const [builtinOffline, setBuiltinOffline] = useState<string[]>([]);
  const [builtinOverrides, setBuiltinOverrides] = useState<Record<string, Partial<Tool>>>({});
  const [hot7d, setHot7d] = useState<Record<string, number>>({});
  const [ratings, setRatings] = useState<Record<string, { avg: number; count: number }>>({});
  const [toolSort, setToolSort] = useState<SortKey>('newest');
  const [skillSort, setSkillSort] = useState<SortKey>('newest');
  /* 部门筛选清单：员工名册短名动态拉取（与上传「适用部门」选项同源），静态清单兜底 */
  const [deptOptions, setDeptOptions] = useState<string[]>(departments);
  const [showUpload, setShowUpload] = useState(['1', 'records'].includes(params.get('upload') || ''));
  // 资源中枢当前页签：默认恢复上次访问（顶栏 ?sec= / 直达 ?tab= 可强制指定）
  const [libTab, setLibTab] = useState<LibTab>(() => {
    const requested = params.get('sec') || params.get('tab');
    const saved = localStorage.getItem(LIB_TAB_KEY);
    return isLibTab(requested) ? requested : isLibTab(saved) ? saved : 'agents';
  });
  const requestedTabRef = useRef(libTab);

  // URL 带 ?upload=1 时打开上传弹窗（组件未重挂载也能触发）
  useEffect(() => {
    if (['1', 'records'].includes(params.get('upload') || '')) setShowUpload(true);
  }, [params]);

  // 顶栏「工具库 / 技能库」(?sec=tools|skills)：切到对应页签并滚动到资源中枢；?tab= 只切页签不滚动。
  // 延迟一拍：避开 HashRouter 导航时浏览器恢复历史滚动位置对 smooth 滚动的打断。
  useEffect(() => {
    const sec = params.get('sec');
    const tab = params.get('tab');
    const next: LibTab | null =
      isLibTab(sec) ? sec : isLibTab(tab) ? tab : null;
    if (!next) return;
    if (next !== requestedTabRef.current) { setSkillTag('全部'); setSkillQ(''); }
    requestedTabRef.current = next;
    setLibTab(next);
    localStorage.setItem(LIB_TAB_KEY, next);
    if (!sec) return;
    const t = setTimeout(() => {
      scrollToLibrary();
    }, 80);
    return () => clearTimeout(t);
  }, [params]);

  /** 手动切换页签：localStorage 记住上次访问；URL 同步 ?tab=（replace 不产生历史）并清掉 sec，避免随后又被顶栏参数拉回 */
  const switchLib = (tab: LibTab) => {
    if (tab !== libTab) { setSkillTag('全部'); setSkillQ(''); }
    requestedTabRef.current = tab;
    setLibTab(tab);
    localStorage.setItem(LIB_TAB_KEY, tab);
    if (params.get('tab') !== tab || params.get('sec')) {
      const next = new URLSearchParams(params);
      next.delete('sec');
      next.set('tab', tab);
      setParams(next, { replace: true });
    }
  };

  const { getUsage } = useUsage();
  const { session } = useAuth();
  const isAdmin = session?.role === 'admin';
  const [toolQ, setToolQ] = useState('');
  const [skillQ, setSkillQ] = useState('');
  const q = toolQ.trim().toLocaleLowerCase();

  const tools = useMemo(() => {
    // 内置工具应用管理端编辑覆盖并过滤已下架项，再拼接员工上传工具
    const builtins = staticTools
      .map((t) => (builtinOverrides[t.id] ? { ...t, ...builtinOverrides[t.id] } : t))
      .filter((t) => !builtinOffline.includes(t.id));
    return [...builtins, ...extraTools];
  }, [extraTools, builtinOffline, builtinOverrides]);

  // Skill Center：技能列表 + 统计实时同步；上传工具：服务端已上线清单（含内置工具下架/覆盖）
  useEffect(() => {
    void refreshSkills();
    loadSkillDeptMap().then((d) => {
      setSkillDepts(d.depts);
      setSkillDeptMap(d.map);
      setSkillApplicable(d.applicable);
      // 适用部门选项：配置过的技能涉及的部门短名（排除「全部」，该值由行首固定「全部」药丸承担），去重排序
      setSkillApplyDepts(
        [...new Set(Object.values(d.applicable).flat())].filter((x) => x && x !== '全部').sort(),
      );
    });
    api.toolsExtra().then((r) => {
      if (!r.ok) return;
      applyUsageResets(r.usageReset);
      setExtraTools(r.tools || []);
      setBuiltinOffline(r.builtinOffline || []);
      setBuiltinOverrides(r.builtinOverrides || {});
      setHot7d(r.hot7d || {});
      setRatings(r.ratings || {});
    });
    api.meta.departments().then((r) => {
      if (r.ok && r.departments?.length) setDeptOptions(['全部', ...r.departments]);
    }).catch(() => {});
  }, []);

  // 登录后回到原操作：打开工具详情 / 打开上传弹窗（由登录门禁写入 sessionStorage）
  useEffect(() => {
    if (!session) return;
    try {
      const raw = sessionStorage.getItem('skillharbor-pending');
      if (!raw) return;
      const p = JSON.parse(raw) as { type: string; id?: string };
      // 成功消费后才删除：员工上传工具要等 extraTools 拉取到位才能找到，提前删会丢失「登录后回开弹窗」
      if (p.type === 'tool') {
        const t = tools.find((x) => x.id === p.id);
        if (t) {
          setActiveTool(t);
          sessionStorage.removeItem('skillharbor-pending');
        }
      } else if (p.type === 'upload') {
        setShowUpload(true);
        sessionStorage.removeItem('skillharbor-pending');
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, extraTools]);

  // 标签集合 = 预设标签 + 工具数据里出现的自定义标签（上传时新增的会同步出现在这里）
  const tagList = useMemo(() => {
    const extra = new Set<string>();
    tools.forEach((t) => (t.tags || []).forEach((x) => !BASE_TAGS.includes(x) && extra.add(x)));
    return ['全部', ...BASE_TAGS, ...extra];
  }, [tools]);

  // 部门筛选清单：名册短名为主，补上工具里出现但名册没有的部门（如「Demo Unit」），保证每个工具都筛得到
  const deptList = useMemo(() => {
    const set = new Set(deptOptions.filter((d) => d !== '全部'));
    tools.forEach((t) => applyDeptsOf(t).forEach((d) => d && d !== '全部' && set.add(d)));
    return ['全部', ...set];
  }, [deptOptions, tools]);

  // 归属部门筛选清单：工具数据里实际出现的归属部门（上传人部门），只列筛得到结果的项
  const ownerDeptList = useMemo(() => {
    const set = new Set<string>();
    tools.forEach((t) => t.department && set.add(t.department));
    return ['全部', ...set];
  }, [tools]);

  const filtered = useMemo(() => {
    const list = tools.filter((t) => {
      const okOwner = ownerDept === '全部' || t.department === ownerDept;
      const okDept = dept === '全部' || applyDeptsOf(t).some((d) => d === dept || d === '全部');
      const okTag = tag === '全部' || (t.tags || []).includes(tag);
      const okQ =
        !q || [t.name, t.department, t.owner, t.desc, ...(t.tags || []), ...(t.departments || [])]
          .some(value => value.toLocaleLowerCase().includes(q));
      return okOwner && okDept && okTag && okQ;
    });
    // 排序：最新上架 = 首次上架时间倒序；最近热门 = 近 7 天真实点击倒序（并列按上架时间）；
    // 评价最好 = 星级均分倒序（同分按评价数，无评价统一垫底）——评分汇总来自服务端（含内置工具）
    if (toolSort === 'newest') return [...list].sort((a, b) => toolListedAt(b) - toolListedAt(a));
    if (toolSort === 'hot') return [...list].sort((a, b) => (hot7d[b.id] || 0) - (hot7d[a.id] || 0) || toolListedAt(b) - toolListedAt(a));
    if (toolSort === 'rated') {
      return [...list].sort((a, b) => {
        const ra = ratings[a.id];
        const rb = ratings[b.id];
        if (!ra && !rb) return toolListedAt(b) - toolListedAt(a);
        if (!ra) return 1;
        if (!rb) return -1;
        return rb.avg - ra.avg || rb.count - ra.count || toolListedAt(b) - toolListedAt(a);
      });
    }
    return list;
  }, [ownerDept, dept, tag, q, tools, toolSort, hot7d, ratings]);

  // 瀑布流：默认只展示第一阶段，剩余由滚动哨兵按页追加
  const visibleTools = filtered.slice(0, toolLimit);

  const catalogSkills = useMemo(() => skills.filter(s => libTab === 'agents' ? s.kind === 'agent' : s.kind !== 'agent'), [skills, libTab]);
  const skillLabel = libTab === 'agents' ? '智能体' : '技能';
  // 业务标签与数量只统计当前资源类型
  const skillTagList = useMemo(() => {
    const cnt = new Map<string, number>();
    catalogSkills.forEach((s) => cnt.set(s.category, (cnt.get(s.category) || 0) + 1));
    return ['全部', ...[...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)];
  }, [catalogSkills]);

  // 技能筛选：归属部门（服务端推导：上传人部门优先，无上传人回落主要使用部门）+ 适用部门（管理端配置，未配置回落归属部门）+ 标签（category）+ 排序
  const skillKw = skillQ.trim().toLocaleLowerCase();
  const filteredSkills = useMemo(() => {
    const list = catalogSkills.filter((s) => {
      const okDept = skillDept === '全部' || skillDeptMap[s.id || ''] === skillDept;
      const okApply =
        skillApplyDept === '全部' ||
        skillApplyDeptsOf(s, skillDeptMap, skillApplicable).some((d) => d === skillApplyDept || d === '全部');
      const okTag = skillTag === '全部' || s.category === skillTag;
      const okQ =
        !skillKw || [s.name, s.category, s.desc || '', s.slug || ''].some(value => value.toLocaleLowerCase().includes(skillKw));
      return okDept && okApply && okTag && okQ;
    });
    if (skillSort === 'newest') return [...list].sort((a, b) => skillListedAt(b) - skillListedAt(a));
    if (skillSort === 'hot') return [...list].sort((a, b) => (b.calls7d || 0) - (a.calls7d || 0) || skillListedAt(b) - skillListedAt(a));
    return list;
  }, [catalogSkills, skillDept, skillApplyDept, skillDeptMap, skillApplicable, skillTag, skillSort, skillKw]);
  const visibleSkills = filteredSkills.slice(0, skillLimit);

  // 筛选 / 搜索 / 排序变化：瀑布流回到第一屏重新累计
  useEffect(() => {
    setToolLimit(TOOLS_PAGE);
  }, [ownerDept, dept, tag, q, toolSort]);
  useEffect(() => {
    setSkillLimit(SKILLS_PAGE);
  }, [libTab, skillDept, skillApplyDept, skillTag, skillKw, skillSort]);

  // 滚动哨兵：进入视口（预留 400px 预载）即追加下一阶段；切页签后面板重挂载，观察器随之重建
  useEffect(() => {
    const el = toolsSentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setToolLimit((n) => Math.min(n + TOOLS_PAGE, filtered.length)),
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length, libTab]);
  useEffect(() => {
    const el = skillsSentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setSkillLimit((n) => Math.min(n + SKILLS_PAGE, filteredSkills.length)),
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filteredSkills.length, libTab]);

  // 兜底：哨兵初始就落在预载区内时（卡片正好铺满一屏，如技能 6 张卡），IO 交叉状态
  // 从未变化便不再回调，滚动也触发不了追加。渲染后主动检查：仍在预载区内且有剩余
  // 就继续追加，直到哨兵被推出预载区或全部加载完（与上方 IO 的 rootMargin 保持一致）
  useEffect(() => {
    if (toolLimit >= filtered.length) return;
    const el = toolsSentinel.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight + 400 && r.bottom > 0) setToolLimit((n) => Math.min(n + TOOLS_PAGE, filtered.length));
  }, [toolLimit, filtered.length]);
  useEffect(() => {
    if (skillLimit >= filteredSkills.length) return;
    const el = skillsSentinel.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight + 400 && r.bottom > 0) setSkillLimit((n) => Math.min(n + SKILLS_PAGE, filteredSkills.length));
  }, [skillLimit, filteredSkills.length]);

  const isTools = libTab === 'tools';
  const resourceLabel = isTools ? '工具' : skillLabel;
  const activeQuery = isTools ? toolQ : skillQ;
  const selectedFilters: [string, string, (value: string) => void][] = isTools
    ? [['归属部门', ownerDept, setOwnerDept], ['适用部门', dept, setDept], ['业务标签', tag, setTag]]
    : [['归属部门', skillDept, setSkillDept], ['适用部门', skillApplyDept, setSkillApplyDept], ['业务标签', skillTag, setSkillTag]];
  const activeFilters = selectedFilters.filter(([, value]) => value !== '全部');
  const clearFilters = () => {
    filterToggleRef.current?.focus({ preventScroll: true });
    selectedFilters.forEach(([, , setValue]) => setValue('全部'));
  };
  const clearConditions = () => {
    clearFilters();
    if (isTools) setToolQ(''); else setSkillQ('');
    catalogSearchRef.current?.focus({ preventScroll: true });
  };
  const showAll = (tab: LibTab, query: string) => {
    switchLib(tab);
    if (tab === 'tools') {
      setOwnerDept('全部'); setDept('全部'); setTag('全部'); setToolQ(query);
    } else {
      setSkillDept('全部'); setSkillApplyDept('全部'); setSkillTag('全部'); setSkillQ(query);
    }
    setFiltersOpen(false);
    setCatalogSearchRequest(value => value + 1);
  };
  useEffect(() => {
    if (!catalogSearchRequest) return;
    catalogSearchRef.current?.focus({ preventScroll: true });
    scrollToLibrary();
  }, [catalogSearchRequest]);
  const openKnowledge = (query: string) => {
    try { localStorage.setItem('kb-search-q', query); } catch { /* navigation remains available */ }
    nav('/kb');
  };
  const latest = latestItems();
  const popular = hotRank();

  return (
    <main className="home-page mx-auto max-w-[1440px]">
      <section className="relative px-8 pb-5 pt-7">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="hero-halo hero-halo-1" style={{ width: 520, height: 360, left: -120, top: -180 }} />
          <div className="hero-halo hero-halo-2" style={{ width: 480, height: 360, right: -100, top: -180 }} />
        </div>
        <div className="relative">
          <h1 className="text-[26px] font-semibold leading-tight">让每个人的经验，成为<span className="text-accentText">所有人</span>的能力</h1>
          <p className="mt-2 text-[13px] text-t2">找到适合的智能体、技能和工具，开始你的工作。</p>
          <GlobalResourceSearch tools={tools} skills={skills} skillsLoading={skillsLoading} skillsError={skillsError}
            onRetrySkills={() => void refreshSkills(true)} onTool={setActiveTool} onSkill={setActiveSkill}
            onShowAll={showAll} onKnowledge={openKnowledge} />
        </div>
      </section>

      <section id="library" aria-label="资源库" className="scroll-mt-20 px-8 pb-8 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div role="group" aria-label="资源类型" className="flex gap-2.5">
            {([['agents', '智能体', '◈'], ['skills', 'AI 技能', '✦'], ['tools', 'AI 工具', '▦']] as const).map(([tab, label, icon]) => (
              <button key={tab} type="button" onClick={() => switchLib(tab)} aria-pressed={libTab === tab}
                className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${libTab === tab ? 'border-accent bg-accent text-primaryForeground' : 'border-line bg-card text-t2 hover:border-accent hover:text-t1'}`}>
                <span aria-hidden="true">{icon}</span>{label}
                <span className={`rounded-full px-2 py-px font-mono text-xs ${libTab === tab ? 'bg-black/10 text-inherit' : 'bg-soft text-t2'}`}>
                  {tab === 'tools' ? tools.length : skillsLoading ? '…' : skillsError ? '—' : skills.filter(item => tab === 'agents' ? item.kind === 'agent' : item.kind !== 'agent').length}
                </span>
              </button>
            ))}
          </div>
          {isAdmin && <Link to="/admin?view=skills" className="rounded text-xs text-accentText hover:underline">管理资源 →</Link>}
        </div>
        <p className="mt-3 text-xs text-t2">
          {isTools ? '在线工具、下载文件和本地应用，按需选择。' : libTab === 'agents' ? '组合多个技能，完成一套业务流程。' : '解决一项具体任务，可在 AI 助手中调用。'}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="search-field flex h-9 w-[280px] shrink-0 items-center rounded-[10px] border border-line bg-soft px-3 dark:bg-card">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2 shrink-0 text-t3"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input ref={catalogSearchRef} type="search" value={activeQuery} onChange={event => isTools ? setToolQ(event.target.value) : setSkillQ(event.target.value)}
              aria-label={`搜索${resourceLabel}`} placeholder={isTools ? '搜索工具 / 负责人 / 标签…' : `搜索${skillLabel} / 分类…`}
              className="min-w-0 flex-1 bg-transparent text-xs text-t1 outline-none placeholder:text-t3" />
            {activeQuery && <button type="button" onClick={() => { catalogSearchRef.current?.focus(); if (isTools) setToolQ(''); else setSkillQ(''); }} className="ml-1 shrink-0 rounded px-1 text-xs text-t2 hover:text-t1" aria-label="清空资源搜索">✕</button>}
          </div>
          <button ref={filterToggleRef} type="button" aria-expanded={filtersOpen} aria-controls="catalog-filters" onClick={() => setFiltersOpen(value => !value)}
            className={`flex h-9 items-center gap-2 rounded-[10px] border px-3 text-xs ${filtersOpen || activeFilters.length ? 'border-accent bg-accentSoft text-accentText' : 'border-line bg-card text-t2 hover:border-accent'}`}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M7 12h10M10 17h4" /></svg>
            筛选{activeFilters.length > 0 ? `（${activeFilters.length}）` : ''}<span aria-hidden="true">{filtersOpen ? '⌃' : '⌄'}</span>
          </button>
          <span role="status" className="text-xs text-t3">{isTools ? filtered.length : skillsLoading ? '加载中…' : skillsError ? '加载失败' : filteredSkills.length}{isTools || (!skillsLoading && !skillsError) ? ` 个${resourceLabel}` : ''}</span>
          <div className="ml-auto"><SortTabs value={isTools ? toolSort : skillSort} onChange={isTools ? setToolSort : setSkillSort} options={isTools ? TOOL_SORTS : SKILL_SORTS} /></div>
        </div>

        {filtersOpen && (
          <div id="catalog-filters" role="region" aria-label="资源筛选" className="mt-4 space-y-2.5 rounded-xl border border-line bg-soft/40 p-4">
            {isTools ? <>
              <FilterOptions label="归属部门" values={ownerDeptList} value={ownerDept} onChange={setOwnerDept} />
              <FilterOptions label="适用部门" values={deptList} value={dept} onChange={setDept} />
              <FilterOptions label="业务标签" values={tagList} value={tag} onChange={setTag} />
            </> : <>
              {skillDepts.length > 0 && <FilterOptions label="归属部门" values={['全部', ...skillDepts]} value={skillDept} onChange={setSkillDept} />}
              <FilterOptions label="适用部门" values={['全部', ...skillApplyDepts]} value={skillApplyDept} onChange={setSkillApplyDept} />
              <FilterOptions label="业务标签" values={skillTagList} value={skillTag} onChange={setSkillTag} />
            </>}
          </div>
        )}
        {activeFilters.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="已选筛选条件">
            {activeFilters.map(([label, value, setValue]) => <button key={label} type="button" aria-label={`移除${label}：${value}`} onClick={() => { filterToggleRef.current?.focus({ preventScroll: true }); setValue('全部'); }}
              className="pill gap-2 bg-accentSoft text-accentText">{label}：{value}<span aria-hidden="true">×</span></button>)}
            <button type="button" onClick={clearFilters} className="rounded px-1 py-1 text-xs text-t2 underline">清除筛选</button>
          </div>
        )}

        {isTools ? <>
          <div className="mt-5 grid grid-cols-3 gap-4 2xl:grid-cols-4">
            {visibleTools.map((tool, index) => (
              <div key={tool.id} className="anim-stagger" style={{ ['--d' as string]: index }}>
                <ToolCard tool={tool} usage={getUsage(tool.id, tool.usage)} isNew={isNewListed(toolListedAt(tool))} onDetail={setActiveTool} />
              </div>
            ))}
          </div>
          <div ref={toolsSentinel} className="mt-5 text-center">
            {visibleTools.length < filtered.length && <button type="button" className="rounded px-2 py-1 text-xs text-accentText hover:underline" onClick={() => setToolLimit(value => value + TOOLS_PAGE)}>加载更多 · 已显示 {visibleTools.length} / {filtered.length}</button>}
          </div>
          {filtered.length === 0 && <div className="card mt-5 p-8 text-center text-sm text-t2">没有匹配的工具，换个关键词或筛选条件试试。<button type="button" className="ml-2 rounded text-accentText underline" onClick={clearConditions}>清除条件</button></div>}
        </> : <>
          <div className="mt-5 grid grid-cols-3 gap-3.5">
            {visibleSkills.map((skill, index) => {
              const style = skillStyle(skill.category);
              const department = skillDeptMap[skill.id];
              const applicable = skillApplyDeptsOf(skill, skillDeptMap, skillApplicable).filter(value => value !== '全部').join('、');
              const descriptionId = `resource-description-${encodeURIComponent(skill.id)}`;
              return (
                <div key={skill.id} className="anim-stagger" style={{ ['--d' as string]: index }}>
                  <button type="button" aria-label={`查看${skill.name}详情`} aria-describedby={descriptionId}
                    className="resource-card card flex h-full min-h-[154px] w-full flex-col gap-3 rounded-xl p-4 text-left transition-colors hover:border-accent"
                    onClick={() => setActiveSkill(skill)}>
                    <div className="flex w-full items-start gap-2.5">
                      <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${style.bg} ${style.fg}`}>{skill.icon}</span>
                      <span className="min-w-0 flex-1 self-center text-sm font-semibold leading-5 line-clamp-2">{skill.name}</span>
                      {isNewListed(skillListedAt(skill)) && <span className="pill shrink-0 bg-accentSoft !px-1.5 !py-0 text-accentText !text-[10px] font-bold">NEW</span>}
                    </div>
                    <p id={descriptionId} className="min-h-[36px] text-xs leading-[18px] text-t2 line-clamp-2">{skill.desc?.trim() || '用途说明待补充，点击查看详情。'}</p>
                    <div className="mt-auto flex w-full items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-t3">
                      <span className="min-w-0 truncate" title={[skill.category, department, applicable ? `适用 ${applicable}` : ''].filter(Boolean).join(' · ')}>{skill.category || '未分类'}{department ? ` · ${department}` : ''}</span>
                      <span className="shrink-0">累计 {skill.usage.toLocaleString()} 次</span>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
          <div ref={skillsSentinel} className="mt-5 text-center">
            {visibleSkills.length < filteredSkills.length && <button type="button" className="rounded px-2 py-1 text-xs text-accentText hover:underline" onClick={() => setSkillLimit(value => value + SKILLS_PAGE)}>加载更多 · 已显示 {visibleSkills.length} / {filteredSkills.length}</button>}
          </div>
          {skillsLoading && <div role="status" className="card mt-5 p-8 text-center text-sm text-t2">正在加载{skillLabel}…</div>}
          {skillsError && <div role="alert" className="card mt-5 p-8 text-center text-sm text-t2">技能中心暂时无法连接<button type="button" className="ml-2 rounded text-accentText underline" onClick={() => { catalogSearchRef.current?.focus({ preventScroll: true }); void refreshSkills(true); }}>重新加载</button></div>}
          {!skillsLoading && !skillsError && !filteredSkills.length && <div className="card mt-5 p-8 text-center text-sm text-t2">{catalogSkills.length ? `没有匹配的${skillLabel}，换个筛选条件试试。` : `暂无${skillLabel}`}{(activeQuery || activeFilters.length > 0) && <button type="button" className="ml-2 rounded text-accentText underline" onClick={clearConditions}>清除条件</button>}</div>}
        </>}
      </section>

      <section aria-label="资源动态" className="px-8 pb-10">
        <div className="grid grid-cols-3 gap-3.5">
          <div className="card rounded-[14px] p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold"><span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-ok" />最新上架</h3>
            <ul className="mt-2.5">
              {latest.map((item, index) => <li key={index} className="border-b border-line/60 last:border-0">
                <button type="button" onClick={item.go} aria-label={`查看${item.name}详情`} className="flex w-full items-center gap-2.5 rounded py-2.5 text-left text-xs hover:bg-soft">
                  <span aria-hidden="true" className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${item.cls}`}>{item.tag}</span>
                  <span className="min-w-0 flex-1 truncate text-t2">{item.name}</span><span className="shrink-0 text-[11px] text-t3">{item.when}</span>
                </button>
              </li>)}
            </ul>
            {!latest.length && <p className="py-5 text-xs text-t3">暂无新上架资源</p>}
          </div>
          <KnowledgeActivity />
          <div className="card rounded-[14px] p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold"><span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-accent" />热度榜</h3>
            <ul className="mt-2.5">
              {popular.map((item, index) => <li key={index} className="border-b border-line/60 last:border-0">
                <button type="button" onClick={item.go} aria-label={`查看${item.name}详情`} className="flex w-full items-center gap-2.5 rounded py-3 text-left text-xs hover:bg-soft">
                  <span aria-hidden="true" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-accentSoft text-[10px] font-bold text-accentText">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-t2">{item.name}</span><span className="shrink-0 text-[11px] text-t3">{item.n}</span>
                </button>
              </li>)}
            </ul>
            {!popular.length && <p className="py-5 text-xs text-t3">暂无使用记录</p>}
          </div>
        </div>
      </section>

      {/* 工具详情弹窗 */}
      {activeTool && <ToolModal tool={activeTool} isNew={isNewListed(toolListedAt(activeTool))} onClose={() => setActiveTool(null)} />}

      {/* 技能详情弹窗（带归属/适用部门映射，基本信息卡展示三行部门标签） */}
      {activeSkill && (
        <SkillModal
          skill={activeSkill}
          deptMap={skillDeptMap}
          applicable={skillApplicable}
          onClose={() => setActiveSkill(null)}
          onOpenGuide={() => {
            setActiveSkill(null);
            setShowGuide(true);
          }}
        />
      )}

      {/* 技能使用指引弹窗 */}
      {showGuide && <SkillGuideModal onClose={() => setShowGuide(false)} />}

      {/* 上传工具弹窗（四步向导）：关闭时清掉 URL 里的 upload 参数，
          否则下次导航到同地址不会触发 effect，出现“点按钮没反应” */}
      {showUpload && (
        <UploadModal
          initialMode={params.get('upload') === 'records' ? 'records' : 'wizard'}
          initialUploadId={params.get('uploadId') || undefined}
          onClose={() => {
            setShowUpload(false);
            if (params.get('upload')) {
              const next = new URLSearchParams(params);
              next.delete('upload');
              next.delete('uploadId');
              setParams(next, { replace: true });
            }
          }}
        />
      )}
    </main>
  );
}
