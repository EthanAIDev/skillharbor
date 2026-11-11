import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentStructure from '../src/components/AgentStructure';
import type { AgentGraph } from '../src/services/agentStructure';

const graph: AgentGraph = {
  schemaVersion: 1, slug: 'sample', version: '1.0.0', kind: 'agent', source: 'manifest', entry: 'SKILL.md', warnings: [],
  components: [{ id: 'calc', name: '包内计算', kind: 'skill', path: 'internal-skills/calc.md', visibility: 'internal', status: 'ready' }],
  dependencies: [
    { id: 'report', name: '报告', slug: 'report-skill', source: 'registry', required: true, status: 'ready' },
    { id: 'future', name: '预审', source: 'registry', required: false, status: 'planned' },
    { id: 'wrong', name: '失配技能', slug: 'unknown-v2', source: 'registry', required: true, status: 'missing' },
  ],
  steps: [{ id: 'produce', task: '计算并出报告', executor: 'dispatch', targets: ['component:calc', 'dependency:report', 'dependency:future'] }],
};

describe('AgentStructure', () => {
  it('opens every ready target in a step using the correct namespace', () => {
    const component = vi.fn(); const dependency = vi.fn();
    render(<AgentStructure graph={graph} name="样例智能体" onComponent={component} onDependency={dependency} />);
    fireEvent.click(screen.getByRole('button', { name: /包内计算/ }));
    fireEvent.click(screen.getByRole('button', { name: /报告/ }));
    expect(component).toHaveBeenCalledWith(graph.components[0]);
    expect(dependency).toHaveBeenCalledWith(graph.dependencies[0]);
    expect(screen.getByText(/计算并出报告/)).toBeTruthy();
  });
  it('explains planned/missing targets instead of offering dead links, including unreferenced dependencies', () => {
    render(<AgentStructure graph={graph} name="样例智能体" onComponent={vi.fn()} onDependency={vi.fn()} />);
    expect(screen.getByText('待建设')).toBeTruthy();
    expect(screen.getByText('未找到对应技能')).toBeTruthy();
    expect(screen.getByText('失配技能')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /预审|失配技能/ })).toBeNull();
  });
});

