import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import ToolModal from '../src/components/ToolModal';
import ToolDetail from '../src/pages/ToolDetail';
import { tools } from '../src/data/tools';
import { api } from '../src/services/api';
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: { username: 'tester', name: '测试员工' } }) }));
const tool = tools[0];
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  vi.spyOn(api.evals, 'get').mockResolvedValue({ ok: true, recent: [], summary: { avg: 0, count: 0 } });
  vi.spyOn(api, 'toolsExtra').mockResolvedValue({ ok: true, tools: [] });
});
function open(kind: string) {
  return render(<MemoryRouter initialEntries={['/tool/' + tool.id]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    {kind === 'modal' ? <ToolModal tool={tool} onClose={() => {}} /> : <Routes><Route path="/tool/:id" element={<ToolDetail />} /></Routes>}
  </MemoryRouter>);
}
test.each(['modal', 'detail'])('%s keeps a failed draft and shows only successful evaluations once', async kind => {
  const pending = deferred();
  const submit = vi.spyOn(api.evals, 'submitStars').mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, summary: { avg: 5, count: 1 } });
  open(kind);
  await act(async () => {});
  fireEvent.click(screen.getAllByText('★', { exact: true })[4]);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '待提交的评价' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  expect(screen.getByDisplayValue('待提交的评价')).toBeTruthy();
  expect(screen.queryByText('测试员工')).toBeNull();
  expect((screen.getByRole('button', { name: /发送/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /发送/ }));
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ok: false, message: '评价保存失败' }));
  expect(screen.getByText('评价保存失败')).toBeTruthy();
  expect(screen.getByDisplayValue('待提交的评价')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await screen.findByText('测试员工');
  expect(screen.getAllByText('测试员工')).toHaveLength(1);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
});

test.each(['modal', 'detail'])('%s recovers after a rejected submit connection', async kind => {
  vi.spyOn(api.evals, 'submitStars').mockRejectedValue(new TypeError('offline'));
  open(kind);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '5 星' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '连接中断的草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await screen.findByText('提交连接中断，请重试');
  expect(screen.getByDisplayValue('连接中断的草稿')).toBeTruthy();
  expect((screen.getByRole('button', { name: '发送', exact: true }) as HTMLButtonElement).disabled).toBe(false);
});

test('a delayed initial feed cannot erase a newly saved evaluation', async () => {
  const old = deferred();
  vi.mocked(api.evals.get).mockReturnValue(old.promise);
  vi.spyOn(api.evals, 'submitStars').mockResolvedValue({ ok: true, summary: { avg: 5, count: 1 } });
  open('modal');
  fireEvent.click(screen.getByRole('button', { name: '5 星' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '已保存评价' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await screen.findByText('测试员工');
  await act(async () => old.resolve({ ok: true, recent: [], summary: { count: 0 } }));
  expect(screen.getByText('测试员工')).toBeTruthy();
});

const history = {
  ok: true, summary: { avg: 3, count: 2 }, recent: [
    { id: 'mine', n: '测试员工', s: 2, c: '本人旧评价', t: 2, mine: true },
    { id: 'other', n: '历史同事', s: 4, c: '同事历史评价', t: 1, mine: false },
  ],
};

test.each([
  ['modal', 'business'], ['modal', 'reject'], ['detail', 'business'], ['detail', 'reject'],
])('%s preserves late nonempty history and a failed %s draft before retry', async (kind, failure) => {
  const read = deferred(); vi.mocked(api.evals.get).mockReturnValue(read.promise);
  const post = vi.spyOn(api.evals, 'submitStars');
  if (failure === 'reject') post.mockRejectedValueOnce(new TypeError('offline'));
  else post.mockResolvedValueOnce({ ok: false, message: '评价保存失败' });
  post.mockResolvedValue({ ok: true, summary: { avg: 4.5, count: 2 } });
  open(kind); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '5 星' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '失败后保留草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  const error = failure === 'reject' ? '提交连接中断，请重试' : '评价保存失败';
  await screen.findByText(error);
  await act(async () => read.resolve(history));
  expect(screen.getByText(/同事历史评价/)).toBeTruthy(); expect(screen.getByText(/本人旧评价/)).toBeTruthy();
  expect(screen.getByText('3.0')).toBeTruthy(); expect(screen.getByText(error)).toBeTruthy();
  expect(screen.getByDisplayValue('失败后保留草稿')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await screen.findByText(/失败后保留草稿/);
  expect(screen.getByText(/同事历史评价/)).toBeTruthy(); expect(screen.queryByText(/本人旧评价/)).toBeNull();
  expect(screen.getAllByText('测试员工')).toHaveLength(1); expect(screen.getByText('4.5')).toBeTruthy();
});

test.each(['modal', 'detail'])('%s merges a successful submission with late nonempty history using mine identity', async kind => {
  const read = deferred(); vi.mocked(api.evals.get).mockReturnValue(read.promise);
  vi.spyOn(api.evals, 'submitStars').mockResolvedValue({ ok: true, summary: { avg: 4.5, count: 2 } });
  open(kind); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '5 星' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '本人的成功更新' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await screen.findByText(/本人的成功更新/);
  await act(async () => read.resolve(history));
  expect(screen.getByText(/同事历史评价/)).toBeTruthy(); expect(screen.queryByText(/本人旧评价/)).toBeNull();
  expect(screen.getAllByText('测试员工')).toHaveLength(1); expect(screen.getAllByText(/本人的成功更新/)).toHaveLength(1);
  expect(screen.getByText('4.5')).toBeTruthy(); expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
});

test('a submit completed for the old tool cannot clear the new tool draft', async () => {
  const old = deferred();
  vi.spyOn(api.evals, 'submitStars').mockReturnValue(old.promise);
  const wrap = (id: string) => <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ToolModal tool={{ ...tool, id }} onClose={() => {}} /></MemoryRouter>;
  const view = render(wrap('old'));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '5 星' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '旧草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  view.rerender(wrap('new'));
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '新工具草稿' } });
  await act(async () => old.resolve({ ok: true, summary: { count: 1 } }));
  expect(screen.getByDisplayValue('新工具草稿')).toBeTruthy();
  expect(screen.queryByText('测试员工')).toBeNull();
});
