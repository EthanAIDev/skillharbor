import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import OpsDashboard from '../src/pages/admin/OpsDashboard';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('an incomplete stats query hides charts and can be retried without losing the dashboard', async () => {
  let failing = true;
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/admin/users') return response({ ok: true, users: [{ username: 'alice', name: 'Alice', dept: '研发' }] });
    if (url.includes('/api/token/')) return failing ? response({}, 503) : response({ data: [{ name: 'Alice', daily_used_tokens: 42 }] });
    if (url.includes('/api/log/')) return response({ data: [{ model_name: 'test', created_at: Math.floor(Date.now() / 1000), prompt_tokens: 40, completion_tokens: 2 }] });
    return response({ ok: true, rows: [] });
  });
  const view = render(<MemoryRouter><OpsDashboard /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('统计未完成');
  expect(view.container.querySelector('[title="0"]')).toBeNull();
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: '重试统计' }));
  await screen.findByText('今日 42 tokens');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('leaving the dashboard aborts unfinished statistics requests', async () => {
  let querySignal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === '/api/admin/users') return response({ ok: true, users: [{ username: 'alice', name: 'Alice', dept: '研发' }] });
    if (String(input).includes('/api/token/')) {
      querySignal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => querySignal?.addEventListener('abort', () => reject(querySignal?.reason), { once: true }));
    }
    return response({ ok: true, rows: [] });
  });
  const view = render(<MemoryRouter><OpsDashboard /></MemoryRouter>);
  await waitFor(() => expect(querySignal).toBeDefined());
  view.unmount();
  expect(querySignal?.aborted).toBe(true);
});

test('a failed staff list is reported instead of leaving statistics loading forever', async () => {
  vi.mocked(fetch).mockImplementation(async (input) => String(input) === '/api/admin/users'
    ? response({ ok: false }, 503) : response({ ok: true, rows: [] }));
  render(<MemoryRouter><OpsDashboard /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('统计未完成');
  expect(screen.getByRole('button', { name: '重试统计' })).toBeTruthy();
});

test('a stalled staff list reaches the same deadline and exposes retry', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/admin/users'
      ? new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
      : response({ ok: true, rows: [] }));
    render(<MemoryRouter><OpsDashboard /></MemoryRouter>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('alert').textContent).toContain('统计未完成');
    expect(screen.getByRole('button', { name: '重试统计' })).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

test('leaving during the staff query cancels it and never starts One-API requests', async () => {
  let staffSignal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === '/api/admin/users') {
      staffSignal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => staffSignal?.addEventListener('abort', () => reject(staffSignal?.reason), { once: true }));
    }
    return response({ ok: true, rows: [] });
  });
  const view = render(<MemoryRouter><OpsDashboard /></MemoryRouter>);
  view.unmount();
  expect(staffSignal?.aborted).toBe(true);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/one-api/'))).toBe(false);
});
