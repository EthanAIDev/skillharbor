import { useEffect, useMemo, useState } from 'react';
import { api, type GwLog, type GwSkillRow } from '../../services/api';

const ACTIONS = ['load_skill', 'read_reference', 'read_asset', 'report_output', 'list_skills', 'auth'];
const PAGE_SIZE = 50;

const EMPTY = { skill: '', action: '', status: '', date_from: '', date_to: '', user: '' };
type Filters = typeof EMPTY;

const ymd = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

interface Props {
  initialSkill?: string;
}

/** 技能管理 · 调用日志页签：快捷日期 + 筛选 + 同步人员 + 导出 CSV；用户识别走 IP-姓名登记表 */
export default function GatewayLogsAdmin({ initialSkill }: Props) {
  const [skills, setSkills] = useState<GwSkillRow[]>([]);
  const [logs, setLogs] = useState<{ total: number; page: number; size: number; items: GwLog[] } | null>(null);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [form, setForm] = useState<Filters>({ ...EMPTY, skill: initialSkill || '' });
  const [applied, setApplied] = useState<Filters>({ ...EMPTY, skill: initialSkill || '' });
  const [page, setPage] = useState(1);

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    skills.forEach((s) => m.set(s.slug, s.display_name || s.name));
    return (slug: string) => m.get(slug) || slug;
  }, [skills]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 2600);
  };

  const fetchLogs = (f: Filters, p: number) => {
    setErr('');
    api.gateway
      .logs({ ...f, page: p, size: PAGE_SIZE })
      .then((d) => (d && Array.isArray(d.items) ? setLogs(d) : setErr('日志返回异常')))
      .catch(() => setErr('技能中心不可达，请稍后重试'));
  };

  useEffect(() => {
    api.gateway.skills().then((s) => Array.isArray(s) && setSkills(s)).catch(() => {});
  }, []);

  useEffect(() => {
    setPage(1);
    fetchLogs(applied, 1);
  }, [applied]);

  const syncNames = async () => {
    flash('正在同步人员…');
    const r = await api.gateway.syncNames().catch(() => null);
    flash(r && (r.synced !== undefined || r.total !== undefined) ? `已同步 IP-姓名对照表（${r.synced ?? r.total ?? 'ok'}）` : r && r.detail ? '同步失败：' + r.detail : '已触发同步');
  };

  const quick = (days: number) => {
    const f = { ...form, date_from: days ? ymd(days - 1) : '', date_to: days ? ymd(0) : '' };
    setForm(f);
    setApplied(f);
  };

  const go = (p: number) => {
    setPage(p);
    fetchLogs(applied, p);
  };
  const totalPages = logs ? Math.max(1, Math.ceil(logs.total / (logs.size || PAGE_SIZE))) : 1;
  const exportUrl = api.gateway.logsExportUrl(applied);

  const userOf = (r: GwLog) => r.ip_name || (r.token_key ? r.token_name : '未知（未登记）');
  const inputCls = 'h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line px-2.5 text-xs text-t1 outline-none';

  return (
    <div className="p-6 pt-4 flex flex-col gap-4">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      {/* 快捷日期 + 筛选 */}
      <div className="flex gap-2 flex-wrap items-center">
        {([[1, '今天'], [7, '近 7 天'], [30, '近 30 天'], [0, '全部']] as const).map(([d, l]) => (
          <button key={l} className={`tab ${d && applied.date_from === ymd(d - 1) && applied.date_to ? 'tab-active' : !d && !applied.date_from ? 'tab-active' : 'tab-idle'}`} onClick={() => quick(d)}>
            {l}
          </button>
        ))}
        <span className="w-px h-5 bg-line" />
        <select className={inputCls} value={form.skill} onChange={(e) => setForm({ ...form, skill: e.target.value })}>
          <option value="">全部技能</option>
          {skills.map((s) => (
            <option key={s.slug} value={s.slug}>{s.display_name || s.name}</option>
          ))}
        </select>
        <select className={inputCls} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
          <option value="">全部动作</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select className={inputCls} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="">全部状态</option>
          <option value="ok">成功</option>
          <option value="fail">失败</option>
        </select>
        <input type="date" className={inputCls} value={form.date_from} onChange={(e) => setForm({ ...form, date_from: e.target.value })} />
        <span className="text-xs text-t3">至</span>
        <input type="date" className={inputCls} value={form.date_to} onChange={(e) => setForm({ ...form, date_to: e.target.value })} />
        <input
          className={inputCls + ' w-[150px]'}
          placeholder="搜索用户 / IP…"
          value={form.user}
          onChange={(e) => setForm({ ...form, user: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && setApplied(form)}
        />
        <span className="flex-1" />
        <button className="h-[34px] px-3.5 rounded-[10px] border border-line text-xs text-t2 hover:text-t1" onClick={syncNames} title="触发网关从门户登录记录拉取最新 IP-姓名对照表">
          同步人员
        </button>
        <button className="btn-primary !h-[34px] !text-xs" onClick={() => setApplied(form)}>查询</button>
        <a href={exportUrl} target="_blank" rel="noreferrer" className="h-[34px] px-3.5 rounded-[10px] border border-line text-xs text-t2 hover:text-t1 flex items-center">
          导出 CSV
        </a>
      </div>

      {err && <div className="card p-4 text-sm text-danger bg-dangerSoft/40">{err}</div>}

      {/* 日志表 */}
      <div className="card overflow-x-auto">
        <div className="flex bg-soft dark:bg-[#16151F] border-b border-line min-w-[960px]">
          <span className="th w-[118px]">时间</span>
          <span className="th w-[120px]">用户（IP 归属）</span>
          <span className="th w-[120px]">IP</span>
          <span className="th flex-1 min-w-[180px]">技能</span>
          <span className="th w-[110px]">动作</span>
          <span className="th w-[190px]">详情</span>
          <span className="th w-[100px]">耗时 / 状态</span>
        </div>
        {(logs?.items || []).map((r) => {
          const fail = r.status !== 'ok';
          return (
            <div
              key={r.id}
              className={`flex items-center border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03] min-w-[960px] ${fail ? 'bg-warnSoft/40 dark:bg-warnSoft/10' : ''}`}
            >
              <span className="td w-[118px] font-mono text-[11px]">{(r.ts || '').slice(5, 16)}</span>
              <span className="td w-[120px] text-xs">{userOf(r)}</span>
              <span className="td w-[120px] font-mono text-[11px] text-t3">{r.ip || '—'}</span>
              <span className="td flex-1 min-w-[180px] text-xs truncate">{nameOf(r.skill_slug)}</span>
              <span className="td w-[110px] font-mono text-[11px]">{r.action}</span>
              <span className="td w-[190px] font-mono text-[11px] text-t2 truncate">{r.detail || r.version || '—'}</span>
              <span className="td w-[100px] font-mono text-[11px]">
                {fail ? <span className="text-danger font-medium">fail</span> : <span className="text-t2">{r.duration_ms ?? 0}ms ok</span>}
              </span>
            </div>
          );
        })}
        {logs && logs.items.length === 0 && <div className="p-12 text-center text-sm text-t3">当前筛选下没有调用记录</div>}
        {!logs && !err && <div className="p-12 text-center text-sm text-t3">加载中…</div>}
      </div>

      {/* 分页 */}
      <div className="flex items-center text-xs text-t3">
        <span>
          {logs ? `第 ${logs.page} / ${totalPages} 页 · 共 ${logs.total} 条` : '—'}
        </span>
        <span className="flex-1" />
        <button className="px-3 py-1 hover:text-t1 disabled:opacity-40" disabled={!logs || page <= 1} onClick={() => go(page - 1)}>‹ 上一页</button>
        <span className="font-mono text-accentText px-1">{page}</span>
        <button className="px-3 py-1 hover:text-t1 disabled:opacity-40" disabled={!logs || page >= totalPages} onClick={() => go(page + 1)}>下一页 ›</button>
      </div>

      <div className="text-xs text-t3 leading-relaxed">
        动作：load_skill / read_reference / read_asset / report_output（MCP 四工具）+ list_skills / auth（连接类）；用户识别走 IP-姓名登记表，未登记显示「未知」；
        「同步人员」= 从 skillharbor 门户登录记录同步 IP-姓名对照表；导出 CSV 与技能中心同源。
      </div>
    </div>
  );
}
