export type ResolutionStatus = 'ready' | 'missing' | 'disabled' | 'ambiguous' | 'planned';
export interface PackageComponent {
  id: string;
  name: string;
  kind: 'skill' | 'script';
  path: string;
  visibility: 'internal' | 'public';
  status: 'ready' | 'missing';
}
export interface PackageDependency {
  id: string;
  source: 'registry';
  slug?: string;
  name: string;
  required: boolean;
  status: ResolutionStatus;
  candidates?: string[];
}
export interface AgentGraph {
  schemaVersion: 1;
  slug: string;
  version: string;
  kind: 'agent' | 'skill';
  source: 'manifest' | 'legacy';
  entry: string;
  components: PackageComponent[];
  dependencies: PackageDependency[];
  steps: {
    id: string;
    task: string;
    executor: 'dispatch' | 'self';
    targets: string[];
    input?: string;
    output?: string;
  }[];
  warnings: string[];
  runtimeRequirements?: string[];
}

/** Legacy absence is allowed; supplied declarations must match the persisted schema. */
export function isRuntimeRequirements(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 128 &&
      value.every(
        (item) =>
          typeof item === 'string' &&
          !!item.trim() &&
          Array.from(item.trim()).length <= 256 &&
          !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(item),
      ))
  );
}
export interface ComponentContent {
  slug: string;
  version: string;
  id: string;
  name: string;
  kind: 'skill' | 'script';
  path: string;
  content: string;
}

async function read<T>(path: string, version?: string): Promise<T> {
  const response = await fetch(
    `/api/skill-gateway/api/skills/${path}${version ? `?version=${encodeURIComponent(version)}` : ''}`,
    { signal: AbortSignal.timeout(20000) },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok === false)
    throw new Error(body?.message || body?.detail || '暂时无法读取，请重试');
  return body as T;
}
export const loadAgentGraph = async (slug: string, version?: string): Promise<AgentGraph> => {
  const graph = await read<AgentGraph>(`${encodeURIComponent(slug)}/structure`, version);
  if (!isRuntimeRequirements(graph.runtimeRequirements)) throw new Error('运行环境要求格式异常，请重试');
  return { ...graph, runtimeRequirements: graph.runtimeRequirements ?? [] };
};
export const loadPackageComponent = (slug: string, id: string, version: string) =>
  read<ComponentContent>(`${encodeURIComponent(slug)}/components/${encodeURIComponent(id)}`, version);

export const RESOLUTION_LABELS: Record<ResolutionStatus, string> = {
  ready: '可查看',
  missing: '未找到对应技能',
  disabled: '已停用',
  ambiguous: '存在多个候选，需确认',
  planned: '待建设',
};
