import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import Home from '../src/pages/Home';
import { api } from '../src/services/api';
import * as gateway from '../src/services/skillsGateway';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('../src/hooks/useUsage', () => ({ useUsage: () => ({ getUsage: (_: string, value: number) => value }), applyUsageResets: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.spyOn(gateway, 'loadSkills').mockResolvedValue([
    { id: 'ordinary-name', name: '真正智能体', kind: 'agent', category: '测试分类', icon: '智', usage: 0 },
    { id: 'fake-agent', name: '普通技能', kind: 'skill', category: '测试分类', icon: '技', usage: 0, desc: '简介中特有关键字' },
  ]);
  vi.spyOn(gateway, 'loadSkillDeptMap').mockResolvedValue({ map: {}, depts: [], applicable: {}, live: true });
  vi.spyOn(api, 'toolsExtra').mockResolvedValue({ ok: true, tools: [] });
  vi.spyOn(api.meta, 'departments').mockResolvedValue({ ok: true, departments: ['测试'] });
});
test('agent tab uses server kind, retains deep links and excludes agents from the skill tab', async () => {
  render(<MemoryRouter initialEntries={['/?tab=agents']}><Home /></MemoryRouter>);
  const library = within(document.getElementById('library')!);
  await library.findByText('真正智能体');
  expect(library.queryByText('普通技能')).toBeNull();
  fireEvent.click(library.getByRole('button', { name: /AI 技能/ }));
  await library.findByText('普通技能');
  expect(library.queryByText('真正智能体')).toBeNull();
});
test('global search matches a skill description', async () => {
  render(<MemoryRouter initialEntries={['/?tab=skills']}><Home /></MemoryRouter>);
  await within(document.getElementById('library')!).findByText('普通技能');
  fireEvent.change(screen.getByPlaceholderText(/搜工具/), { target: { value: '简介中特有关键字' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索', exact: true }));
  expect(await screen.findByText('技能 · 测试分类')).toBeTruthy();
});
