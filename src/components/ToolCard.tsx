import type { Tool } from '../types';
import { TYPE_LABELS } from '../types';
import { TYPE_STYLES, DEPT_STYLES } from '../data/tools';

interface Props {
  tool: Tool;
  usage: number;
  isNew?: boolean; // 上架 24h 内：标题后 NEW 徽标（主色调）
  onDetail: (tool: Tool) => void;
}

/** 首页工具卡 v2（三段式）：标题独占首行；描述+标签在左、缩略图（首张页面截图）在右；作者·使用次数独占末行。
 * 未上传截图 → 同尺寸浅色占位 + 居中工具图标，整页网格等高。 */
export default function ToolCard({ tool, usage, isNew, onDetail }: Props) {
  const type = TYPE_STYLES[tool.type];
  const deptStyle = DEPT_STYLES[tool.department];
  const shot = tool.shots?.[0];

  return (
    <button type="button" aria-label={`查看${tool.name}详情`} aria-describedby={`tool-description-${encodeURIComponent(tool.id)}`} className="tool-card focus-ring w-full text-left cursor-pointer h-full flex flex-col gap-2.5 px-[18px] pt-4 pb-3" onClick={() => onDetail(tool)}>
      {/* 行1：标题（最多两行）+ NEW */}
      <div className="flex items-start gap-1.5">
        <h3 className="text-sm font-semibold leading-[1.4] line-clamp-2">{tool.name}</h3>
        {isNew && <span className="mt-0.5 shrink-0 rounded-full bg-accent px-2 py-px text-[10px] font-bold text-primaryForeground">NEW</span>}
      </div>

      {/* 行2：描述预览+标签（左） | 缩略图（右）——描述取「项目描述」开头，最多 2 行省略号截断 */}
      <div className="flex flex-1 min-h-0 gap-3.5">
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <p id={`tool-description-${encodeURIComponent(tool.id)}`} className="text-xs text-t2 leading-[1.55] line-clamp-2">{tool.desc}</p>
          <div className="mt-auto flex flex-wrap gap-1.5">
            <span className={`pill ${type.bg} ${type.fg} font-medium`}>{TYPE_LABELS[tool.type]}</span>
            {(tool.tags || []).slice(0, 2).map((t) => (
              <span key={t} className="pill bg-soft text-t3 font-normal">{t}</span>
            ))}
          </div>
        </div>
        <div className="w-[96px] h-[72px] shrink-0">
          {shot ? (
            <img src={shot} alt="" loading="lazy" className="w-full h-full rounded-[10px] border border-line object-cover" />
          ) : (
            <div className={`w-full h-full rounded-[10px] border border-line bg-soft flex items-center justify-center ${deptStyle ? '' : 'bg-accentSoft'}`}>
              <span
                className={`w-9 h-9 rounded-[11px] flex items-center justify-center text-[17px] font-semibold ${deptStyle?.bg || 'bg-accentSoft'} ${deptStyle?.fg || 'text-accentText'}`}
                style={tool.iconBg && !deptStyle ? { background: tool.iconBg, color: '#17161F' } : undefined}
              >
                {tool.icon}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 行3：作者 · 使用次数（细分隔线） */}
      <div className="mt-0.5 pt-2 border-t border-line flex items-center justify-between text-[11px] text-t3">
        <span>{tool.department} · {tool.owner}</span>
        <span className="font-medium text-accentText">{usage.toLocaleString()} 次使用</span>
      </div>
    </button>
  );
}
