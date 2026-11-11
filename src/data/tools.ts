import type { Tool, ToolType } from '../types';

/**
 * Built-in demo catalog shown before any uploads exist.
 * Replace URLs / owners for your deployment, or clear this list and rely on server seeds.
 */
export const tools: Tool[] = [
  {
    id: '1',
    name: 'Demo Policy Watcher',
    desc: 'Example external tool card for policy monitoring workflows.',
    department: 'Engineering',
    owner: 'Alice Demo',
    url: 'https://example.com/demo-tool',
    type: 'external',
    icon: 'P',
    tags: ['demo'],
    usage: 0,
    likes: 0,
    onlineAt: '2026-01-01',
  },
  {
    id: '2',
    name: 'Demo Region Analyzer',
    desc: 'Example service-style tool entry pointing at localhost.',
    department: 'Operations',
    owner: 'Bob Demo',
    url: 'http://127.0.0.1:8000',
    type: 'external',
    icon: 'R',
    tags: ['demo'],
    usage: 0,
    likes: 0,
    onlineAt: '2026-01-01',
  },
  {
    id: '3',
    name: 'Demo Market Brief',
    desc: 'Example content-generation tool placeholder.',
    department: 'Engineering',
    owner: 'Alice Demo',
    url: 'http://127.0.0.1:8000',
    type: 'external',
    icon: 'M',
    tags: ['demo'],
    usage: 0,
    likes: 0,
    onlineAt: '2026-01-01',
  },
];

export const departments = ['全部', 'Engineering', 'Operations', 'Platform'];

/** Department chip colors */
export const DEPT_STYLES: Record<string, { bg: string; fg: string }> = {
  Engineering: { bg: 'bg-[#E8F1FF] dark:bg-[#1A2740]', fg: 'text-[#2563EB] dark:text-[#93C5FD]' },
  Operations: { bg: 'bg-[#EAF8F0] dark:bg-[#1A2E24]', fg: 'text-[#059669] dark:text-[#6EE7B7]' },
  Platform: { bg: 'bg-[#F3E8FF] dark:bg-[#2A1F3D]', fg: 'text-[#7C3AED] dark:text-[#C4B5FD]' },
};

export const TYPE_STYLES: Record<ToolType, { bg: string; fg: string }> = {
  external: { bg: 'bg-[#EBF2FE] dark:bg-[#1E2A4A]', fg: 'text-[#1D4ED8] dark:text-[#6E9BFF]' },
  local: { bg: 'bg-[#EEEDFE] dark:bg-[#33294F]', fg: 'text-[#5046E5] dark:text-[#C9B8FF]' },
  coze: { bg: 'bg-[#FDEBDD] dark:bg-[#33291A]', fg: 'text-[#9A3412] dark:text-[#FFC46B]' },
  download: { bg: 'bg-[#DDF3EE] dark:bg-[#1A3230]', fg: 'text-[#0F766E] dark:text-[#4ED9C0]' },
  service: { bg: 'bg-[#FDEDF1] dark:bg-[#3A2229]', fg: 'text-[#BE185D] dark:text-[#F9A8CE]' },
};

export function getTool(id: string | undefined): Tool | undefined {
  return tools.find((t) => t.id === id);
}

/** Preset business tags for uploads / filters */
export const BASE_TAGS = ['业务提效', '运营管理', '内容生成', 'demo'];
