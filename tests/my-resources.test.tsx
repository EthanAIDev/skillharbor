import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import Workbench from '../src/pages/Workbench';
import { api, type UploadRow } from '../src/services/api';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: { username: 'tester', name: '测试员工', dept: '测试' } }) }));
vi.mock('../src/services/workbench', () => ({
  loadQuota: async () => null, loadAvailableModels: async () => [], submitRequest: vi.fn(),
  listMyRequests: async () => [], myTools: () => [], loadMyTools: async () => [],
  loadMySkills: async () => [], loadRecentUsage: async () => [], loadMyToolsStats: async () => null,
}));
vi.mock('../src/services/skillsGateway', () => ({ loadSkillDeptMap: async () => ({ map: {}, applicable: {} }) }));

const row = (id: string, status: UploadRow['status'], overrides: Partial<UploadRow> = {}): UploadRow => ({
  id, status, kind: 'skill', u: 'tester', n: '测试员工', d: '测试', name: id,
  createdAt: Date.UTC(2026, 9, 1), ...overrides,
});
const records: UploadRow[] = [
  row('智能体草稿', 'draft', { report: { verdict: 'ok', lines: [], entry: 'SKILL.md', warns: 0, structure: {
    schemaVersion: 1, slug: 'agent-a', version: '2.4.0', kind: 'agent', source: 'manifest', entry: 'SKILL.md',
    components: [], dependencies: [], steps: [], warnings: [],
  } } }),
  row('技能待审', 'pending'),
  row('技能驳回', 'rejected', { rejectReason: '请补充权限说明', updateOf: 'skill:previous', updateNote: '新增权限校验', updateVersion: '1.3.0' }),
  row('工具发布中', 'deploying', { kind: 'web' }),
  row('工具失败', 'deploy_failed', { kind: 'service', deployError: '入口探活超时' }),
  row('技能已上线', 'online', { publishSlug: 'live-skill', updateVersion: '1.0.0' }),
  row('工具已下线', 'offline', { kind: 'link' }),
];

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="当前位置">{location.pathname + location.search}</output><button onClick={() => navigate(-1)}>历史后退</button><button onClick={() => navigate(1)}>历史前进</button></>;
}
function renderWorkbench(entry = '/workbench?tab=resources') {
  return render(<MemoryRouter initialEntries={[entry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Workbench /><LocationProbe /></MemoryRouter>);
}
function resource(name: string) {
  return within(screen.getByRole('article', { name }));
}

beforeEach(() => {
  vi.spyOn(api.uploads, 'mine').mockResolvedValue({ ok: true, rows: records });
  vi.spyOn(api.uploads, 'myOnline').mockResolvedValue({ tools: [], skills: [{ slug: 'live-skill', name: '技能已上线', version: '2.0.0' }] });
});

test('lists every upload state and combines type, state and keyword filters', async () => {
  renderWorkbench();
  await screen.findByRole('article', { name: '智能体草稿' });
  expect(screen.getAllByRole('article')).toHaveLength(7);
  fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'agent' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(resource('智能体草稿').getByText('草稿')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'skill' } });
  fireEvent.change(screen.getByLabelText('资源状态'), { target: { value: 'rejected' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(resource('技能驳回').getByText('已驳回')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('搜索我的资源'), { target: { value: '新增权限' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('搜索我的资源'), { target: { value: '找不到' } });
  expect(screen.getByText('没有符合筛选条件的资源')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
  expect(screen.getAllByRole('article')).toHaveLength(7);
  fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'tool' } });
  expect(screen.getAllByRole('article')).toHaveLength(3);
});

test('shows reasons, create/update intent, manifest version and exact draft edit links', async () => {
  renderWorkbench();
  await screen.findByRole('article', { name: '智能体草稿' });
  expect(resource('工具失败').getByText('入口探活超时')).toBeTruthy();
  expect(resource('技能驳回').getByText('请补充权限说明')).toBeTruthy();
  expect(resource('技能驳回').getByText('更新')).toBeTruthy();
  expect(resource('智能体草稿').getByText('新建')).toBeTruthy();
  expect(resource('智能体草稿').getByText('2.4.0')).toBeTruthy();
  expect(resource('技能驳回').getByText('新增权限校验')).toBeTruthy();
  expect(resource('技能驳回').getByRole('link', { name: '继续编辑' }).getAttribute('href')).toBe('/?upload=1&uploadId=' + encodeURIComponent('技能驳回'));
  expect(resource('智能体草稿').getByRole('link', { name: '继续编辑' }).getAttribute('href')).toBe('/?upload=1&uploadId=' + encodeURIComponent('智能体草稿'));
  expect(screen.getAllByRole('link', { name: '继续编辑' })).toHaveLength(2);
  expect(screen.getByRole('link', { name: '发布资源' }).getAttribute('href')).toBe('/?upload=1');
  expect(screen.queryByRole('button', { name: /审批|回滚|停用/ })).toBeNull();
});

test('keeps submission versions separate from current online versions and does not merge same names', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [
    row('one', 'online', { name: '同名资源', publishSlug: 'one', updateVersion: '1.0.0' }),
    row('two', 'draft', { name: '同名资源' }),
  ] });
  vi.mocked(api.uploads.myOnline).mockResolvedValue({ tools: [], skills: [
    { slug: 'one', name: '同名资源', version: '3.1.0' },
    { slug: 'other', name: '同名资源', version: '4.0.0' },
  ] });
  renderWorkbench();
  await screen.findByText('3.1.0');
  expect(screen.getAllByRole('article', { name: '同名资源' })).toHaveLength(3);
  expect(screen.getByText('1.0.0')).toBeTruthy();
  expect(screen.getByText('4.0.0')).toBeTruthy();
  expect(screen.getAllByText('技能中心记录').length).toBeGreaterThan(0);
  expect(screen.getAllByText('类型待确认').length).toBeGreaterThan(0);
});

test('reports API failures and retries without presenting a false empty state', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValueOnce({ ok: false, message: '网络连接中断' });
  renderWorkbench();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('网络连接中断'));
  expect(screen.queryByText('还没有发布过资源')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
  expect(await screen.findByRole('article', { name: '技能待审' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('surfaces a rejected request and partial online-source failure', async () => {
  vi.mocked(api.uploads.myOnline).mockRejectedValue(new Error('技能中心连接超时'));
  renderWorkbench();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('技能中心连接超时'));
  expect(screen.getByRole('article', { name: '技能已上线' })).toBeTruthy();
  expect(screen.queryByText('2.0.0')).toBeNull();
});

test('waits for loading and shows an empty state only after both sources succeed', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.uploads.mine).mockReturnValue(new Promise(r => { resolve = r; }));
  vi.mocked(api.uploads.myOnline).mockResolvedValue({ tools: [], skills: [] });
  renderWorkbench();
  expect(within(screen.getByRole('region', { name: '我的资源' })).getByRole('status').textContent).toContain('正在加载我的资源');
  expect(screen.queryByText('还没有发布过资源')).toBeNull();
  await act(async () => resolve({ ok: true, rows: [] }));
  expect(await screen.findByText('还没有发布过资源')).toBeTruthy();
});

test('resource tabs use URL state and browser back/forward, retaining unrelated parameters', async () => {
  const view = renderWorkbench('/workbench?tab=resources&from=bookmark');
  await screen.findByRole('heading', { name: '我的资源' });
  fireEvent.click(screen.getByRole('button', { name: '我的技能' }));
  expect(screen.getByLabelText('当前位置').textContent).toBe('/workbench?tab=skills&from=bookmark');
  expect(screen.getByRole('heading', { name: '技能调用明细' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '历史后退' }));
  await screen.findByRole('heading', { name: '我的资源' });
  fireEvent.click(screen.getByRole('button', { name: '历史前进' }));
  expect(screen.getByRole('heading', { name: '技能调用明细' })).toBeTruthy();
  view.unmount();
  renderWorkbench('/workbench?tab=skills&from=bookmark');
  expect(screen.getByRole('heading', { name: '技能调用明细' })).toBeTruthy();
});

test('retains the token default and supports the legacy sec parameter', async () => {
  const view = renderWorkbench('/workbench');
  expect(await screen.findByRole('heading', { name: '接入指引' })).toBeTruthy();
  view.unmount();
  renderWorkbench('/workbench?sec=skills');
  expect(screen.getByRole('heading', { name: '技能调用明细' })).toBeTruthy();
});

test('refreshes publication progress while keeping the selected filters', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValueOnce({ ok: true, rows: [row('发布任务', 'deploying', { kind: 'web' })] })
    .mockResolvedValueOnce({ ok: true, rows: [row('发布任务', 'online', { kind: 'web' })] });
  vi.mocked(api.uploads.myOnline).mockResolvedValue({ skills: [], tools: [] });
  renderWorkbench();
  await screen.findByRole('article', { name: '发布任务' });
  fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'tool' } });
  expect(resource('发布任务').getByText('发布中')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByRole('article', { name: '发布任务' });
  expect(resource('发布任务').getByText('已上线')).toBeTruthy();
  expect((screen.getByLabelText('资源类型') as HTMLSelectElement).value).toBe('tool');
});

test('marks offline gateway data as a snapshot and avoids claiming an empty complete list', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [] });
  vi.mocked(api.uploads.myOnline).mockResolvedValue({ gatewayAvailable: false, skills: [], tools: [] });
  renderWorkbench();
  expect(await screen.findByText(/线上版本和直传资源可能不完整/)).toBeTruthy();
  expect(screen.queryByText('还没有发布过资源')).toBeNull();
  expect(screen.getByRole('button', { name: '重试同步' })).toBeTruthy();
});

test('does not present a snapshot version as a live online version', async () => {
  vi.mocked(api.uploads.myOnline).mockResolvedValue({ gatewayAvailable: false, tools: [], skills: [{ slug: 'live-skill', name: '技能已上线', version: '旧快照版本' }] });
  renderWorkbench();
  await screen.findByRole('article', { name: '技能已上线' });
  expect(resource('技能已上线').getByText('快照版本')).toBeTruthy();
  expect(resource('技能已上线').queryByText('线上版本')).toBeNull();
  expect(resource('技能已上线').getByText('上传快照（技能中心暂不可用）')).toBeTruthy();
  expect(resource('技能待审').getAllByText('—')).toHaveLength(3);
});

test('uses authoritative direct-upload kind and ignores unresolved pending duplicates', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [row('no-slug', 'online', { name: '待上架' })] });
  vi.mocked(api.uploads.myOnline).mockResolvedValue({ gatewayAvailable: true, tools: [], skills: [
    { id: 'no-slug', slug: '', name: '待上架', pendingPublish: true },
    { slug: 'direct-agent', name: '直传智能体', kind: 'agent', status: 'enabled', version: '5.0.0' },
  ] });
  renderWorkbench();
  await screen.findByRole('article', { name: '直传智能体' });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('资源类型'), { target: { value: 'agent' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(resource('直传智能体').getByText('技能中心实时')).toBeTruthy();
});
