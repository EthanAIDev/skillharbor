import type { UploadRow } from './api';
import type { ResourceType } from './packageAssistance';
import { isRuntimeRequirements } from './agentStructure';

export interface UploadReview {
  ok: true;
  id: string;
  revision: number;
  reviewToken: string;
  record: UploadRow;
  status: UploadRow['status'];
  resourceType: ResourceType;
  summary: {
    runtimeRequirements?: string[];
    name: string;
    purpose: string;
    functions: {
      id: string;
      name: string;
      source: 'package' | 'registry';
      kind: 'skill' | 'script';
      status: string;
      required: boolean;
      path?: string;
      slug?: string;
    }[];
    steps: { id: string; task: string; executor: 'dispatch' | 'self'; targets: string[] }[];
  };
  check: {
    state: 'complete' | 'attention' | 'blocked' | 'unknown';
    checkedAt: number;
    sourceAvailable: boolean;
    issues: { level: 'error' | 'warn' | 'info'; message: string }[];
  };
  update?: {
    target: { id: string; name: string; version?: string };
    proposedVersion?: string;
    state: 'available' | 'unavailable';
    changes: { field: string; label: string; before: string[]; after: string[] }[];
  };
}
export type UploadReviewResponse = UploadReview | { ok: false; message?: string; status?: number };

export function isReviewToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isReviewSnapshot(review: UploadReview, id: string): boolean {
  const record = review.record;
  return (
    !!record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    review.id === id &&
    record.id === id &&
    Number.isInteger(review.revision) &&
    review.revision >= 0 &&
    (record.packageRevision ?? 0) === review.revision &&
    record.status === review.status &&
    ['draft', 'pending', 'deploying', 'deploy_failed', 'online', 'rejected', 'offline'].includes(
      record.status,
    ) &&
    ['web', 'skill', 'file', 'link', 'service'].includes(record.kind) &&
    isRuntimeRequirements(review.summary?.runtimeRequirements) &&
    isRuntimeRequirements(record.report?.structure?.runtimeRequirements)
  );
}

/** Preserve component/dependency identity; a bare legacy id must be unambiguous. */
export function reviewTargetName(target: string, functions: UploadReview['summary']['functions']): string {
  const qualified = /^(component|dependency):(.*)$/.exec(target);
  const matches = qualified
    ? functions.filter(
        (fn) =>
          fn.id === qualified[2] && fn.source === (qualified[1] === 'component' ? 'package' : 'registry'),
      )
    : target.includes(':')
      ? []
      : functions.filter((fn) => fn.id === target);
  if (matches.length === 1) return matches[0].name || '功能未命名，请核对技术解析报告';
  return matches.length > 1 ? '对应功能不唯一，请核对技术解析报告' : '未能确认对应功能，请核对技术解析报告';
}

/** A validated structure is more specific than legacy upload classification. */
export function reviewResourceType(row: UploadRow): ResourceType {
  const graph = row.report?.structure;
  if (
    graph?.schemaVersion === 1 &&
    (graph.kind === 'agent' || graph.kind === 'skill') &&
    (graph.source === 'manifest' || graph.source === 'legacy') &&
    typeof graph.entry === 'string' &&
    Array.isArray(graph.components) &&
    Array.isArray(graph.dependencies) &&
    Array.isArray(graph.steps)
  )
    return graph.kind;
  if (row.resourceType === 'agent' || row.resourceType === 'skill' || row.resourceType === 'tool')
    return row.resourceType;
  const legacyKind: string = row.kind;
  return legacyKind === 'agent' ? 'agent' : legacyKind === 'skill' ? 'skill' : 'tool';
}

export const REVIEW_TYPE_LABELS: Record<ResourceType, string> = {
  agent: '智能体',
  skill: 'AI 技能',
  tool: '工具',
};
export const FUNCTION_STATUS: Record<string, string> = {
  ready: '可用',
  missing: '未找到',
  disabled: '已停用',
  ambiguous: '存在多个候选',
  planned: '待建设',
  unknown: '暂无法核实',
};
