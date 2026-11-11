import { useEffect, useState } from 'react';
import { api } from '../../services/api';

type SyncRow = { ip: string; name: string; lastAt: number; firstAt: number; count: number; stale: boolean };

/** 接入清单（同步心跳观测）：每台已接入设备请求 /api/skill-stubs/all 即心跳，IP→姓名取登录记录。
 * 网关独立化后保留在门户（心跳数据源在门户侧），随「服务运维」页展示 */
export default function SkillsSyncPanel() {
  const [data, setData] = useState<{ rows: SyncRow[]; staffTotal: number; staffCovered: number } | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    setErr('');
    api.stats.skillSync().then((r) => (r.ok ? setData(r) : setErr(r.message || '加载失败'))).catch(() => setErr('接口不可达'));
  };
  useEffect(load, []);
  const rel = (t: number) => {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    if (m < 1440) return `${Math.floor(m / 60)} 小时前`;
    return `${Math.floor(m / 1440)} 天前`;
  };
  const abs = (t: number) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rows = data?.rows || [];
  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-t2 leading-relaxed">
        每台已接入电脑的技能同步（登录时 / 每 15 分钟 / 手动）都会请求门户壳技能接口，即为一次心跳；姓名按该 IP 最近一次成功登录推导。
        <b className="text-t1">超过 24 小时无心跳</b>说明该设备同步停滞（多为旧版装机只在登录时同步，或计划任务被清理）——可让对应同事重跑门户「使用指引」里的一键安装脚本。
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: '已接入设备', value: rows.length, sub: '按 IP 去重' },
          { label: '其中 24h 内活跃', value: rows.filter((r) => !r.stale).length, sub: '心跳正常' },
          { label: '员工覆盖', value: `${data?.staffCovered ?? '—'} / ${data?.staffTotal ?? '—'}`, sub: '已接入人数 / 在职员工' },
        ].map((c) => (
          <div key={c.label} className="card p-4 flex flex-col gap-1">
            <span className="text-[11px] text-t3">{c.label}</span>
            <span className="text-xl font-semibold font-mono">{c.value}</span>
            <span className="text-[10px] text-t3">{c.sub}</span>
          </div>
        ))}
      </div>
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-t3 text-left border-b border-line">
              <th className="py-2.5 px-4 font-medium">员工</th>
              <th className="py-2.5 px-4 font-medium">设备 IP</th>
              <th className="py-2.5 px-4 font-medium">最后同步</th>
              <th className="py-2.5 px-4 font-medium">首次接入</th>
              <th className="py-2.5 px-4 font-medium">累计同步</th>
              <th className="py-2.5 px-4 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ip} className="border-b border-line/50 last:border-0">
                <td className="py-2.5 px-4">{r.name || <span className="text-t3">未匹配登录记录</span>}</td>
                <td className="py-2.5 px-4 font-mono">{r.ip}</td>
                <td className="py-2.5 px-4" title={abs(r.lastAt)}>{rel(r.lastAt)}</td>
                <td className="py-2.5 px-4 text-t3" title={abs(r.firstAt)}>{abs(r.firstAt)}</td>
                <td className="py-2.5 px-4 font-mono">{r.count}</td>
                <td className="py-2.5 px-4">
                  {r.stale
                    ? <span className="pill bg-dangerSoft text-danger">超 24h 未同步</span>
                    : <span className="pill bg-okSoft text-ok">正常</span>}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={6} className="py-8 text-center text-t3">{data ? '尚无设备接入——等员工运行一键安装脚本后，这里会出现第一条心跳' : '加载中…'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <button className="btn-ghost self-start !text-xs" onClick={load}>刷新</button>
    </div>
  );
}
