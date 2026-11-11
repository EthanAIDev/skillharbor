import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HashRouter, useLocation, useNavigate } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import Admin from '../src/pages/Admin';
import Nav from '../src/components/Nav';
import { api } from '../src/services/api';

vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => ({ session: { name: '测试员工', username: 'tester', role: 'admin' }, logout: vi.fn() }) }));
vi.mock('../src/hooks/useTheme', () => ({ useTheme: () => ({ dark: false, toggle: vi.fn() }) }));
vi.mock('../src/pages/admin/StatsDashboard', () => ({ default: () => <div>统计内容</div> }));
vi.mock('../src/pages/admin/ToolsAdmin', () => ({ default: () => <div>工具内容</div> }));
vi.mock('../src/pages/admin/SkillsManage', () => ({ default: ({ tab, onTab }: any) => <div><span>当前页签：{tab}</span><button onClick={() => onTab('logs')}>日志页签</button></div> }));

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>浏览器后退</button><button onClick={() => navigate(1)}>浏览器前进</button></>;
}

test('admin views and tabs persist in the URL and follow browser history', async () => {
  window.history.replaceState(null, '', '/#/admin?view=stats');
  vi.spyOn(api.uploads, 'adminList').mockResolvedValue({ ok: true, rows: [] });
  vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  const tree = () => <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Admin /><LocationProbe /></HashRouter>;
  const view = render(tree());
  fireEvent.click(screen.getByRole('button', { name: '工具管理' }));
  expect(screen.getByTestId('location').textContent).toBe('/admin?view=tools');
  fireEvent.click(screen.getByRole('button', { name: '技能管理' }));
  fireEvent.click(screen.getByRole('button', { name: '日志页签' }));
  expect(screen.getByTestId('location').textContent).toContain('view=skills&tab=logs');
  view.unmount();
  render(tree());
  expect(screen.getByText('当前页签：logs')).toBeTruthy();
  fireEvent.click(screen.getByText('浏览器后退'));
  await waitFor(() => expect(screen.getByText('当前页签：skills')).toBeTruthy());
  fireEvent.click(screen.getByText('浏览器前进'));
  await waitFor(() => expect(screen.getByText('当前页签：logs')).toBeTruthy());
});

test('the profile upload-history link identifies the records view', () => {
  window.history.replaceState(null, '', '/#/');
  localStorage.setItem('dt-gw-banner', 'off');
  render(<HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Nav /><LocationProbe /></HashRouter>);
  fireEvent.click(screen.getByTitle('测试员工'));
  fireEvent.click(screen.getByText('上传记录'));
  expect(screen.getByTestId('location').textContent).toBe('/?upload=records');
});

test('desktop navigation provides a direct agent library entry', () => {
  window.history.replaceState(null, '', '/#/');
  localStorage.setItem('dt-gw-banner', 'off');
  render(<HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Nav /><LocationProbe /></HashRouter>);
  fireEvent.click(screen.getByRole('button', { name: '智能体' }));
  expect(screen.getByTestId('location').textContent).toBe('/?sec=agents');
});

test('admin navigation groups resource, operations, and organization responsibilities', () => {
  window.history.replaceState(null, '', '/#/admin?view=stats');
  vi.spyOn(api.uploads, 'adminList').mockResolvedValue({ ok: true, rows: [] });
  vi.spyOn(api.gateway, 'alerts').mockResolvedValue([]);
  render(<HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Admin /></HashRouter>);
  expect(within(screen.getByRole('group', { name: '资源与审核' })).getByRole('button', { name: '审核中心' })).toBeTruthy();
  expect(within(screen.getByRole('group', { name: '运行与统计' })).getByRole('button', { name: '服务运维' })).toBeTruthy();
  expect(within(screen.getByRole('group', { name: '组织与设置' })).getByRole('button', { name: '组织管理' })).toBeTruthy();
});
