import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import DependencyIssues from '../src/pages/admin/DependencyIssues';
import DisableSkillDialog from '../src/pages/admin/DisableSkillDialog';
import * as governance from '../src/services/dependencyGovernance';
import { api } from '../src/services/api';

test('dependency issues show exact identifiers, filter statuses and open the affected resource', async () => {
  vi.spyOn(governance, 'loadDependencyIssues').mockResolvedValue({ readOnly: true, scanned: 2, errors: [], items: [
    { slug: 'report-agent', name: '报告智能体', kind: 'agent', version: '1.2.0', status: 'enabled', dependency: { id: 'd1', name: '写作', slug: 'writer-v2', required: true, status: 'missing' } },
    { slug: 'survey', name: '调查智能体', kind: 'agent', version: '2.0.0', status: 'enabled', dependency: { id: 'd2', name: '预审', required: false, status: 'planned' } },
  ] });
  const open = vi.fn(); render(<DependencyIssues onOpen={open} />);
  await screen.findByText('writer-v2');
  fireEvent.change(screen.getByLabelText('依赖状态'), { target: { value: 'missing' } });
  expect(screen.queryByText('调查智能体')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看报告智能体' }));
  expect(open).toHaveBeenCalledWith('report-agent');
});

test('an unavailable impact check cannot silently disable a skill', async () => {
  vi.spyOn(governance, 'loadDependents').mockRejectedValue(new Error('查询失败'));
  const disable = vi.spyOn(api.gateway, 'setStatus').mockResolvedValue({ ok: true });
  render(<DisableSkillDialog slug="writer" name="写作" onClose={vi.fn()} onDisabled={vi.fn()} />);
  await screen.findByText('查询失败');
  expect((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled).toBe(true);
  expect(disable).not.toHaveBeenCalled();
});

test('impact is displayed and requires a separate explicit confirmation', async () => {
  vi.spyOn(governance, 'loadDependents').mockResolvedValue({ readOnly: true, slug: 'writer', errors: [], items: [{ slug: 'parent', name: '父智能体', kind: 'agent', version: '1.0.0', status: 'enabled', dependencyId: 'd1', required: true, resolution: 'exact' }] });
  const disable = vi.spyOn(api.gateway, 'setStatus').mockResolvedValue({ ok: true });
  const done = vi.fn();
  render(<DisableSkillDialog slug="writer" name="写作" onClose={vi.fn()} onDisabled={done} />);
  await screen.findByText('父智能体'); expect(disable).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(disable).toHaveBeenCalledWith('writer', 'disabled'));
  expect(done).toHaveBeenCalled();
});

test('a partially failed dependency scan does not claim there is no impact', async () => {
  vi.spyOn(governance, 'loadDependents').mockResolvedValue({ readOnly: true, slug: 'writer', items: [], errors: [{ slug: 'broken', message: '损坏清单' }] });
  const disable = vi.spyOn(api.gateway, 'setStatus').mockResolvedValue({ ok: true });
  render(<DisableSkillDialog slug="writer" name="写作" onClose={vi.fn()} onDisabled={vi.fn()} />);
  await screen.findByText(/损坏清单/);
  expect((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled).toBe(true);
  expect(disable).not.toHaveBeenCalled();
});

test('a late impact response for an old resource cannot authorize a new one', async () => {
  let resolve!: (value: governance.DependentsReport) => void;
  const old = new Promise<governance.DependentsReport>(done => { resolve = done; });
  vi.spyOn(governance, 'loadDependents').mockReturnValueOnce(old).mockRejectedValueOnce(new Error('新资源检查失败'));
  const disable = vi.spyOn(api.gateway, 'setStatus').mockResolvedValue({ ok: true });
  const view = render(<DisableSkillDialog slug="old" name="旧资源" onClose={vi.fn()} onDisabled={vi.fn()} />);
  view.rerender(<DisableSkillDialog slug="new" name="新资源" onClose={vi.fn()} onDisabled={vi.fn()} />);
  await screen.findByText('新资源检查失败');
  await act(async () => resolve({ readOnly: true, slug: 'old', items: [], errors: [] }));
  expect((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/没有发现对此资源的引用/)).toBeNull();
  expect(disable).not.toHaveBeenCalled();
});

test('a failed scan can be retried before confirmation', async () => {
  vi.spyOn(governance, 'loadDependents').mockRejectedValueOnce(new Error('查询失败')).mockResolvedValueOnce({ readOnly: true, slug: 'writer', items: [], errors: [] });
  const disable = vi.spyOn(api.gateway, 'setStatus').mockResolvedValue({ ok: true });
  render(<DisableSkillDialog slug="writer" name="写作" onClose={vi.fn()} onDisabled={vi.fn()} />);
  await screen.findByText('查询失败');
  fireEvent.click(screen.getByRole('button', { name: '重试检查' }));
  await screen.findByText(/没有发现对此资源的引用/);
  expect((screen.getByRole('button', { name: '确认停用' }) as HTMLButtonElement).disabled).toBe(false);
  expect(disable).not.toHaveBeenCalled();
});

test('the report transport rejects HTTP failure even when the body looks like an empty report', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ readOnly: true, slug: 'writer', items: [], errors: [] }), { status: 503 }));
  await expect(governance.loadDependents('writer')).rejects.toThrow('HTTP 503');
});

test.each([
  { readOnly: true, slug: 'writer', items: [] },
  { readOnly: true, slug: 'other', items: [], errors: [] },
  { readOnly: true, slug: 'writer', items: [{ slug: 'parent' }], errors: [] },
  { readOnly: true, slug: 'writer', items: [], errors: [], warnings: 'incomplete' },
])('the report transport refuses an incomplete or mismatched report: %j', async report => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }));
  await expect(governance.loadDependents('writer')).rejects.toThrow('结果不完整');
});

test('dependency reports carry the current session and preserve exact identifiers', async () => {
  localStorage.setItem('skillharbor-token', 'test-session');
  const report: governance.DependencyIssuesReport = { readOnly: true, scanned: 1, errors: [], items: [{ slug: 'a', name: '智能体', kind: 'agent', version: '1.0.0', status: 'enabled', dependency: { id: 'b', name: '依赖', slug: 'writer-v2', status: 'missing', required: true } }] };
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(report), { status: 200 }));
  expect(await governance.loadDependencyIssues()).toEqual(report);
  expect(fetch).toHaveBeenCalledWith('/api/skill-gateway/api/skills/dependency-issues', expect.objectContaining({ headers: { Authorization: 'Bearer test-session' } }));
});
