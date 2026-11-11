import { useEffect, useState } from 'react';
import { api, type GwAlert } from '../../services/api';

const TYPE_LABEL: Record<string, string> = { scrape: '疑似刷库', auth: '令牌异常', rollback: '版本回滚', stale: '久未更新' };

const RULES = [
  '① 疑似刷库（实锤制）：10 分钟内拉取 ≥4 份不同参考且零产出 → 先进入待确认，宽限 10 分钟内交出产出自动销案；仅「整库搬走（拉走 ≥80% 参考文件）」或「24 小时内 3 个时段只拿不交」才告警',
  '② 令牌异常：5 分钟内鉴权失败 ≥5 次（免令牌模式下不触发）',
  '③ 版本回滚：任何技能发生版本回滚即记录，便于追溯',
  '④ 久未更新：技能超过 60 天未更新则提示（低优先级）',
];

/** 技能管理 · 告警页签：规则说明 + 级别/状态筛选 + 待处理（红/橙）与已处理（灰）列表 */
export default function SkillsAlerts({ onChanged }: { onChanged?: () => void }) {
  const [alerts, setAlerts] = useState<GwAlert[] | null>(null);
  const [err, setErr] = useState('');
  const [level, setLevel] = useState('');
  const [status, setStatus] = useState('open');

  const load = () => {
    setErr('');
    api.gateway
      .alerts({ level, status })
      .then((a) => (Array.isArray(a) ? setAlerts(a) : setErr('告警返回异常')))
      .catch(() => setErr('技能中心不可达，请稍后重试'));
  };
  useEffect(load, [level, status]);

  const resolve = async (a: GwAlert) => {
    if (!window.confirm('确认标记为已处理？处理后从待处理列表移除，记录保留。')) return;
    const r = await api.gateway.resolveAlert(a.id);
    if (r && r.detail) return setErr('处理失败：' + r.detail);
    load();
    onChanged?.();
  };

  const inputCls = 'h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line px-2.5 text-xs text-t1 outline-none';

  return (
    <div className="p-6 pt-4 flex flex-col gap-4">
      {/* 规则说明 */}
      <div className="card p-4 text-xs text-t2 leading-[1.9]">
        <span className="font-semibold text-t1">告警规则（网关自动生成）</span>
        <br />
        {RULES.map((r) => (
          <span key={r}>{r}<br /></span>
        ))}
      </div>

      {/* 筛选 */}
      <div className="flex gap-2 items-center">
        <select className={inputCls} value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">全部级别</option>
          <option value="high">高级</option>
          <option value="low">提示</option>
        </select>
        <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">待处理</option>
          <option value="resolved">已处理</option>
          <option value="">全部</option>
        </select>
        <span className="flex-1" />
        <span className="text-xs text-t3">{alerts?.length ?? '…'} 条</span>
      </div>

      {err && <div className="card p-4 text-sm text-danger bg-dangerSoft/40">{err}</div>}

      <div className="grid md:grid-cols-2 gap-3">
        {(alerts || []).map((a) => {
          const high = a.level === 'high';
          const open = a.status !== 'resolved';
          return (
            <div
              key={a.id}
              className={`rounded-xl p-4 flex items-start gap-3 ${
                !open ? 'bg-soft dark:bg-white/[0.03] opacity-75' : high ? 'bg-dangerSoft/60 dark:bg-dangerSoft/20' : 'bg-warnSoft/60 dark:bg-warnSoft/20'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className={`text-[13px] font-semibold ${!open ? 'text-t3' : high ? 'text-danger' : 'text-warn'}`}>
                  {high ? '高级' : '提示'} · {TYPE_LABEL[a.type || ''] || a.type || '异常'}
                  {open ? '（待处理）' : '（已处理）'}
                </div>
                <div className={`text-xs mt-1 leading-relaxed ${!open ? 'text-t3' : high ? 'text-danger/80' : 'text-warn/80'}`}>
                  {a.subject ? `${a.subject}：` : ''}
                  {a.description}
                </div>
                <div className="text-[10px] text-t3 mt-1 font-mono">{(a.ts || '').slice(5, 16)} 触发</div>
              </div>
              {open && (
                <button
                  className="shrink-0 px-4 h-[30px] rounded-lg bg-card dark:bg-[#17161F] border border-line text-xs font-medium hover:border-current self-center"
                  onClick={() => resolve(a)}
                >
                  处理
                </button>
              )}
            </div>
          );
        })}
        {alerts && alerts.length === 0 && (
          <div className="md:col-span-2 card p-12 text-center text-sm text-t3">当前筛选下没有告警</div>
        )}
        {!alerts && !err && <div className="md:col-span-2 card p-12 text-center text-sm text-t3">加载中…</div>}
      </div>

      <div className="text-xs text-t3 leading-relaxed">
        告警由技能中心网关按上述规则自动生成；「处理」即归档（记录保留）；高级告警建议先在「调用日志」按对应技能 / IP 核实使用人，再行处置。
      </div>
    </div>
  );
}
