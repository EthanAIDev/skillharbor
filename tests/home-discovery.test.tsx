import { fireEvent, render, screen, within } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import Home from '../src/pages/Home';
import ToolCard from '../src/components/ToolCard';
import { api } from '../src/services/api';
import * as gateway from '../src/services/skillsGateway';
import type { Skill, Tool } from '../src/types';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('../src/hooks/useUsage', () => ({ useUsage: () => ({ getUsage: (_id: string, value: number) => value }), applyUsageResets: vi.fn() }));

const catalog: Skill[] = [
  ...Array.from({ length: 5 }, (_, i): Skill => ({
    id: `bid-agent-${i}`, name: `投标业务流程 ${i}`, kind: 'agent', category: '项目申报', icon: '智', usage: i,
    desc: '整理投标材料并生成检查清单', createdAt: '2026-11-01',
  })),
  { id: 'bid-skill', name: '投标校对', kind: 'skill', category: '文档处理', icon: '技', usage: 3, desc: '检查投标文件中的错漏' },
];

function json(items: unknown[], status = 200) {
  return new Response(JSON.stringify({ items }), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.spyOn(gateway, 'loadSkills').mockResolvedValue(catalog);
  vi.spyOn(gateway, 'loadSkillDeptMap').mockResolvedValue({
    map: Object.fromEntries(catalog.map(item => [item.id, item.kind === 'agent' ? '业务一' : '业务二'])),
    depts: ['业务一', '业务二'], applicable: { 'bid-skill': ['业务二'] }, live: true,
  });
  vi.spyOn(api, 'toolsExtra').mockResolvedValue({ ok: true, tools: [] });
  vi.spyOn(api.meta, 'departments').mockResolvedValue({ ok: true, departments: ['测试'] });
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json([]))));
});

async function home(tab = 'agents') {
  render(<MemoryRouter initialEntries={[`/?tab=${tab}`]}><Home /></MemoryRouter>);
  await within(document.getElementById('library')!).findByText(tab === 'skills' ? '投标校对' : '投标业务流程 0');
}

test('knowledge activity distinguishes HTTP failure from empty and retries successfully', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(json([], 503)).mockResolvedValueOnce(json([{ name: '恢复后的文档.md', repos: '测试知识库' }]));
  await home();
  const activity = within(screen.getByRole('heading', { name: /知识库动态/ }).closest('.card')! as HTMLElement);
  expect((await activity.findByRole('alert')).textContent).toMatch(/暂时无法/);
  expect(activity.queryByText('暂无可展示的动态')).toBeNull();
  const retry = activity.getByRole('button', { name: '重新加载' });
  retry.focus(); fireEvent.click(retry);
  expect(await activity.findByText(/恢复后的文档/)).toBeTruthy();
  expect(activity.queryByRole('alert')).toBeNull();
  expect(document.activeElement).toBe(activity.getByRole('heading', { name: '知识库动态' }));
});

test('knowledge search failure retains local matches and exposes retry rather than no matches', async () => {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve(json([], String(input).includes('/kb/search?') ? 503 : 200))));
  await home();
  fireEvent.change(screen.getByPlaceholderText(/搜工具/), { target: { value: '投标' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }));
  const results = await screen.findByRole('region', { name: '全站搜索结果' });
  expect((await within(results).findByRole('alert')).textContent).toMatch(/知识库.*暂时无法/);
  expect(within(results).getByText('投标业务流程 0')).toBeTruthy();
  expect(within(results).queryByText(/未命中|没有找到匹配/)).toBeNull();
  expect(within(results).getByRole('button', { name: '重试知识库搜索' })).toBeTruthy();
});

test('full-result handoff keeps the submitted query and actual agent kind across tab changes', async () => {
  await home('skills');
  const sourceLibrary = within(document.getElementById('library')!);
  fireEvent.change(sourceLibrary.getByRole('searchbox', { name: '搜索技能' }), { target: { value: '校对' } });
  fireEvent.click(sourceLibrary.getByRole('button', { name: /^筛选/ }));
  fireEvent.click(within(sourceLibrary.getByRole('group', { name: '归属部门' })).getByRole('button', { name: '业务二' }));
  fireEvent.click(within(sourceLibrary.getByRole('group', { name: '适用部门' })).getByRole('button', { name: '业务二' }));
  fireEvent.change(screen.getByPlaceholderText(/搜工具/), { target: { value: '投标' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: /查看全部智能体/ }));
  const library = within(document.getElementById('library')!);
  expect((library.getByRole('searchbox', { name: '搜索智能体' }) as HTMLInputElement).value).toBe('投标');
  expect(library.getAllByRole('button', { name: /查看投标业务流程.*详情/ })).toHaveLength(5);
  expect(library.queryByText('投标校对')).toBeNull();
  expect(library.queryByRole('button', { name: /移除归属部门|移除适用部门/ })).toBeNull();
  expect(screen.queryByRole('region', { name: '全站搜索结果' })).toBeNull();
});

test('agent cards expose the business purpose in the catalog', async () => {
  await home();
  const library = within(document.getElementById('library')!);
  expect(library.getAllByText('整理投标材料并生成检查清单')).toHaveLength(5);
});

test('tool card is a native detail button with an accessible name', () => {
  const tool: Tool = { id: 'synthetic', name: '合成工具', desc: '生成项目表格', department: '测试', owner: '测试员', url: '/', type: 'external', icon: '工', usage: 0, likes: 0 };
  const onDetail = vi.fn();
  render(<ToolCard tool={tool} usage={0} onDetail={onDetail} />);
  const button = screen.getByRole('button', { name: '查看合成工具详情' });
  expect(button.tagName).toBe('BUTTON');
  expect(button.getAttribute('type')).toBe('button');
  fireEvent.click(button);
  expect(onDetail).toHaveBeenCalledWith(tool);
});

test('advanced filters expose selected state and can be cleared while collapsed', async () => {
  await home();
  const library = within(document.getElementById('library')!);
  const toggle = library.getByRole('button', { name: /^筛选/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(library.queryByRole('region', { name: '资源筛选' })).toBeNull();
  fireEvent.click(toggle);
  const ownership = within(library.getByRole('group', { name: '归属部门' }));
  fireEvent.click(ownership.getByRole('button', { name: '业务二' }));
  expect(ownership.getByRole('button', { name: '业务二' }).getAttribute('aria-pressed')).toBe('true');
  expect(library.getByText(/没有匹配的智能体/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(library.getByRole('button', { name: '移除归属部门：业务二' })).toBeTruthy();
  const clear = library.getByRole('button', { name: '清除筛选' });
  clear.focus(); fireEvent.click(clear);
  expect(library.getAllByRole('button', { name: /查看投标业务流程.*详情/ })).toHaveLength(5);
  expect(library.queryByRole('button', { name: /移除归属部门/ })).toBeNull();
  expect(document.activeElement).toBe(toggle);
  const sorting = within(library.getByRole('group', { name: '排序方式' }));
  fireEvent.click(sorting.getByRole('button', { name: '最近热门' }));
  expect(sorting.getByRole('button', { name: '最近热门' }).getAttribute('aria-pressed')).toBe('true');
});

test('loading another page appends cards without moving earlier category rows', async () => {
  vi.mocked(gateway.loadSkills).mockResolvedValueOnce(Array.from({ length: 12 }, (_, index) => ({
    ...catalog[0], id: `append-${index}`, name: `投标业务流程 ${index}`, category: index % 2 ? '乙类' : '甲类',
  })));
  await home();
  const library = within(document.getElementById('library')!);
  const names = () => library.getAllByRole('button', { name: /查看投标业务流程.*详情/ }).map(button => button.getAttribute('aria-label'));
  const firstPage = names();
  expect(firstPage).toHaveLength(6);
  fireEvent.click(library.getByRole('button', { name: /加载更多/ }));
  expect(names()).toHaveLength(12);
  expect(names().slice(0, 6)).toEqual(firstPage);
});

test('a navigation deep link resets the previous kind query without clearing full-search handoffs', async () => {
  render(<MemoryRouter initialEntries={['/?tab=agents']}><Link to="/?sec=skills">导航技能库</Link><Home /></MemoryRouter>);
  const library = within(document.getElementById('library')!);
  await library.findByText('投标业务流程 0');
  fireEvent.change(library.getByRole('searchbox', { name: '搜索智能体' }), { target: { value: '不存在的关键词' } });
  fireEvent.click(screen.getByRole('link', { name: '导航技能库' }));
  expect(await library.findByText('投标校对')).toBeTruthy();
  expect((library.getByRole('searchbox', { name: '搜索技能' }) as HTMLInputElement).value).toBe('');
});

test('latest and popularity rows expose native detail actions when records exist', async () => {
  await home();
  const latest = within(screen.getByRole('heading', { name: '最新上架' }).closest('.card')! as HTMLElement);
  const popular = within(screen.getByRole('heading', { name: '热度榜' }).closest('.card')! as HTMLElement);
  for (const button of [...latest.getAllByRole('button'), ...popular.getAllByRole('button')]) {
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
  }
  fireEvent.click(popular.getByRole('button', { name: '查看投标业务流程 4详情' }));
  expect(await screen.findByRole('dialog', { name: '投标业务流程 4' })).toBeTruthy();
});
