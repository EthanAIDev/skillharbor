import { getToken } from './api';

export type DependencyState = 'missing' | 'disabled' | 'ambiguous' | 'planned';
export interface ScanMessage { slug: string; message: string }
interface ResourceIdentity { slug: string; name: string; kind: 'agent' | 'skill'; version: string; status: string }
export interface DependencyIssue extends ResourceIdentity {
  dependency: { id: string; name: string; slug?: string; required: boolean; status: DependencyState; candidates?: string[] };
}
export interface DependentResource extends ResourceIdentity {
  dependencyId: string;
  required: boolean;
  resolution: 'exact' | 'ambiguous';
  selfReference?: boolean;
  steps?: { id: string; task: string }[];
}
export interface DependencyIssuesReport { readOnly: true; scanned: number; items: DependencyIssue[]; errors: ScanMessage[]; warnings?: ScanMessage[] }
export interface DependentsReport { readOnly: true; slug: string; items: DependentResource[]; errors: ScanMessage[]; warnings?: ScanMessage[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is ResourceIdentity => record(value) && typeof value.slug === 'string' && typeof value.name === 'string' && typeof value.version === 'string' && ['enabled', 'disabled'].includes(String(value.status)) && ['agent', 'skill'].includes(String(value.kind));
const messages = (value: unknown): value is ScanMessage[] => Array.isArray(value) && value.every(item => record(item) && typeof item.slug === 'string' && typeof item.message === 'string');
function issue(value: unknown): value is DependencyIssue {
  if (!identity(value)) return false;
  const dep: unknown = (value as unknown as Record<string, unknown>).dependency;
  return record(dep) && typeof dep.id === 'string' && typeof dep.name === 'string' && typeof dep.required === 'boolean' && ['missing', 'disabled', 'ambiguous', 'planned'].includes(String(dep.status)) && (dep.slug === undefined || typeof dep.slug === 'string') && (dep.candidates === undefined || Array.isArray(dep.candidates) && dep.candidates.every(candidate => typeof candidate === 'string'));
}

async function readReport(path: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const token = getToken();
    const response = await fetch('/api/skill-gateway/api/skills' + path, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: controller.signal });
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('依赖检查返回格式异常，请重试'); }
    if (!response.ok || (record(body) && (body.ok === false || body.detail))) {
      throw new Error(record(body) && typeof body.message === 'string' ? body.message : record(body) && typeof body.detail === 'string' ? body.detail : `依赖检查失败（HTTP ${response.status}），请重试`);
    }
    if (!record(body) || body.readOnly !== true || !Array.isArray(body.items) || !messages(body.errors) || (body.warnings !== undefined && !messages(body.warnings))) throw new Error('依赖检查结果不完整，请重试');
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('依赖检查超时，请重试');
    throw error;
  } finally { window.clearTimeout(timeout); }
}

export async function loadDependencyIssues(): Promise<DependencyIssuesReport> {
  const body = await readReport('/dependency-issues');
  if (!Number.isInteger(body.scanned) || Number(body.scanned) < 0 || !(body.items as unknown[]).every(issue)) throw new Error('依赖检查结果不完整，请重试');
  return body as unknown as DependencyIssuesReport;
}

export async function loadDependents(slug: string): Promise<DependentsReport> {
  const body = await readReport('/' + encodeURIComponent(slug) + '/dependents');
  if (body.slug !== slug || (body.warnings !== undefined && !messages(body.warnings)) || !(body.items as unknown[]).every(item => {
    if (!identity(item)) return false;
    const dep = item as unknown as DependentResource;
    return typeof dep.dependencyId === 'string' && typeof dep.required === 'boolean' && ['exact', 'ambiguous'].includes(dep.resolution) && (dep.selfReference === undefined || typeof dep.selfReference === 'boolean') && (dep.steps === undefined || Array.isArray(dep.steps) && dep.steps.every(step => record(step) && typeof step.id === 'string' && typeof step.task === 'string'));
  })) throw new Error('依赖检查结果不完整，请重试');
  return body as unknown as DependentsReport;
}

export const DEPENDENCY_LABELS: Record<DependencyState, string> = { missing: '依赖缺失', disabled: '依赖已停用', ambiguous: '匹配不明确', planned: '待建设' };
