import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../services/api';
import { tools as staticTools } from '../../data/tools';
import { ZbModal } from '../../components/ZbModal';

/* ============ 自绘图表（零依赖，纯 div） ============ */

/** 柱状图：data = [{label, value, highlight?}] */
function BarChart({ data, height = 150 }: { data: { label: string; value: number; highlight?: boolean }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-1.5" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0 group" title={`${d.label} · ${d.value}`}>
          <span className="text-[10px] font-mono text-t3">{d.value || ''}</span>
          <div
            className={`w-full rounded-t-[4px] min-h-[2px] transition-colors ${d.highlight ? 'bg-accent' : 'bg-accent/45 group-hover:bg-accent/75'}`}
            style={{ height: `${Math.max(3, (d.value / max) * 100)}%` }}
          />
          <span className="text-[9px] font-mono text-t3 truncate w-full text-center">{d.label}</span>
        </div>
      ))}
      {data.length === 0 && <div className="w-full text-center text-xs text-t3" style={{ lineHeight: `${height}px` }}>暂无数据</div>}
    </div>
  );
}

/** 横条：label + 比例条 + 数值（部门占比 / TOP 工具 / 技能排行） */
function HBarList({ rows, unit = '', onClick }: { rows: { label: string; value: number }[]; unit?: string; onClick?: (row: { label: string; value: number }) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div
          key={i}
          className={`flex items-center gap-2.5 text-xs ${onClick ? 'cursor-pointer hover:bg-soft/60 rounded-lg px-1.5 py-1 -mx-1.5' : ''}`}
          onClick={() => onClick?.(r)}
        >
          <span className="w-[150px] truncate text-t2 shrink-0" title={r.label}>{r.label}</span>
          <div className="flex-1 h-[14px] rounded-full bg-soft dark:bg-white/[0.05] overflow-hidden">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="font-mono text-t1 w-[64px] text-right shrink-0">{r.value.toLocaleString()}{unit}</span>
          <span className="font-mono text-[10px] text-t3 w-[40px] text-right shrink-0">{total ? Math.round((r.value / total) * 100) : 0}%</span>
        </div>
      ))}
      {rows.length === 0 && <div className="py-8 text-center text-xs text-t3">暂无数据</div>}
    </div>
  );
}

/** 漏斗：逐级递减横条（load_skill → read_reference → read_asset → report_output） */
function Funnel({ steps }: { steps: { action: string; count: number }[] }) {
  const top = Math.max(1, ...steps.map((s) => s.count));
  return (
    <div className="flex flex-col gap-2.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].count : s.count;
        return (
          <div key={s.action} className="flex flex-col gap-1">
            <div className="flex items-center gap-2.5 text-xs">
              <span className="font-mono text-t2 w-[120px] truncate" title={s.action}>{s.action}</span>
              <span className="font-mono text-t1 font-semibold w-[44px] text-right">{s.count.toLocaleString()}</span>
              <span className="font-mono text-[10px] text-t3">{i > 0 && prev ? `${Math.round((s.count / prev) * 100)}%` : '入口'}</span>
            </div>
            <div className="h-[26px] rounded-lg bg-accent/15 overflow-hidden">
              <div className="h-full rounded-lg bg-accent/60" style={{ width: `${Math.max(4, (s.count / top) * 100)}%` }} />
            </div>
          </div>
        );
      })}
      {steps.length === 0 && <div className="py-8 text-center text-xs text-t3">暂无调用数据</div>}
    </div>
  );
}

/* ============ 数据结构 ============ */

interface StatTool {
  id: string;
  name: string;
  owner: string;
  department: string;
  days: Record<string, number>;
  total: number;
  users: number;
}
interface StatData {
  month: string;
  config: { dailyLimit: number };
  days: string[];
  tools: StatTool[];
  owners: { owner: string; department: string; total: number; tools: number; users: number }[];
  totalClicks: number;
  activeUsers: number;
  anomalies: { day: string; ip: string; users: { u: string; n: string }[] }[];
  trend30: { day: string; count: number }[];
}

interface Props {
  focusToolId: string;
  onDoneFocus: () => void;
  onOpenSkillLogs: (slug: string) => void;
}

const ACTION_LABEL: Record<string, string> = {
  load_skill: 'load_skill（技能加载）',
  read_reference: 'read_reference（读参考）',
  read_asset: 'read_asset（读资产）',
  report_output: 'report_output（写产出）',
};

/** 统计看板：工具 / 技能 两口径分列展示，自绘图表 + 明细下钻 */
export default function StatsDashboard({ focusToolId, onDoneFocus, onOpenSkillLogs }: Props) {
  const [tab, setTab] = useState<'tools' | 'skills'>('tools');

  /* ---------- 工具口径 ---------- */
  const [month, setMonth] = useState(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 7));
  const [data, setData] = useState<StatData | null>(null);
  const [onlineTools, setOnlineTools] = useState(0);
  const [toolNames, setToolNames] = useState<Record<string, string>>({});
  const [limitInput, setLimitInput] = useState('');
  const [toast, setToast] = useState('');
  const [dayDetail, setDayDetail] = useState<{ tool: StatTool; day: string; rows: any[] } | null>(null);
  const [focusRows, setFocusRows] = useState<{ day: string; count: number }[] | null>(null);
  const [monthLoading, setMonthLoading] = useState(true);
  const [monthError, setMonthError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const currentMonth = useRef(month);
  const monthRequest = useRef(0), detailRequest = useRef(0), saveRequest = useRef(0);
  const closeDetail = () => {
    detailRequest.current++;
    setDayDetail(null); setFocusRows(null); setDetailLoading(false); setDetailError('');
  };
  const changeMonth = (next: string) => {
    if (!next || next === currentMonth.current) return;
    currentMonth.current = next;
    monthRequest.current++; saveRequest.current++;
    setData(null); setLimitInput(''); setMonthError(''); setMonthLoading(true); setSaving(false);
    closeDetail(); setMonth(next);
  };

  const loadMonth = async (m: string) => {
    if (!alive.current || m !== currentMonth.current) return;
    const request = ++monthRequest.current;
    const current = () => alive.current && request === monthRequest.current && m === currentMonth.current;
    setData(null); setMonthLoading(true); setMonthError('');
    closeDetail();
    try {
      const r = await api.stats.admin(m);
      if (!current()) return;
      if (!r.ok || r.month !== m) throw new Error(r.message || '统计读取失败，请重试');
      setData(r);
      setLimitInput(String(r.config?.dailyLimit ?? 5));
    } catch (error) {
      if (current()) setMonthError(error instanceof Error ? error.message : '统计读取失败，请重试');
    } finally {
      if (current()) setMonthLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void loadMonth(month);
    return () => { alive.current = false; monthRequest.current++; detailRequest.current++; saveRequest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    api.adminTools.list().then((r) => {
      if (!alive.current || !r.ok) return;
      const extras = r.extra || [];
      const names: Record<string, string> = {};
      for (const t of extras) names[t.id] = t.name;
      setToolNames(names);
      setOnlineTools(extras.filter((t) => t.status !== 'offline').length + staticTools.length - (r.builtinOffline || []).length);
    });
  }, []);

  /* 工具管理页「统计」跳转：定位该工具当月逐日，点击日期下钻 */
  useEffect(() => {
    if (!focusToolId || !data) return;
    detailRequest.current++; setDetailLoading(false); setDetailError('');
    const t = data.tools.find((x) => x.id === focusToolId);
    const name = t?.name || toolNames[focusToolId] || focusToolId;
    const rows = (data.days || []).slice().sort().map((d) => ({ day: d, count: t?.days[d] || 0 }));
    setFocusRows(rows);
    setDayDetail({ tool: t || ({ id: focusToolId, name, owner: '—', department: '—', days: {}, total: 0, users: 0 } as StatTool), day: '', rows: [] });
    onDoneFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToolId, data]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 2400);
  };
  const openCell = async (tool: StatTool, day: string) => {
    const m = currentMonth.current, owner = monthRequest.current, request = ++detailRequest.current;
    const current = () => alive.current && m === currentMonth.current && owner === monthRequest.current && request === detailRequest.current;
    setDayDetail({ tool, day, rows: [] }); setFocusRows(null); setDetailLoading(true); setDetailError('');
    try {
      const r = await api.stats.detail(tool.id, day);
      if (!current()) return;
      if (!r.ok) throw new Error(r.message || '明细读取失败，请重试');
      setDayDetail({ tool, day, rows: r.rows || [] });
    } catch (error) {
      if (current()) setDetailError(error instanceof Error ? error.message : '明细读取失败，请重试');
    } finally {
      if (current()) setDetailLoading(false);
    }
  };
  const saveLimit = async () => {
    if (saving || monthLoading || !data) return;
    const m = currentMonth.current, request = ++saveRequest.current;
    const current = () => alive.current && m === currentMonth.current && request === saveRequest.current;
    setSaving(true);
    try {
      const r = await api.stats.setConfig(Number(limitInput));
      if (!current()) return;
      if (!r.ok) { flash(r.message || '保存失败'); return; }
      flash(r.message || '已保存');
      await loadMonth(m);
    } catch { if (current()) flash('保存连接中断，请重试'); }
    finally { if (current()) setSaving(false); }
  };

  const days = data?.days || [];
  const monthDays = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }, [month]);

  const depts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of data?.tools || []) map.set(t.department, (map.get(t.department) || 0) + t.total);
    return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [data]);

  const top5 = useMemo(
    () => (data?.tools || []).slice(0, 5).map((t) => ({ label: t.name, value: t.total })),
    [data],
  );

  const kpi = {
    count: data?.totalClicks ?? 0,
    users: data?.activeUsers ?? 0,
    per: data && data.activeUsers ? Math.round((data.totalClicks / data.activeUsers) * 10) / 10 : 0,
  };

  /* ---------- 技能口径 ---------- */
  const [ov, setOv] = useState<{ skills_total?: number; skills_enabled?: number; calls_7d?: number; calls_today?: number; total_calls?: number; active_ips_7d?: number } | null>(null);
  const [gwTrend, setGwTrend] = useState<{ date: string; count: number }[] | null>(null);
  const [funnel, setFunnel] = useState<{ actions: { action: string; count: number }[]; sampled: number; total: number } | null>(null);
  const [skillsList, setSkillsList] = useState<{ slug: string; name: string; calls_7d?: number; calls_total?: number; status?: string }[]>([]);
  const [gwErr, setGwErr] = useState('');

  useEffect(() => {
    if (tab !== 'skills') return;
    setGwErr('');
    Promise.all([api.gateway.overview(), api.gateway.trend(30), api.stats.funnel(), api.gateway.skills()])
      .then(([o, tr, fn, sk]) => {
        setOv(o || null);
        setGwTrend(Array.isArray(tr) ? tr : []);
        if (fn && fn.ok) setFunnel(fn);
        else setGwErr(fn?.message || '漏斗数据不可用');
        if (Array.isArray(sk)) {
          setSkillsList(sk.map((s: any) => ({ slug: s.slug, name: s.display_name || s.name, calls_7d: s.calls_7d, calls_total: s.calls_total, status: s.status })));
        }
      })
      .catch(() => setGwErr('技能中心不可达，请稍后重试'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const skillRank = useMemo(() => {
    return skillsList
      .filter((s) => (s.calls_total ?? 0) > 0)
      .sort((a, b) => (b.calls_total ?? 0) - (a.calls_total ?? 0))
      .slice(0, 6)
      .map((s) => ({ label: s.name, value: s.calls_total ?? 0, slug: s.slug }));
  }, [skillsList]);

  const trendBars = (data?.trend30 || []).map((d) => ({ label: d.day.slice(5), value: d.count, highlight: d.count > 0 && d.count === Math.max(...(data?.trend30 || [{ count: 0 }]).map((x) => x.count)) }));

  return (
    <div className="p-6 flex flex-col gap-4 relative">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <button className={`tab ${tab === 'tools' ? 'tab-active' : 'tab-idle'}`} onClick={() => setTab('tools')}>工具</button>
        <button className={`tab ${tab === 'skills' ? 'tab-active' : 'tab-idle'}`} onClick={() => setTab('skills')}>技能</button>
        <span className="w-px h-5 bg-line mx-1" />
        {tab === 'tools' ? (
          <input
            type="month"
            aria-label="统计月份"
            value={month}
            onChange={(e) => changeMonth(e.target.value)}
            className="h-[34px] rounded-[10px] bg-soft dark:bg-card border border-line px-2.5 text-xs outline-none text-t2"
          />
        ) : (
          <span className="pill bg-soft text-t2 font-normal">近 30 日</span>
        )}
        <span className="flex-1" />
        {tab === 'tools' && (
          <span className="flex items-center gap-2 text-xs text-t3">
            每日计入上限
            <input
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value.replace(/\D/g, '').slice(0, 3))}
              className="w-14 h-8 rounded-lg bg-soft dark:bg-card border border-line px-2 text-center font-mono outline-none focus:border-accent text-t1"
            />
            次 / 账号 / 工具
            <button className="btn-primary !text-[11px] !h-8" disabled={saving || monthLoading || !data} onClick={saveLimit}>{saving ? '保存中…' : '保存'}</button>
          </span>
        )}
      </div>

      {tab === 'tools' ? (
        monthLoading || monthError || !data ? <div role={monthError ? 'alert' : 'status'} className="card p-8 text-center text-sm text-t2">
          {monthError || '正在加载统计…'}
          {monthError && <button className="btn-ghost ml-3" onClick={() => void loadMonth(month)}>重试</button>}
        </div> : <>
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: `本月有效使用（${month}）`, value: kpi.count.toLocaleString(), sub: `计入规则：每账号 × 每工具每日上限 ${data?.config.dailyLimit ?? 5} 次` },
              { label: '本月使用人数', value: kpi.users.toLocaleString(), sub: '按登录账号去重' },
              { label: '上线工具数', value: onlineTools, sub: '内置 + 员工上传（已上线）' },
              { label: '人均使用', value: kpi.per, sub: '本月有效使用 ÷ 使用人数' },
            ].map((k) => (
              <div key={k.label} className="card p-4">
                <div className="text-xs text-t3">{k.label}</div>
                <div className="text-[22px] font-semibold mt-1 font-mono">{k.value}</div>
                <div className="text-[11px] text-t3 mt-0.5">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* 趋势 + 部门占比 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[13px] font-semibold">近 30 日有效使用趋势</span>
                <span className="flex-1" />
                <span className="text-[10px] text-t3 font-mono">数据源：/api/admin/stats · trend30</span>
              </div>
              <BarChart data={trendBars} />
            </div>
            <div className="card p-4">
              <div className="text-[13px] font-semibold mb-3">部门占比（本月有效使用）</div>
              <HBarList rows={depts} />
            </div>
          </div>

          {/* TOP5 + 异常识别 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="text-[13px] font-semibold mb-3">TOP 5 工具（本月）</div>
              <HBarList rows={top5} />
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-[13px] font-semibold">异常识别（待复核）</span>
                <span className="pill bg-warnSoft text-warn font-normal">{data?.anomalies.length || 0} 组</span>
              </div>
              <p className="text-[11px] text-t3 mb-2">同一 IP 当日 ≥5 个账号操作，列出来源供人工判断（仅安全审计用途）</p>
              <div className="flex flex-col gap-2 max-h-[160px] overflow-y-auto">
                {(data?.anomalies || []).slice(0, 10).map((a, i) => (
                  <div key={i} className="rounded-xl bg-warnSoft/60 dark:bg-warnSoft/10 p-2.5 text-xs">
                    <span className="font-mono">{a.day} · {a.ip} · {a.users.length} 个账号</span>
                    <div className="text-t2 mt-0.5">{a.users.map((u) => u.n).join('、')}</div>
                  </div>
                ))}
                {data && data.anomalies.length === 0 && <div className="text-xs text-t3 py-4 text-center">本月无异常分组</div>}
              </div>
            </div>
          </div>

          {/* 工具 × 日期矩阵 */}
          <div className="card overflow-x-auto">
            <div className="flex items-center px-4 py-3 border-b border-line">
              <h3 className="text-sm font-semibold">工具 × 日期 明细矩阵（{month}）</h3>
              <span className="text-[11px] text-t3 ml-3">点击格子看当日明细（时间 / 账号 / IP / 是否计入）</span>
            </div>
            <table className="w-full border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-soft dark:bg-[#16151F]">
                  <th className="th text-left sticky left-0 bg-soft dark:bg-[#16151F] min-w-[160px]">工具（负责人）</th>
                  <th className="th w-16 text-right">合计</th>
                  {Array.from({ length: monthDays }, (_, i) => (
                    <th key={i} className="th w-8 text-center font-mono">
                      {String(i + 1).padStart(2, '0')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data?.tools || []).map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03]">
                    <td className="td min-w-[160px] truncate" title={t.name}>
                      {t.name} <span className="text-[11px] text-t3">{t.owner}</span>
                    </td>
                    <td className="td w-16 text-right font-mono font-semibold">{t.total.toLocaleString()}</td>
                    {Array.from({ length: monthDays }, (_, i) => {
                      const day = `${month}-${String(i + 1).padStart(2, '0')}`;
                      const v = t.days[day];
                      return (
                        <td key={day} className="td w-8 text-center">
                          {v ? (
                            <button
                              onClick={() => openCell(t, day)}
                              className="w-7 h-6 rounded-md font-mono text-[11px] hover:ring-1 hover:ring-accent"
                              style={{ background: `rgba(80,70,229,${Math.min(0.08 + v * 0.06, 0.55)})` }}
                            >
                              {v}
                            </button>
                          ) : (
                            <span className="text-t3/30">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {data && data.tools.length === 0 && (
                  <tr>
                    <td colSpan={monthDays + 2} className="p-10 text-center text-sm text-t3">本月暂无使用记录</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-t3 leading-relaxed">
            口径说明：工具 = 门户「打开工具」的有效使用次数（登录账号点击；每账号 × 每工具每日前 {data?.config.dailyLimit ?? 5} 次计入，10 秒内重复点击合并为 1 次）；
            与「技能」页签的 MCP 调用口径互相独立，不可相加。
          </div>
        </>
      ) : (
        <>
          {gwErr && <div className="card p-3 text-xs text-warn bg-warnSoft/50">{gwErr}</div>}

          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: '技能总数（启用）', value: ov ? `${ov.skills_total ?? '—'}（${ov.skills_enabled ?? '—'}）` : '…', sub: '技能中心实时' },
              { label: '近 7 日调用', value: ov?.calls_7d ?? '…', sub: `活跃来源 ${ov?.active_ips_7d ?? '—'} 个` },
              { label: '今日调用', value: ov?.calls_today ?? '…', sub: 'load_skill 口径' },
              { label: '累计调用', value: ov?.total_calls ?? '…', sub: '服务上线以来' },
            ].map((k) => (
              <div key={k.label} className="card p-4">
                <div className="text-xs text-t3">{k.label}</div>
                <div className="text-[22px] font-semibold mt-1 font-mono">{k.value}</div>
                <div className="text-[11px] text-t3 mt-0.5">{k.sub}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[13px] font-semibold">近 30 日调用趋势（MCP 调用次数）</span>
                <span className="flex-1" />
                <span className="text-[10px] text-t3 font-mono">数据源：网关 /api/stats/trend</span>
              </div>
              <BarChart data={(gwTrend || []).map((d) => ({ label: d.date, value: d.count }))} />
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[13px] font-semibold">调用漏斗（全技能 · 累计）</span>
                <span className="flex-1" />
                <span className="text-[10px] text-t3 font-mono">样本 {funnel ? `${funnel.sampled}/${funnel.total}` : '…'} 条日志</span>
              </div>
              <Funnel steps={(funnel?.actions || []).map((a) => ({ action: ACTION_LABEL[a.action] || a.action, count: a.count }))} />
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="text-[13px] font-semibold mb-3">技能调用排行（累计 · 点击跳转调用日志）</div>
              <HBarList rows={skillRank} onClick={(r) => onOpenSkillLogs((skillRank.find((x) => x.label === r.label) || {}).slug || '')} />
            </div>
            <div className="card overflow-hidden">
              <div className="flex bg-soft dark:bg-[#16151F] border-b border-line">
                <span className="th flex-1">技能</span>
                <span className="th w-[72px] text-right">7 日</span>
                <span className="th w-[72px] text-right">累计</span>
                <span className="th w-[64px] text-center">状态</span>
              </div>
              {skillsList.map((s) => (
                <div key={s.slug} className="flex items-center border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03]">
                  <span className="td flex-1 truncate" title={s.name}>{s.name}</span>
                  <span className="td w-[72px] text-right font-mono text-xs">{s.calls_7d ?? 0}</span>
                  <span className="td w-[72px] text-right font-mono text-xs">{s.calls_total ?? 0}</span>
                  <span className="td w-[64px] text-center">
                    <span className={`pill font-normal ${(s.status || 'enabled') === 'enabled' ? 'bg-okSoft text-ok' : 'bg-soft text-t3'}`}>
                      {(s.status || 'enabled') === 'enabled' ? '启用' : '停用'}
                    </span>
                  </span>
                </div>
              ))}
              {skillsList.length === 0 && <div className="p-10 text-center text-sm text-t3">{gwErr ? '技能中心不可达' : '加载中…'}</div>}
            </div>
          </div>

          <div className="text-xs text-t3 leading-relaxed">
            口径说明：技能 = MCP 实际调用次数（load_skill / read_reference / read_asset / report_output 四动作，全量统计不去重）；
            与「工具」页签的有效使用口径互相独立。漏斗为服务端聚合网关调用日志（上限 1 万条样本）。
          </div>
        </>
      )}

      {/* 明细弹层（矩阵下钻 / 工具管理跳转） */}
      <ZbModal open={!!dayDetail} onClose={closeDetail} label="使用明细" maxWidth="max-w-[560px]" className="max-h-[70vh] overflow-y-auto p-5">
        {dayDetail && (
          <>
            <div className="flex items-center gap-2.5 mb-3">
              <h3 className="text-sm font-semibold">
                {dayDetail.tool.name}
                {dayDetail.day ? ` · ${dayDetail.day} 明细` : ' · 本月逐日'}
              </h3>
              <span className="flex-1" />
              <button className="text-t3 hover:text-t1 text-lg" onClick={closeDetail}>✕</button>
            </div>

            {detailLoading || detailError ? <div role={detailError ? 'alert' : 'status'} className="p-5 text-center text-xs text-t2">
              {detailError || '正在加载明细…'}
              {detailError && <button className="ml-2 underline" onClick={() => void openCell(dayDetail.tool, dayDetail.day)}>重试</button>}
            </div> : !dayDetail.day && focusRows ? (
              <div className="flex flex-col gap-1">
                {focusRows.map((r) => (
                  <button
                    key={r.day}
                    className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-soft/70"
                    onClick={() => openCell(dayDetail.tool, r.day)}
                  >
                    <span className="font-mono text-t2 w-[86px]">{r.day}</span>
                    <div className="flex-1 h-[10px] rounded-full bg-soft dark:bg-white/[0.05] overflow-hidden">
                      <div className="h-full bg-accent/60" style={{ width: `${Math.min(100, (r.count / Math.max(1, ...focusRows.map((x) => x.count))) * 100)}%` }} />
                    </div>
                    <span className="font-mono w-[40px] text-right">{r.count}</span>
                  </button>
                ))}
                {focusRows.length === 0 && <div className="p-8 text-center text-xs text-t3">本月无使用记录</div>}
              </div>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-soft dark:bg-[#16151F]">
                    <th className="th text-left">时间</th>
                    <th className="th text-left">账号（姓名）</th>
                    <th className="th text-left">IP</th>
                    <th className="th text-left">是否计入</th>
                  </tr>
                </thead>
                <tbody>
                  {dayDetail.rows.map((r, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="td font-mono text-[11px]">
                        {new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td className="td">{r.u}（{r.n}）</td>
                      <td className="td font-mono text-[11px]">{r.ip}</td>
                      <td className="td">
                        {r.counted ? <span className="pill bg-okSoft text-ok font-normal">计入</span> : <span className="pill bg-soft text-t3 font-normal">溢出</span>}
                      </td>
                    </tr>
                  ))}
                  {dayDetail.rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-8 text-center text-xs text-t3">无记录</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </>
        )}
      </ZbModal>
    </div>
  );
}
