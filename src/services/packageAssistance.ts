import type { AgentGraph } from './agentStructure';

export type ResourceType = 'agent' | 'skill' | 'tool';
export interface ManifestComponent {
  id: string; name?: string; kind: 'skill' | 'script'; path: string; visibility?: 'internal' | 'public';
  [key: string]: unknown;
}
export interface ManifestDependency {
  id: string; name?: string; source: 'registry'; slug?: string; required?: boolean; status?: string;
  [key: string]: unknown;
}
export interface AgentManifest {
  schemaVersion: number; id: string; kind: 'agent' | 'skill'; version: string; entry: string;
  components?: ManifestComponent[]; dependencies?: ManifestDependency[];
  steps?: unknown[];
  runtimeRequirements?: string[];
  [key: string]: unknown;
}
export interface PackageAssistance {
  root: string;
  revision?: number;
  manifestPath?: string;
  candidates: { path: string; name: string }[];
  files: { path: string; kind: 'skill' | 'script' | 'file' }[];
  manifest: AgentManifest | null;
  manifestYaml: string | null;
  inspection: { structure?: AgentGraph | null; errors?: string[]; warnings?: string[]; [key: string]: unknown } | null;
  errors: string[]; warnings: string[]; needsSelection: boolean;
}
export interface UploadReport {
  verdict: 'ok' | 'warn' | 'fail'; lines: string[]; entry: string | null; warns?: number;
  structure?: AgentGraph; assistance?: PackageAssistance;
  rules?: { id: string; level: 'error' | 'warn'; msg: string; fix?: string }[];
}
export interface PreparePackageRequest {
  entry?: string; manifest?: AgentManifest; updateOf?: string; apply?: boolean; revision?: number; regenerate?: boolean;
}
export interface PreparePackageResponse {
  ok: boolean; message?: string; assistance?: PackageAssistance; id?: string; report?: UploadReport; parsedNames?: string[];
}
