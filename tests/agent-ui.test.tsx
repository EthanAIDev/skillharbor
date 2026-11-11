import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import SkillModal from '../src/components/SkillModal';
import * as gateway from '../src/services/skillsGateway';
import * as structures from '../src/services/agentStructure';
import type { Skill } from '../src/types';

vi.mock('../src/components/EvalSection', () => ({ default: () => null }));
const graph = (slug: string, kind: 'agent' | 'skill', runtimeRequirements?: unknown) => ({
  schemaVersion: 1,
  slug,
  version: 'v1',
  kind,
  source: 'manifest',
  entry: 'SKILL.md',
  warnings: [],
  components: [],
  dependencies: [],
  steps: [],
  ...(runtimeRequirements === undefined ? {} : { runtimeRequirements }),
});
const skill = (id = 'a', kind: 'agent' | 'skill' = 'skill'): Skill => ({
  id,
  name: `资源${id}`,
  kind,
  version: 'v1',
  icon: '技',
  category: '测试',
  usage: 0,
});
const md = () =>
  vi.spyOn(gateway, 'loadSkillMd').mockResolvedValue({ slug: 'a', version: 'v1', content: '正文' });

test.each(['agent', 'skill'] as const)(
  'published %s shows declared runtime capabilities without presenting child-skill links',
  async (kind) => {
    md();
    vi.spyOn(structures, 'loadAgentGraph').mockResolvedValue(
      graph('a', kind, ['浏览器自动化工具', '项目查询接口']) as structures.AgentGraph,
    );
    render(<SkillModal skill={skill('a', kind)} onClose={() => {}} onOpenGuide={() => {}} />);
    const requirements = await screen.findByRole('region', { name: '运行环境要求' });
    expect(requirements.textContent).toContain('浏览器自动化工具');
    expect(requirements.textContent).toContain('项目查询接口');
    expect(requirements.textContent).toContain('平台未验证实际可用性');
    expect(within(requirements).queryByRole('button')).toBeNull();
    expect(within(requirements).queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: '关闭详情' })).toBeTruthy();
  },
);

test('switching resources invalidates old runtime requirements and ignores a late graph', async () => {
  md();
  let resolve!: (value: structures.AgentGraph) => void;
  const old = new Promise<structures.AgentGraph>((r) => {
    resolve = r;
  });
  vi.spyOn(structures, 'loadAgentGraph')
    .mockReturnValueOnce(old)
    .mockResolvedValue(graph('b', 'skill', ['新导出工具']) as structures.AgentGraph);
  const props = { onClose: () => {}, onOpenGuide: () => {} };
  const { rerender } = render(<SkillModal skill={skill('a')} {...props} />);
  rerender(<SkillModal skill={skill('b')} {...props} />);
  await screen.findByText('新导出工具');
  await act(async () => resolve(graph('a', 'skill', ['过期浏览器工具']) as structures.AgentGraph));
  expect(screen.queryByText('过期浏览器工具')).toBeNull();
});

test('a malformed persisted runtime declaration is a retryable read error, while legacy absence remains valid', async () => {
  md();
  vi.mocked(fetch)
    .mockResolvedValueOnce(new Response(JSON.stringify(graph('a', 'skill', null))))
    .mockResolvedValueOnce(new Response(JSON.stringify(graph('a', 'skill'))));
  render(<SkillModal skill={skill('a')} onClose={() => {}} onOpenGuide={() => {}} />);
  const error = await screen.findByRole('alert');
  expect(error.textContent).toContain('运行环境要求格式异常');
  fireEvent.click(within(error).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.queryByRole('region', { name: '运行环境要求' })).toBeNull();
});

test('a simple skill structure read failure offers retry instead of claiming no runtime requirements', async () => {
  md();
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: '暂时无法读取运行环境要求' }), { status: 503 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(graph('a', 'skill', ['查询接口']))));
  render(<SkillModal skill={skill('a')} onClose={() => {}} onOpenGuide={() => {}} />);
  const error = await screen.findByRole('alert');
  expect(error.textContent).toContain('暂时无法读取运行环境要求');
  expect(screen.queryByRole('region', { name: '运行环境要求' })).toBeNull();
  fireEvent.click(within(error).getByRole('button', { name: '重试' }));
  await screen.findByText('查询接口');
  expect(screen.queryByRole('alert')).toBeNull();
});
