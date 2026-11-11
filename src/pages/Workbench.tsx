import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ONE_API } from '../config';
import {
  loadQuota,
  loadAvailableModels,
  submitRequest,
  listMyRequests,
  myTools,
  loadMyTools,
  loadMySkills,
  loadRecentUsage,
  loadMyToolsStats,
  type Quota,
  type MyToolsStats,
} from '../services/workbench';
import type { Skill, Tool, ToolType } from '../types';
import { TYPE_LABELS } from '../types';
import { loadSkillDeptMap } from '../services/skillsGateway';
import SkillModal from '../components/SkillModal';
import SkillGuideModal from '../components/SkillGuideModal';
import ToolModal from '../components/ToolModal';
import MyResources from '../components/MyResources';

import { getToken } from '../services/api';


function fmt(n: number) {
  return n.toLocaleString('zh-CN');
}

/** M/D HH:MM（今年内），用于"最近使用"类时间戳 */
function fmtTime(t: number) {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 统计看板格 */
function StatCell({ k, v, chip, up }: { k: string; v: string; chip?: string; up?: boolean }) {
  return (
    <div className="card p-[18px] flex flex-col gap-1.5">
      <span className="text-xs text-t2">{k}</span>
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-[26px] font-semibold leading-none truncate">{v}</span>
        {chip && <span className={`pill ${up === undefined ? 'bg-accentSoft text-accentText' : up ? 'bg-okSoft text-ok' : 'bg-warnSoft text-warn'} shrink-0`}>{chip}</span>}
      </div>
    </div>
  );
}

/** 明细行指标列 */
function Metric({ k, v, delta, small }: { k: string; v: string; delta?: number; small?: boolean }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] text-t3">{k}</div>
      <div className={`font-mono font-semibold mt-0.5 flex items-center gap-1 ${small ? 'text-xs text-t2' : 'text-[15px]'}`}>
        <span className="truncate">{v}</span>
        {delta !== undefined && delta !== 0 && (
          <span className={`text-[10px] font-normal shrink-0 ${delta > 0 ? 'text-ok' : 'text-warn'}`}>
            {delta > 0 ? `↑${fmt(delta)}` : `↓${fmt(-delta)}`}
          </span>
        )}
      </div>
    </div>
  );
}

/** 近 14 天迷你趋势线 */
function Spark({ days }: { days: number[] }) {
  const max = Math.max(...days, 1);
  const pts = days.map((v, i) => `${(i / (days.length - 1)) * 100},${26 - (v / max) * 22}`).join(' ');
  return (
    <svg width="104" height="28" viewBox="0 0 100 28" preserveAspectRatio="none" className="shrink-0 hidden sm:block" aria-hidden>
      <polyline points={pts} fill="none" stroke="#5046E5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** HTTP 环境下 navigator.clipboard 不可用（非安全上下文），降级 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function QuotaSkeleton() {
  return (
    <div className="card p-5 flex flex-col gap-3.5 animate-pulse">
      <div className="h-4 w-48 bg-soft dark:bg-[#262533] rounded" />
      <div className="h-[14px] bg-soft dark:bg-[#262533] rounded-full" />
      <div className="h-3 w-64 bg-soft dark:bg-[#262533] rounded" />
    </div>
  );
}

/**
 * 模型介绍（各厂官方文档缩减，≤30 字；vision=是否支持图片输入）。
 * 模型列表动态来自 One-API 渠道，新模型未配文案时显示「—」，补一行即可。
 */
const MODEL_META: Record<string, { desc: string; vision: boolean }> = {
  'ark-code-latest': { desc: '智能调度模型，按效果与速度自动匹配最优组合，尝鲜字节新能力', vision: false },
  'doubao-seed-2.1-pro': { desc: '豆包 2.1 旗舰，编码 / Agent / 多模态全面领先，胜任复杂任务', vision: true },
  'doubao-seed-2.1-lite': { desc: '质量与速度兼顾的通用生产模型，适合内容创作与数据分析', vision: false },
  'doubao-seed-2.0-mini': { desc: '轻量极速小模型，适合分类、提取、改写等高并发简单任务', vision: false },
  'doubao-seed-evolving': { desc: '豆包周级自升级模型，1M 长上下文，擅长编码、Agent 与长程规划', vision: false },
  'deepseek-v4.1-flash': { desc: 'V4.1 高速版，性能较 V4-Flash 再升级，Agent 能力增强', vision: false },
  'deepseek-v4-pro': { desc: 'Agent 能力大幅增强，代码 / 工具调用 / 多步任务更优，百万上下文', vision: false },
  'deepseek-v4-flash': { desc: 'V4 高速版，Agent 能力增强，基准远超上代预览版', vision: false },
  'glm-5.3': { desc: '智谱旗舰（抵扣较高），编程与安全突出，1M 上下文', vision: false },
  'glm-5.3-flash': { desc: 'GLM 首个原生多模态（火爆中），低成本高智能', vision: true },
  'kimi-k3': { desc: 'Kimi 旗舰（抵扣较高），原生视觉 + 100 万上下文，深度推理', vision: true },
  'kimi-k2.7-code': { desc: 'Kimi 编程模型，指令遵循更可靠，支持图片 / 视频输入与思考模式', vision: true },
  'minimax-m3': { desc: '新一代 M 系列，编码与智能体评测行业顶尖，适合 Agent 与长上下文', vision: false },
};

export default function Workbench() {
  const nav = useNavigate();
  const { session } = useAuth();
  const me = session!;
  const [quota, setQuota] = useState<Quota | null>(null);
  const [quotaErr, setQuotaErr] = useState(false); // One-API 额度服务不可用（未配置管理令牌 / 网络异常）
  const [models, setModels] = useState<string[]>([]);
  const realKey = quota?.apiKeyReal || '';
  /* 密钥默认全隐藏：星号数量与真实 Key 等长，不泄露任何前后缀 */
  const maskedKey = realKey ? '*'.repeat(realKey.length) : '';
  const [showKey, setShowKey] = useState(false);
  const displayKey = realKey && showKey ? realKey : maskedKey;
  /* 我的工具 / 我的技能 / 最近使用：先静态兜底立即渲染，再拉真实数据替换（工具按负责人姓名、技能按上传人姓名关联） */
  const [mine, setMine] = useState<Tool[]>(() => myTools(me.name));
  const [mySkills, setMySkills] = useState<Skill[]>([]);
  const [skillsReady, setSkillsReady] = useState(false);
  const [recent, setRecent] = useState<{ time: string; label: string }[]>([]);
  const [myRequests, setMyRequests] = useState<Awaited<ReturnType<typeof listMyRequests>>>([]);

  const [copied, setCopied] = useState(false);
  const [copyFail, setCopyFail] = useState(false);
  const [baseCopied, setBaseCopied] = useState(false);
  /* 详情弹窗（与首页工具库/技能库同款）：技能/工具名点击弹出，不跳页 */
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
  /* 技能归属/适用部门映射（SkillModal 展示用，与首页同源同缓存） */
  const [skillDeptMap, setSkillDeptMap] = useState<Record<string, string>>({});
  const [skillApplicable, setSkillApplicable] = useState<Record<string, string[]>>({});
  const [showForm, setShowForm] = useState<'expand' | 'open' | null>(null);
  const [to, setTo] = useState(200000);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState('');

  /* URL 是导航状态来源，支持刷新、前进后退及旧 sec 参数。 */
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') || searchParams.get('sec');
  const tab = ['resources', 'token', 'tools', 'skills'].includes(requestedTab || '') ? requestedTab : 'token';
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params);
  };
  const [toolStats, setToolStats] = useState<MyToolsStats | null>(null);
  const [toolStatsLoaded, setToolStatsLoaded] = useState(false);

  useEffect(() => {
    setQuota(null);
    setQuotaErr(false);
    loadQuota()
      .then((q) => {
        setQuota(q);
        setQuotaErr(!q);
      })
      .catch(() => {
        setQuota(null);
        setQuotaErr(true);
      });
    setModels([]);
    loadAvailableModels().then(setModels).catch(() => setModels([]));
    loadMyTools(me.name).then(setMine).catch(() => {});
    loadMySkills(me.name)
      .then((s) => setMySkills(s))
      .finally(() => setSkillsReady(true));
    loadRecentUsage().then(setRecent).catch(() => {});
    loadSkillDeptMap()
      .then((d) => {
        setSkillDeptMap(d.map);
        setSkillApplicable(d.applicable);
      })
      .catch(() => {});
    refreshRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.name, me.username]);

  /* 「我的工具」看板数据懒加载：首次切到该 tab 时拉取 */
  useEffect(() => {
    if (tab !== 'tools' || toolStatsLoaded) return;
    loadMyToolsStats()
      .then((s) => {
        setToolStats(s);
        setToolStatsLoaded(true);
      })
      .catch(() => setToolStatsLoaded(true));
  }, [tab, toolStatsLoaded]);


  const refreshRequests = () => {
    listMyRequests().then(setMyRequests).catch(() => {});
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const copy = async () => {
    const ok = await copyText(realKey);
    setCopied(ok);
    setCopyFail(!ok);
    setTimeout(() => {
      setCopied(false);
      setCopyFail(false);
    }, 1600);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    const type = showForm === 'open' ? ('open' as const) : ('expand' as const);
    const created = await submitRequest({
      type,
      username: me.username,
      name: me.name,
      dept: me.dept,
      from: type === 'expand' ? quota?.total || ONE_API.dailyQuota : undefined,
      to: type === 'expand' ? to : undefined,
      reason: reason.trim(),
    });
    if (!created) return flash('提交失败，请稍后重试或联系管理员');
    flash(type === 'open' ? '开通申请已提交，管理员会在 One-API 为你创建以姓名命名的令牌' : '扩容申请已提交，等待管理员审批');
    setShowForm(null);
    setReason('');
    refreshRequests();
  };

  const barW = (v: number, max: number) => `${Math.max(Math.min((v / max) * 100, 100), 1)}%`;
  const noToken = quota?.tokenState === 'none';

  /* 侧栏导航定义：key / label / 徽标数量 / 内联 SVG 图标 */
  const NAV_ITEMS = [
    { key: 'resources', label: '我的资源', n: '', icon: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/></svg> },
    { key: 'token', label: '我的令牌', n: '', icon: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="4.2"/><path d="m11.2 11.2 4 4"/><path d="M8 6v4M6 8h4"/></svg> },
    { key: 'tools', label: '我的工具', n: mine.length ? String(mine.length) : '', icon: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12.8 3.6a4.4 4.4 0 0 0 5 6.9l-8.3 8.3-3-3L14.8 7.5"/><circle cx="5.2" cy="14.6" r="1.1"/></svg> },
    { key: 'skills', label: '我的技能', n: mySkills.length ? String(mySkills.length) : '', icon: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 2.5 5 11h4l-1.5 6.5L14 9h-4z"/></svg> },
  ] as const;

  return (
    <main className="flex items-stretch">
      {/* ===== 左侧固定侧栏（管理后台布局）：Nav h-16 之下贴顶，独立滚动 ===== */}
      <aside className="w-[212px] shrink-0 sticky top-16 h-[calc(100vh-64px)] border-r border-line bg-card/60 backdrop-blur flex flex-col z-10">
        <div className="px-5 pt-6 pb-3">
          <div className="text-[13px] font-semibold text-t1">工作台</div>
          <div className="text-[11px] text-t3 mt-0.5">{me.dept}</div>
        </div>
        <nav className="px-3 flex flex-col gap-0.5">
          {NAV_ITEMS.map((it) => (
            <button
              key={it.key}
              onClick={() => setTab(it.key)}
              aria-current={tab === it.key ? 'page' : undefined}
              className={`flex items-center gap-2.5 px-3 h-9 rounded-[10px] text-[13px] transition-colors text-left ${
                tab === it.key ? 'bg-accentSoft text-accentText font-semibold' : 'text-t2 hover:text-t1 hover:bg-soft'
              }`}
            >
              <span className={`shrink-0 ${tab === it.key ? 'text-accentText' : 'text-t3'}`}>{it.icon}</span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.n && (
                <span className={`rounded-lg px-1.5 py-px text-[10px] font-semibold font-mono ${tab === it.key ? 'bg-accent text-white' : 'bg-accentSoft text-accentText'}`}>
                  {it.n}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto p-4 border-t border-line">
          <div className="rounded-xl bg-soft dark:bg-[#13121C] p-3.5 flex flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-full bg-accentSoft text-accentText flex items-center justify-center text-xs font-semibold shrink-0">
                {me.name.slice(-2)}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{me.name}</div>
                <div className="text-[10px] text-t3 truncate">{me.dept}</div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ===== 右侧内容区（无页头，空间全部留给模块内容） ===== */}
      <div className="flex-1 min-w-0">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      {tab === 'resources' && <MyResources key={me.username} />}

      {tab === 'token' && (
      <section className="px-8 pt-6 pb-10 flex flex-col lg:flex-row gap-4 items-stretch">
        {/* 左列 */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          {/* 未开通令牌：占位说明卡 */}
          {noToken ? (
            <div className="card p-6 flex flex-col gap-3.5">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-[10px] bg-warnSoft text-warn flex items-center justify-center text-lg font-semibold">!</span>
                <div>
                  <h2 className="text-[15px] font-semibold">你还没有开通 AI 令牌</h2>
                  <p className="text-[11px] text-t3 mt-0.5">开通后即可在本页查看每日额度、API Key，并按指引调用大模型</p>
                </div>
              </div>
              <div className="rounded-xl bg-soft dark:bg-[#13121C] p-4 text-xs text-t2 leading-[1.9]">
                公司 AI 令牌（API Key）由管理员在 One-API 统一开通，<b className="text-t1">以你的真实姓名命名</b>，用于统计个人每日额度。
                <br />
                你可以现在提交开通申请（说明用途），管理员处理后本页会自动显示你的额度与密钥信息。
              </div>
              <div className="flex items-center gap-3">
                <button className="btn-primary" onClick={() => setShowForm('open')}>申请开通 AI 令牌</button>
                <a href={ONE_API.adminUrl} target="_blank" rel="noreferrer" className="text-xs text-accentText hover:underline">
                  了解 One-API →
                </a>
              </div>
            </div>
          ) : quotaErr ? (
            <div className="card p-6 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-[10px] bg-warnSoft text-warn flex items-center justify-center text-lg font-semibold">!</span>
                <div>
                  <h2 className="text-[15px] font-semibold">额度服务暂不可用</h2>
                  <p className="text-[11px] text-t3 mt-0.5">无法连接 One-API（服务未接入或网络异常），额度与模型列表暂时无法显示</p>
                </div>
              </div>
              <p className="text-xs text-t2 leading-relaxed">
                请稍后刷新重试；若持续出现，请联系管理员检查 One-API 接入配置（ONE_API_ADMIN_TOKEN）。
              </p>
              <button className="btn-primary self-start" onClick={() => {
                setQuotaErr(false);
                loadQuota().then((q) => { setQuota(q); setQuotaErr(!q); }).catch(() => { setQuota(null); setQuotaErr(true); });
                loadAvailableModels().then(setModels).catch(() => setModels([]));
              }}>
                重新加载
              </button>
            </div>
          ) : !quota ? (
            <QuotaSkeleton />
          ) : (
            <>
              {/* 额度 */}
              <div className="card p-5 flex flex-col gap-3.5">
                <div className="flex items-center">
                  <h2 className="text-[15px] font-semibold">今日令牌额度（One-API）</h2>
                  <span className="flex-1" />
                  <span className="text-[11px] text-t3">每日 00:00 重置 · 实时数据，刷新更新</span>
                </div>
                <div className="h-[14px] rounded-full bg-soft dark:bg-[#13121C] border border-line overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-accent to-[#7B6CF6] dark:to-[#A277FF] transition-all"
                    style={{ width: `${Math.min(quota.pct, 100)}%` }}
                  />
                </div>
                <div className="flex items-center">
                  <span className="text-xs text-t2">
                    已用 {fmt(quota.used)} / {fmt(quota.total)} tokens
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-base font-bold text-accentText">{quota.pct}%</span>
                </div>
                {quota.models.length > 0 && (
                  <>
                    <div className="text-xs text-t3">按模型分布</div>
                    {quota.models.map((m, i) => (
                      <div key={m.model} className="flex flex-col gap-1.5">
                        <div className="flex items-center text-xs">
                          <span className="font-medium">{m.model}</span>
                          <span className="flex-1" />
                          <span className="text-[11px] text-t3 font-mono">
                            {fmt(m.used)} · {Math.round((m.used / (quota.used || 1)) * 100)}%
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-soft dark:bg-[#13121C] overflow-hidden">
                          <div
                            className={`h-full rounded-full ${['bg-accent', 'bg-[#7B6CF6] dark:bg-[#B49CFF]', 'bg-[#B0A4F8] dark:bg-[#D9CDFB]'][i % 3]}`}
                            style={{ width: barW(m.used, quota.models[0].used || 1) }}
                          />
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {quota.used === 0 && (
                  <p className="text-[11px] text-t3">今天还没有调用记录，用你的 Key 发起一次请求后这里会有数据。</p>
                )}
              </div>

              {/* API Key */}
              <div className="card p-5 flex flex-col gap-3">
                <div className="flex items-center">
                  <h2 className="text-[15px] font-semibold">我的 API Key</h2>
                  <span className="flex-1" />
                  {realKey ? (
                    <span className="pill bg-okSoft text-ok">● 有效</span>
                  ) : (
                    <span className="pill bg-warnSoft text-warn">密钥未下发</span>
                  )}
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 h-10 rounded-[10px] bg-soft dark:bg-[#13121C] border border-line flex items-center px-3.5">
                    <span className="font-mono text-xs truncate">{displayKey || '—'}</span>
                  </div>
                  {realKey && (
                    <button className="btn-ghost h-10" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  )}
                  <button className="btn-primary h-10" onClick={copy} disabled={!realKey} title={realKey ? undefined : '密钥未下发，请到 One-API 个人页查看'}>
                    {copied ? '已复制 ✓' : copyFail ? '复制失败' : realKey ? '复制' : '暂不可复制'}
                  </button>
                </div>
                <p className="text-[11px] text-t3">
                  已与 One-API 实时同步：即以你姓名命名的令牌，请妥善保管、勿转发他人。
                  {quota.tokenRemainUsd !== undefined && <> 令牌剩余额度 ${quota.tokenRemainUsd.toFixed(2)}。</>}
                </p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-t3">Base URL</span>
                  <span className="font-mono text-accentText">{ONE_API.baseUrl}</span>
                  <button
                    className="w-6 h-6 rounded-md border border-line bg-soft dark:bg-[#13121C] flex items-center justify-center text-t3 hover:text-t1 transition-colors shrink-0"
                    onClick={async () => {
                      const ok = await copyText(ONE_API.baseUrl);
                      setBaseCopied(ok);
                      setTimeout(() => setBaseCopied(false), 1600);
                    }}
                    title="复制 Base URL"
                  >
                    {baseCopied ? (
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 8.5 5.5 11.5 13.5 3.5"/></svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg>
                    )}
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-t3">可用模型</span>
                    <span className="text-[11px] text-t3">{models.length ? `共 ${models.length} 个，随 One-API 渠道自动同步` : '暂无法获取（One-API 不可用）'}</span>
                  </div>
                  <div className="flex flex-col divide-y divide-line">
                    {models.map((m) => {
                      const meta = MODEL_META[m];
                      return (
                        <div key={m} className="flex items-center gap-2.5 py-1.5">
                          <span className="font-mono text-[11px] text-t1 w-[150px] shrink-0 truncate" title={m}>
                            {m}
                          </span>
                          {meta && (
                            <span className={`pill shrink-0 !text-[10px] !px-1.5 ${meta.vision ? 'bg-accentSoft text-accentText' : 'bg-soft text-t3'}`}>
                              {meta.vision ? '支持图片' : '仅文本'}
                            </span>
                          )}
                          <span className="text-[11px] text-t3 truncate">{meta?.desc || '—'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* 接入指引 */}
          <div className="card p-5 flex flex-col gap-3.5">
            <div>
              <h2 className="text-[15px] font-semibold">接入指引</h2>
              <p className="text-xs text-t3 mt-1">3 步开始用你的 Key 调用大模型，不用再找管理员开通</p>
            </div>
            {[
              ['获得 API Key', noToken ? '先提交开通申请，管理员会为你创建以姓名命名的令牌' : '点击上方「复制」，或到 One-API 个人页查看完整密钥'],
              ['配置 Base URL 到你的工具或代码', '完全兼容 OpenAI 接口格式，Cherry Studio / 代码 / 内部工具均可直接填入'],
              ['选择模型并调用', '在可用模型列表中按需选择；额度每日 00:00 自动重置'],
            ].map(([t, d], i) => (
              <div key={t} className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-accentSoft text-accentText flex items-center justify-center text-xs font-semibold font-mono shrink-0">
                  {i + 1}
                </span>
                <div>
                  <div className="text-[13px] font-medium">{t}</div>
                  <div className="text-xs text-t2 mt-0.5">{d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右列（我的工具/我的技能已迁移至独立 Tab） */}
        <div className="w-full lg:w-[320px] shrink-0 flex flex-col gap-4">

          {/* 最近使用（真实点击记录） */}
          <div className="card p-5 flex flex-col gap-2.5">
            <div className="flex items-center mb-1">
              <h2 className="text-[15px] font-semibold">最近使用</h2>
              <span className="flex-1" />
              <Link to="/?sec=tools" className="text-xs text-accentText hover:underline">全部 →</Link>
            </div>
            {recent.length ? (
              recent.map((r, i) => (
                <div key={`${r.label}-${i}`} className="flex items-center gap-2.5">
                  <span className="text-[11px] text-t3 w-9 shrink-0">{r.time}</span>
                  <span className="text-xs truncate">{r.label}</span>
                </div>
              ))
            ) : (
              <p className="text-xs text-t3 leading-relaxed">暂无使用记录，从工具库打开工具后这里会显示你的足迹。</p>
            )}
          </div>

          {/* 扩容 / 开通 申请 */}
          <div className="rounded-2xl p-4 text-white bg-gradient-to-br from-[#5046E5] to-[#7B6CF6] dark:from-[#6D4AFF] dark:to-[#A277FF] flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold">{noToken ? '需要开通 AI 令牌？' : '额度用完了怎么办？'}</h2>
            <p className="text-[11px] text-white/85 leading-relaxed">
              {noToken
                ? '提交开通申请并注明用途，管理员会在 One-API 为你创建以姓名命名的令牌。'
                : '每日额度次日自动恢复；如需临时提升，可提交扩容申请，管理员审批后即时生效。'}
            </p>
            {!showForm ? (
              <button className="self-start text-[11px] font-medium hover:underline" onClick={() => setShowForm(noToken ? 'open' : 'expand')}>
                {noToken ? '申请开通 →' : '申请扩容 →'}
              </button>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-2 anim-fade">
                {showForm === 'expand' && (
                  <select
                    value={to}
                    onChange={(e) => setTo(Number(e.target.value))}
                    className="h-8 rounded-lg bg-white/15 border border-white/30 text-[12px] text-white outline-none px-2 [&>option]:text-black"
                  >
                    {[150000, 200000, 300000, 500000].map((v) => (
                      <option key={v} value={v}>
                        调整为每日 {fmt(v)} tokens
                      </option>
                    ))}
                  </select>
                )}
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={showForm === 'open' ? '用途说明（必填，如：报告写作、数据分析）' : '申请理由（必填）'}
                  className="h-8 rounded-lg bg-white/15 border border-white/30 text-[12px] text-white placeholder:text-white/60 outline-none px-2"
                />
                <div className="flex gap-2">
                  <button type="submit" className="rounded-full bg-white text-accent px-3.5 py-1 text-[11px] font-medium" disabled={!reason.trim()}>
                    提交申请
                  </button>
                  <button type="button" className="text-[11px] text-white/80" onClick={() => setShowForm(null)}>
                    取消
                  </button>
                </div>
              </form>
            )}
            {myRequests.length > 0 && (
              <div className="border-t border-white/25 pt-2 flex flex-col gap-1">
                {myRequests.slice(0, 3).map((r) => (
                  <div key={r.id} className="text-[11px] text-white/85">
                    {r.createdAt} {r.type === 'open' ? '开通申请' : `申请 ${fmt(r.to!)}/日`} ·{' '}
                    {r.status === 'pending' ? '审批中…' : r.status === 'approved' ? '✓ 已通过' : '✕ 已驳回'}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      )}

      {/* ===== Tab：我的工具（使用情况看板 · 只读） ===== */}
      {tab === 'tools' && (
        <section className="px-8 pt-6 pb-10 flex flex-col gap-4">
          {!toolStatsLoaded ? (
            <div className="card p-12 text-center text-t3 text-sm">统计加载中…</div>
          ) : !toolStats ? (
            <div className="card p-12 text-center text-t3 text-sm">统计服务暂不可用，请稍后刷新重试</div>
          ) : (
            <>
              {/* 统计卡无条件显示（与「我的技能」tab 一致，无工具时为 0 值） */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCell k="我的工具" v={String(toolStats.summary.count)} chip="我负责的" />
                <StatCell k="累计使用" v={fmt(toolStats.summary.total)} chip="全部工具合计" />
                <StatCell
                  k="近 7 天使用"
                  v={fmt(toolStats.summary.last7)}
                  chip={toolStats.summary.last7 >= toolStats.summary.prev7 ? `↑ 较上周 +${fmt(toolStats.summary.last7 - toolStats.summary.prev7)}` : `↓ 较上周 -${fmt(toolStats.summary.prev7 - toolStats.summary.last7)}`}
                  up={toolStats.summary.last7 >= toolStats.summary.prev7}
                />
                <StatCell k="使用过我工具的同事" v={String(toolStats.summary.users)} chip="人" />
              </div>

              {toolStats.tools.length === 0 ? (
                <div className="card p-12 flex flex-col items-center gap-3 text-center">
                  <span className="w-12 h-12 rounded-[12px] bg-soft flex items-center justify-center text-xl text-t3">工</span>
                  <p className="text-sm text-t2">你名下暂无登记的工具</p>
                  <p className="text-xs text-t3">在首页「上传工具」提交网页 / 文件 / 技能包，审核上线后这里会出现使用统计</p>
                  <button className="btn-primary mt-1" onClick={() => nav('/?upload=1')}>去上传工具</button>
                </div>
              ) : (
                <>
              <div className="card p-5 flex flex-col gap-3">
                <div className="flex items-center">
                  <h2 className="text-[15px] font-semibold">使用趋势（近 14 天）</h2>
                  <span className="ml-auto text-[11px] text-t3">数据来自门户点击统计</span>
                </div>
                <div className="flex items-end gap-2 h-[110px]">
                  {toolStats.summary.days.map((v, i) => {
                    const maxDay = Math.max(...toolStats.summary.days, 1);
                    return (
                      <div key={i} className="flex-1 h-full flex flex-col justify-end" title={`${v} 次`}>
                        <div
                          className={`rounded-t-[5px] transition-all ${i === 13 ? 'bg-accent' : 'bg-accent/25 dark:bg-[#33294F]'}`}
                          style={{ height: `${Math.max((v / maxDay) * 100, v ? 6 : 2)}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex text-[10px] text-t3">
                  <span>13 天前</span>
                  <span className="flex-1" />
                  <span className="text-accentText font-medium">今天</span>
                </div>
              </div>

              <div className="card p-5">
                <div className="flex items-center">
                  <h2 className="text-[15px] font-semibold">工具使用明细</h2>
                  <span className="ml-auto text-[11px] text-t3">点名称弹出工具详情</span>
                </div>
                <div className="mt-1">
                  {toolStats.tools.map((t) => {
                    /* 看板行只有统计字段，弹详情需完整 Tool 对象（与 mine 同源合并，按 id 对上） */
                    const full = mine.find((m) => m.id === t.id);
                    return (
                      <div key={t.id} className="flex items-center gap-3.5 py-3 border-b border-line last:border-0">
                        <span className="w-9 h-9 rounded-[9px] bg-accentSoft text-accentText flex items-center justify-center text-sm font-semibold shrink-0">
                          {t.icon}
                        </span>
                        <div className="w-[220px] shrink-0 min-w-0">
                          {full ? (
                            <button onClick={() => setActiveTool(full)} className="text-[13px] font-semibold truncate block hover:text-accentText text-left w-full">
                              {t.name}
                            </button>
                          ) : (
                            <Link to={`/tool/${t.id}`} className="text-[13px] font-semibold truncate block hover:text-accentText">
                              {t.name}
                            </Link>
                          )}
                          <div className="text-[11px] text-t3 mt-0.5 truncate">
                            {TYPE_LABELS[t.type as ToolType] || t.type}
                            {t.onlineAt ? ` · ${t.onlineAt} 上线` : ''}
                          </div>
                        </div>
                        <Metric k="累计使用" v={fmt(t.total)} />
                        <Metric k="近 7 天" v={fmt(t.last7)} delta={t.last7 - t.prev7} />
                        <Metric k="使用人数" v={String(t.users)} />
                        <Metric k="最近使用" v={t.lastAt ? fmtTime(t.lastAt) : '—'} small />
                        <Spark days={t.days} />
                        {full ? (
                          <button onClick={() => setActiveTool(full)} className="text-xs text-accentText hover:underline shrink-0 hidden sm:inline">
                            详情 →
                          </button>
                        ) : (
                          <Link to={`/tool/${t.id}`} className="text-xs text-accentText hover:underline shrink-0 hidden sm:inline">
                            详情 →
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11px] text-t3 pt-3">ℹ 本页为只读看板：修改工具信息、提交新版本请到首页「工具库」对应工具详情页操作。</p>
              </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {/* ===== Tab：我的技能（调用情况看板 · 只读） ===== */}
      {tab === 'skills' && (
        <section className="px-8 pt-6 pb-10 flex flex-col gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCell k="我的技能" v={skillsReady ? String(mySkills.length) : '…'} chip="已上架" />
            <StatCell k="累计调用" v={fmt(mySkills.reduce((s, x) => s + x.usage, 0))} chip="全部技能合计" />
            <StatCell k="近 7 天调用" v={fmt(mySkills.reduce((s, x) => s + (x.calls7d || 0), 0))} chip="数据来自技能中心" />
          </div>

          <div className="card p-5">
            <div className="flex items-center">
              <h2 className="text-[15px] font-semibold">技能调用明细</h2>
              <span className="ml-auto text-[11px] text-t3">点名称弹出技能详情</span>
            </div>
            <div className="mt-1">
              {mySkills
                .slice()
                .sort((a, b) => (b.calls7d || 0) - (a.calls7d || 0) || b.usage - a.usage)
                .map((s) => (
                  <div key={s.id} className="w-full flex items-center gap-3.5 py-3 border-b border-line last:border-0 group">
                    <span className="w-9 h-9 rounded-[9px] bg-accentSoft text-accentText flex items-center justify-center text-sm font-semibold shrink-0">
                      {s.icon}
                    </span>
                    <div className="w-[220px] shrink-0 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <button
                          onClick={() => setActiveSkill(s)}
                          className="text-[13px] font-semibold truncate group-hover:text-accentText text-left"
                          title="查看技能详情"
                        >
                          {s.name}
                        </button>
                        {s.version && (
                          <span className="pill bg-accentSoft text-accentText shrink-0 !text-[10px] !px-1.5">
                            v{s.version.replace(/^v/i, '')}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-t3 mt-0.5 truncate">
                        {s.category}
                        {s.createdAt ? ` · ${s.createdAt.slice(0, 10)} 上架` : ''}
                      </div>
                    </div>
                    <Metric k="累计调用" v={fmt(s.usage)} />
                    <Metric k="近 7 天" v={fmt(s.calls7d || 0)} />
                    <span className="flex-1" />
                    <button onClick={() => nav('/?sec=skills')} className="text-xs text-accentText shrink-0 hidden sm:inline hover:underline">
                      技能库 →
                    </button>
                  </div>
                ))}
            </div>
            {mySkills.length === 0 && (
              <div className="py-8 flex flex-col items-center gap-3 text-center">
                <span className="w-12 h-12 rounded-[12px] bg-soft flex items-center justify-center text-xl text-t3">技</span>
                <p className="text-sm text-t2">{skillsReady ? '你名下暂无已上架技能' : '技能中心同步中…'}</p>
                {skillsReady && (
                  <>
                    <p className="text-xs text-t3">在首页「上传工具」提交技能包，审核上架后这里会出现调用统计</p>
                    <button className="btn-primary mt-1" onClick={() => nav('/?upload=1')}>去上传技能</button>
                  </>
                )}
              </div>
            )}
            {mySkills.length > 0 && (
              <p className="text-[11px] text-t3 pt-3">提交新版本可使用「上传工具 → 更新已有」；版本回滚与上下架由管理员在本站后台「技能管理」处理。</p>
            )}
          </div>
        </section>
      )}
      </div>

      {/* 详情弹窗（与首页同款）：工具 / 技能 / 技能使用指引 */}
      {activeTool && <ToolModal tool={activeTool} onClose={() => setActiveTool(null)} />}
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
      {showGuide && <SkillGuideModal onClose={() => setShowGuide(false)} />}
    </main>
  );
}
