import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import SkillsManage from '../src/pages/admin/SkillsManage';
import { api } from '../src/services/api';
import type { AgentGraph } from '../src/services/agentStructure';

const graph: AgentGraph = {
  schemaVersion: 1, slug: 'fixture', version: 'v2.4.0-preview.20261101.123456', kind: 'agent', source: 'manifest', entry: 'main/SKILL.md', warnings: [],
  components: [{ id: 'calculator', name: '内部计算', kind: 'skill', path: 'internal-skills/calc.md', visibility: 'internal', status: 'ready' }],
  dependencies: [], steps: [],
};
const inspected = (structure = graph, errors: string[] = []) => ({ root: '', entry: structure.entry, structure, errors, warnings: [] });
const legacy = { ...graph, kind: 'skill' as const, source: 'legacy' as const, version: 'v1.0.0' };
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.spyOn(api.gateway, 'health').mockResolvedValue({ ok: true, auth_mode: '', mcp_port: 8765, mcp_alive: true });
  vi.spyOn(api.gateway, 'skills').mockResolvedValue([]);
  vi.spyOn(api.gateway, 'overview').mockResolvedValue({});
  vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  vi.spyOn(api.meta, 'departments').mockResolvedValue({ ok: true, departments: [] });
  vi.spyOn(api.skillDepartments, 'all').mockResolvedValue({ ok: true, map: {} });
  vi.spyOn(api.gateway, 'inspectSkill').mockResolvedValue(inspected());
  vi.spyOn(api.gateway, 'uploadSkill').mockResolvedValue({ slug: 'fixture', version: graph.version });
});

async function open() {
  render(<SkillsManage tab="skills" onTab={() => {}} onAlertsChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /上传技能包/ }));
  const dialog = screen.getByRole('dialog', { name: '上传技能包' });
  return { dialog, choose: (file = new File(['zip'], 'fixture.zip')) => fireEvent.change(dialog.querySelector('input[type="file"]')!, { target: { files: [file] } }),
    upload: () => within(dialog).getByRole('button', { name: '上传', exact: true }) as HTMLButtonElement };
}

test('manifest preflight shows its structure and publishes the complete locked version', async () => {
  const { dialog, choose, upload } = await open();
  choose();
  await within(dialog).findByRole('region', { name: '上传包结构预览' });
  expect(within(dialog).getByText(/internal-skills\/calc.md/)).toBeTruthy();
  const version = within(dialog).getByLabelText(/版本号/) as HTMLInputElement;
  expect(version.value).toBe(graph.version);
  expect(version.readOnly).toBe(true);
  expect(upload().disabled).toBe(false);
  fireEvent.click(upload());
  await waitFor(() => expect(api.gateway.uploadSkill).toHaveBeenCalledTimes(1));
  const form = vi.mocked(api.gateway.uploadSkill).mock.calls[0][0];
  expect(form.get('version')).toBe(graph.version);
  expect((form.get('file') as File).name).toBe('fixture.zip');
});

test('inspect errors block publishing, and network failure can retry without losing form data', async () => {
  vi.mocked(api.gateway.inspectSkill).mockResolvedValueOnce(inspected(graph, ['必要依赖不存在'])).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(inspected());
  const { dialog, choose, upload } = await open();
  choose();
  await within(dialog).findByText(/必要依赖不存在/);
  expect(upload().disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText('中文名（可选）'), { target: { value: '保留填写' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '重新预检' }));
  await within(dialog).findByText(/预检.*网络/);
  expect(upload().disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: '重新预检' }));
  await waitFor(() => expect(upload().disabled).toBe(false));
  expect(within(dialog).getByDisplayValue('保留填写')).toBeTruthy();
  expect(api.gateway.uploadSkill).not.toHaveBeenCalled();
});

test('late preflight cannot replace the selected package or unlock upload while its inspection is pending', async () => {
  const old = deferred(), current = deferred();
  vi.mocked(api.gateway.inspectSkill).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const { dialog, choose, upload } = await open();
  choose(new File(['a'], 'old.zip'));
  choose(new File(['b'], 'current.zip'));
  await act(async () => old.resolve(inspected()));
  expect(upload().disabled).toBe(true);
  expect(within(dialog).queryByRole('region', { name: '上传包结构预览' })).toBeNull();
  await act(async () => current.resolve(inspected({ ...graph, slug: 'current', version: 'v7.0.0' })));
  expect((within(dialog).getByLabelText(/版本号/) as HTMLInputElement).value).toBe('v7.0.0');
  expect(upload().disabled).toBe(false);
});

test('legacy packages retain editable versions including v-prefixed prereleases', async () => {
  vi.mocked(api.gateway.inspectSkill).mockResolvedValue(inspected(legacy));
  const { dialog, choose, upload } = await open();
  choose();
  await within(dialog).findByRole('region', { name: '上传包结构预览' });
  const version = within(dialog).getByLabelText(/版本号/) as HTMLInputElement;
  expect(version.readOnly).toBe(false);
  fireEvent.change(version, { target: { value: 'v3.4.10-preview.20261101.123456' } });
  fireEvent.click(upload());
  await waitFor(() => expect(api.gateway.uploadSkill).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.gateway.uploadSkill).mock.calls[0][0].get('version')).toBe('v3.4.10-preview.20261101.123456');
});

test('archives above 150 MiB are rejected locally while the inclusive limit may be inspected', async () => {
  const { dialog, choose, upload } = await open();
  const oversize = new File(['small fixture'], 'oversize.zip');
  Object.defineProperty(oversize, 'size', { value: 150 * 1024 * 1024 + 1 });
  choose(oversize);
  await within(dialog).findByText(/超过.*150/);
  expect(api.gateway.inspectSkill).not.toHaveBeenCalled();
  expect(upload().disabled).toBe(true);
  const limit = new File(['small fixture'], 'limit.zip');
  Object.defineProperty(limit, 'size', { value: 150 * 1024 * 1024 });
  choose(limit);
  await waitFor(() => expect(api.gateway.inspectSkill).toHaveBeenCalledTimes(1));
});

test('closing a pending inspection invalidates it before a new upload session', async () => {
  const old = deferred();
  vi.mocked(api.gateway.inspectSkill).mockReturnValueOnce(old.promise);
  const { dialog, choose } = await open();
  choose();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭上传技能包' }));
  fireEvent.click(await screen.findByRole('button', { name: /上传技能包/ }));
  await act(async () => old.resolve(inspected()));
  const reopened = screen.getByRole('dialog', { name: '上传技能包' });
  expect(within(reopened).queryByRole('region', { name: '上传包结构预览' })).toBeNull();
  expect((within(reopened).getByRole('button', { name: '上传', exact: true }) as HTMLButtonElement).disabled).toBe(true);
});
