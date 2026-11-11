import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { loadAdminStats, listAllRequests, decideRequest as decideRequestApi, closeRequest as closeRequestApi, type AdminStats, type QuotaRequest } from '../../services/workbench';
import { SKILL_GATEWAY_URL } from '../../data/skills';
import { ONE_API } from '../../config';

function fmt(n: number) {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n.toLocaleString('zh-CN');
}

/** 运营总览（原「管理员工作台」合并入管理后台）：One-API KPI / 消耗图表 / 申请审批 / 系统状态 */
export default function OpsDashboard() {
  const [statsRefresh, setStatsRefresh] = useState(0);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsErr, setStatsErr] = useState(false);
  const [requests, setRequests] = useState<QuotaRequest[]>([]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(new Error('统计查询超时')), 60_000);
    setStats(null);
    setStatsErr(false);
    (async () => {
      const r = await api.users.list(controller.signal);
      controller.signal.throwIfAborted();
      if (!r.ok || !Array.isArray(r.users)) throw new Error('用户列表不可用');
      const result = await loadAdminStats(r.users.map((u: { username: string; name: string; dept: string }) =>
        ({ username: u.username, name: u.name, deptShort: u.dept })), controller.signal);
      if (!disposed) setStats(result);
    })().catch(() => { if (!disposed) setStatsErr(true); }).finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [statsRefresh]);

  const refresh = () => {
    listAllRequests().then(setRequests).catch(() => {});
  };
  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending').slice(0, 2);
  const openCount = pending.filter((r) => r.type === 'open').length;
  const expandCount = pending.filter((r) => r.type === 'expand').length;

  const decide = (id: string, ok: boolean) => {
    decideRequestApi(id, ok).then(() => refresh());
  };

  const maxTrend = stats ? Math.max(...stats.trend, 1) : 1;
  const maxDept = stats?.byDept[0]?.used || 1;
  const maxModel = stats?.byModel[0]?.used || 1;

  const kpis = [
    { label: '今日全员消耗', value: stats ? fmt(stats.todayTotal) : statsErr ? '—' : '…', chip: statsErr ? '统计未完成' : stats ? 'One-API 实时' : '加载中', cls: statsErr ? 'bg-warnSoft text-warn' : 'bg-okSoft text-ok' },
    { label: '今日活跃用户', value: stats ? String(stats.activeUsers) : statsErr ? '—' : '…', chip: stats ? `/ ${stats.totalUsers} 人` : '', cls: 'bg-accentSoft text-accentText' },
    {
      label: '待处理事项',
      value: String(pending.length),
      chip: pending.length ? (openCount ? `开通 ${openCount}${expandCount ? ' · 扩容 ' + expandCount : ''}` : `扩容 ${expandCount}`) : '已清空',
      cls: pending.length ? 'bg-warnSoft text-warn' : 'bg-okSoft text-ok',
    },
    { label: '已开通令牌', value: stats ? String(stats.withToken) : statsErr ? '—' : '…', chip: stats ? `未开通 ${stats.totalUsers - stats.withToken}` : '', cls: 'bg-accentSoft text-accentText' },
  ];

  return (
    <div className="flex flex-col min-h-full pb-6">
      {/* Hero */}
      <section className="relative overflow-hidden px-8 pt-10 pb-2">
        <div className="hero-halo hero-halo-1 anim-fade" style={{ width: 520, height: 420, left: -120, top: -140 }} />
        <div className="hero-halo hero-halo-2 anim-fade" style={{ width: 580, height: 440, right: -100, top: -120 }} />
        <div className="relative">
          <h1 className="text-[26px] font-semibold leading-tight">管理员工作台</h1>
          <p className="mt-2 text-[13px] text-t2">
            总经办 · 系统管理员 ｜{' '}
            {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}{' '}
            ｜ {statsErr ? '统计未完成' : stats ? 'One-API 实时数据 · 刷新更新' : '正在读取完整统计'}
          </p>
          <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpis.map((k) => (
              <div key={k.label} className="card bg-soft dark:bg-card p-[18px] flex flex-col gap-1.5">
                <span className="text-xs text-t2">{k.label}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[28px] font-semibold leading-none">{k.value}</span>
                  <span className={`pill ${k.cls}`}>{k.chip}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-8 pt-8 pb-10 flex flex-col lg:flex-row gap-4 items-stretch">
        {/* 左列 */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          {/* 近14日趋势 */}
          <div className="card p-5 flex flex-col gap-3.5">
            <div className="flex items-center">
              <h2 className="text-[15px] font-semibold">全员令牌消耗（近 14 日）</h2>
              <span className="flex-1" />
              <span className="text-[11px] text-t3">今日 {stats ? fmt(stats.trend[13]) : statsErr ? '—' : '…'} tokens</span>
            </div>
            {stats ? <div className="flex items-end gap-2.5 h-[120px]">
              {stats.trend.map((v, i) => (
                <div
                  key={i}
                  title={fmt(v)}
                  className={`flex-1 rounded transition-all ${i === 13 ? 'bg-accent' : 'bg-accent/25 dark:bg-[#33294F]'}`}
                  style={{ height: `${Math.max((v / maxTrend) * 100, 6)}%` }}
                />
              ))}
            </div> : <div className="h-[120px] flex flex-col items-center justify-center gap-3">
              {statsErr ? <>
                <p role="alert" className="text-xs text-warn">统计未完成，未展示部分数据。请重试。</p>
                <button className="btn-ghost !text-xs" onClick={() => setStatsRefresh((v) => v + 1)}>重试统计</button>
              </> : <p role="status" className="text-xs text-t3">正在读取完整统计…</p>}
            </div>}
            <div className="flex items-center text-[10px] text-t3">
              <span>13 天前</span>
              <span className="flex-1" />
              <span className="text-accentText font-medium">今日</span>
            </div>
          </div>

          {/* 部门排行 */}
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex items-center">
              <h2 className="text-[15px] font-semibold">部门消耗排行（今日）</h2>
              <span className="flex-1" />
              <span className="text-xs text-accentText cursor-pointer hover:underline">明细 →</span>
            </div>
            {(stats?.byDept || []).slice(0, 5).map((d, i) => (
              <div key={d.dept} className="flex flex-col gap-1.5">
                <div className="flex items-center text-xs">
                  <span className="font-medium">{d.dept}</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-t3 font-mono">
                    {d.used.toLocaleString()} · {d.pct}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-soft dark:bg-[#13121C] overflow-hidden">
                  <div
                    className={`h-full rounded-full ${['bg-accent', 'bg-[#7B6CF6] dark:bg-[#B49CFF]', 'bg-[#9B8FF8] dark:bg-[#C9B8FF]', 'bg-[#B0A4F8] dark:bg-[#D9CDFB]'][Math.min(i, 3)]}`}
                    style={{ width: `${Math.max((d.used / maxDept) * 100, 2)}%` }}
                  />
                </div>
              </div>
            ))}
            {stats && stats.byDept.length === 0 && <p className="text-xs text-t3">今天还没有消耗记录。</p>}
          </div>

          {/* 模型分布 */}
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex items-center">
              <h2 className="text-[15px] font-semibold">模型消耗分布（今日）</h2>
              <span className="flex-1" />
              <span className="text-xs text-accentText cursor-pointer hover:underline">明细 →</span>
            </div>
            {(stats?.byModel || []).map((m, i) => (
              <div key={m.model} className="flex flex-col gap-1.5">
                <div className="flex items-center text-xs">
                  <span className="font-medium font-mono">{m.model}</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-t3 font-mono">
                    {m.used.toLocaleString()} · {m.pct}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-soft dark:bg-[#13121C] overflow-hidden">
                  <div
                    className={`h-full rounded-full ${['bg-accent', 'bg-[#7B6CF6] dark:bg-[#B49CFF]', 'bg-[#B0A4F8] dark:bg-[#D9CDFB]'][Math.min(i, 2)]}`}
                    style={{ width: `${Math.max((m.used / maxModel) * 100, 2)}%` }}
                  />
                </div>
              </div>
            ))}
            {stats && stats.byModel.length === 0 && <p className="text-xs text-t3">今天还没有调用记录。</p>}
          </div>
        </div>

        {/* 右列 */}
        <div className="w-full lg:w-[320px] shrink-0 flex flex-col gap-4">
          {/* 待办 */}
          <div className="card p-5 flex flex-col gap-3">
            <div className="flex items-center">
              <h2 className="text-[15px] font-semibold">待办事项</h2>
              <span className="flex-1" />
              {pending.length > 0 && (
                <span className="rounded-full bg-warnSoft text-warn px-2 py-px text-[11px] font-semibold font-mono">
                  {pending.length}
                </span>
              )}
            </div>
            {pending.length === 0 && <p className="text-xs text-t3">暂无待处理事项 ✓</p>}
            {pending.map((r) =>
              r.type === 'open' ? (
                <div key={r.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-medium">
                      {r.name} · {r.dept}
                    </span>
                    <span className="pill bg-warnSoft text-warn">开通申请</span>
                  </div>
                  <div className="text-[11px] text-t2">用途：{r.reason} · {r.createdAt}</div>
                  <div className="flex items-center gap-3">
                    <a
                      href={ONE_API.adminUrl + '/console/token'}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-medium text-accentText hover:underline"
                    >
                      去 One-API 开通 →
                    </a>
                    <button
                      className="text-[11px] text-t3 hover:text-ok hover:underline"
                      onClick={() => {
                        closeRequestApi(r.id).then(() => refresh());
                      }}
                    >
                      标记已处理
                    </button>
                  </div>
                </div>
              ) : (
                <div key={r.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-medium">
                      {r.name} · {r.dept}
                    </span>
                    <span className="pill bg-accentSoft text-accentText">扩容申请</span>
                    <span className="flex-1" />
                    <span className="text-[11px] text-t3 font-mono">
                      {(r.from! / 10000).toFixed(0)}万→{(r.to! / 10000).toFixed(0)}万/日
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-t2 flex-1 truncate">
                      {r.reason} · {r.createdAt}
                    </span>
                    <button className="text-[11px] font-medium text-ok hover:underline" onClick={() => decide(r.id, true)}>
                      通过
                    </button>
                    <button className="text-[11px] text-t3 hover:text-t1 hover:underline" onClick={() => decide(r.id, false)}>
                      驳回
                    </button>
                  </div>
                </div>
              ),
            )}
            {decided.map((r) => (
              <div key={r.id} className="text-[11px] text-t3">
                {r.name} 的{r.type === 'open' ? '开通' : '扩容'}申请 · {r.status === 'approved' ? '✓ 已处理' : '✕ 已驳回'} · {r.createdAt}
              </div>
            ))}
            <Link to="/admin" className="flex items-center gap-2 group">
              <span className="pill bg-[#EBF2FE] text-[#3B82F6] dark:bg-[#1E2A4A] dark:text-[#6E9BFF]">工具审核</span>
              <span className="text-xs group-hover:text-accentText">提交 / 更新审核请前往审核中心</span>
              <span className="flex-1" />
              <span className="text-[11px] font-medium text-accentText">去处理 →</span>
            </Link>
          </div>

          {/* 系统状态 */}
          <div className="card p-5 flex flex-col gap-2.5">
            <h2 className="text-[15px] font-semibold">系统状态</h2>
            {[
              ['统计数据', statsErr ? '● 未完成' : stats ? '● 已更新' : '…', statsErr],
              ['令牌开通', stats ? `${stats.withToken} / ${stats.totalUsers} 人` : '…', false],
              ['每日限额', '60M tokens / 令牌', false],
              ['门户版本', 'v2.3.0', false],
            ].map(([k, v, warn]) => (
              <div key={k as string} className="flex items-center justify-between">
                <span className="text-xs text-t2">{k as string}</span>
                <span className={`text-xs ${warn ? 'text-warn' : 'text-ok'}`}>{v as string}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
