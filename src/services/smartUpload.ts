import { getToken, type UploadRow } from './api';
import type { UploadReport } from './packageAssistance';
import { isRuntimeRequirements } from './agentStructure';

export interface SmartAnalysis {
  status: 'ready' | 'question' | 'blocked';
  kind: 'agent' | 'skill' | 'tool';
  runtimeRequirements?: string[];
  resource: {
    name: string;
    description: string;
    functions: { name: string; source: 'package' | 'registry' }[];
  };
  question?: {
    id: string;
    prompt: string;
    options: { id: string; label: string; description: string }[];
  };
  issues: { code: string; message: string }[];
  repairText: string;
  engine?: 'rules' | 'ai';
  aiNotice?: string;
  revision?: number;
  updateOf?: string;
  newResource?: boolean;
  identityConfirmed?: boolean;
  displayMetadata?: UploadDisplayMetadata;
}

export interface AnalyzeRequest {
  choices?: Record<string, string>;
  revision?: number;
  updateOf?: string;
  newResource?: boolean;
  retryAi?: boolean;
}

export interface AnalyzeResponse {
  ok: boolean;
  id?: string;
  analysis?: SmartAnalysis;
  report?: UploadReport;
  revision?: number;
  message?: string;
}

export interface SmartUploadRow extends UploadRow {
  smartAnalysis?: SmartAnalysis;
  packageRevision?: number;
  newResource?: boolean;
}

export type UploadDisplayMetadata = Pick<
  UploadRow,
  'icon' | 'iconUrl' | 'iconBg' | 'url' | 'tags' | 'departments' | 'category'
>;

export interface SmartDraftMetadata extends UploadDisplayMetadata {
  name: string;
  desc: string;
  updateNote: string;
}

export function isSmartAnalysis(value: unknown): value is SmartAnalysis {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<SmartAnalysis>;
  if (data.aiNotice !== undefined && typeof data.aiNotice !== 'string') return false;
  if (data.engine !== undefined && !['rules', 'ai'].includes(data.engine)) return false;
  if (data.revision !== undefined && (!Number.isInteger(data.revision) || data.revision < 0)) return false;
  if (data.updateOf !== undefined && (typeof data.updateOf !== 'string' || data.updateOf !== '' && !/^(skill|tool):\S+$/.test(data.updateOf))) return false;
  if (data.newResource !== undefined && typeof data.newResource !== 'boolean' || data.identityConfirmed !== undefined && typeof data.identityConfirmed !== 'boolean') return false;
  if (data.displayMetadata !== undefined) {
    const metadata = data.displayMetadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    for (const key of ['icon', 'iconUrl', 'iconBg', 'url', 'category'] as const) if (metadata[key] !== undefined && typeof metadata[key] !== 'string') return false;
    for (const key of ['tags', 'departments'] as const) if (metadata[key] !== undefined && (!Array.isArray(metadata[key]) || !metadata[key]!.every(item => typeof item === 'string'))) return false;
  }
  if (!isRuntimeRequirements(data.runtimeRequirements)) return false;
  if (
    !data.status ||
    !['ready', 'question', 'blocked'].includes(data.status) ||
    !data.kind ||
    !['agent', 'skill', 'tool'].includes(data.kind)
  )
    return false;
  if (
    !data.resource ||
    typeof data.resource.name !== 'string' ||
    typeof data.resource.description !== 'string' ||
    !Array.isArray(data.resource.functions)
  )
    return false;
  if (
    !data.resource.functions.every(
      (fn) =>
        fn &&
        typeof fn.name === 'string' &&
        ['package', 'registry'].includes(fn.source),
    )
  )
    return false;
  if (
    !Array.isArray(data.issues) ||
    !data.issues.every(
      (issue) =>
        issue &&
        typeof issue.code === 'string' &&
        typeof issue.message === 'string',
    ) ||
    typeof data.repairText !== 'string'
  )
    return false;
  if (
    data.status === 'question' &&
    (!data.question ||
      typeof data.question.id !== 'string' ||
      typeof data.question.prompt !== 'string' ||
      !Array.isArray(data.question.options) ||
      !data.question.options.length ||
      !data.question.options.every(
        (option) =>
          option &&
          typeof option.id === 'string' &&
          typeof option.label === 'string' &&
          typeof option.description === 'string',
      ))
  )
    return false;
  return true;
}

export const smartUpload = {
  async saveDraft(
    id: string,
    body: SmartDraftMetadata & { revision?: number },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; revision?: number; message?: string }> {
    const token = getToken();
    try {
      const response = await fetch(
        `/api/uploads/${encodeURIComponent(id)}/draft`,
        {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      return response.ok && data?.ok
        ? data
        : { ok: false, message: data?.message || '草稿保存失败，请重试' };
    } catch {
      return {
        ok: false,
        message: signal?.aborted ? '已取消保存' : '网络连接中断，请重试',
      };
    }
  },
  async analyze(
    id: string,
    body: AnalyzeRequest,
    signal?: AbortSignal,
  ): Promise<AnalyzeResponse> {
    const token = getToken();
    try {
      const response = await fetch(
        `/api/uploads/${encodeURIComponent(id)}/analyze`,
        {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      if (!response.ok || !data || data.ok === false || data.detail) {
        return {
          ok: false,
          message:
            typeof data?.message === 'string'
              ? data.message
              : '项目整理未完成，请重试',
        };
      }
      if (!isSmartAnalysis(data.analysis))
        return { ok: false, message: '整理结果格式异常，请重试' };
      return data;
    } catch (error) {
      if (signal?.aborted) return { ok: false, message: '已取消整理' };
      return {
        ok: false,
        message:
          error instanceof SyntaxError
            ? '服务返回异常，请重试'
            : '网络连接中断，请检查连接后重试',
      };
    }
  },
};
