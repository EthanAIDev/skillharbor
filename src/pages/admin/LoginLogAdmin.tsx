import { useEffect, useState } from 'react';
import { api } from '../../services/api';

interface LoginRow {
  t: number;
  u: string;
  n: string;
  ip: string;
  d: string;
  ok: boolean;
  remote: boolean;
}

const fmtDT = (t: number) =>
  new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 管理后台 · 登录记录：每次登录的 IP / 设备 / 状态，异地登录高亮（仅安全审计用途） */
export default function LoginLogAdmin() {
  const [rows, setRows] = useState<LoginRow[]>([]);
  const [onlyRemote, setOnlyRemote] = useState(false);

  useEffect(() => {
    api.logins().then((r) => r.ok && setRows(r.rows || []));
  }, []);

  const list = onlyRemote ? rows.filter((r) => r.remote || !r.ok) : rows;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="pill bg-accentSoft text-accentText font-medium">最近 {rows.length} 条</span>
        <span className={`pill font-normal cursor-pointer ${onlyRemote ? 'bg-warnSoft text-warn' : 'bg-soft text-t3'}`} onClick={() => setOnlyRemote((v) => !v)}>
          {onlyRemote ? '仅看异常（异地 / 失败）' : '仅看异常（异地 / 失败）'}
        </span>
        <span className="flex-1" />
        <span className="text-xs text-t3">IP 仅用于安全审计与异常排查，保留最近 4000 条</span>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex bg-soft dark:bg-[#16151F] border-b border-line min-w-[760px]">
          <span className="th w-[130px]">时间</span>
          <span className="th w-[120px]">账号</span>
          <span className="th w-[110px]">姓名</span>
          <span className="th w-[150px]">IP</span>
          <span className="th w-[130px]">设备</span>
          <span className="th w-[150px]">状态</span>
        </div>
        {list.map((r, i) => (
          <div
            key={i}
            className={`flex border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03] min-w-[760px] ${r.remote || !r.ok ? 'bg-warnSoft/40 dark:bg-warnSoft/10' : ''}`}
          >
            <span className="td w-[130px] font-mono text-[11px]">{fmtDT(r.t)}</span>
            <span className="td w-[120px] font-mono text-[11px]">{r.u}</span>
            <span className="td w-[110px]">{r.n === r.u ? '—' : r.n}</span>
            <span className="td w-[150px] font-mono text-[11px]">{r.ip}</span>
            <span className="td w-[130px]">{r.d}</span>
            <span className="td w-[150px]">
              {!r.ok ? (
                <span className="pill bg-dangerSoft text-danger font-normal">登录失败</span>
              ) : r.remote ? (
                <span className="pill bg-warnSoft text-warn font-normal">异地登录，已提醒</span>
              ) : (
                <span className="pill bg-okSoft text-ok font-normal">正常</span>
              )}
            </span>
          </div>
        ))}
        {list.length === 0 && <div className="p-12 text-center text-sm text-t3">暂无记录</div>}
      </div>
    </div>
  );
}
