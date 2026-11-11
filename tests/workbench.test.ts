import { expect, test, vi } from 'vitest';
import { loadAdminStats } from '../src/services/workbench';

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const tokens = Array.from({ length: 10 }, (_, i) => ({ name: `员工${i}`, status: 1, daily_used_tokens: 1 }));

test('admin statistics include token and log records beyond the former 510-row cutoff', async () => {
  const now = Math.floor(Date.now() / 1000);
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    const page = Number(url.searchParams.get('p'));
    const isToken = url.pathname.endsWith('/token/');
    const rows = Array.from({ length: 621 }, (_, id) => isToken
      ? { id, name: `员工${id}`, status: 1, daily_used_tokens: 2 }
      : { id, token_name: `员工${id}`, model_name: 'test', prompt_tokens: 1, completion_tokens: 1, created_at: now });
    return json(rows.slice(page * 10, (page + 1) * 10));
  });

  const result = await loadAdminStats([{ username: 'last', name: '员工620', deptShort: '末页部门' }]);
  expect(result.todayTotal).toBe(1242);
  expect(result.withToken).toBe(1);
  expect(result.byDept).toEqual([{ dept: '末页部门', used: 2, pct: 0 }]);
  expect(result.trend[13]).toBe(1242);
  expect(result.byModel).toEqual([{ model: 'test', used: 1242, pct: 100 }]);
});

test('admin statistics use supported larger pages without scanning past the advertised total', async () => {
  let requests = 0;
  vi.mocked(fetch).mockImplementation(async (input) => {
    requests++;
    const url = new URL(String(input), 'http://localhost');
    const page = Number(url.searchParams.get('p'));
    const size = Number(url.searchParams.get('size')) || 10;
    const isToken = url.pathname.endsWith('/token/');
    const rows = Array.from({ length: 621 }, (_, id) => isToken
      ? { id, name: `员工${id}`, status: 1, daily_used_tokens: 2 }
      : { id, model_name: 'test', prompt_tokens: 1, completion_tokens: 1, created_at: Math.floor(Date.now() / 1000) });
    return new Response(JSON.stringify({ success: true, data: rows.slice(page * size, (page + 1) * size), total: 621 }));
  });
  const result = await loadAdminStats([]);
  expect(result.todayTotal).toBe(1242);
  expect(result.trend[13]).toBe(1242);
  expect(requests).toBeLessThanOrEqual(14);
});

test('admin statistics reject overlapping pages instead of counting the same record twice', async () => {
  const rows = tokens.map((token, id) => ({ ...token, id }));
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    return json(url.pathname.endsWith('/token/') && Number(url.searchParams.get('p')) <= 1 ? rows : []);
  });
  await expect(loadAdminStats([])).rejects.toThrow(/统计数据.*重试/);
});

test('admin statistics time out a stalled request without returning partial data', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const result = expect(loadAdminStats([])).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
  } finally { vi.useRealTimers(); }
});

test.each(['missing rows', 'changed total', 'invalid response'])('admin statistics reject %s rather than treating it as an empty result', async (fault) => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const page = Number(new URL(String(input), 'http://localhost').searchParams.get('p'));
    if (fault === 'invalid response') return json({ message: 'missing data' });
    return new Response(JSON.stringify({ data: page === 0 ? Array.from({ length: 100 }, (_, id) => ({ id, daily_used_tokens: 1 })) : [],
      total: fault === 'changed total' && page > 0 ? 100 : 101 }));
  });
  await expect(loadAdminStats([])).rejects.toThrow(/统计数据.*重试/);
});

test('an already cancelled statistics query makes no upstream request', async () => {
  const controller = new AbortController(); controller.abort(new Error('left dashboard'));
  await expect(loadAdminStats([], controller.signal)).rejects.toThrow('left dashboard');
  expect(fetch).not.toHaveBeenCalled();
});

test('admin statistics reject a failed required token page instead of returning partial totals', async () => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/one-api/api/token/') {
      const page = Number(url.searchParams.get('p'));
      if (page === 0) return json(tokens);
      if (page === 1) return json({}, 503);
    }
    return json([]);
  });

  await expect(loadAdminStats([])).rejects.toThrow('proxy 503');
});

test.each(['token', 'log'])('admin statistics reject a network failure on a required %s page before a later short page', async (kind) => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== `/api/one-api/api/${kind}/`) return json([]);
    const page = Number(url.searchParams.get('p'));
    if (page <= 1) return json(kind === 'token' ? tokens : Array.from({ length: 10 }, () => ({ token_name: '员工', model_name: 'test', prompt_tokens: 1, completion_tokens: 1, created_at: Math.floor(Date.now() / 1000) })));
    if (page === 2) throw new TypeError('page connection lost');
    return json([]);
  });

  await expect(loadAdminStats([])).rejects.toThrow('page connection lost');
});

test.each([
  { kind: 'token', finalSize: 0, expected: 10 },
  { kind: 'token', finalSize: 3, expected: 13 },
  { kind: 'log', finalSize: 0, expected: 20 },
  { kind: 'log', finalSize: 3, expected: 26 },
])('admin statistics retain a real $finalSize-row terminal $kind page despite failed prefetches', async ({ kind, finalSize, expected }) => {
  let finishTerminal!: (response: Response) => void;
  const terminal = new Promise<Response>((resolve) => { finishTerminal = resolve; });
  const rows = kind === 'token' ? tokens : Array.from({ length: 10 }, () => ({ token_name: '员工', model_name: 'test', prompt_tokens: 1, completion_tokens: 1, created_at: Math.floor(Date.now() / 1000) }));
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== `/api/one-api/api/${kind}/`) return json([]);
    const page = Number(url.searchParams.get('p'));
    if (page === 0) return json(rows);
    if (page === 1) return terminal;
    // Resolve the earlier terminal page only after a later prefetch has failed.
    queueMicrotask(() => finishTerminal(json(rows.slice(0, finalSize))));
    throw new TypeError('irrelevant prefetch failed');
  });

  const result = await loadAdminStats([]);
  if (kind === 'token') expect(result.todayTotal).toBe(expected);
  else expect(result.byModel).toEqual([{ model: 'test', used: expected, pct: 0 }]);
});
