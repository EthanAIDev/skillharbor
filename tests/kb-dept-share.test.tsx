import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import KbExplorer from '../src/pages/KbExplorer';

/* 部门库「共享可见部门（只读）」前端行为（2026-11-03）：
 * admin 勾选/保存共享部门；库维护员只读展示；被共享部门看到「共享」徽标与只读提示且无写入口。 */

type Json = any;
function json(body: Json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function mockFetch(routes: { repos: Json; perm: Json; config: Json; posted: Json[]; depts?: string[] }) {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('/api/kb/repos')) return json(routes.repos);
    if (url.includes('/api/kb/stats')) return json({ ok: true, total: 0, byRepo: [] });
    if (url.includes('/api/kb/perm')) return json(routes.perm);
    if (url.includes('/api/kb/list')) return json({ ok: true, entries: [] });
    if (url.includes('/api/kb/people')) {
      return json({ ok: true, groups: [], depts: routes.depts || ['政技部', '咨询所', '研究院'] });
    }
    if (url.includes('/api/kb/repo-config')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        routes.posted.push(body);
        return json({ ok: true, maintainers: [], readDepts: body.readDepts || [] });
      }
      return json(routes.config);
    }
    return json({ ok: false, message: 'unexpected ' + url }, 404);
  }));
}

const deptRepo = (overrides: Json = {}) => ({
  id: 14, name: '政技部知识库', tier: 'dept', readShared: false,
  canWrite: true, canManage: true, canDownload: true, ...overrides,
});
const deptConfig = (overrides: Json = {}) => ({
  ok: true, tier: 'dept', dept: '政技部', owner: '', maintainers: [], readDepts: ['咨询所'],
  allowDownload: true, isAdmin: true, name: '政技部知识库', ...overrides,
});

test('admin picks extra departments and saves the read-only share list', async () => {
  const posted: Json[] = [];
  mockFetch({
    repos: { ok: true, v2: true, repos: [deptRepo()] },
    perm: { ok: true, canWrite: true, tier: 'dept', readShared: false, canManage: true, canDownload: true },
    config: deptConfig(),
    posted,
  });
  render(<KbExplorer meName="测试员工" />);
  await screen.findByText('政技部知识库');
  fireEvent.click(screen.getByRole('button', { name: '权限' }));
  await screen.findByText('共享可见部门（只读）');
  expect(screen.getByText(/保存后：0 名维护人员可上传管理/).textContent).toContain('咨询所只读可见');
  expect(screen.getByRole('button', { name: /咨询所/ }).textContent).toContain('✓');
  fireEvent.click(screen.getByRole('button', { name: '研究院' }));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0].readDepts).toEqual(['咨询所', '研究院']);
});

test('non-admin maintainer sees the share list as read-only and cannot change it', async () => {
  const posted: Json[] = [];
  mockFetch({
    repos: { ok: true, v2: true, repos: [deptRepo()] },
    perm: { ok: true, canWrite: true, tier: 'dept', readShared: false, canManage: true, canDownload: true },
    config: deptConfig({ isAdmin: false }),
    posted,
  });
  render(<KbExplorer meName="测试员工" />);
  await screen.findByText('政技部知识库');
  fireEvent.click(screen.getByRole('button', { name: '权限' }));
  await screen.findByText('共享可见部门（只读）');
  expect(screen.getByText(/咨询所（只读）/)).toBeTruthy();
  expect(screen.getByText(/仅管理员可设置/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '研究院' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect('readDepts' in posted[0]).toBe(false);
});

test('a shared department sees the share badge and a read-only library without write controls', async () => {
  mockFetch({
    repos: { ok: true, v2: true, repos: [deptRepo({ readShared: true, canWrite: false, canManage: false })] },
    perm: { ok: true, canWrite: false, tier: 'dept', readShared: true, canManage: false, canDownload: true },
    config: deptConfig(),
    posted: [],
  });
  render(<KbExplorer meName="测试员工" />);
  await screen.findByText('政技部知识库');
  expect(screen.getByText('共享')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '权限' })).toBeNull();
  fireEvent.click(screen.getByText('政技部知识库'));
  await screen.findByText(/跨部门共享库 · 只读/);
  expect(screen.getByText(/该库由其他部门共享/)).toBeTruthy();
  expect(screen.queryByText('上传文件')).toBeNull();
});
