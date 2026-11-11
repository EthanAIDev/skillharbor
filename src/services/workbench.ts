import { ONE_API } from '../config';
import { tools } from '../data/tools';
import type { Skill, Tool } from '../types';
import { loadSkills } from './skillsGateway';
import { api as portalApi, getToken } from './api';

/**
 * 工作台数据层（生产：只出真实数据）。
 * - One-API 额度 / 模型列表 / 管理端统计：经 /api/one-api 代理读取真实数据；
 *   服务不可用（未配置 ONE_API_ADMIN_TOKEN、网络异常）时返回 null / 空列表，由页面展示空态，不再有演示兜底。
 * - 员工未开通令牌（one-api 里无同名令牌）→ quota.tokenState = 'none'，由 UI 展示开通引导。
 * - 扩容/开通申请提交到服务端（requests.json），管理员工作台待办处理。
 */

const PROXY = '/api/one-api';

function startOfTodaySec(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ===== One-API 代理访问（须携带登录令牌：代理侧校验管理员身份） =====
async function api<T = any>(path: string, signal: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  signal.throwIfAborted();
  const r = await fetch(PROXY + path, { headers, signal });
  if (!r.ok) throw new Error('proxy ' + r.status);
  const j = await r.json();
  if (j && j.success === false) throw new Error(j.message || 'one-api error');
  return j as T;
}

interface OneApiToken {
  name: string;
  status: number;
  key?: string;
  remain_quota?: number;
  unlimited_quota?: boolean;
  /** 定制字段：每令牌每日 token 限额与已用（每日 00:00 由 one-api 重置） */
  daily_token_limit?: number;
  daily_used_tokens?: number;
  unlimited_daily_tokens?: boolean;
}
interface OneApiLog {
  token_name: string;
  model_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: number;
}

/**
 * 新版 One-API 支持 size=100 和 total；旧版忽略 size、固定 10 条且无 total。
 * p 从 0 起，首页后最多并发 8 页。读取到 total / 真实末页才成功，不返回截断数据。
 */
async function paged(pathBase: string, signal: AbortSignal): Promise<any[]> {
  const sep = pathBase.includes('?') ? '&' : '?';
  const fetchPage = async (p: number) => {
    const j = await api(pathBase + sep + 'size=100&p=' + p, signal);
    const d = j?.data ?? j;
    const items = Array.isArray(d) ? d : d?.items;
    const total = j?.total !== undefined ? j.total : d?.total;
    if (!Array.isArray(items) || (total !== undefined && (!Number.isSafeInteger(total) || total < 0)))
      throw new Error('统计数据格式异常，请重试');
    return { items, total: total as number | undefined };
  };
  const first = await fetchPage(0);
  const total = first.total;
  const size = total !== undefined || first.items.length > 10 ? 100 : 10;
  const out: any[] = [];
  const ids = new Set<number | string>();
  const append = (page: typeof first): boolean => {
    if (page.total !== total || (total !== undefined && page.items.length !== Math.min(size, total - out.length)))
      throw new Error('统计数据不完整或已变化，请重试');
    for (const item of page.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('统计数据格式异常，请重试');
      if (item.id !== undefined) {
        if (ids.has(item.id)) throw new Error('统计数据分页重复，请重试');
        ids.add(item.id);
      }
    }
    out.push(...page.items);
    return total !== undefined ? out.length === total : page.items.length < size;
  };
  if (append(first)) return out;
  const BATCH = 8;
  for (let base = 1; ; base += BATCH) {
    signal.throwIfAborted();
    const count = total === undefined ? BATCH : Math.min(BATCH, Math.ceil(total / size) - base);
    const pages = await Promise.allSettled(
      Array.from({ length: count }, (_, i) => fetchPage(base + i)),
    );
    // Consume in page order: a failure before the first real short page means
    // incomplete data; failures in speculative pages after it are irrelevant.
    for (const page of pages) {
      if (page.status === 'rejected') throw page.reason;
      if (append(page.value)) return out;
    }
  }
}

async function listTokens(signal: AbortSignal): Promise<OneApiToken[]> {
  return (await paged('/api/token/', signal)) as OneApiToken[];
}
async function logsSince(startSec: number, endSec: number, signal: AbortSignal): Promise<OneApiLog[]> {
  const base = `/api/log/?type=0&start_timestamp=${startSec}&end_timestamp=${endSec}`;
  return (await paged(base, signal)) as OneApiLog[];
}

// ===== 额度 =====
export interface ModelUsage {
  model: string;
  used: number;
}
export interface Quota {
  used: number;
  total: number; // total=0 表示不限量
  pct: number;
  remaining: number; // 不限量时为 -1
  models: ModelUsage[];
  tokenState: 'ok' | 'none';
  /** one-api 令牌剩余额度（500000 = $1），仅真实模式有值 */
  tokenRemainUsd?: number;
  /** 真实 API Key（sk- + 令牌 key），仅真实模式有值；复制用完整值，展示用掩码 */
  apiKeyReal?: string;
}

/**
 * 拉取当前登录员工（按姓名关联的 one-api 令牌）今日额度。
 * 走服务端 /api/one-api/my-quota：翻页聚合在服务端完成，密钥/额度只返回本人。
 * 返回 null = 额度服务不可用（未配置 ONE_API_ADMIN_TOKEN / 网络异常），由页面展示空态。
 */
export async function loadQuota(): Promise<Quota | null> {
  try {
    const r = await portalApi.oneApi.myQuota();
    if (!r || r.ok === false) return null;
    if (r.tokenState === 'none') {
      return { used: 0, total: ONE_API.dailyQuota, pct: 0, remaining: ONE_API.dailyQuota, models: [], tokenState: 'none' };
    }
    const used = r.used || 0;
    const total = r.unlimited ? 0 : r.total || ONE_API.dailyQuota;
    return {
      used,
      total,
      pct: total ? Math.min(Math.round((used / total) * 100), 999) : 0,
      remaining: total ? Math.max(total - used, 0) : -1,
      models: r.models || [],
      tokenState: 'ok',
      tokenRemainUsd: r.remainUsd,
      apiKeyReal: r.apiKey || undefined,
    };
  } catch {
    return null;
  }
}

// ===== 可用模型（API Key 卡展示） =====
/**
 * 可用模型：服务端 /api/one-api/models 合并启用渠道（status=1）的 models 字段并缓存 5 分钟。
 * 服务不可用时返回空列表（页面展示空态）。
 */
export async function loadAvailableModels(): Promise<string[]> {
  try {
    const r = await portalApi.oneApi.models();
    if (!r || r.ok === false) return [];
    return r.models || [];
  } catch {
    return [];
  }
}

// ===== 申请（扩容 / 开通）：服务端落库（requests.json），员工提交 → 管理员工作台待办处理 =====
export interface QuotaRequest {
  id: string;
  type: 'expand' | 'open';
  username: string;
  name: string;
  dept: string;
  from?: number;
  to?: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export async function submitRequest(r: Omit<QuotaRequest, 'id' | 'status' | 'createdAt'>): Promise<QuotaRequest | null> {
  const res = await portalApi.requests.submit({ type: r.type, reason: r.reason, from: r.from, to: r.to });
  return res.ok ? res.req || null : null;
}

/** 我提交的申请（按时间倒序） */
export async function listMyRequests(): Promise<QuotaRequest[]> {
  const res = await portalApi.requests.mine();
  return res.ok ? res.rows || [] : [];
}

/** 全部申请（管理端待办） */
export async function listAllRequests(): Promise<QuotaRequest[]> {
  const res = await portalApi.adminRequests.list();
  return res.ok ? res.rows || [] : [];
}

/** 管理员处理申请（通过 / 驳回） */
export async function decideRequest(id: string, ok: boolean): Promise<boolean> {
  const res = await portalApi.adminRequests.decide(id, ok);
  return !!res.ok;
}

/** 标记已处理（开通类申请在 One-API 手工创建后点此关闭） */
export async function closeRequest(id: string): Promise<boolean> {
  return decideRequest(id, true);
}

// ===== 管理端统计 =====
export interface AdminStats {
  todayTotal: number;
  activeUsers: number;
  totalUsers: number;
  withToken: number;
  trend: number[];
  byDept: { dept: string; used: number; pct: number }[];
  byModel: { model: string; used: number; pct: number }[];
}

/**
 * 管理端统计：只读 One-API 真实数据。
 * 抛错 = 额度服务不可用（未配置 ONE_API_ADMIN_TOKEN / 网络异常），由页面展示空态。
 */
export async function loadAdminStats(
  users: { username: string; name: string; deptShort: string }[],
  signal?: AbortSignal,
): Promise<AdminStats> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('统计查询超时，请重试')), 60_000);
  try {
    return await collectAdminStats(users, controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

async function collectAdminStats(
  users: { username: string; name: string; deptShort: string }[],
  signal: AbortSignal,
): Promise<AdminStats> {
  // Capture the interval once so a slow query crossing midnight cannot change its buckets.
  const todayStart = startOfTodaySec();
  const end = Math.floor(Date.now() / 1000);
  const tokens = await listTokens(signal);
  const nameToDept = new Map(users.map((u) => [u.name, u.deptShort]));

  // 今日消耗：直接读每令牌的 daily_used_tokens
  let todayTotal = 0;
  const deptMap = new Map<string, number>();
  const activeNames = new Set<string>();
  tokens.forEach((t) => {
    const used = t.daily_used_tokens || 0;
    todayTotal += used;
    if (used > 0) activeNames.add(t.name);
    const dept = nameToDept.get(t.name);
    if (dept) deptMap.set(dept, (deptMap.get(dept) || 0) + used);
  });
  const withToken = users.filter((u) => tokens.some((t) => t.name === u.name)).length;

  // 模型分布 / 14 日趋势：读取近 14 日全部日志，并发翻页直到真实末页。
  const start = todayStart - 13 * 86400;
  const logs = await logsSince(start, end, signal);
  const dayTotals = new Array(14).fill(0);
  const modelMap = new Map<string, number>();
  logs.forEach((l) => {
    const u = (l.prompt_tokens || 0) + (l.completion_tokens || 0);
    const dayIdx = Math.floor((l.created_at - start) / 86400);
    if (dayIdx >= 0 && dayIdx < 14) dayTotals[dayIdx] += u;
    if (l.created_at >= todayStart) modelMap.set(l.model_name, (modelMap.get(l.model_name) || 0) + u);
  });

  const byDept = [...deptMap.entries()]
    .map(([dept, used]) => ({ dept, used, pct: todayTotal ? Math.round((used / todayTotal) * 100) : 0 }))
    .sort((a, b) => b.used - a.used);
  const byModel = [...modelMap.entries()]
    .map(([model, used]) => ({ model, used, pct: todayTotal ? Math.round((used / todayTotal) * 100) : 0 }))
    .sort((a, b) => b.used - a.used);

  return {
    todayTotal,
    activeUsers: users.filter((u) => activeNames.has(u.name)).length,
    totalUsers: users.length,
    withToken,
    trend: dayTotals,
    byDept,
    byModel,
  };
}

/** 员工「我的工具」静态兜底（内置名册按姓名过滤；完整数据走 loadMyTools） */
export function myTools(name: string) {
  return tools.filter((t) => t.owner === name);
}

/**
 * 员工「我的工具」真实数据：内置名册（应用管理端的下架/覆盖）+ 服务端上线上传工具，
 * 与首页工具库同一数据源，按姓名（owner）关联。
 */
export async function loadMyTools(name: string): Promise<Tool[]> {
  const fallback = myTools(name);
  try {
    const r = await portalApi.toolsExtra();
    if (!r.ok) return fallback;
    const offline = r.builtinOffline || [];
    const overrides = r.builtinOverrides || {};
    const builtins = tools
      .map((t) => (overrides[t.id] ? { ...t, ...overrides[t.id] } : t))
      .filter((t) => !offline.includes(t.id));
    return [...builtins, ...(r.tools || [])].filter((t) => t.owner === name);
  } catch {
    return fallback;
  }
}

/**
 * 员工「我的技能」：技能中心实时数据按上传人（owner，姓名）关联；
 * 技能中心不可达时得到空列表，由页面展示空态。
 */
export async function loadMySkills(name: string): Promise<Skill[]> {
  const all = await loadSkills();
  return all.filter((s) => (s.owner || '') === name);
}

/** 时间人性化：今天 → HH:MM，昨天 → 昨天，更早 → M/D */
function humanTime(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, yest)) return '昨天';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 员工「最近使用」真实数据：本人点击记录（服务端 stats.json，10 秒内连击已合并；按登录令牌识别用户） */
export async function loadRecentUsage(): Promise<{ time: string; label: string }[]> {
  try {
    const r = await portalApi.stats.mine();
    const recent: { t: number; name: string }[] = (r && r.recent) || [];
    return recent.map((x) => ({ time: humanTime(x.t), label: x.name }));
  } catch {
    return [];
  }
}

// ===== 我名下工具的使用统计（工作台「我的工具」看板，只读） =====
export interface ToolUsageStat {
  id: string;
  name: string;
  icon: string;
  type: string;
  onlineAt: string;
  total: number; // 累计有效使用
  last7: number; // 近 7 天
  prev7: number; // 上一周（环比用）
  users: number; // 使用过的人数
  lastAt: number; // 最近使用时间戳（ms，0=从未）
  days: number[]; // 近 14 天每日使用量
}
export interface MyToolsStats {
  tools: ToolUsageStat[];
  summary: { count: number; total: number; last7: number; prev7: number; users: number; days: number[] };
}
export async function loadMyToolsStats(): Promise<MyToolsStats | null> {
  try {
    const r = await portalApi.stats.myTools();
    return r && r.ok ? (r as MyToolsStats) : null;
  } catch {
    return null;
  }
}
