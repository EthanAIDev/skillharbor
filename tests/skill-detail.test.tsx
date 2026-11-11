import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import SkillModal from '../src/components/SkillModal';
import * as gateway from '../src/services/skillsGateway';
import * as structures from '../src/services/agentStructure';

vi.mock('../src/components/EvalSection', () => ({ default: ({ target }: { target: string }) => <div data-testid="review">{target}</div> }));
test('package-local skill opens at the parent version and does not gain an independent review target', async () => {
  vi.spyOn(gateway, 'loadSkillMd').mockResolvedValue({ slug: 'parent', version: 'v1.0.0', content: '主技能' });
  vi.spyOn(structures, 'loadAgentGraph').mockResolvedValue({ schemaVersion: 1, slug: 'parent', version: 'v1.0.0', kind: 'agent', source: 'legacy', entry: 'SKILL.md', warnings: [], dependencies: [], steps: [], components: [{ id: 'calc', name: '计算组件', kind: 'skill', path: 'internal/calc.md', status: 'ready', visibility: 'internal' }] });
  const read = vi.spyOn(structures, 'loadPackageComponent').mockResolvedValue({ slug: 'parent', version: 'v1.0.0', id: 'calc', name: '计算组件', kind: 'skill', path: 'internal/calc.md', content: '包内计算说明正文' });
  render(<SkillModal skill={{ id: 'parent', name: '父智能体', kind: 'agent', version: 'v1.0.0', icon: '智', category: '测试', usage: 0 }} onClose={vi.fn()} onOpenGuide={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /计算组件/ }));
  await screen.findByText('包内计算说明正文');
  expect(read).toHaveBeenCalledWith('parent', 'calc', 'v1.0.0');
  expect(screen.queryByTestId('review')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回上一级：父智能体' }));
  await waitFor(() => expect(screen.getByTestId('review').textContent).toBe('skill:parent'));
  expect(screen.queryByRole('button', { name: /返回上一级/ })).toBeNull();
  expect(screen.getAllByRole('heading', { name: '父智能体', exact: true })).toContain(document.activeElement);
});

test('a content-only failure offers retry even when structure succeeds', async () => {
  vi.spyOn(gateway, 'loadSkillMd').mockResolvedValueOnce(null).mockResolvedValue({ slug: 'simple', version: 'v1', content: '重试后原文' });
  vi.spyOn(structures, 'loadAgentGraph').mockResolvedValue({ schemaVersion: 1, slug: 'simple', version: 'v1', kind: 'skill', source: 'legacy', entry: 'SKILL.md', warnings: [], dependencies: [], steps: [], components: [] });
  render(<SkillModal skill={{ id: 'simple', name: '功能技能', icon: '技', category: '测试', usage: 0 }} onClose={vi.fn()} onOpenGuide={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '重新读取原文' }));
  await screen.findByText('重试后原文');
  expect(screen.queryByRole('button', { name: '重新读取原文' })).toBeNull();
});

const parent = { id: 'parent', name: '父智能体', kind: 'agent' as const, version: 'v1', icon: '智', category: '测试', usage: 0 };
const child = { ...parent, id: 'child', name: '子智能体' };
const leaf = { ...parent, id: 'leaf', name: '末级技能', kind: 'skill' as const };
function mockNestedDetails() {
  vi.spyOn(gateway, 'loadSkillMd').mockImplementation(async slug => ({ slug, version: 'v1', content: `${slug}正文` }));
  vi.spyOn(structures, 'loadAgentGraph').mockImplementation(async slug => ({
    schemaVersion: 1, slug, version: 'v1', kind: slug === 'leaf' ? 'skill' : 'agent', source: 'manifest', entry: 'SKILL.md',
    warnings: [], steps: [], components: [],
    dependencies: slug === 'leaf' ? [] : [{ id: slug === 'parent' ? 'child' : 'leaf', slug: slug === 'parent' ? 'child' : 'leaf', name: slug === 'parent' ? '子智能体' : '末级技能', required: true, status: 'ready' }],
  }));
}

test('the explicit back button walks nested skill details one level at a time without closing the modal', async () => {
  mockNestedDetails();
  vi.spyOn(gateway, 'loadSkills').mockResolvedValue([parent, child, leaf]);
  const onClose = vi.fn();
  render(<SkillModal skill={parent} onClose={onClose} onOpenGuide={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /返回上一级/ })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /子智能体/ }));
  await screen.findByRole('dialog', { name: '子智能体', exact: true });
  fireEvent.click(await screen.findByRole('button', { name: /末级技能/ }));
  await screen.findByRole('dialog', { name: '末级技能', exact: true });
  fireEvent.click(screen.getByRole('button', { name: '返回上一级：子智能体' }));
  await screen.findByRole('dialog', { name: '子智能体', exact: true });
  fireEvent.click(screen.getByRole('button', { name: '返回上一级：父智能体' }));
  await screen.findByRole('dialog', { name: '父智能体', exact: true });
  expect(screen.queryByRole('button', { name: /返回上一级/ })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test('returning while another dependency is opening ignores its late result', async () => {
  mockNestedDetails();
  let resolve!: (skills: typeof leaf[]) => void;
  vi.spyOn(gateway, 'loadSkills').mockResolvedValueOnce([parent, child]).mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
  render(<SkillModal skill={parent} onClose={vi.fn()} onOpenGuide={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /子智能体/ }));
  await screen.findByRole('dialog', { name: '子智能体', exact: true });
  fireEvent.click(await screen.findByRole('button', { name: /末级技能/ }));
  await screen.findByText('正在打开关联技能…');
  fireEvent.click(screen.getByRole('button', { name: '返回上一级：父智能体' }));
  await screen.findByRole('dialog', { name: '父智能体', exact: true });
  await act(async () => resolve([leaf]));
  expect(screen.queryByRole('dialog', { name: '末级技能', exact: true })).toBeNull();
  expect(screen.getByRole('dialog', { name: '父智能体', exact: true })).toBeTruthy();
});
