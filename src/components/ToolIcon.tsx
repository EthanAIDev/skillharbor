import type { Tool } from '../types';
import { DEPT_STYLES } from '../data/tools';

const SIZES: Record<string, string> = {
  sm: 'w-6 h-6 rounded-md text-[12px]',
  md: 'w-[38px] h-[38px] rounded-[10px] text-base',
  lg: 'w-14 h-14 rounded-[14px] text-[22px]',
  xl: 'w-16 h-16 rounded-[14px] text-[24px]',
};

/** 工具图标：有网页图标用图片，否则文字块（用户上传工具支持自定义背景色与 2 字符） */
export default function ToolIcon({ tool, size = 'md' }: { tool: Pick<Tool, 'icon' | 'iconUrl' | 'iconBg' | 'department'>; size?: keyof typeof SIZES }) {
  const base = SIZES[size] + ' flex items-center justify-center font-semibold shrink-0 overflow-hidden';
  if (tool.iconUrl) {
    return <img src={tool.iconUrl} alt="" className={base + ' object-cover border border-line bg-soft'} loading="lazy" />;
  }
  if (tool.iconBg) {
    return (
      <span className={base} style={{ background: tool.iconBg, color: '#17161F' }}>
        {tool.icon}
      </span>
    );
  }
  const st = DEPT_STYLES[tool.department] || DEPT_STYLES['研究院'];
  return <span className={`${base} ${st.bg} ${st.fg}`}>{tool.icon}</span>;
}
