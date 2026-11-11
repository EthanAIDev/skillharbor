import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { ah, type AhInterface, type AhState, type AhSystem } from '../services/api';
import { ZbModal } from '../components/ZbModal';
import { copyText } from '../lib/copyText';

/* ============================== 工具函数 ============================== */

function fmtTime(t: number) {
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  const today = new Date();
  const day = d.toDateString() === today.toDateString() ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`;
  return `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function useCopyFeedback(text: string, resetAfter?: number) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0), locked = useRef(false);
  useEffect(() => {
    request.current++; locked.current = false;
    setDone(false); setError(''); setBusy(false);
    return () => { request.current++; };
  }, [text]);
  useEffect(() => {
    if (!done || !resetAfter) return;
    const timer = window.setTimeout(() => setDone(false), resetAfter);
    return () => window.clearTimeout(timer);
  }, [done, resetAfter]);
  const copy = async () => {
    if (locked.current) return;
    locked.current = true;
    const ticket = ++request.current;
    setBusy(true); setDone(false); setError('');
    const ok = await copyText(text, () => ticket === request.current);
    if (ticket !== request.current) return;
    locked.current = false; setBusy(false); setDone(ok);
    if (!ok) setError('复制失败，请重试');
  };
  return { done, error, busy, copy };
}

const METHOD_CLS: Record<string, string> = { GET: 'bg-okSoft text-ok', POST: 'bg-accentSoft text-accentText' };
const statePill = (st: string) =>
  st === 'cloud' ? (
    <span className="pill bg-okSoft text-ok">☁ 已接入</span>
  ) : st === 'ready' ? (
    <span className="pill bg-accentSoft text-accentText">可申请</span>
  ) : (
    <span className="pill bg-soft text-t2">内网直调</span>
  );

/* ============================== 生成物（curl / 对接提示词 / 采集提示词） ============================== */

function genCurl(f: AhInterface, sysName: string) {
  const owner = sysName && !sysName.includes('（') ? sysName : '系统负责人';
  const cloud = f.state === 'cloud'
    ? `# 云侧调用（云服务器本机执行）\ncurl -s -m 8 -H "X-API-Key: <向${owner}索取>" \\\n  "http://127.0.0.1:${f.port}${f.path}${f.method === 'GET' ? '?code=DTSJ20260977504QUP' : ''}"\n\n`
    : '';
  return (
    cloud +
    `# 内网直调\ncurl -s -m 5 -H "X-API-Key: <同上>" \\\n  "http://${f.up}${f.path}${f.method === 'GET' ? '?code=DTSJ20260977504QUP' : ''}"`
  );
}

function genAgent(f: AhInterface, sysName: string) {
  const addr = f.state === 'cloud' ? `http://127.0.0.1:${f.port}${f.path}` : `http://${f.up}${f.path}（内网直调地址）`;
  return `【接口对接任务 · ${sysName}】
用途：${f.title} —— ${f.desc}

接口：${f.method} ${addr}
鉴权：${f.auth}
参数：${(f.params || []).map((p) => `${p[0]}=<${(p[3] || '').slice(0, 20)}…>`).join(' & ')}
返回：JSON，见平台接口文档页

实现要求：
1. 业务结果以返回 JSON 中的字段为准（如 found），不要只看 HTTP 状态码；
2. 超时建议 5 秒，失败自动降级，不阻断用户操作；
3. 先按文档示例自测一次，返回正常即接入成功。

对接完成后请回报验证结果。`;
}

function collectPrompt(name: string) {
  return `【内网系统接入 · 信息采集与准备】（发给提供方开发的 agent 执行）

背景：公司接口平台需要登记「${name || '（系统名称）'}」的接口供其他系统发现与调用（系统与数据不迁移、不上公网）。请完成后按《接入信息报告》模板输出。

请执行并报告：
1. 系统名称/用途/技术栈/启动方式；服务端口；每个接口的用途说明（一句话）。
2. 只读检查：ipconfig（记录 IPv4 与是否 DHCP）、netstat -ano | findstr ":端口"（监听 0.0.0.0 还是 127.0.0.1）。
3. 若监听 127.0.0.1：改绑 0.0.0.0 并重启（改动前先向用户说明）。
4. 防火墙放行（管理员 PowerShell，仅对中转服务器开放）：
   New-NetFirewallRule -DisplayName "svc-for-188" -Direction Inbound -Protocol TCP -LocalPort 端口号 -RemoteAddress 127.0.0.1 -Action Allow
5. 接口清单：路径/方法/入参/返回示例/鉴权方式（有 OpenAPI 文件直接提供更佳）。
6. 可用时间（开关机习惯）、数据敏感性、联系人。

禁止：修改本机网络设置（IP/网关/DNS）；任何形式的公网暴露。`;
}

/* ============================== 采集报告解析 ============================== */

export interface ParsedReport {
  sysName: string; use: string; ip: string; port: string; bind: string;
  method: string; path: string; ifTitle: string; ifDesc: string;
  auth: string; avail: string; contact: string;
}

export function parseReport(txt: string): ParsedReport | { error: string } {
  const pick = (re: RegExp) => {
    const m = txt.match(re);
    return m ? m[1].trim() : '';
  };
  const sysName = pick(/系统名称[:：]\s*(.+)/);
  const use = pick(/用途[:：]\s*(.+)/);
  const ip = pick(/内网\s*IP[:：]\s*([\d.]+)/);
  const port = pick(/服务端口[:：]\s*(\d+)/);
  const bind = pick(/监听地址[:：]\s*(0\.0\.0\.0|127\.0\.0\.1)/);
  const ifline = txt.match(/接口清单[:：][^\n]*?(GET|POST|PUT|DELETE)\s+(\S+)/);
  const ifTitle = pick(/接口清单[:：][^\n]*?(?:GET|POST|PUT|DELETE)\s+\S+\s+(.+)/);
  const ifDesc = pick(/接口说明[:：]\s*(.+)/);
  const auth = pick(/鉴权方式[:：]\s*(.+)/);
  const avail = pick(/可用时间[\/:：\s]*(.+)/);
  const contact = pick(/开发联系人[:：]\s*(.+)/);
  if (!sysName || !ip || !ifline) return { error: '未能识别关键字段（系统名称 / 内网 IP / 接口清单）。请确认粘贴的是完整的《接入信息报告》。' };
  return { sysName, use, ip, port, bind, method: ifline[1], path: ifline[2], ifTitle, ifDesc, auth, avail, contact };
}

/* ============================== 页面 ============================== */

type View = 'plaza' | 'myif' | 'channels' | 'help' | 'detail';

export default function ApiHub() {
  const { session } = useAuth();
  const [data, setData] = useState<AhState | null>(null);
  const [view, setView] = useState<View>('plaza');
  const [filter, setFilter] = useState<'all' | 'cloud' | 'ready' | 'lan'>('all');
  const [search, setSearch] = useState('');
  const [curIf, setCurIf] = useState<string>('');
  const [regOpen, setRegOpen] = useState(false);
  const [copy, setCopy] = useState<{ title: string; kind: 'curl' | 'agent' | 'collect'; ifId: string } | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const alive = useRef(true);
  const request = useRef(0);
  const reload = useCallback(async () => {
    if (!alive.current) return false;
    const ticket = ++request.current;
    setLoading(true); setLoadError('');
    try {
      const result = await ah.state();
      if (!alive.current || ticket !== request.current) return false;
      if (!result.ok) throw new Error((result as AhState & { message?: string }).message || '接口中心读取失败，请重试');
      setData(result);
      return true;
    } catch (error) {
      if (alive.current && ticket === request.current) setLoadError(error instanceof Error ? error.message : '接口中心读取失败，请重试');
      return false;
    } finally {
      if (alive.current && ticket === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; request.current++; };
  }, [reload]);

  const systems = data?.systems || {};
  const ifs = useMemo(() => data?.interfaces || [], [data]);
  const sysName = (f: AhInterface) => systems[f.sysId]?.name || '（未知系统）';
  const cur = ifs.find((x) => x.id === curIf);

  const filtered = useMemo(() => {
    const q = search.trim();
    return ifs.filter((f) => {
      if (filter !== 'all' && f.state !== filter) return false;
      if (!q) return true;
      return (f.title + f.path + f.desc + sysName(f)).includes(q);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ifs, filter, search, data?.systems]);

  const openIf = (id: string) => { setCurIf(id); setView('detail'); };
  const doCopy = async (kind: 'curl' | 'agent' | 'collect', f: AhInterface) => setCopy({ title: f.title, kind, ifId: f.id });

  if (loading) {
    return (
      <div role="status" className="max-w-[1440px] mx-auto px-8 py-16 text-center text-t3 text-sm">接口中心加载中…</div>
    );
  }
  if (loadError || !data) {
    return (
      <div role="alert" className="max-w-[1440px] mx-auto px-8 py-16 text-center text-sm text-t2">
        {loadError || '接口中心读取失败，请重试'}
        <button className="btn-ghost ml-3" onClick={() => void reload()}>重试</button>
      </div>
    );
  }

  const st = data.stats;

  return (
    <div className="max-w-[1440px] mx-auto px-8 pt-6 pb-20 flex gap-6 items-start">
      {/* ===== 左侧栏 ===== */}
      <aside className="w-[200px] shrink-0 sticky top-[88px] flex flex-col gap-1">
        {([
          ['plaza', '🧩', '接口广场'],
          ['myif', '🔌', '我的接口'],
          ['channels', '🧭', '我的接入'],
          ['help', '📖', '接入指南'],
        ] as [View, string, string][]).map(([v, ic, label]) => (
          <div
            key={v}
            onClick={() => setView(v)}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[13.5px] cursor-pointer transition-colors ${
              view === v ? 'bg-accentSoft text-accentText font-semibold' : 'text-t2 hover:text-t1 hover:bg-soft'
            }`}
          >
            <span className="w-5 text-center text-[15px]">{ic}</span>
            {label}
          </div>
        ))}
      </aside>

      {/* ===== 内容区 ===== */}
      <main className="flex-1 min-w-0">
        {view === 'plaza' && (
          <div className="page-enter">
            {/* 统计 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mb-5">
              <div className="card p-[18px]"><div className="text-[26px] font-bold leading-tight">{st.systems}</div><div className="text-xs text-t2">已登记系统</div></div>
              <div className="card p-[18px]"><div className="text-[26px] font-bold leading-tight">{st.total}</div><div className="text-xs text-t2">广场接口</div><div className="text-[11px] text-t3 mt-0.5">{st.cloud} 已接入 · {st.ready} 可申请</div></div>
              <div className="card p-[18px]"><div className="text-[26px] font-bold leading-tight">{st.channels}</div><div className="text-xs text-t2">云侧通道</div><div className="text-[11px] text-t3 mt-0.5">端口池 18000-18999</div></div>
              <div className="card p-[18px]"><div className="text-[26px] font-bold leading-tight flex items-center gap-2">{data.channels.every((c) => c.lastCheck?.ok !== false) ? <><span className="w-2 h-2 rounded-full bg-ok shadow-[0_0_0_3px_rgb(var(--c-ok-soft))]" /> {st.channels}/{st.channels}</> : st.channels}</div><div className="text-xs text-t2">自检状态</div></div>
            </div>

            <div className="flex gap-5 items-start">
              {/* 左：接口列表 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between flex-wrap gap-2 mt-5 mb-3.5">
                  <h3 className="text-[15px] font-bold">全部接口</h3>
                  <div className="text-xs text-t3">
                    <span className="pill bg-okSoft text-ok mr-1">☁ 已接入</span>云侧可直接调用 ·
                    <span className="pill bg-accentSoft text-accentText mx-1">可申请</span>点开即可接入 ·
                    <span className="pill bg-soft text-t2 mx-1">内网直调</span>无需通道
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap items-center mb-4">
                  {([
                    ['all', `全部（${st.total}）`],
                    ['cloud', `云侧已接入（${st.cloud}）`],
                    ['ready', `可申请接入（${st.ready}）`],
                    ['lan', `内网直调（${st.lan}）`],
                  ] as const).map(([f, label]) => (
                    <div key={f} onClick={() => setFilter(f)} className={`tab cursor-pointer ${filter === f ? 'tab-active' : 'tab-idle'}`}>{label}</div>
                  ))}
                  <div className="relative ml-auto">
                    <span className="absolute left-3 top-[9px] text-[13px] opacity-50">🔍</span>
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="搜索接口 / 系统 / 用途…"
                      className="w-[280px] h-9 rounded-[10px] bg-card border border-line px-3 pl-9 text-[13px] outline-none focus:border-accent transition-colors"
                    />
                  </div>
                </div>
                <div className="grid [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))] gap-3.5">
                  {filtered.map((f) => (
                    <div key={f.id} onClick={() => openIf(f.id)} className="card p-4 flex flex-col gap-2 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`method font-mono text-[11px] font-bold rounded px-1.5 py-0.5 ${METHOD_CLS[f.method] || 'bg-soft text-t2'}`}>{f.method}</span>
                        <span className="text-sm font-semibold">{f.title}</span>
                        {statePill(f.state)}
                      </div>
                      <div className="font-mono text-xs text-t2">{f.path}</div>
                      <div className="text-xs text-t2 leading-relaxed line-clamp-2 min-h-[38px]">{f.desc}</div>
                      <div className="text-xs text-t3 border-t border-dashed border-line pt-2 flex justify-between">
                        <span>{sysName(f)} · {systems[f.sysId]?.dept || ''}</span>
                        <span>{f.state === 'cloud' ? `127.0.0.1:${f.port}` : f.up.split(':')[1] ? `端口 ${f.up.split(':')[1]}` : ''}</span>
                      </div>
                    </div>
                  ))}
                  {!filtered.length && <div className="text-xs text-t3 col-span-full">没有匹配的接口</div>}
                </div>
              </div>
              {/* 右：悬浮动态 */}
              <div className="w-[300px] shrink-0 sticky top-[88px] hidden xl:block">
                <div className="card">
                  <div className="px-[18px] py-3.5 border-b border-line text-[13px] font-semibold">最近动态</div>
                  {data.dynamics.map((d, i) => (
                    <div key={i} className="px-[18px] py-3 border-b border-dashed border-line last:border-b-0">
                      <div className="text-[11px] text-t3">{fmtTime(d.t)}</div>
                      <div className="text-xs text-t1 leading-relaxed my-0.5">{d.text}</div>
                      <span className="pill bg-okSoft text-ok">{d.tag}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {view === 'myif' && (
          <div className="page-enter">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3.5">
              <div>
                <div className="text-lg font-bold">我的接口</div>
                <div className="text-xs text-t2">我名下登记的接口 —— 新接口从这里登记进广场</div>
              </div>
              <button className="btn-primary" onClick={() => setRegOpen(true)}>＋ 登记新接口</button>
            </div>
            <div className="card">
              <table className="w-full">
                <thead><tr>
                  <th className="th">接口</th><th className="th">所属系统</th><th className="th">说明</th>
                  <th className="th">云侧接入</th><th className="th">状态</th><th className="th">最近更新</th><th className="th"></th>
                </tr></thead>
                <tbody>
                  {ifs.filter((f) => f.owner === session?.username || session?.role === 'admin').map((f) => (
                    <tr key={f.id} className="cursor-pointer hover:bg-soft" onClick={() => openIf(f.id)}>
                      <td className="td"><span className={`method font-mono text-[11px] font-bold rounded px-1.5 py-0.5 mr-1.5 ${METHOD_CLS[f.method] || 'bg-soft text-t2'}`}>{f.method}</span><code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">{f.path}</code></td>
                      <td className="td text-t1">{sysName(f)}</td>
                      <td className="td !whitespace-normal break-words max-w-[260px]">{f.desc.slice(0, 40)}</td>
                      <td className="td">{f.port || '—'}</td>
                      <td className="td">{f.state === 'cloud' ? <><span className="w-2 h-2 rounded-full bg-ok inline-block shadow-[0_0_0_3px_rgb(var(--c-ok-soft))]" /> 已接入</> : statePill(f.state)}</td>
                      <td className="td">{fmtTime(f.updatedAt)}</td>
                      <td className="td">
                        <button
                          className="btn-ghost btn-sm !text-xs"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`下架「${f.title}」？（已接入云侧的需先停用通道）`)) return;
                            const r = await ah.removeIf(f.id);
                            if (!r.ok) alert(r.message || '删除失败');
                            reload();
                          }}
                        >下架</button>
                      </td>
                    </tr>
                  ))}
                  {!ifs.filter((f) => f.owner === session?.username || session?.role === 'admin').length && (
                    <tr><td className="td text-center text-t3" colSpan={7}>还没有登记接口 —— 点右上「＋登记新接口」，推荐用采集导入</td></tr>
                  )}
                </tbody>
              </table>
              <div className="px-4 py-3 text-xs text-t3 border-t border-line">
                💡 新接口登记用「采集导入」最省事：复制提示词发给系统开发的 agent → 报告回来粘贴进登记框 → 解析自动填全。登记后接口进入广场，"可申请"状态即可被云上系统一键申请接入。
              </div>
            </div>
          </div>
        )}

        {view === 'channels' && (
          <ChannelsView data={data} reload={reload} />
        )}

        {view === 'help' && (
          <div className="card page-enter">
            <div className="card-head px-5 py-4 text-sm font-semibold border-b border-line">三种对接场景，两条路径</div>
            <div className="p-5 text-sm space-y-3">
              <p><b>① 云上系统 → 内网接口</b>：在广场点开接口 →「申请接入」→ 平台自动自检、分配端口、生效 → 云侧用 <code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">127.0.0.1:18xxx</code> 调用。全程无需接触服务器、无需改防火墙。</p>
              <p><b>② 内网 ↔ 内网</b>：网络本身可达，<b>不需要通道</b>。在广场看说明与鉴权获取方式，直接调内网地址。</p>
              <p><b>③ 内网 → 云上系统</b>：内网可直接出公网，同样无需通道，云侧提供地址登记到广场即可。</p>
              <div className="rounded-[10px] bg-warnSoft text-warn text-xs px-3 py-2.5">接口密钥均向系统负责人索取，平台不存储密钥值。</div>
            </div>
          </div>
        )}

        {view === 'detail' && cur && (
          <IfDetail
            f={cur}
            sys={systems[cur.sysId]}
            sysName={sysName(cur)}
            onBack={() => setView('plaza')}
            onCopy={doCopy}
            reload={reload}
          />
        )}
      </main>

      {/* 登记弹窗 */}
      {regOpen && <RegModal onClose={() => setRegOpen(false)} onDone={() => { setRegOpen(false); reload(); }} />}

      {/* 复制弹窗 */}
      {copy && cur && (
        <CopyModal
          title={copy.title}
          sub={`${sysName(ifs.find((x) => x.id === copy.ifId)!)} · 生成内容按登记信息自动填充`}
          text={
            copy.kind === 'curl' ? genCurl(ifs.find((x) => x.id === copy.ifId)!, sysName(ifs.find((x) => x.id === copy.ifId)!))
              : copy.kind === 'agent' ? genAgent(ifs.find((x) => x.id === copy.ifId)!, sysName(ifs.find((x) => x.id === copy.ifId)!))
              : collectPrompt(sysName(ifs.find((x) => x.id === copy.ifId)!))
          }
          onClose={() => setCopy(null)}
        />
      )}
    </div>
  );
}

/* ============================== 我的接入 ============================== */

function ChannelsView({ data, reload }: { data: AhState; reload: () => void }) {
  const { session } = useAuth();
  const [busy, setBusy] = useState('');
  return (
    <div className="page-enter">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3.5">
        <div>
          <div className="text-lg font-bold">我的接入</div>
          <div className="text-xs text-t2">已开通的云侧通道 —— 全部由平台自动配置，人工不接触服务器</div>
        </div>
        <div className="flex items-center gap-3 text-xs text-t2">
          端口池 18000-18999
          <div className="w-40 h-2.5 bg-soft border border-line rounded-full overflow-hidden"><div className="h-full bg-accent rounded-full" style={{ width: `${Math.max(2, data.stats.channels)}%` }} /></div>
          <b>{data.stats.channels} / 999</b>
        </div>
      </div>
      <div className="card mb-4">
        <table className="w-full">
          <thead><tr><th className="th">接口</th><th className="th">上游（内网）</th><th className="th">云侧地址</th><th className="th">自检</th><th className="th">开通人</th><th className="th">开通时间</th><th className="th"></th></tr></thead>
          <tbody>
            {data.channels.map((c) => {
              const f = data.interfaces.find((x) => x.id === c.ifId);
              const canDisable = !!session && (session.role === 'admin' || c.createdBy === session.username || f?.owner === session.username);
              return (
                <tr key={c.ifId}>
                  <td className="td text-t1 font-medium">{f ? f.title : c.ifId}</td>
                  <td className="td"><code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">{c.up}</code></td>
                  <td className="td"><code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">127.0.0.1:{c.port}</code></td>
                  <td className="td">{c.lastCheck?.ok ? `✅ ${c.lastCheck.ms}ms` : '—'}</td>
                  <td className="td">{c.createdName || c.createdBy}</td>
                  <td className="td">{fmtTime(c.createdAt)}</td>
                  <td className="td">
                    {canDisable && <button
                      className="btn-ghost !text-xs !py-1.5 !px-3"
                      disabled={busy === c.ifId}
                      onClick={async () => {
                        if (!confirm(`停用「${f?.title}」的云侧通道？云侧调用将立即中断。`)) return;
                        setBusy(c.ifId);
                        const r = await ah.disable(c.ifId);
                        setBusy('');
                        if (!r.ok) alert(r.message || '停用失败');
                        reload();
                      }}
                    >{busy === c.ifId ? '停用中…' : '停用'}</button>}
                  </td>
                </tr>
              );
            })}
            {!data.channels.length && <tr><td className="td text-center text-t3" colSpan={7}>还没有云侧通道 —— 在接口广场点开「可申请」的接口一键开通</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================== 接口详情 ============================== */

function IfDetail({ f, sys, sysName, onBack, onCopy, reload }: {
  f: AhInterface; sys?: AhSystem; sysName: string; onBack: () => void;
  onCopy: (kind: 'curl' | 'agent' | 'collect', f: AhInterface) => void; reload: () => void;
}) {
  const [applyOpen, setApplyOpen] = useState(false);
  return (
    <div className="page-enter">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2.5 flex-wrap">
            <span className={`method font-mono text-[11px] font-bold rounded px-2 py-1 ${METHOD_CLS[f.method] || 'bg-soft text-t2'}`}>{f.method}</span>
            <code className="font-mono text-sm bg-soft border border-line rounded px-2 py-1">{f.path}</code>
            <span className="pill bg-soft text-t2">{sysName}</span>
            {statePill(f.state)}
          </h2>
          <div className="text-[13px] text-t2 mt-1">{f.title} · 密钥获取：{f.auth}</div>
        </div>
        <button className="btn-ghost !text-xs !py-1.5 !px-3" onClick={onBack}>← 返回广场</button>
      </div>

      <div className="rounded-xl bg-soft border border-line px-4 py-3 mb-4 text-[13.5px] text-t2 leading-relaxed">
        <b className="text-t1">接口说明</b>　{f.desc}
      </div>

      {f.state === 'cloud' ? (
        <div className="card mb-4">
          <div className="card-head px-5 py-3.5 text-sm font-semibold border-b border-line">调用地址</div>
          <div className="p-5">
            <div className="grid md:grid-cols-2 gap-3">
              <div className="border border-line rounded-xl p-3.5 bg-soft">
                <div className="text-[11px] font-semibold text-accentText mb-1">☁ 云侧调用（经公司通道 · 仅云服务器本机可达）</div>
                <div className="font-mono text-[12.5px] break-all">http://127.0.0.1:{f.port}{f.path}</div>
              </div>
              <div className="border border-line rounded-xl p-3.5 bg-soft">
                <div className="text-[11px] font-semibold text-t2 mb-1">🏢 内网直调</div>
                <div className="font-mono text-[12.5px] break-all">http://{f.up}{f.path}</div>
              </div>
            </div>
            <div className="flex gap-2.5 flex-wrap mt-3.5">
              <button className="btn-primary !text-xs !py-2" onClick={() => onCopy('curl', f)}>📋 复制 curl 示例</button>
              <button className="btn-primary !text-xs !py-2" onClick={() => onCopy('agent', f)}>🤖 复制对接提示词（给调用方 agent）</button>
              <button className="btn-ghost !text-xs !py-2" onClick={() => onCopy('collect', f)}>🧾 复制采集提示词（给提供方 agent）</button>
            </div>
          </div>
        </div>
      ) : f.state === 'ready' ? (
        <div className="mb-4 p-5 card" style={{ border: '1.5px dashed rgb(var(--c-accent))' }}>
          <div className="flex justify-between items-center gap-4 flex-wrap">
            <div>
              <div className="font-bold text-[15px]">云上系统需要调用这个接口？</div>
              <div className="text-[13px] text-t2 mt-1">
                点右侧按钮申请云侧接入 —— 平台自动完成连通自检 → 分配专属端口 → 通道生效，全程无需接触任何服务器。接入后云侧用 <code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">127.0.0.1:专属端口</code> 调用。
              </div>
            </div>
            <button className="btn-primary !h-11 !px-6 shrink-0" onClick={() => setApplyOpen(true)}>⚡ 申请接入</button>
          </div>
        </div>
      ) : (
        <div className="card mb-4">
          <div className="card-head px-5 py-3.5 text-sm font-semibold border-b border-line">调用地址（内网直调，无需通道）</div>
          <div className="p-5">
            <div className="border border-line rounded-xl p-3.5 bg-soft font-mono text-[12.5px] break-all">http://{f.up}{f.path}</div>
            <div className="flex gap-2.5 mt-3.5">
              <button className="btn-primary !text-xs !py-2" onClick={() => onCopy('curl', f)}>📋 复制 curl 示例</button>
              <button className="btn-ghost !text-xs !py-2" onClick={() => onCopy('agent', f)}>🤖 复制对接提示词</button>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4">
        <div className="card-head px-5 py-3.5 text-sm font-semibold border-b border-line">
          接口文档 <span className="text-[11px] text-t3 font-normal">OpenAPI 渲染 · 在线调试后续开启</span>
        </div>
        <div className="px-5 pb-5 pt-1">
          <h4 className="text-[13px] text-t2 font-semibold my-3">请求参数</h4>
          <table className="w-full">
            <thead><tr><th className="th">参数</th><th className="th">类型</th><th className="th">必填</th><th className="th !whitespace-normal">说明</th></tr></thead>
            <tbody>
              {(f.params || []).map((p, i) => (
                <tr key={i}>
                  <td className="td"><code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">{p[0]}</code></td>
                  <td className="td">{p[1]}</td>
                  <td className="td">{p[2] === '必填' ? <b className="text-danger">必填</b> : '可选'}</td>
                  <td className="td !whitespace-normal break-words">{p[3]}</td>
                </tr>
              ))}
              {!(f.params || []).length && <tr><td className="td text-t3" colSpan={4}>参数明细由提供方补全</td></tr>}
            </tbody>
          </table>
          {f.respOK && (
            <>
              <h4 className="text-[13px] text-t2 font-semibold mt-4 mb-2">返回示例</h4>
              <pre className="bg-[#0f172a] text-[#e2e8f0] rounded-xl p-4 font-mono text-xs overflow-x-auto whitespace-pre leading-relaxed">{f.respOK}</pre>
            </>
          )}
          {!!(f.errs || []).length && (
            <>
              <h4 className="text-[13px] text-t2 font-semibold mt-4 mb-2">错误码</h4>
              <table className="w-full">
                <thead><tr><th className="th">状态码</th><th className="th">含义</th></tr></thead>
                <tbody>{f.errs.map((e, i) => <tr key={i}><td className="td"><code className="font-mono text-xs bg-soft border border-line rounded px-1.5 py-px">{e[0]}</code></td><td className="td">{e[1]}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head px-5 py-3.5 text-sm font-semibold border-b border-line">所属系统</div>
        <div className="p-5 grid [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))] gap-3">
          {[
            ['系统', sysName],
            ['部门 / 负责人', `${sys?.dept || '—'} · ${sys?.owner || '—'}`],
            ['部署位置', sys?.loc || '—'],
            ['可用性', sys?.avail || '—'],
          ].map(([k, v]) => (
            <div key={k} className="bg-soft border border-line rounded-xl px-3.5 py-2.5">
              <div className="text-[11px] text-t3">{k}</div>
              <div className="text-[13px] font-medium mt-0.5 break-all">{v}</div>
            </div>
          ))}
        </div>
      </div>

      {applyOpen && <ApplyModal f={f} onClose={() => setApplyOpen(false)} onDone={() => { setApplyOpen(false); reload(); }} />}
    </div>
  );
}

/* ============================== 接入向导（真实调用后端） ============================== */

function ApplyModal({ f, onClose, onDone }: { f: AhInterface; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [port, setPort] = useState(0);
  const [ms, setMs] = useState(0);
  const [ip, port2] = f.up.split(':');

  const run = async () => {
    setStep(2);
    const r = await ah.apply(f.id, reason);
    if (!r.ok) { setErr(r.message || '接入失败'); return; }
    setPort((r as any).port); setMs((r as any).probe?.ms ?? 0); setStep(4);
  };

  return (
    <ZbModal open onClose={onClose} label="申请云侧接入" maxWidth="max-w-[640px]" className="max-h-[88vh] overflow-y-auto" dismissible={!!err}>
        <button onClick={onClose} className="absolute top-3.5 right-3.5 w-8 h-8 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft">✕</button>
        {step < 4 && !err && (
          <>
            <h2 className="text-base font-semibold">申请云侧接入</h2>
            <div className="text-xs text-t3 mb-4">平台自动完成：连通自检 → 分配专属端口 → 通道生效</div>
            <div className="flex mb-5">
              {['确认信息', '连通自检', '分配端口生效'].map((label, i) => (
                <div key={label} className={`flex-1 text-center relative ${i === 0 ? '' : ''}`}>
                  <div className={`w-8 h-8 rounded-full border inline-flex items-center justify-center text-[13px] font-semibold relative z-[2] ${
                    step > i + 1 ? 'bg-ok border-ok text-white' : step === i + 1 ? 'bg-accent border-accent text-white shadow-[0_0_0_4px_rgb(var(--c-accent-soft))]' : 'bg-soft border-line text-t2'
                  }`}>{step > i + 1 ? '✓' : i + 1}</div>
                  <div className="text-xs text-t2 mt-1.5">{label}</div>
                  {i > 0 && <div className={`absolute top-4 left-[-50%] w-full h-0.5 z-[1] ${step > i ? 'bg-ok' : 'bg-line'}`} />}
                </div>
              ))}
            </div>
            {step === 1 && (
              <>
                <div className="mb-3.5"><label className="block text-xs text-t2 mb-1.5 font-medium">接口</label>
                  <input readOnly value={`${f.method} ${f.path} · ${f.title}`} className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm opacity-85 outline-none" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-xs text-t2 mb-1.5 font-medium">目标内网地址（登记信息自动带出）</label>
                    <input readOnly value={ip} className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm opacity-85 outline-none" /></div>
                  <div><label className="block text-xs text-t2 mb-1.5 font-medium">端口</label>
                    <input readOnly value={port2} className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm opacity-85 outline-none" /></div>
                </div>
                <div className="mt-3.5"><label className="block text-xs text-t2 mb-1.5 font-medium">用途说明（留档）</label>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：云上报销系统调用该接口自动带出项目名称" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
                <button className="btn-primary w-full h-11 mt-4" onClick={run}>开始自检并接入</button>
              </>
            )}
            {step >= 2 && (
              <div className="py-10 text-center text-sm text-t2 flex flex-col items-center gap-3">
                <span className="spinner" style={{ borderTopColor: 'rgb(var(--c-accent))', borderColor: 'rgb(var(--c-line))' }} />
                {step === 2 ? <>连通自检中：平台从 188 直测 {f.up} …</> : <>分配端口并下发隧道配置 …</>}
              </div>
            )}
          </>
        )}
        {err && (
          <>
            <h2 className="text-base font-semibold">❌ 接入未成功</h2>
            <div className="text-xs text-t3 mb-4">未做任何变更，可排查后重试</div>
            <div className="rounded-[10px] bg-warnSoft text-warn text-xs px-3 py-2.5 leading-relaxed">{err}</div>
            <button className="btn-primary w-full h-11 mt-4" onClick={onClose}>知道了</button>
          </>
        )}
        {step === 4 && !err && (
          <>
            <h2 className="text-base font-semibold">✅ 接入成功</h2>
            <div className="text-xs text-t3 mb-4">通道已生效（frpc 热加载），本次操作已记入审计日志</div>
            <div className="rounded-[10px] bg-okSoft text-ok text-xs px-3 py-2.5 mb-3.5">
              连通自检通过{ms ? `（${ms}ms）` : ''} · 专属端口 <b>{port}</b> 已分配 · 路由已热加载生效
            </div>
            <div className="mb-3.5"><label className="block text-xs text-t2 mb-1.5 font-medium">云侧调用地址（仅云服务器本机可达）</label>
              <input readOnly value={`http://127.0.0.1:${port}${f.path}`} className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-[13px] font-mono opacity-85 outline-none" /></div>
            <button className="btn-primary w-full h-11" onClick={onDone}>完成</button>
          </>
        )}
    </ZbModal>
  );
}

/* ============================== 登记弹窗（采集导入 / 手动填写） ============================== */

const SAMPLE_REPORT = `【接入信息报告】
系统名称：合同管理系统
用途：公司合同的登记、审批流转与查询
技术栈/启动方式：Node.js（Express）/ pm2 常驻
内网 IP：10.0.0.10（DHCP：否，静态）
服务端口：3000
监听地址：0.0.0.0（原状，未修改）
防火墙规则：已添加（svc-for-188，仅对 127.0.0.1 开放）
接口清单：GET /api/contract/info 按合同编号查合同基本信息（名称、金额、状态、对方单位）
接口说明：输入合同编号（如 HT-2026-0311），返回合同名称与状态，供报销/付款录入时自动带出，避免错配
鉴权方式：X-API-Key，向合同部李四索取
可用时间/开关机习惯：工作日 8:30-18:00，周末关机
数据敏感性：含合同金额，内部敏感，仅限授权系统调用
开发联系人：李四`;

function RegModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'paste' | 'manual'>('paste');
  const [report, setReport] = useState('');
  const [parsed, setParsed] = useState<ParsedReport | null>(null);
  const [parseErr, setParseErr] = useState('');
  const copyPrompt = useCopyFeedback(collectPrompt(''), 2200);
  const [submitErr, setSubmitErr] = useState('');
  const [busy, setBusy] = useState(false);
  /* 手动表单（m2 = 内网地址，形如 10.0.0.x:3000） */
  const [m, setM] = useState<any>({ title: '', method: 'GET', path: '', desc: '', sysName: '', auth: '', addr: '' });

  const doParse = () => {
    setParseErr(''); setParsed(null);
    const r = parseReport(report);
    if ('error' in r) { setParseErr(r.error); return; }
    setParsed(r);
  };

  const submitParsed = async () => {
    if (!parsed) return;
    setBusy(true); setSubmitErr('');
    const title = (parsed.ifTitle || parsed.ifDesc || parsed.use || parsed.path).slice(0, 20).replace(/[（(][^）)]*$/, '');
    const r = await ah.register({
      sysName: parsed.sysName, dept: '（采集登记）', contact: parsed.contact, avail: parsed.avail,
      ip: parsed.ip, port: parsed.port, method: parsed.method, path: parsed.path,
      title, desc: parsed.ifDesc || parsed.use || '（采集登记）', auth: parsed.auth,
    });
    setBusy(false);
    if (!r.ok) { setSubmitErr(r.message || '登记失败'); return; }
    onDone();
  };

  const submitManual = async () => {
    const addr = String(m.addr || '').trim();
    if (!m.title || !m.path || !m.sysName || !addr) { setSubmitErr('接口名称、路径、所属系统、内网地址为必填'); return; }
    const [ip, port] = addr.split(':');
    setBusy(true); setSubmitErr('');
    const r = await ah.register({ sysName: m.sysName, ip, port, method: m.method, path: m.path, title: m.title, desc: m.desc || m.title, auth: m.auth });
    setBusy(false);
    if (!r.ok) { setSubmitErr(r.message || '登记失败'); return; }
    onDone();
  };

  return (
    <ZbModal open onClose={onClose} label="登记新接口" maxWidth="max-w-[620px]" className="max-h-[88vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-3.5 right-3.5 w-8 h-8 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft">✕</button>
        <h2 className="text-base font-semibold">登记新接口</h2>
        <div className="text-xs text-t3 mb-4">推荐「采集导入」：复制提示词发给系统开发的 agent，把返回报告粘贴回来即自动完成登记</div>
        <div className="flex gap-1.5 mb-4">
          <div onClick={() => setMode('paste')} className={`tab cursor-pointer ${mode === 'paste' ? 'tab-active' : 'tab-idle'}`}>🧾 采集导入（推荐）</div>
          <div onClick={() => setMode('manual')} className={`tab cursor-pointer ${mode === 'manual' ? 'tab-active' : 'tab-idle'}`}>✍ 手动填写</div>
        </div>

        {mode === 'paste' && (
          <>
            <div className="border border-line rounded-xl px-4 py-3.5 bg-soft flex justify-between items-center gap-3 flex-wrap">
              <div className="text-[12.5px] text-t1">① 复制采集提示词 → 发给该系统开发的 agent 执行</div>
              <button
                className="btn-primary !text-xs !py-2"
                disabled={copyPrompt.busy} onClick={copyPrompt.copy}
              >{copyPrompt.done ? '✓ 已复制，发给对方 agent' : '📋 复制提示词'}</button>
            </div>
            {copyPrompt.error && <p role="alert" className="text-xs text-danger mt-2">{copyPrompt.error}</p>}
            <div className="mt-3.5">
              <label className="block text-xs text-t2 mb-1.5 font-medium">② 把 agent 返回的《接入信息报告》整段粘贴到此处 *</label>
              <textarea
                value={report}
                onChange={(e) => { setReport(e.target.value); setParsed(null); setParseErr(''); }}
                rows={9}
                placeholder={'【接入信息报告】\n系统名称：…\n内网 IP：…（DHCP：否）\n服务端口：…\n监听地址：…\n接口清单：GET /api/… …\n鉴权方式：…\n开发联系人：…'}
                className="w-full rounded-xl bg-soft border border-line px-3.5 py-3 font-mono text-xs leading-relaxed outline-none focus:border-accent focus:bg-card transition-colors resize-y"
              />
              <div className="text-xs text-t3 mt-1.5">
                <a href="#" onClick={(e) => { e.preventDefault(); setReport(SAMPLE_REPORT); setParsed(null); setParseErr(''); }} className="text-accentText">载入示例报告</a>（演示解析效果，格式取自真实接入案例）
              </div>
            </div>
            <button className="btn-primary w-full h-11 mt-2" onClick={doParse}>③ 解析并登记</button>
            {parseErr && <div className="rounded-[10px] bg-warnSoft text-warn text-xs px-3 py-2.5 mt-3">{parseErr}</div>}
            {parsed && (
              <div className="border border-ok rounded-xl px-4 py-3.5 mt-3.5 bg-okSoft">
                <div className="font-semibold text-[13px] mb-2">✓ 解析成功，以下信息将登记进广场</div>
                <div className="grid [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))] gap-2.5">
                  {[
                    ['系统', parsed.sysName],
                    ['接口', `${parsed.method} ${parsed.path}`],
                    ['上游地址', `${parsed.ip}:${parsed.port}`],
                    ['鉴权', parsed.auth || '—'],
                    ['接口说明', parsed.ifDesc || '—'],
                    ['联系人', parsed.contact || '—'],
                    ['可用时间', parsed.avail || '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-card border border-line rounded-xl px-3.5 py-2">
                      <div className="text-[11px] text-t3">{k}</div>
                      <div className="text-[13px] font-medium mt-0.5 break-all">{v}</div>
                    </div>
                  ))}
                </div>
                {parsed.bind === '127.0.0.1' ? (
                  <div className="rounded-[10px] bg-warnSoft text-warn text-xs px-3 py-2.5 mt-3">⚠ 该服务当前只监听 127.0.0.1，局域网访问不到 —— 请让对方 agent 按提示词第 3 节改绑 0.0.0.0 后重新出报告再粘贴。</div>
                ) : (
                  <>
                    {submitErr && <div className="rounded-[10px] bg-warnSoft text-warn text-xs px-3 py-2.5 mt-3">{submitErr}</div>}
                    <button className="btn-primary w-full h-11 mt-3" disabled={busy} onClick={submitParsed}>{busy ? '登记中…' : '确认登记'}</button>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {mode === 'manual' && (
          <>
            <ManualForm m={m} setM={setM} />
            {submitErr && <div className="rounded-[10px] bg-warnSoft text-warn text-xs px-3 py-2.5 mt-2">{submitErr}</div>}
            <button className="btn-primary w-full h-11 mt-4" disabled={busy} onClick={submitManual}>{busy ? '登记中…' : '登记进广场'}</button>
          </>
        )}
    </ZbModal>
  );
}

/* 手动表单（ip/port 合并一个"内网地址"输入框，兼容 ip:port / 纯 ip） */
function ManualForm({ m, setM }: { m: any; setM: (v: any) => void }) {
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setM({ ...m, [k]: e.target.value });
  return (
    <>
      <div className="mb-3.5"><label className="block text-xs text-t2 mb-1.5 font-medium">接口名称 *</label>
        <input value={m.title} onChange={set('title')} placeholder="例：按项目编码查项目名称" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
      <div className="grid grid-cols-[130px_1fr] gap-3">
        <div><label className="block text-xs text-t2 mb-1.5 font-medium">方法 *</label>
          <select value={m.method} onChange={set('method')} className="w-full h-11 rounded-xl bg-soft border border-line px-3 text-sm outline-none">
            {['GET', 'POST', 'PUT', 'DELETE'].map((x) => <option key={x}>{x}</option>)}
          </select></div>
        <div><label className="block text-xs text-t2 mb-1.5 font-medium">路径 *</label>
          <input value={m.path} onChange={set('path')} placeholder="/api/xxx" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
      </div>
      <div className="mt-3.5"><label className="block text-xs text-t2 mb-1.5 font-medium">接口说明 *（一句话用途，展示在广场卡片）</label>
        <input value={m.desc} onChange={set('desc')} placeholder="例：输入项目编码自动带出项目名称，避免录入错配" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
      <div className="grid grid-cols-2 gap-3 mt-3.5">
        <div><label className="block text-xs text-t2 mb-1.5 font-medium">所属系统 *</label>
          <input value={m.sysName} onChange={set('sysName')} placeholder="例：合同管理系统" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
        <div><label className="block text-xs text-t2 mb-1.5 font-medium">内网地址（IP:端口）*</label>
          <input value={m.addr || ''} onChange={(e) => setM({ ...m, addr: e.target.value })} placeholder="10.0.0.10:3000" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
      </div>
      <div className="mt-3.5"><label className="block text-xs text-t2 mb-1.5 font-medium">鉴权方式（怎么拿密钥）</label>
        <input value={m.auth} onChange={set('auth')} placeholder="例：X-API-Key，向系统负责人索取" className="w-full h-11 rounded-xl bg-soft border border-line px-3.5 text-sm outline-none focus:border-accent focus:bg-card transition-colors" /></div>
    </>
  );
}

/* ============================== 复制弹窗 ============================== */

function CopyModal({ title, sub, text, onClose }: { title: string; sub: string; text: string; onClose: () => void }) {
  const copy = useCopyFeedback(text);
  return (
    <ZbModal open onClose={onClose} label={`一键复制 · ${title}`} maxWidth="max-w-[760px]" className="max-h-[88vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-3.5 right-3.5 w-8 h-8 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft">✕</button>
        <h2 className="text-base font-semibold">一键复制 · {title}</h2>
        <div className="text-xs text-t3 mb-4">{sub}</div>
        <pre className="bg-soft border border-line rounded-xl p-4 font-mono text-[12.5px] leading-[1.8] whitespace-pre-wrap max-h-[400px] overflow-y-auto">{text}</pre>
        <div className="mt-3.5 flex gap-2.5 items-center">
          <button className="btn-primary !text-xs !py-2" disabled={copy.busy} onClick={copy.copy}>📋 复制到剪贴板</button>
          {copy.done && <span className="text-xs text-ok">✓ 已复制</span>}
        </div>
        {copy.error && <p role="alert" className="text-xs text-danger mt-2">{copy.error}</p>}
        <div className="text-xs text-t3 mt-2">由平台按登记信息（OpenAPI）自动生成 —— 地址、鉴权、示例均为实际值。</div>
    </ZbModal>
  );
}
