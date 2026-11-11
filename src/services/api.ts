/**
 * 服务端 API 客户端：统一携带 Bearer 令牌，返回 {ok, ...} 结构。
 * 失败统一返回 {ok:false,message}；成功保持门户对象 / 网关原始数组兼容。
 */
import type { QuotaRequest } from './workbench';
import type { PreparePackageRequest, PreparePackageResponse, ResourceType, UploadReport } from './packageAssistance';
import type { UploadReviewResponse } from './uploadReview';

const TOKEN_KEY = 'skillharbor-token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
export function setToken(t: string) {
  try {
    t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function req(path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { ...(init.headers as object) };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  try {
    const r = await fetch(path, { ...init, headers });
    let d: any;
    try {
      d = r.status === 204 ? { ok: true } : await r.json();
    } catch {
      return { ok: false, status: r.status, unauthorized: r.status === 401, message: `服务返回异常（HTTP ${r.status}），请重试` };
    }
    if (!r.ok || d?.ok === false || d?.detail) {
      const body = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
      const detail = typeof body.detail === 'string' ? body.detail : body.detail ? JSON.stringify(body.detail) : '';
      return { ...body, ok: false, status: r.status, unauthorized: r.status === 401,
        message: body.message || detail || `请求失败（HTTP ${r.status}），请重试` };
    }
    if (d === null || typeof d !== 'object') return { ok: false, message: '服务返回格式异常，请重试' };
    return d;
  } catch {
    return { ok: false, networkError: true, message: '网络连接中断，请检查连接后重试' };
  }
}
const post = (path: string, body?: unknown) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const del = (path: string) => req(path, { method: 'DELETE' });

export interface EvalItem {
  id: string;
  target: string;
  tn?: string;
  u?: string;
  mine?: boolean;
  n: string;
  d: string;
  v: 1 | -1;
  c: string;
  t: number;
  ip?: string;
  flag: 'ok' | 'suspect' | 'excluded';
}
export interface EvalSummary {
  up: number;
  down: number;
  excluded: number;
  total: number;
  rate: number | null;
}
export interface UploadRow {
  id: string;
  u: string;
  n: string;
  d: string;
  kind: 'web' | 'skill' | 'file' | 'link' | 'service';
  resourceType?: ResourceType;
  packageRevision?: number;
  filename?: string;
  sourceAvailable?: boolean;
  sizeMB?: number;
  name?: string;
  desc?: string;
  icon?: string;
  iconUrl?: string;
  iconBg?: string;
  url?: string;
  status: 'draft' | 'pending' | 'deploying' | 'deploy_failed' | 'online' | 'rejected' | 'offline';
  /** 适用部门（短名多选；['全部'] 表示全部门适用） */
  departments?: string[];
  /** 业务标签（提交时落库；驳回重交带回） */
  tags?: string[];
  /** 技能类上传的分类（提交时落库；驳回重交带回） */
  category?: string;
  createdAt: number;
  submittedAt?: number;
  approvedAt?: number;
  rejectedAt?: number;
  rejectReason?: string;
  deployedUrl?: string;
  /** 部署失败原因（status === 'deploy_failed' 时展示，审核中心可重试） */
  deployError?: string;
  /** 部署后入口探活结果（status 数字 / 'unreachable'） */
  healthCheck?: { at: number; status: number | string };
  publishSlug?: string;
  /** 更新提交：绑定的原记录（tool:<extraToolId> / skill:<slug>） */
  updateOf?: string;
  updateNote?: string;
  updateVersion?: string;
  /** 免选类型 · 管理员改判记录（如「网页工具 → 服务型工具」） */
  rekindNote?: string;
  report?: UploadReport;
}

/** P3 部署历史行 */
export interface DeployRow {
  id: string;
  tool: string;
  name: string;
  version: string;
  type: 'deploy' | 'rollback';
  by: string;
  at: number;
}

/* ===== 技能中心网关（经 /api/skill-gateway 代理，响应为网关原始 JSON，无 ok 字段） ===== */
export interface GwSkillRow {
  kind?: 'agent' | 'skill';
  slug: string;
  name: string;
  display_name?: string;
  category?: string;
  description?: string;
  status?: string;
  current_version?: string;
  created_at?: string;
  updated_at?: string;
  owner?: string;
  calls_7d?: number;
  calls_total?: number;
}
export interface GwVersion {
  version: string;
  note?: string;
  operator?: string;
  uploaded_at?: string;
  file_count?: number;
  effective?: string;
  is_current?: boolean;
}
export interface GwFile {
  path: string;
  kind?: string;
  size?: number;
}
export interface GwSkillDetail extends GwSkillRow {
  versions?: GwVersion[];
  files?: GwFile[];
}
export interface GwLog {
  id: number;
  ts: string;
  token_name?: string;
  token_key?: string;
  skill_slug: string;
  action: string;
  version?: string;
  detail?: string;
  status: string;
  duration_ms?: number;
  ip?: string;
  ip_name?: string;
}
export interface GwAlert {
  id: number;
  ts: string;
  level?: string;
  type?: string;
  subject?: string;
  description?: string;
  status?: string;
}
/** 我名下已上线记录（上传向导「更新已有」绑定列表） */
export interface MyOnlineTool {
  id: string;
  name: string;
  kind: string;
  onlineAt?: string;
  updatedAt?: string;
  desc?: string;
  tags?: string[];
  departments?: string[];
}
export interface MyOnlineSkill {
  kind?: 'agent' | 'skill';
  status?: string;
  updatedAt?: string;
  slug: string;
  /** 已通过审核但未上架技能中心的置灰项（不可作为更新对象） */
  id?: string;
  pendingPublish?: boolean;
  name: string;
  version?: string;
  onlineAt?: string;
  desc?: string;
  category?: string;
  tags?: string[];
  departments?: string[];
}
export interface ExtraToolRow {
  id: string;
  uploadId?: string;
  name: string;
  desc?: string;
  department?: string;
  /** 适用部门（短名多选；['全部'] 表示全部门适用；未设置时首页按归属部门参与筛选） */
  departments?: string[];
  owner?: string;
  url?: string;
  type: string;
  icon?: string;
  iconUrl?: string;
  iconBg?: string;
  tags?: string[];
  usage?: number;
  likes?: number;
  approvedAt?: number;
  shots?: string[];
  docUrl?: string;
  onlineAt?: string;
  updatedAt?: string;
  updatedNote?: string;
  status?: string;
  /** 手动登记（管理员后台添加，无上传/部署生命周期，编辑可改 URL） */
  manual?: boolean;
}

/* ===== 服务型工具运维看板 ===== */
export interface ServiceRow {
  siteKey: string;
  toolId: string;
  name: string;
  status: string;
  port: number;
  containerPort: number;
  image: string;
  url: string;
  health?: { at: number; status: number | string; entry?: string } | null;
  registeredAt: number;
}
export interface ServicesInfo {
  ok: boolean;
  rows?: ServiceRow[];
  live?: {
    ok: boolean;
    containers?: { name: string; status: string; running: boolean }[];
    stats?: Record<string, { cpu: string; mem: string }>;
    df?: { Type?: string; TotalCount?: number; Size?: string; Reclaimable?: string }[];
    message?: string;
  };
  mock?: boolean;
  portBegin?: number;
  portEnd?: number;
}

export const api = {
  /* 鉴权 */
  login: (username: string, password: string) => post('/api/auth/login', { username, password }),
  me: () => req('/api/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) => post('/api/auth/password', { oldPassword, newPassword }),

  /* 用户管理（admin） */
  users: {
    list: (signal?: AbortSignal) => req('/api/admin/users', { signal }),
    add: (u: { username: string; name: string; dept: string; deptShort: string; title: string }) => post('/api/admin/users', u),
    disable: (username: string) => post(`/api/admin/users/${username}/disable`),
    enable: (username: string) => post(`/api/admin/users/${username}/enable`),
    reset: (username: string) => post(`/api/admin/users/${username}/reset`),
    remove: (username: string) => del(`/api/admin/users/${username}`),
    edit: (username: string, body: { name?: string; dept?: string; title?: string }) =>
      post(`/api/admin/users/${username}/edit`, body),
  },
  /* 组织管理（admin）：部门字典 + 负责人 */
  org: {
    depts: () => req('/api/admin/org/depts'),
    addDept: (name: string, createLib: boolean) => post('/api/admin/org/depts', { name, createLib }),
    renameDept: (name: string, newName: string) => post('/api/admin/org/dept-rename', { name, newName }),
    delDept: (name: string) => post('/api/admin/org/dept-del', { name }),
    setHead: (dept: string, head: string, syncKb: boolean) => post('/api/admin/org/set-head', { dept, head, syncKb }),
  },
  logins: () => req('/api/admin/logins'),

  /* 评价 */
  evals: {
    get: (target: string) => req(`/api/evals?target=${encodeURIComponent(target)}`),
    all: (target: string) => req(`/api/evals/all?target=${encodeURIComponent(target)}`),
    /** 五星评价（stars 1..5）；vote 为技能侧旧二元制兼容入口 */
    submitStars: (target: string, targetName: string, stars: number, comment: string) =>
      post('/api/evals', { target, targetName, stars, comment }) as Promise<{ ok: boolean; summary?: { avg?: number | null; count?: number; up?: number; down?: number; rate?: number | null }; message?: string }>,
    submit: (target: string, targetName: string, vote: 1 | -1, comment: string) =>
      post('/api/evals', { target, targetName, vote, comment }),
    adminList: (f: { target?: string; vote?: string; flag?: string; q?: string } = {}) =>
      req('/api/admin/evals?' + new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>)),
    flag: (id: string, flag: 'ok' | 'excluded') => post(`/api/admin/evals/${id}/flag`, { flag }),
    remove: (id: string) => del(`/api/admin/evals/${id}`),
    exportUrl: () => '/api/admin/evals/export.csv?token=' + encodeURIComponent(getToken()),
  },

  /* 上传 */
  uploads: {
    parse: (file: File, kind: string, resourceType?: ResourceType) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', kind);
      if (resourceType) fd.append('resourceType', resourceType);
      return req('/api/uploads/parse', { method: 'POST', body: fd });
    },
    prepare: (id: string, body: PreparePackageRequest): Promise<PreparePackageResponse> => post(`/api/uploads/${encodeURIComponent(id)}/prepare`, body),
    parseOnly: () => post('/api/uploads/parseonly'),
    submit: (
      id: string,
      meta: {
        name: string;
        desc: string;
        icon: string;
        iconUrl?: string;
        iconBg?: string;
        url?: string;
        tags?: string[];
        departments?: string[];
        category?: string;
        updateOf?: string;
        updateNote?: string;
        updateVersion?: string;
        revision?: number;
      },
    ) => post('/api/uploads/submit', { id, ...meta }),
    icon: (url: string) => post('/api/uploads/icon', { url }),
    mine: () => req('/api/uploads/mine'),
    myOnline: (): Promise<{ tools?: MyOnlineTool[]; skills?: MyOnlineSkill[]; gatewayAvailable?: boolean }> => req('/api/uploads/my-online'),
    adminList: (status = '') => req('/api/admin/uploads' + (status ? `?status=${status}` : '')) as Promise<{ ok: boolean; rows?: UploadRow[]; filesBase?: string }>,
    review: (id: string): Promise<UploadReviewResponse> => req(`/api/admin/uploads/${encodeURIComponent(id)}/review`),
    approve: (id: string, revision?: number, reviewToken?: string) => post(`/api/admin/uploads/${id}/approve`, revision === undefined && reviewToken === undefined ? undefined : { ...(revision === undefined ? {} : { revision }), ...(reviewToken === undefined ? {} : { reviewToken }) }),
    reject: (id: string, reason: string, revision?: number, reviewToken?: string) => post(`/api/admin/uploads/${id}/reject`, { reason, ...(revision === undefined ? {} : { revision }), ...(reviewToken === undefined ? {} : { reviewToken }) }),
    offline: (id: string) => post(`/api/admin/uploads/${id}/offline`),
    publish: (id: string) => post(`/api/admin/uploads/${id}/publish`),
    /** P3 一键回滚到上一保留版本（URL 不变，符号链接切换） */
    rollback: (id: string): Promise<{ ok: boolean; message?: string }> => post(`/api/admin/uploads/${id}/rollback`),
    /** 免选类型 · 管理员改判（web / service / skill；仅待审记录，更新提交类型锁定） */
    rekind: (id: string, kind: 'web' | 'service' | 'skill'): Promise<{ ok: boolean; message?: string }> =>
      post(`/api/admin/uploads/${id}/rekind`, { kind }),
    /** P3 部署历史（tool=u<uploadId> 过滤单工具） */
    deployments: (tool?: string): Promise<{ ok: boolean; rows?: DeployRow[] }> =>
      req('/api/admin/deployments' + (tool ? `?tool=${tool}` : '')),
    /** 会话材料：截图（type=shot，≤2 张）/ 说明书（type=doc，1 份） */
    material: (id: string, type: 'shot' | 'doc', file: File) => {
      const fd = new FormData();
      fd.append('type', type);
      fd.append('file', file);
      return req(`/api/uploads/${id}/material`, { method: 'POST', body: fd }) as Promise<{ ok: boolean; shots?: string[]; doc?: string; message?: string }>;
    },
    materialDel: (id: string, type: 'shot' | 'doc', index?: number) => post(`/api/uploads/${id}/material-del`, { type, index }),
  },

  /* 部门清单（上传弹窗「适用部门」选项；名册短名去重） */
  meta: {
    departments: (): Promise<{ ok: boolean; departments?: string[] }> => req('/api/meta/departments'),
  },

  /* 动态工具（上传上线后自动出现；含内置工具下架/覆盖，首页据此过滤） */
  toolsExtra: () => req('/api/tools/extra'),

  /* 工具管理（admin） */
  adminTools: {
    list: (): Promise<{ ok: boolean; extra?: ExtraToolRow[]; builtinOffline?: string[]; builtinDeleted?: string[]; builtinOverrides?: Record<string, Partial<ExtraToolRow>>; usageReset?: Record<string, number> }> =>
      req('/api/admin/tools'),
    edit: (id: string, patch: Partial<ExtraToolRow>) => post(`/api/admin/tools/${encodeURIComponent(id)}/edit`, patch),
    /** 手动添加工具（S3 拦截外置数据库包后的正当出路：管理员自行部署后登记卡片） */
    manual: (tool: { name: string; url: string; type: string; desc?: string; icon?: string; tags?: string[]; departments?: string[] }) =>
      post('/api/admin/tools/manual', tool),
    setStatus: (id: string, status: 'online' | 'offline') => post(`/api/admin/tools/${encodeURIComponent(id)}/status`, { status }),
    /** 清零单个工具的「累计使用」显示（不影响统计看板原始记录） */
    resetUsage: (id: string) => post(`/api/admin/tools/${encodeURIComponent(id)}/reset-usage`),
    /** 批量清零全部已上线工具的「累计使用」显示 */
    resetAllUsage: () => post('/api/admin/tools/reset-usage'),
    /** 删除工具（软删除）：各页面即时隐藏，服务端记录与统计评价保留，可恢复 */
    remove: (id: string) => post(`/api/admin/tools/${encodeURIComponent(id)}/delete`),
  },

  /* 服务型工具运维（admin）：登记表 × 容器实时状态 */
  adminServices: {
    list: (): Promise<ServicesInfo> => req('/api/admin/services'),
  },

  /* 技能中心网关（管理后台 · 二级菜单） */
  gateway: {
    skills: (): Promise<GwSkillRow[]> => req('/api/skill-gateway/api/skills'),
    health: (): Promise<{ ok: boolean; auth_mode: string; mcp_port: number; mcp_alive: boolean }> =>
      req('/api/skill-gateway/api/health'),
    skill: (slug: string): Promise<GwSkillDetail> => req(`/api/skill-gateway/api/skills/${encodeURIComponent(slug)}`),
    setStatus: (slug: string, status: 'enabled' | 'disabled') =>
      post(`/api/skill-gateway/api/skills/${encodeURIComponent(slug)}/status?status=${status}`),
    setMeta: (slug: string, meta: { display_name?: string; category?: string; owner?: string }) => {
      const qs = new URLSearchParams(Object.fromEntries(Object.entries(meta).filter(([, v]) => v)) as Record<string, string>);
      return post(`/api/skill-gateway/api/skills/${encodeURIComponent(slug)}/meta?${qs}`);
    },
    rollback: (slug: string, version: string) =>
      post(`/api/skill-gateway/api/skills/${encodeURIComponent(slug)}/rollback?version=${encodeURIComponent(version)}`),
    removeSkill: (slug: string) => del(`/api/skill-gateway/api/skills/${encodeURIComponent(slug)}`),
    logs: (f: { user?: string; skill?: string; action?: string; status?: string; date_from?: string; date_to?: string; page?: number; size?: number } = {}) =>
      req('/api/skill-gateway/api/logs?' + new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined)) as Record<string, string>)),
    logsExportUrl: (f: { user?: string; skill?: string; action?: string; status?: string; date_from?: string; date_to?: string } = {}) => {
      const qs = new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== undefined)) as Record<string, string>);
      /* 导出走 <a> 直链，管理端代理要求管理员身份——同 evals.exportUrl 口径拼 ?token= */
      qs.set('token', getToken());
      return '/api/skill-gateway/api/logs/export.csv?' + qs;
    },
    alerts: (f: { level?: string; status?: string } = {}) =>
      req('/api/skill-gateway/api/alerts' + (Object.values(f).some(Boolean) ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>) : '')),
    resolveAlert: (id: number) => post(`/api/skill-gateway/api/alerts/${id}/resolve`),
    overview: (): Promise<{ skills_total?: number; skills_enabled?: number; calls_7d?: number; calls_today?: number; total_calls?: number; alerts_open?: number; active_ips_7d?: number }> =>
      req('/api/skill-gateway/api/stats/overview'),
    trend: (days = 30): Promise<{ date: string; count: number }[]> =>
      req(`/api/skill-gateway/api/stats/trend?days=${days}`),
    share: (): Promise<{ slug: string; count: number }[]> => req('/api/skill-gateway/api/stats/share'),
    skillTrend: (slug: string, days = 14): Promise<{ date: string; count: number }[]> =>
      req(`/api/skill-gateway/api/skills/${encodeURIComponent(slug)}/trend?days=${days}`),
    /** 只读包预检，返回与发布相同的入口、结构和校验问题。 */
    inspectSkill: (fd: FormData) => req('/api/skill-gateway/api/skills/inspect', { method: 'POST', body: fd }),
    /** 管理员直传技能包（multipart 经代理直达网关上传接口，version 必填，effective: now=立即生效 / pending=仅入库） */
    uploadSkill: (fd: FormData) => req('/api/skill-gateway/api/skills/upload', { method: 'POST', body: fd }),
    /** 触发网关从门户登录记录拉取 IP-姓名对照表 */
    syncNames: () => post('/api/skill-gateway/api/ip-names/sync'),
  },

  /* 技能「适用部门」（admin）：技能中心数据源无此字段，门户本地持久化（['全部'] = 全部门适用，空 = 清除回落归属部门） */
  skillDepartments: {
    all: (): Promise<{ ok: boolean; map?: Record<string, string[]> }> => req('/api/admin/skill-departments'),
    save: (slug: string, departments: string[]) => post('/api/admin/skill-departments', { slug, departments }),
  },

  /* 工作台申请（开通 / 扩容 One-API 令牌；服务端落 requests.json，管理员在工作台待办处理） */
  requests: {
    submit: (b: { type: 'open' | 'expand'; reason: string; from?: number; to?: number }): Promise<{ ok: boolean; req?: QuotaRequest }> =>
      post('/api/requests', b),
    mine: (): Promise<{ ok: boolean; rows?: QuotaRequest[] }> => req('/api/requests/mine'),
  },
  adminRequests: {
    list: (): Promise<{ ok: boolean; rows?: QuotaRequest[] }> => req('/api/admin/requests'),
    decide: (id: string, ok: boolean) => post(`/api/admin/requests/${encodeURIComponent(id)}/decide`, { ok }),
  },

  /* 系统设置（admin）：飞书告警 webhook */
  alertWebhook: {
    get: (): Promise<{ ok: boolean; url?: string }> => req('/api/admin/alert-webhook'),
    set: (url: string) => post('/api/admin/alert-webhook', { url }),
    test: () => post('/api/admin/alert-webhook/test'),
  },

  /* 使用统计 */
  stats: {
    click: (toolId: string) => post('/api/stats/click', { toolId }),
    mine: (month?: string) => req('/api/stats/mine' + (month ? `?month=${month}` : '')),
    /** 我名下工具的使用统计（工作台「我的工具」看板） */
    myTools: () => req('/api/stats/my-tools'),
    admin: (month?: string) => req('/api/admin/stats' + (month ? `?month=${month}` : '')),
    detail: (toolId: string, day: string) => req(`/api/admin/stats/detail?toolId=${encodeURIComponent(toolId)}&day=${day}`),
    setConfig: (dailyLimit: number) => post('/api/admin/stats/config', { dailyLimit }),
    /** 技能调用漏斗（服务端分页聚合网关日志） */
    funnel: () => req('/api/admin/gw-funnel'),
    /** 技能同步接入清单（/api/skill-stubs/all 心跳观测，方案A零侵入） */
    skillSync: () => req('/api/admin/skill-sync'),
  },

  /* One-API 员工自助（服务端按登录姓名关联令牌，密钥仅本人可见） */
  oneApi: {
    myQuota: () => req('/api/one-api/my-quota'),
    models: () => req('/api/one-api/models'),
  },
};

/* ============================== 接口中心（apihub） ============================== */
export interface AhSystem { id: string; name: string; dept: string; owner: string; loc: string; avail: string }
export interface AhInterface {
  id: string; sysId: string; method: string; path: string; title: string; desc: string; auth: string;
  state: 'cloud' | 'ready' | 'lan'; up: string; port?: number;
  owner: string; ownerName: string;
  params: string[][]; respOK?: string | null; respMiss?: string | null; errs: string[][]; callers: string[][];
  createdAt: number; updatedAt: number;
}
export interface AhChannel { ifId: string; port: number; up: string; reason: string; createdBy: string; createdName?: string; createdAt: number; lastCheck?: { t: number; ok: boolean; ms: number } }
export interface AhState {
  ok: boolean; systems: Record<string, AhSystem>; interfaces: AhInterface[];
  dynamics: { t: number; text: string; tag: string }[]; channels: AhChannel[];
  stats: { systems: number; total: number; cloud: number; ready: number; lan: number; channels: number };
}
export const ah = {
  state: (): Promise<AhState> => req('/api/apihub/state'),
  register: (body: unknown) => post('/api/apihub/interfaces', body),
  removeIf: (id: string) => del(`/api/apihub/interfaces/${id}`),
  apply: (ifId: string, reason: string) => post('/api/apihub/channels', { ifId, reason }),
  disable: (ifId: string) => del(`/api/apihub/channels/${ifId}`),
};
