import type { Skill } from '../types';
import { SKILL_STYLES } from '../data/skills';

/**
 * Skill Center（原 Skill Gateway，http://127.0.0.1:8800）数据接入。
 * 经服务端代理 /api/skill-gateway 拉取，5 分钟缓存；不可达时返回空列表 / null，由页面展示空态（无演示兜底）。
 */

const PROXY = '/api/skill-gateway';
const TTL = 5 * 60 * 1000;

interface GwSkill {
  kind?: 'agent' | 'skill';
  slug: string;
  name: string;
  display_name?: string;
  category?: string;
  description?: string;
  current_version?: string;
  status?: string;
  owner?: string;
  created_at?: string;
  updated_at?: string;
  calls_7d?: number;
  calls_total?: number;
  routable?: boolean;
}

let skillsCache: { at: number; data: Skill[] } | null = null;
/** 技能 × 部门映射（服务端按调用日志聚合：ip_name 员工 → 部门），每技能取主要使用部门；
 * applicable = 管理端配置的「适用部门」（slug → 短名数组，['全部'] = 全部门适用），未配置的技能按归属部门参与筛选 */
export interface SkillDeptMap {
  map: Record<string, string>;
  depts: string[];
  applicable: Record<string, string[]>;
  live: boolean;
}
let deptMapCache: { at: number; data: SkillDeptMap } | null = null;

export async function loadSkillDeptMap(): Promise<SkillDeptMap> {
  if (deptMapCache && Date.now() - deptMapCache.at < TTL) return deptMapCache.data;
  try {
    const r = await fetch('/api/skills/dept-usage', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const s: SkillDeptMap = { map: d.map || {}, depts: d.depts || [], applicable: d.applicable || {}, live: true };
    deptMapCache = { at: Date.now(), data: s };
    return s;
  } catch {
    return { map: {}, depts: [], applicable: {}, live: false };
  }
}

/** 技能中心徽标取显示名首字 */
function iconOf(name: string): string {
  return (name || '技')[0];
}

/** 技能中心实时列表（不可达时返回空列表，不缓存空结果以便下次自动重试） */
export async function loadSkills(strict = false, force = false): Promise<Skill[]> {
  if (!force && skillsCache && Date.now() - skillsCache.at < TTL) return skillsCache.data;
  try {
    const r = await fetch(`${PROXY}/api/skills`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(String(r.status));
    const list = (await r.json()) as GwSkill[];
    const mapped: Skill[] = list
      .filter((s) => !s.status || s.status === 'enabled')
      .map((s) => ({
        id: s.slug,
        kind: s.kind || 'skill',
        slug: s.slug,
        name: s.display_name || s.name,
        category: s.category || '未分类',
        usage: s.calls_total || 0,
        icon: iconOf(s.display_name || s.name),
        desc: s.description,
        version: s.current_version,
        owner: s.owner || '',
        createdAt: s.created_at,
        calls7d: s.calls_7d || 0,
        updatedAt: s.updated_at,
        routable: s.routable,
      }))
      .sort((a, b) => b.usage - a.usage);
    skillsCache = { at: Date.now(), data: mapped };
    return mapped;
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export function skillStyle(category: string) {
  return SKILL_STYLES[category] || SKILL_STYLES['规划咨询'];
}

/* ====================== 按包版本读取主技能原文 ====================== */

/** 原文与结构分开读取；资源类型、分派关系只由网关统一解析。 */
export interface SkillMd {
  slug: string;
  version: string;
  content: string;
}
const contentCache = new Map<string, { at: number; data: SkillMd }>();

/** 拉取技能指定版本原文（门户代理白名单 GET，5 分钟缓存，失败返回 null 静默降级） */
export async function loadSkillMd(slug: string, version?: string): Promise<SkillMd | null> {
  const cacheKey = `${slug}@${version || 'current'}`;
  const hit = contentCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  try {
    const r = await fetch(`${PROXY}/api/skills/${encodeURIComponent(slug)}/content${version ? `?version=${encodeURIComponent(version)}` : ''}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const parsed: SkillMd = { slug: d.slug || slug, version: d.version || '', content: String(d.content || '') };
    contentCache.set(cacheKey, { at: Date.now(), data: parsed });
    return parsed;
  } catch {
    return null;
  }
}
