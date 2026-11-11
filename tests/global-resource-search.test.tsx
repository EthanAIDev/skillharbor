import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import GlobalResourceSearch from '../src/components/GlobalResourceSearch';
import type { Skill } from '../src/types';

const skills: Skill[] = [
  { id: 'a', name: '项目智能体', kind: 'agent', desc: '输出项目报告', category: '测试', usage: 0, icon: '智' },
  { id: 'b', name: '项目校对', kind: 'skill', desc: '检查项目文字', category: '测试', usage: 0, icon: '技' },
];
function mount(overrides = {}) {
  const callbacks = { onTool: vi.fn(), onSkill: vi.fn(), onShowAll: vi.fn(), onKnowledge: vi.fn(), onRetrySkills: vi.fn() };
  render(<GlobalResourceSearch tools={[]} skills={skills} skillsLoading={false} skillsError={false} {...callbacks} {...overrides} />);
  return callbacks;
}
function response(items: unknown[], extra = {}) {
  return new Response(JSON.stringify({ items, ...extra }), { status: 200 });
}
function search(value: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
  fireEvent.submit(screen.getByRole('search', { name: '全站资源搜索' }));
}

test('the newest search owns the result even if an aborted request resolves late', async () => {
  let first!: (value: Response) => void;
  let second!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { first = resolve; }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { second = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  mount();
  search('旧关键词');
  search('项目');
  expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  await act(async () => second(response([{ name: '新文档' }])));
  expect(await screen.findByText('新文档')).toBeTruthy();
  await act(async () => first(response([{ name: '过期文档' }])));
  expect(screen.queryByText('过期文档')).toBeNull();
  expect(screen.getByText('项目智能体')).toBeTruthy();
});

test('application errors in HTTP 200 responses can be retried without losing local results', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([], { ok: false })).mockResolvedValueOnce(response([{ name: '恢复文档' }]));
  vi.stubGlobal('fetch', fetcher);
  mount();
  search('项目');
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('项目智能体')).toBeTruthy();
  const retry = screen.getByRole('button', { name: '重试知识库搜索' });
  retry.focus();
  fireEvent.click(retry);
  expect(await screen.findByText('恢复文档')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['/api/kb/search?q=%E9%A1%B9%E7%9B%AE', '/api/kb/search?q=%E9%A1%B9%E7%9B%AE']);
});

test('knowledge full results carry the query while a document hit carries its name', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response([{ name: '项目研究报告', repos: '公开库' }]))));
  const callbacks = mount();
  search('项目');
  fireEvent.click(await screen.findByRole('button', { name: '查看全部知识库结果 →' }));
  expect(callbacks.onKnowledge).toHaveBeenLastCalledWith('项目');
  search('项目');
  fireEvent.click(await screen.findByRole('button', { name: /项目研究报告/ }));
  expect(callbacks.onKnowledge).toHaveBeenLastCalledWith('项目研究报告');
});

test('a successful empty search is distinct from an unavailable skill catalog', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response([]))));
  const callbacks = mount({ skills: [], skillsError: true });
  search('没有匹配');
  const result = await screen.findByRole('region', { name: '全站搜索结果' });
  expect(await within(result).findByRole('alert')).toBeTruthy();
  expect(within(result).queryByText(/没有找到匹配的资源/)).toBeNull();
  fireEvent.click(within(result).getByRole('button', { name: '重新加载资源' }));
  expect(callbacks.onRetrySkills).toHaveBeenCalledOnce();
});

test('Escape dismisses the dropdown and returns focus to the persistent input', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response([]))));
  mount();
  search('项目');
  const all = await screen.findByRole('button', { name: /查看全部智能体/ });
  all.focus();
  fireEvent.keyDown(all, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: '全站搜索结果' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('searchbox'));
});

test('an empty successful search announces no matches', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response([]))));
  mount();
  search('无匹配词');
  expect(await screen.findByText(/没有找到匹配的资源/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an unauthenticated knowledge search offers the sign-in route while keeping local results', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))));
  const callbacks = mount();
  search('项目');
  expect(await screen.findByText('登录后可搜索知识库。')).toBeTruthy();
  expect(screen.getByText('项目智能体')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '登录并搜索知识库' }));
  expect(callbacks.onKnowledge).toHaveBeenCalledWith('项目');
  expect(screen.queryByRole('button', { name: '重试知识库搜索' })).toBeNull();
});
