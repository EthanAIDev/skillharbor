import { useVersionCheck } from '../hooks/useVersionCheck';

/**
 * 平台更新提醒卡（定稿形态）：右上角、不自动收起。
 * normal：正常的「平台已更新」，展示更新内容，立即刷新 / 暂不刷新；
 * broken：版本信息与实际资源错位（部署不完整），建议刷新重试并联系管理员。
 */
export default function UpdateToast() {
  const { remote, snooze } = useVersionCheck();
  if (!remote) return null;
  const { info, mode } = remote;
  const broken = mode === 'broken';

  const notes = info.notes?.length ? info.notes : ['功能优化与问题修复'];

  return (
    <div className="anim-toast fixed top-20 right-4 z-50 w-[364px] max-sm:left-3 max-sm:right-3 max-sm:w-auto card p-5 shadow-[0_16px_48px_rgba(0,0,0,0.22)]">
      <button
        onClick={() => snooze(info)}
        title={broken ? '知道了' : '暂不刷新'}
        className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft text-sm"
      >
        ✕
      </button>

      <div className="flex items-center gap-3 mb-3.5 pr-7">
        <div
          className={`w-[42px] h-[42px] rounded-xl flex items-center justify-center text-[19px] shrink-0 ${
            broken ? 'bg-warnSoft' : 'bg-gradient-to-br from-accent to-accent/70'
          }`}
        >
          {broken ? '⚠️' : '🚀'}
        </div>
        <div>
          <div className="text-[14.5px] font-bold">{broken ? '平台更新数据异常' : '平台已更新'}</div>
          <div className="text-[11.5px] text-t3 font-mono mt-0.5">
            v{info.version} · {info.buildTime}
          </div>
        </div>
      </div>

      {broken ? (
        <div className="rounded-xl bg-warnSoft px-3.5 py-3 mb-3 text-[12.5px] text-warn leading-[1.8]">
          检测到平台版本信息与实际资源不一致，可能部署未完成。可尝试刷新重试；若持续出现此提示，请联系管理员检查部署。
        </div>
      ) : (
        <div className="rounded-xl bg-soft px-3.5 py-3 mb-3 max-h-[188px] overflow-y-auto overscroll-contain">
          <div className="text-[11px] text-t3 mb-1.5">本次更新内容</div>
          <ul>
            {notes.map((n, i) => (
              <li key={i} className="text-[12.5px] text-t2 leading-[1.85] pl-4 relative">
                <span className="absolute left-[2px] top-[9px] w-[5px] h-[5px] rounded-full bg-accent" />
                {n}
              </li>
            ))}
          </ul>
          {notes.length > 3 && <div className="text-[10px] text-t3 text-center mt-1.5">↓ 滚动查看其余 {notes.length - 3} 条</div>}
        </div>
      )}

      <div className="flex justify-between text-[11px] text-t3 mb-3.5">
        <span>发布时间：{info.buildTime}</span>
        <span>{broken ? '异常已记录' : '刷新约 1~2 秒'}</span>
      </div>

      <div className="flex gap-2">
        <button onClick={() => location.reload()} className="btn-primary flex-1 h-9 !text-[12.5px]">
          {broken ? '刷新试试' : '立即刷新'}
        </button>
        <button
          onClick={() => snooze(info)}
          className="flex-1 h-9 rounded-[9px] border border-line text-[12.5px] text-t2 hover:text-t1 transition-colors"
        >
          {broken ? '知道了' : '暂不刷新'}
        </button>
      </div>
    </div>
  );
}
