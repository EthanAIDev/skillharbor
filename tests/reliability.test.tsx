import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import EvalSection from '../src/components/EvalSection';
import UploadModal, { LegacyUploadModal } from '../src/components/UploadModal';
import SkillsManage from '../src/pages/admin/SkillsManage';
import { api } from '../src/services/api';
import * as governance from '../src/services/dependencyGovernance';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: { username: 'tester', name: '测试员工', role: 'admin', dept: '测试' }, expire: vi.fn() }) }));
const wrap = (node: React.ReactNode) => <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const emptyEval = { ok: true, summary: { total: 0, up: 0, down: 0, excluded: 0, rate: null }, recent: [], mine: null };

beforeEach(() => {
  vi.spyOn(api.meta, 'departments').mockResolvedValue({ ok: true, departments: ['测试'] });
  vi.spyOn(api.uploads, 'mine').mockResolvedValue({ ok: true, rows: [] });
  vi.spyOn(api.uploads, 'myOnline').mockResolvedValue({ tools: [], skills: [] });
});

test.each(['recent', 'all'])('the %s evaluation list uses the server mine marker after usernames are redacted', async (source) => {
  const items = [
    { id: 'mine', n: '甲本人', d: '测试', c: '本人评价', t: 1, v: 1, flag: 'ok', mine: true },
    { id: 'other', n: '乙他人', d: '测试', c: '他人评价', t: 2, v: 1, flag: 'ok', mine: false, u: 'tester' },
  ];
  vi.spyOn(api.evals, 'get').mockResolvedValue({ ...emptyEval, summary: { ...emptyEval.summary, total: 2 }, recent: source === 'recent' ? items : [] });
  vi.spyOn(api.evals, 'all').mockResolvedValue({ ok: true, items });
  render(wrap(<EvalSection target="skill:example" targetName="示例" />));
  if (source === 'all') fireEvent.click(await screen.findByRole('button', { name: /查看全部/ }));
  const ownAvatar = await screen.findByText('甲');
  expect(ownAvatar.classList.contains('bg-accent')).toBe(true);
  expect(screen.getByText('乙').classList.contains('bg-accent')).toBe(false);
});

test('switching skill clears the previous review and expanded list immediately', async () => {
  const slowChild = deferred<any>();
  vi.spyOn(api.evals, 'get').mockResolvedValueOnce({ ...emptyEval, summary: { ...emptyEval.summary, total: 1 }, mine: { v: 1, c: '父技能评价' } }).mockReturnValueOnce(slowChild.promise);
  vi.spyOn(api.evals, 'all').mockResolvedValue({ ok: true, items: [{ id: 'one', n: '父技能用户', c: '旧列表', t: 1, v: 1 }] });
  const view = render(wrap(<EvalSection target="skill:parent" targetName="父" />));
  await screen.findByDisplayValue('父技能评价');
  fireEvent.click(screen.getByText(/查看全部/));
  await screen.findByText('旧列表');
  view.rerender(wrap(<EvalSection target="skill:child" targetName="子" />));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  expect(screen.queryByText('已评价')).toBeNull();
  expect(screen.queryByText('旧列表')).toBeNull();
  expect(screen.queryByText('收起')).toBeNull();
  await act(async () => slowChild.resolve(emptyEval));
});

test('a slow response for the old skill cannot overwrite the new skill', async () => {
  const old = deferred<any>();
  vi.spyOn(api.evals, 'get').mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...emptyEval, mine: { v: 1, c: '新技能评价' } });
  const view = render(wrap(<EvalSection target="skill:old" targetName="旧" />));
  view.rerender(wrap(<EvalSection target="skill:new" targetName="新" />));
  await screen.findByDisplayValue('新技能评价');
  await act(async () => old.resolve({ ...emptyEval, mine: { v: -1, c: '迟到的旧评价' } }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('新技能评价');
});

test('records entry opens upload history directly', async () => {
  render(wrap(<UploadModal onClose={() => {}} initialMode="records" />));
  expect(screen.queryByRole('heading', { name: '上传新工具' })).toBeNull();
  expect(screen.getByRole('heading', { name: '上传记录' })).toBeTruthy();
  await screen.findByText(/还没有上传记录|暂无上传记录/);
});

test('replacing the main file removes previews belonging to the old upload session', async () => {
  vi.spyOn(api.uploads, 'parse').mockResolvedValue({ ok: true, id: 'draft-a', detected: 'web', report: { verdict: 'ok', lines: [], entry: 'index.html' } });
  vi.spyOn(api.uploads, 'material').mockResolvedValue({ ok: true });
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  render(wrap(<LegacyUploadModal onClose={() => {}} />));
  fireEvent.change(document.querySelector('input[accept=".zip,.html,.md"]')!, { target: { files: [new File(['html'], 'main.html')] } });
  await screen.findByText('解析成功：main.html');
  fireEvent.change(document.querySelector('input[accept=".jpg,.jpeg,.png,.webp"]')!, { target: { files: [new File(['image'], 'cover.png')] } });
  await screen.findByText('封面');
  fireEvent.change(document.querySelector('input[accept=".pdf,.doc,.docx,.zip"]')!, { target: { files: [new File(['doc'], '说明.pdf')] } });
  await screen.findByText('说明.pdf');
  fireEvent.click(screen.getByText('重新上传'));
  expect(screen.queryByText('封面')).toBeNull();
  expect(screen.queryByText('说明.pdf')).toBeNull();
});

test('a rejected gateway operation reports failure and preserves the row', async () => {
  vi.spyOn(api.gateway, 'health').mockResolvedValue({ ok: true, auth_mode: '', mcp_port: 8765, mcp_alive: true });
  vi.spyOn(api.gateway, 'skills').mockResolvedValue([{ slug: 'example', name: '示例技能', status: 'enabled' }]);
  vi.spyOn(api.gateway, 'overview').mockResolvedValue({});
  vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  vi.spyOn(api.skillDepartments, 'all').mockResolvedValue({ ok: true, map: {} });
  vi.spyOn(api.gateway, 'setStatus').mockResolvedValue({ ok: false, message: '网关不可达' });
  vi.spyOn(governance, 'loadDependents').mockResolvedValue({ readOnly: true, slug: 'example', items: [], errors: [] });
  render(<SkillsManage tab="skills" onTab={() => {}} onAlertsChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '停用' }));
  await screen.findByText('当前已检查的资源中，没有发现对此资源的引用。');
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(screen.getByText(/操作失败.*网关不可达/)).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByRole('button', { name: '停用' })).toBeTruthy();
  expect(screen.queryByText(/已停用「/)).toBeNull();
});

test('failed direct upload shows the error inside the open dialog and keeps the file for retry', async () => {
  vi.spyOn(api.gateway, 'health').mockResolvedValue({ ok: true, auth_mode: '', mcp_port: 8765, mcp_alive: true });
  vi.spyOn(api.gateway, 'skills').mockResolvedValue([]);
  vi.spyOn(api.gateway, 'overview').mockResolvedValue({});
  vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  vi.spyOn(api.skillDepartments, 'all').mockResolvedValue({ ok: true, map: {} });
  vi.spyOn(api.gateway, 'inspectSkill').mockResolvedValue({ errors: [], structure: {
    schemaVersion: 1, slug: 'example', version: 'v1.0.0', kind: 'skill', source: 'legacy', entry: 'SKILL.md', components: [], dependencies: [], steps: [], warnings: [],
  } });
  vi.spyOn(api.gateway, 'uploadSkill').mockResolvedValue({ ok: false, message: '网关不可达' });
  render(<SkillsManage tab="skills" onTab={() => {}} onAlertsChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /上传技能包/ }));
  const dialog = screen.getByRole('dialog', { name: '上传技能包' });
  fireEvent.change(dialog.querySelector('input[type="file"]')!, { target: { files: [new File(['zip'], 'example.zip')] } });
  await within(dialog).findByRole('region', { name: '上传包结构预览' });
  fireEvent.click(within(dialog).getByRole('button', { name: '上传', exact: true }));
  await waitFor(() => expect(within(dialog).getByText(/上传失败.*网关不可达/)).toBeTruthy());
  expect(within(dialog).getByText('example.zip')).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: '上传', exact: true }) as HTMLButtonElement).disabled).toBe(false);
});

test('a dropped submit connection restores the submit button and preserves entered data', async () => {
  vi.spyOn(api.uploads, 'parse').mockResolvedValue({ ok: true, id: 'draft-a', detected: 'web', report: { verdict: 'ok', lines: [], entry: 'index.html' } });
  vi.spyOn(api.uploads, 'submit').mockRejectedValue(new TypeError('Failed to fetch'));
  render(wrap(<LegacyUploadModal onClose={() => {}} />));
  fireEvent.change(document.querySelector('input[accept=".zip,.html,.md"]')!, { target: { files: [new File(['html'], 'main.html')] } });
  await screen.findByText('解析成功：main.html');
  fireEvent.change(screen.getByPlaceholderText('例如：站点选址评分工具'), { target: { value: '测试工具' } });
  fireEvent.change(screen.getByPlaceholderText('自定义标签，回车添加'), { target: { value: '测试' } });
  fireEvent.click(screen.getByRole('button', { name: '添加', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '提交审核 →' }));
  await screen.findByText('提交连接中断，请重试');
  expect((screen.getByRole('button', { name: '提交审核 →' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByDisplayValue('测试工具')).toBeTruthy();
});

test('skill management filters agents separately while preserving legacy skills', async () => {
  vi.spyOn(api.gateway, 'health').mockResolvedValue({ ok: true, auth_mode: '', mcp_port: 8765, mcp_alive: true });
  vi.spyOn(api.gateway, 'skills').mockResolvedValue([
    { slug: 'workflow', name: '流程编排', kind: 'agent', status: 'enabled' },
    { slug: 'legacy', name: '传统技能', status: 'enabled' },
    { slug: 'writer', name: '写作技能', kind: 'skill', status: 'disabled' },
  ]);
  vi.spyOn(api.gateway, 'overview').mockResolvedValue({});
  vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  vi.spyOn(api.skillDepartments, 'all').mockResolvedValue({ ok: true, map: {} });
  render(<SkillsManage tab="skills" onTab={() => {}} onAlertsChange={() => {}} />);
  await screen.findByText('流程编排');
  fireEvent.click(screen.getByRole('button', { name: /^智能体/ }));
  expect(screen.queryByText('传统技能')).toBeNull();
  expect(screen.getByText('流程编排')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^AI 技能/ }));
  expect(screen.queryByText('流程编排')).toBeNull();
  expect(screen.getByText('传统技能')).toBeTruthy();
  expect(screen.getByText('写作技能')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^启用中/ }));
  expect(screen.queryByText('写作技能')).toBeNull();
  expect(screen.getByText('传统技能')).toBeTruthy();
});
