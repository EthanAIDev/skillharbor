import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/hooks/useAuth';
import { api, setToken, getToken } from '../src/services/api';

function Probe() {
  const { session, booting } = useAuth();
  return <output>{booting ? '校验中' : session?.name || '未登录'}</output>;
}
function cachedSession() {
  setToken('test-session');
  localStorage.setItem('skillharbor-session', JSON.stringify({ username: 'tester', name: '测试员工', role: 'user', dept: '测试', loginAt: 1 }));
}

test.each([
  { ok: false, networkError: true, message: '网络连接中断' },
  { ok: false, status: 502, message: '服务暂时不可用' },
])('temporary session-check failure preserves the cached session', async (failure) => {
  cachedSession();
  vi.spyOn(api, 'me').mockResolvedValue(failure);
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByText('测试员工')).toBeTruthy());
  expect(getToken()).toBe('test-session');
});

test('an explicitly expired session clears the cached session and token', async () => {
  cachedSession();
  vi.spyOn(api, 'me').mockResolvedValue({ ok: false, unauthorized: true, status: 401 });
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText('未登录');
  expect(getToken()).toBe('');
});
