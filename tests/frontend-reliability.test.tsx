import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import ApiHub from '../src/pages/ApiHub';
import StatsDashboard from '../src/pages/admin/StatsDashboard';
import SkillsManage from '../src/pages/admin/SkillsManage';
import { ah, api } from '../src/services/api';
import { StrictMode } from 'react';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: { username: 'owner', role: 'admin' } }) }));
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const hub = { ok: true, systems: {}, interfaces: [], channels: [], dynamics: [], stats: { systems: 0, total: 0, cloud: 0, ready: 0, lan: 0, channels: 0 } };
const stats = (month: string, name: string) => ({ ok: true, month, config: { dailyLimit: 5 }, days: [month + '-01'], tools: [{ id: 't', name, owner: 'owner', department: '测试', days: { [month + '-01']: 7 }, total: 7, users: 1 }], owners: [], totalClicks: 7, activeUsers: 1, anomalies: [], trend30: [] });
const dashboard = () => render(<StatsDashboard focusToolId="" onDoneFocus={() => {}} onOpenSkillLogs={() => {}} />);
function month(value: string) { fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value } }); }
beforeEach(() => { vi.spyOn(api.adminTools, 'list').mockResolvedValue({ ok: true, extra: [] }); });

test.each([401, 500, 'network'])('ApiHub exposes initial %s failure and retries successfully', async failure => {
  const read = vi.spyOn(ah, 'state');
  if (failure === 'network') read.mockRejectedValueOnce(new TypeError('断网'));
  else read.mockResolvedValueOnce({ ok: false, message: `HTTP ${failure}` } as any);
  read.mockResolvedValue(hub);
  render(<ApiHub />);
  await screen.findByRole('alert');
  expect(screen.queryByText('接口中心加载中…')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('已登记系统');
});

test('ApiHub ignores a late earlier read during StrictMode startup', async () => {
  const old = deferred();
  vi.spyOn(ah, 'state').mockReturnValueOnce(old.promise).mockResolvedValue({ ...hub, stats: { ...hub.stats, systems: 23 } });
  render(<StrictMode><ApiHub /></StrictMode>); await screen.findByText('23');
  await act(async () => old.resolve({ ...hub, stats: { ...hub.stats, systems: 91 } }));
  expect(screen.getByText('23')).toBeTruthy(); expect(screen.queryByText('91')).toBeNull();
});

test('ApiHub reports a failed reload after channel mutation and permits retry', async () => {
  const channelState = { ...hub, interfaces: [{ id: 'i', sysId: '', method: 'GET', path: '/test', title: '测试接口', desc: '', auth: '', state: 'cloud', up: 'local', owner: 'owner', ownerName: 'owner', params: [], errs: [], callers: [], createdAt: 1, updatedAt: 1 }], channels: [{ ifId: 'i', port: 18000, up: 'local', reason: '', createdBy: 'owner', createdAt: 1 }] } as any;
  vi.spyOn(ah, 'state').mockResolvedValueOnce(channelState).mockResolvedValueOnce({ ok: false, message: '刷新失败' } as any).mockResolvedValue(hub);
  vi.spyOn(ah, 'disable').mockResolvedValue({ ok: true }); vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ApiHub />); fireEvent.click(await screen.findByText('我的接入'));
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  await screen.findByRole('alert'); expect(screen.getByText('刷新失败')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重试' })); await screen.findByText('还没有云侧通道', { exact: false });
});

test('statistics hide the old month immediately and ignore reverse responses', async () => {
  const old = deferred(), latest = deferred();
  vi.spyOn(api.stats, 'admin').mockImplementation(m => m === '2026-01' ? old.promise : m === '2026-02' ? latest.promise : Promise.resolve(stats(m!, '初始工具')));
  dashboard(); await screen.findAllByTitle('初始工具');
  month('2026-01'); expect(screen.queryAllByTitle('初始工具')).toHaveLength(0);
  month('2026-02');
  await act(async () => latest.resolve(stats('2026-02', '二月工具')));
  await act(async () => old.resolve(stats('2026-01', '一月工具')));
  expect(screen.getAllByTitle('二月工具')).toHaveLength(2); expect(screen.queryAllByTitle('一月工具')).toHaveLength(0);
});

test('statistics failures show retry instead of a false empty result', async () => {
  vi.spyOn(api.stats, 'admin').mockResolvedValueOnce({ ok: false, message: '统计暂不可用' }).mockImplementation(m => Promise.resolve(stats(m!, '恢复工具')));
  dashboard(); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findAllByTitle('恢复工具');
});

test('saving the limit and a pending detail cannot restore the previous month', async () => {
  const save = deferred(), detail = deferred();
  vi.spyOn(api.stats, 'admin').mockImplementation(m => Promise.resolve(stats(m!, m === '2026-02' ? '二月工具' : '旧月工具')));
  vi.spyOn(api.stats, 'setConfig').mockReturnValue(save.promise);
  vi.spyOn(api.stats, 'detail').mockReturnValue(detail.promise);
  dashboard(); await screen.findAllByTitle('旧月工具');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  fireEvent.click(screen.getByRole('button', { name: '7', exact: true }));
  month('2026-02'); await screen.findAllByTitle('二月工具');
  await act(async () => { save.resolve({ ok: true, message: '已保存' }); detail.resolve({ ok: true, rows: [{ u: 'old', n: '旧明细', t: 1, ip: '', counted: true }] }); });
  expect(screen.getAllByTitle('二月工具')).toHaveLength(2); expect(screen.queryByRole('dialog')).toBeNull();
});

test('a failed refresh after saving a limit remains visible and retryable', async () => {
  vi.spyOn(api.stats, 'admin').mockImplementationOnce(m => Promise.resolve(stats(m!, '当前工具'))).mockResolvedValueOnce({ ok: false, message: '保存后的刷新失败' }).mockImplementation(m => Promise.resolve(stats(m!, '刷新成功工具')));
  vi.spyOn(api.stats, 'setConfig').mockResolvedValue({ ok: true });
  dashboard(); await screen.findAllByTitle('当前工具'); fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: '重试' })); await screen.findAllByTitle('刷新成功工具');
});

test('closing a pending detail prevents it from reopening on completion', async () => {
  const detail = deferred();
  vi.spyOn(api.stats, 'admin').mockImplementation(m => Promise.resolve(stats(m!, '当前工具')));
  vi.spyOn(api.stats, 'detail').mockReturnValue(detail.promise);
  dashboard(); await screen.findAllByTitle('当前工具'); fireEvent.click(screen.getByRole('button', { name: '7', exact: true }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '✕' }));
  await act(async () => detail.resolve({ ok: true, rows: [] })); expect(screen.queryByRole('dialog')).toBeNull();
});

async function access() {
  vi.spyOn(api.gateway, 'health').mockResolvedValue({ ok: true, auth_mode: '', mcp_port: 8765, mcp_alive: true });
  vi.spyOn(api.gateway, 'skills').mockResolvedValue([{ slug: 'example', name: '测试技能', status: 'enabled' }]);
  vi.spyOn(api.gateway, 'overview').mockResolvedValue({}); vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  vi.spyOn(api.meta, 'departments').mockResolvedValue({ ok: true, departments: [] }); vi.spyOn(api.skillDepartments, 'all').mockResolvedValue({ ok: true, map: {} });
  vi.spyOn(api.gateway, 'skill').mockResolvedValue({ slug: 'example', name: '测试技能', status: 'enabled', description: '简介' });
  vi.spyOn(api.gateway, 'skillTrend').mockResolvedValue([]);
  render(<SkillsManage tab="skills" onTab={() => {}} onAlertsChange={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '接入配置' }));
  return await screen.findByRole('dialog');
}

test.each([{ copied: true, index: 0 }, { copied: false, index: 0 }, { copied: true, index: 1 }, { copied: false, index: 1 }])('HTTP skill copy $index keeps focus and reports success=$copied honestly', async ({ copied, index }) => {
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: undefined } }));
  const dialog = await access();
  const buttons = within(dialog).getAllByRole('button', { name: '复制', exact: true });
  buttons[index].focus();
  const content = dialog.querySelectorAll('pre')[index];
  const range = document.createRange(); range.setStart(content.firstChild!, 1); range.setEnd(content.firstChild!, 8);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  const selected = document.getSelection()!.toString();
  const copy = vi.fn(() => {
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLTextAreaElement).value).toBe(content.textContent);
    return copied;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
  fireEvent.click(buttons[index]);
  if (copied) await within(dialog).findByRole('button', { name: '已复制' });
  else await within(dialog).findByRole('alert');
  expect(copy).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(buttons[index]);
  expect(document.getSelection()!.toString()).toBe(selected);
});

test.each([['register', true], ['register', false], ['example', true], ['example', false]])('ApiHub %s copying reports fallback=%s and permits retry', async (entry, copied) => {
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: undefined } }));
  const active: Element[] = [];
  const copy = vi.fn(() => { active.push(document.activeElement!); return copied; });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
  vi.spyOn(ah, 'state').mockResolvedValue({ ...hub, interfaces: [{ id: 'i', sysId: '', method: 'GET', path: '/example', title: '测试复制接口', desc: '说明', auth: '', state: 'cloud', up: 'local', owner: 'owner', ownerName: 'owner', params: [], errs: [], callers: [], createdAt: 1, updatedAt: 1 }] } as any);
  render(<ApiHub />);
  let control: HTMLElement;
  if (entry === 'register') {
    fireEvent.click(await screen.findByText('我的接口'));
    fireEvent.click(screen.getByRole('button', { name: /登记新接口/ }));
    control = screen.getByRole('button', { name: '📋 复制提示词' });
  } else {
    fireEvent.click(await screen.findByText('测试复制接口'));
    fireEvent.click(screen.getByRole('button', { name: '📋 复制 curl 示例' }));
    control = screen.getByRole('button', { name: '📋 复制到剪贴板' });
  }
  control.focus(); fireEvent.click(control);
  const dialog = screen.getByRole('dialog');
  if (copied) await within(dialog).findByText(/已复制/);
  else {
    await within(dialog).findByRole('alert'); expect(within(dialog).queryByText(/已复制/)).toBeNull();
    copy.mockReturnValue(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /复制提示词|复制到剪贴板/ }));
    await within(dialog).findByText(/已复制/);
  }
  expect(copy).toHaveBeenCalled();
  expect(active.every(element => element instanceof HTMLTextAreaElement)).toBe(true);
  expect(document.activeElement).toBe(control);
});
