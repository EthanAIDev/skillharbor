import { expect, test, vi } from 'vitest';
import { api } from '../src/services/api';

test('network interruption returns a retryable failure instead of rejecting', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(api.uploads.submit('draft', { name: 'Test', desc: '', icon: 'T' })).resolves.toMatchObject({ ok: false, networkError: true });
});

test.each([403, 502])('HTTP %i cannot look successful even if its body says ok', async (status) => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, message: 'rejected' }), { status }));
  expect(await api.gateway.setStatus('example', 'disabled')).toMatchObject({ ok: false, status, message: 'rejected' });
});

test('gateway validation details become a usable failure while preserving details', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ detail: 'bad version' }), { status: 422 }));
  expect(await api.gateway.rollback('example', 'bad')).toMatchObject({ ok: false, message: 'bad version', detail: 'bad version' });
});

test('successful array responses keep the gateway contract', async () => {
  const rows = [{ slug: 'example' }];
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(rows)));
  expect(await api.gateway.skills()).toEqual(rows);
});

test('expired sessions retain the unauthorized marker', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ message: '请先登录' }), { status: 401 }));
  expect(await api.me()).toMatchObject({ ok: false, unauthorized: true });
});
