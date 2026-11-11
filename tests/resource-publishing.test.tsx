import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import UploadModal from '../src/components/UploadModal';
import { api } from '../src/services/api';
import { smartUpload, type SmartAnalysis } from '../src/services/smartUpload';
import type { UploadReport } from '../src/services/packageAssistance';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: { username: 'tester', name: '测试员工', role: 'user', dept: '测试' } }) }));
const ready: SmartAnalysis = { status: 'ready', kind: 'agent', engine: 'ai', resource: { name: '项目助理', description: '整理项目资料并输出报告', functions: [{ name: '生成报告', source: 'package' }] }, runtimeRequirements: ['文件读取工具'], issues: [], repairText: '', revision: 1, newResource: true };
const report: UploadReport = { verdict: 'ok', entry: 'SKILL.md', lines: [], structure: { schemaVersion: 1, slug: 'project-helper', version: '1.0.0', kind: 'agent', source: 'manifest', entry: 'SKILL.md', warnings: [], components: [], dependencies: [], steps: [] } };
const row = { id: 'draftx', u: 'tester', n: '测试员工', d: '测试', kind: 'skill' as const, status: 'draft' as const, filename: 'project.zip', createdAt: 1, sourceAvailable: true, report };
function LocationProbe() { return <output data-testid="location">{useLocation().search}</output>; }
function UrlForm() {
  const params = new URLSearchParams(useLocation().search);
  return <UploadModal initialUploadId={params.get('uploadId') || undefined} initialMode={params.get('upload') === 'records' ? 'records' : 'wizard'} onClose={vi.fn()} />;
}
function mount(props = {}, entry = '/?upload=1') {
  return render(<MemoryRouter initialEntries={[entry]}><LocationProbe /><UploadModal onClose={vi.fn()} {...props} /></MemoryRouter>);
}
const upload = () => fireEvent.change(screen.getByLabelText('主文件'), { target: { files: [new File(['synthetic project'], 'project.zip')] } });
beforeEach(() => {
  vi.spyOn(api.meta, 'departments').mockResolvedValue({ ok: true, departments: ['测试'] });
  vi.spyOn(api.uploads, 'mine').mockResolvedValue({ ok: true, rows: [] });
  vi.spyOn(api.uploads, 'myOnline').mockResolvedValue({ tools: [], skills: [] });
  vi.spyOn(api.uploads, 'parse').mockResolvedValue({ ok: true, id: row.id, detected: 'skill', report, revision: 0 });
  vi.spyOn(api.uploads, 'submit').mockResolvedValue({ ok: true });
  vi.spyOn(smartUpload, 'analyze').mockResolvedValue({ ok: true, id: row.id, analysis: ready, report, revision: 1 });
  vi.spyOn(smartUpload, 'saveDraft').mockResolvedValue({ ok: true, revision: 1 });
});

test('publish opens the full form directly with one title and no smart or advanced entry switch', () => {
  mount();
  expect(screen.getByRole('dialog', { name: '发布资源' })).toBeTruthy();
  expect(screen.getByRole('group', { name: '资源类型' })).toBeTruthy();
  expect(screen.getByLabelText('主文件')).toBeTruthy();
  expect(screen.queryByText('高级发布与结构维护')).toBeNull();
  expect(screen.queryByText('维护结构、发布方式和展示材料')).toBeNull();
  expect(screen.queryByRole('button', { name: /高级发布|返回智能上传/ })).toBeNull();
});

test('a file is detected without a forced category and analyzed in the full form before review', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: /^智能体/ }));
  upload();
  await screen.findByDisplayValue('项目助理');
  expect(api.uploads.parse).toHaveBeenCalledWith(expect.any(File), 'auto');
  expect(smartUpload.analyze).toHaveBeenCalledWith(row.id, { revision: 0 }, expect.any(AbortSignal));
  expect(screen.getByText('生成报告')).toBeTruthy();
  expect(screen.getByRole('region', { name: '运行环境要求' }).textContent).toContain('文件读取工具');
  fireEvent.click(screen.getByRole('button', { name: '业务提效', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '提交审核 →' }));
  await screen.findByText('已提交，等待管理员审核');
  expect(api.uploads.submit).toHaveBeenCalledWith(row.id, expect.objectContaining({ name: ready.resource.name, desc: ready.resource.description, revision: 1 }));
});

test('a category mismatch names the selected and detected types and displays the actual type', async () => {
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: true, analysis: { ...ready, kind: 'skill' }, report: { ...report, structure: { ...report.structure!, kind: 'skill' } }, revision: 1 });
  mount();
  fireEvent.click(screen.getByRole('button', { name: /^智能体/ }));
  upload();
  const warning = await screen.findByRole('alert');
  expect(warning.textContent).toMatch(/分类不一致/);
  expect(warning.textContent).toContain('智能体');
  expect(warning.textContent).toContain('AI 技能');
  const types = within(screen.getByRole('group', { name: '资源类型' }));
  expect(types.getByRole('button', { name: /^AI 技能/ }).getAttribute('aria-pressed')).toBe('true');
});

test('an analysis failure blocks submission and retries with the synchronized revision while preserving manual text', async () => {
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: false, message: '解析服务暂不可用' })
    .mockResolvedValueOnce({ ok: true, analysis: { ...ready, revision: 3 }, report, revision: 3 });
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [{ ...row, packageRevision: 2 }] });
  mount();
  fireEvent.change(screen.getByLabelText('资源名称'), { target: { value: '我填写的名称' } });
  upload();
  await screen.findByText('解析服务暂不可用');
  expect((screen.getByRole('button', { name: '提交审核 →' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '重新解析' }));
  await screen.findByText('生成报告');
  expect((screen.getByLabelText('资源名称') as HTMLInputElement).value).toBe('我填写的名称');
  expect(vi.mocked(smartUpload.analyze).mock.calls.at(-1)?.[1]).toMatchObject({ revision: 2 });
});

test('reupload cancels old analysis and a late result cannot repopulate the new form', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(smartUpload.analyze).mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
  mount();
  upload();
  await waitFor(() => expect(smartUpload.analyze).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: '重新上传' }));
  await act(async () => resolve({ ok: true, analysis: ready, report, revision: 1 }));
  expect(screen.queryByDisplayValue('项目助理')).toBeNull();
  expect(screen.getByLabelText('主文件')).toBeTruthy();
  expect(screen.getByTestId('location').textContent).not.toContain('uploadId=');
});

test('saving a draft uses the current analysis revision and preserves display metadata', async () => {
  mount(); upload();
  await screen.findByDisplayValue('项目助理');
  fireEvent.change(screen.getByLabelText('项目描述'), { target: { value: '我补充的用途' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await screen.findByText('草稿已保存');
  expect(smartUpload.saveDraft).toHaveBeenCalledWith(row.id, expect.objectContaining({ name: '项目助理', desc: '我补充的用途', revision: 1 }), expect.any(AbortSignal));
});

test('tool channel mismatch warns about both deployment channels and keeps the detected one', async () => {
  const toolReport: UploadReport = { verdict: 'ok', entry: 'index.html', lines: [] };
  vi.mocked(api.uploads.parse).mockResolvedValueOnce({ ok: true, id: row.id, detected: 'web', report: toolReport });
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: true, analysis: { ...ready, kind: 'tool', engine: 'rules' }, report: toolReport, revision: 1 });
  mount();
  fireEvent.click(screen.getByRole('button', { name: /服务端应用/ }));
  upload();
  await screen.findByDisplayValue('项目助理');
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('服务端应用');
  expect(alert.textContent).toContain('网页工具');
  expect(within(screen.getByRole('group', { name: '工具部署方式' })).getByRole('button', { name: /网页工具/ }).getAttribute('aria-pressed')).toBe('true');
});

test('an inline question starts unselected and submits its exact opaque answer without changing screens', async () => {
  const question = { ...ready, status: 'question' as const, newResource: false, question: { id: 'entry:opaque', prompt: '这两个入口中，哪个是主流程？', options: [{ id: 'main/path:1', label: '业务总流程', description: '组合材料整理与报告生成' }, { id: 'other/path:2', label: '单项处理', description: '仅完成材料整理' }] } };
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: true, analysis: question, revision: 1 })
    .mockResolvedValueOnce({ ok: true, analysis: { ...ready, revision: 2 }, report, revision: 2 });
  mount();
  fireEvent.click(screen.getByRole('button', { name: /^智能体/ })); upload();
  const answer = await screen.findByRole('button', { name: '确认并继续解析' });
  expect((answer as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '提交审核 →' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('radio').every(input => !(input as HTMLInputElement).checked)).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /业务总流程/ }));
  fireEvent.click(answer);
  await screen.findByText('生成报告');
  expect(vi.mocked(smartUpload.analyze).mock.calls.at(-1)?.[1]).toEqual({ revision: 1, choices: { 'entry:opaque': 'main/path:1' } });
  expect(screen.getByRole('group', { name: '资源类型' })).toBeTruthy();
  expect(screen.getAllByRole('heading', { name: '包内容解析' })).toContain(document.activeElement);
});

test('missing capabilities retain the full form, block review and offer copyable repair advice', async () => {
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: true, analysis: { ...ready, status: 'blocked', issues: [{ code: 'missing', message: '缺少必需的报告技能文件' }], repairText: '请补上报告技能后重新打包。' }, report: { ...report, verdict: 'fail' }, revision: 1 });
  mount(); upload();
  await screen.findByText('缺少必需的报告技能文件');
  expect(screen.getByRole('button', { name: '复制修改建议' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '保存草稿' })).toBeTruthy();
  expect((screen.getByRole('button', { name: '提交审核 →' }) as HTMLButtonElement).disabled).toBe(true);
});

test('restoring a ready owned draft retains user metadata without another analysis request', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [{ ...row, packageRevision: 1, resourceType: 'agent', name: '保存的业务名称', desc: '用户已补充说明', tags: ['内容生成'], departments: ['测试'], category: '规划咨询', smartAnalysis: ready }] });
  mount({ initialUploadId: row.id }, `/?upload=1&uploadId=${row.id}`);
  await screen.findByDisplayValue('保存的业务名称');
  expect(smartUpload.analyze).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await screen.findByText('草稿已保存');
  expect(smartUpload.saveDraft).toHaveBeenCalledWith(row.id, expect.objectContaining({ name: '保存的业务名称', desc: '用户已补充说明', tags: ['内容生成'], departments: ['测试'], category: '规划咨询', revision: 1 }), expect.any(AbortSignal));
});

test('a legacy skill draft is analyzed using its restored kind and revision', async () => {
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [{ ...row, packageRevision: 4, name: '已有草稿名' }] });
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: true, analysis: { ...ready, revision: 5 }, report, revision: 5 });
  mount({ initialUploadId: row.id });
  await screen.findByText('生成报告');
  expect((screen.getByLabelText('资源名称') as HTMLInputElement).value).toBe('已有草稿名');
  expect(smartUpload.analyze).toHaveBeenCalledWith(row.id, { revision: 4 }, expect.any(AbortSignal));
});

test.each(['missing', 'foreign', 'submitted'])('an invalid %s draft never starts analysis', async scenario => {
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: scenario === 'missing' ? [] : [{ ...row, ...(scenario === 'foreign' ? { u: 'someone-else' } : { status: 'pending' }) }] });
  mount({ initialUploadId: row.id });
  await screen.findByRole('alert');
  expect(smartUpload.analyze).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '提交审核 →' }) as HTMLButtonElement).disabled).toBe(true);
});

test('a lost first response synchronizes a committed ready analysis without regenerating it', async () => {
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: false, message: '响应中断' });
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [{ ...row, smartAnalysis: ready, packageRevision: 1 }] });
  mount(); upload();
  await screen.findByText('响应中断');
  fireEvent.click(screen.getByRole('button', { name: '重新解析' }));
  await screen.findByText('生成报告');
  expect(smartUpload.analyze).toHaveBeenCalledOnce();
});

test('a confirmed update inherits authoritative settings even when the owned list is delayed', async () => {
  vi.mocked(api.uploads.myOnline).mockReturnValue(new Promise(() => {}));
  const display = { icon: '更', iconUrl: '/files/uploads/icons/owned.png', iconBg: '#123456', category: '规划咨询', tags: ['内容生成'], departments: ['测试'] };
  const question = { ...ready, status: 'question' as const, newResource: false, question: { id: 'publication-identity', prompt: '这是新项目还是更新本人项目？', options: [{ id: 'update', label: '更新本人项目', description: '沿用历史版本' }, { id: 'new', label: '新项目', description: '独立发布' }] } };
  vi.mocked(smartUpload.analyze).mockResolvedValueOnce({ ok: true, analysis: question, revision: 1 })
    .mockResolvedValueOnce({ ok: true, analysis: { ...ready, resource: { ...ready.resource, name: '本人项目' }, updateOf: 'skill:owned', newResource: false, displayMetadata: display, revision: 2 }, report: { ...report, structure: { ...report.structure!, slug: 'owned', version: '2.0.1' } }, revision: 2 });
  mount(); upload();
  fireEvent.click(await screen.findByRole('radio', { name: /更新本人项目/ }));
  fireEvent.click(screen.getByRole('button', { name: '确认并继续解析' }));
  await screen.findByDisplayValue('本人项目');
  fireEvent.change(screen.getByLabelText('更新说明'), { target: { value: '补充报告生成能力' } });
  fireEvent.click(screen.getByRole('button', { name: '提交审核 →' }));
  await screen.findByText('已提交，等待管理员审核');
  expect(api.uploads.submit).toHaveBeenCalledWith(row.id, expect.objectContaining({ ...display, name: '本人项目', revision: 2, updateOf: 'skill:owned', updateNote: '补充报告生成能力' }));
});

test('the public draft URL survives refresh and reupload clears it without reopening the old draft', async () => {
  render(<MemoryRouter initialEntries={['/?upload=1&filter=keep']}><LocationProbe /><UrlForm /></MemoryRouter>);
  upload(); await screen.findByDisplayValue('项目助理');
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`?upload=1&filter=keep&uploadId=${row.id}`));
  fireEvent.click(screen.getByRole('button', { name: '重新上传' }));
  expect(screen.getByTestId('location').textContent).toBe('?upload=1&filter=keep');
  expect(screen.getByLabelText('主文件')).toBeTruthy();
});

test('cancelling a pending upload ignores its eventual draft and never starts analysis', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.uploads.parse).mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
  mount(); upload();
  fireEvent.click(screen.getByRole('button', { name: '取消本次上传' }));
  await act(async () => resolve({ ok: true, id: row.id, detected: 'skill', report }));
  expect(smartUpload.analyze).not.toHaveBeenCalled();
  expect(screen.getByLabelText('主文件')).toBeTruthy();
});

test('a failed draft save does not claim success or lose edited fields', async () => {
  vi.mocked(smartUpload.saveDraft).mockResolvedValueOnce({ ok: false, message: '草稿保存连接中断' });
  mount(); upload(); await screen.findByDisplayValue('项目助理');
  fireEvent.change(screen.getByLabelText('项目描述'), { target: { value: '保留我的修改' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await screen.findByText('草稿保存连接中断');
  expect(screen.queryByText('草稿已保存')).toBeNull();
  expect((screen.getByLabelText('项目描述') as HTMLTextAreaElement).value).toBe('保留我的修改');
});

test('a submit conflict requires reviewing the synchronized result before an explicit retry', async () => {
  vi.mocked(api.uploads.submit).mockResolvedValueOnce({ ok: false, status: 409, message: '项目内容已更新，请核对最新结果' }).mockResolvedValueOnce({ ok: true });
  mount(); upload(); await screen.findByDisplayValue('项目助理');
  fireEvent.change(screen.getByLabelText('项目描述'), { target: { value: '保留提交前的补充说明' } });
  fireEvent.click(screen.getByRole('button', { name: '业务提效', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '提交审核 →' }));
  const retry = await screen.findByRole('button', { name: '重新解析' });
  expect((screen.getByRole('button', { name: '提交审核 →' }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(api.uploads.mine).mockResolvedValue({ ok: true, rows: [{ ...row, packageRevision: 2, smartAnalysis: { ...ready, revision: 2, resource: { ...ready.resource, functions: [{ name: '最新核查结果', source: 'package' }] } } }] });
  fireEvent.click(retry);
  await screen.findByText('最新核查结果');
  expect(api.uploads.submit).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('项目描述') as HTMLTextAreaElement).value).toBe('保留提交前的补充说明');
  fireEvent.click(screen.getByRole('button', { name: '提交审核 →' }));
  await screen.findByText('已提交，等待管理员审核');
  expect(vi.mocked(api.uploads.submit).mock.calls.at(-1)?.[1]).toMatchObject({ revision: 2, desc: '保留提交前的补充说明' });
});
