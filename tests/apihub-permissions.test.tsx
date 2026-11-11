import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ApiHub from '../src/pages/ApiHub';
import { ah, type AhState } from '../src/services/api';

const auth = vi.hoisted(() => ({ session: { username: 'observer', role: 'user' } }));
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }));

const state: AhState = {
  ok: true, systems: {}, dynamics: [],
  interfaces: [{ id: 'fixture', sysId: 'example', method: 'GET', path: '/example', title: '权限测试接口', desc: '', auth: '',
    state: 'cloud', up: '127.0.0.1:9000', owner: 'owner', ownerName: '登记人', params: [], errs: [], callers: [], createdAt: 1, updatedAt: 1 }],
  channels: [{ ifId: 'fixture', port: 18000, up: '127.0.0.1:9000', reason: '', createdBy: 'creator', createdName: '开通人', createdAt: 1 }],
  stats: { systems: 1, total: 1, cloud: 1, ready: 0, lan: 0, channels: 1 },
};

test.each([
  ['admin', 'admin', true], ['owner', 'user', true], ['creator', 'user', true], ['observer', 'user', false],
])('channel actions for %s respect ownership while channel details stay visible', async (username, role, allowed) => {
  auth.session = { username, role };
  vi.spyOn(ah, 'state').mockResolvedValue(state);
  const disable = vi.spyOn(ah, 'disable').mockResolvedValue({ ok: true });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ApiHub />);
  fireEvent.click(await screen.findByText('我的接入'));
  expect(screen.getByText('127.0.0.1:18000')).toBeTruthy();
  if (!allowed) {
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    expect(disable).not.toHaveBeenCalled();
    return;
  }
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('云侧调用将立即中断'));
  await waitFor(() => expect(disable).toHaveBeenCalledWith('fixture'));
});

test('an owner can cancel the destructive action without changing the channel', async () => {
  auth.session = { username: 'owner', role: 'user' };
  vi.spyOn(ah, 'state').mockResolvedValue(state);
  const disable = vi.spyOn(ah, 'disable').mockResolvedValue({ ok: true });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ApiHub />);
  fireEvent.click(await screen.findByText('我的接入'));
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  expect(disable).not.toHaveBeenCalled();
  expect(screen.getByText('127.0.0.1:18000')).toBeTruthy();
});
