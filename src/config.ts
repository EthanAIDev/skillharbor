/**
 * Site configuration for optional upstream services.
 * Prefer environment-backed server proxies for secrets; these URLs are UI defaults only.
 */
export const ONE_API = {
  /** OpenAI-compatible gateway base (e.g. One-API). Override via your deployment. */
  baseUrl: 'http://127.0.0.1:3000/v1',
  /** Admin console URL for operators. */
  adminUrl: 'http://127.0.0.1:3000',
  /** Default daily quota (tokens) shown in the workbench. */
  dailyQuota: 100_000,
};

/** Optional knowledge-base web UI embedded in the workbench. */
export const KB = {
  url: 'http://127.0.0.1:8110/DocSystem',
};
