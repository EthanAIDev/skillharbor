import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Tool } from '../types';
import { TYPE_LABELS } from '../types';
import { DEPT_STYLES, TYPE_STYLES } from '../data/tools';
import { useUsage } from '../hooks/useUsage';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';
import ToolIcon from './ToolIcon';
import { ZbModal } from './ZbModal';

interface Props {
  tool: Tool;
  isNew?: boolean;
  onClose: () => void;
}

interface EvalRow {
  n: string;
  d?: string;
  s?: number;
  c: string;
  t: number;
  mine?: boolean;
}
interface Summary {
  avg?: number | null;
  count?: number;
  dist?: number[];
  up?: number;
  down?: number;
}

const STAR_TEXT = ['', '很差', '较差', '一般', '不错', '非常好'];
const starsOf = (s?: number) => {
  const v = Math.min(5, Math.max(1, s || 0));
  return '★★★★★'.slice(0, v) + '☆☆☆☆☆'.slice(0, 5 - v);
};

/** 工具详情弹窗（定稿版）：1080×660 定高横向窗口，左右两栏共享三行网格（行级对齐）。
 * 行1 基本信息｜当前版本；行2 截图轮播（无截图→占位）｜弹幕评价；行3 使用说明｜星级评价框。
 * 弹幕为流式直播列（左对齐、多行完整显示、发送即上屏）；评价模型为五星制。 */
export default function ToolModal({ tool, isNew, onClose }: Props) {
  const nav = useNavigate();
  const { session } = useAuth();
  const { record, getUsage } = useUsage();

  const [summary, setSummary] = useState<Summary | null>(null);
  const [feed, setFeed] = useState<EvalRow[]>([]);
  const [stars, setStars] = useState(0);
  const [hoverN, setHoverN] = useState(0);
  const [comment, setComment] = useState('');
  const [sendErr, setSendErr] = useState('');
  const [sending, setSending] = useState(false);
  const sendBusy = useRef(false);
  const evalSession = useRef(0);
  const savedEvaluation = useRef<{ row: EvalRow; summary?: Summary } | null>(null);
  const [shotIdx, setShotIdx] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const usage = getUsage(tool.id, tool.usage);
  const deptStyle = DEPT_STYLES[tool.department] || DEPT_STYLES['研究院'];
  const type = TYPE_STYLES[tool.type];
  const shots = tool.shots || [];
  const changelog = tool.changelog || [];

  useEffect(() => {
    const request = ++evalSession.current;
    savedEvaluation.current = null;
    sendBusy.current = false;
    setSending(false);
    setSummary(null);
    setFeed([]);
    setStars(0);
    setComment('');
    setSendErr('');
    if (tool) api.evals.get(`tool:${tool.id}`).then((r) => {
      if (request !== evalSession.current || !r.ok) return;
      const saved = savedEvaluation.current;
      // POST updates the viewer's existing record. Retain late history, but
      // replace its mine row and older summary with the confirmed POST result.
      setSummary(saved?.summary || r.summary || null);
      const history: EvalRow[] = (r.recent || []).slice().reverse();
      setFeed(saved ? [...history.filter(row => !row.mine), saved.row] : history);
    }).catch(() => {});
    return () => { ++evalSession.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id, session?.username]);

  /* 灯箱开着时 ESC/方向键只作用于灯箱：捕获阶段拦截并阻断冒泡，避免 Radix 把整个弹窗一并关掉；
   * 灯箱未开时 ESC 交给 ZbModal（Radix）处理。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!lightbox) return;
      if (e.key === 'Escape') { e.stopPropagation(); setLightbox(false); }
      if (e.key === 'ArrowLeft') setShotIdx((i) => (i - 1 + shots.length) % shots.length);
      if (e.key === 'ArrowRight') setShotIdx((i) => (i + 1 + shots.length) % shots.length);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [lightbox, shots.length]);

  const openTool = () => {
    if (!session) {
      nav('/login', { state: { from: `/tool/${tool.id}` } });
      return;
    }
    record(tool.id);
    api.stats.click(tool.id).catch(() => {});
    window.open(tool.url, '_blank');
  };

  const send = async () => {
    if (sendBusy.current) return;
    const text = comment.trim();
    if (!stars) { setSendErr('请先点击星星评分'); return; }
    if (!text) { setSendErr('写一句评价再发送吧'); return; }
    const request = evalSession.current;
    sendBusy.current = true;
    setSending(true);
    setSendErr('');
    try {
      const r = await api.evals.submitStars(`tool:${tool.id}`, tool.name, stars, text);
      if (request !== evalSession.current) return;
      if (!r.ok) { setSendErr(r.message || '提交失败，请稍后重试'); return; }
      const row: EvalRow = { n: session?.name || '我', s: stars, c: text, t: Date.now(), mine: true };
      savedEvaluation.current = { row, summary: r.summary };
      setFeed(f => [...f.filter(item => !item.mine).slice(-15), row]);
      setComment('');
      setSummary((previous) => r.summary || previous);
    } catch {
      if (request === evalSession.current) setSendErr('提交连接中断，请重试');
    } finally {
      if (request === evalSession.current) {
        sendBusy.current = false;
        setSending(false);
      }
    }
  };

  const n = comment.length;
  const curVer = changelog[0];

  const feedItems = useMemo(
    () => feed.map((e, i) => (
      <div key={e.t + '-' + i} className={`anim-dm-in relative w-fit max-w-full rounded-[11px] border px-3 py-[5px] text-[11.5px] leading-[19px] shadow-sm shrink-0 break-all ${e.mine ? 'border-accent bg-accentSoft text-t1' : 'border-line bg-card text-t2'}`}>
        <span className="font-semibold text-t1">{e.n}</span>：<span className="text-warn text-[10px]">{starsOf(e.s)}</span> {e.c}
      </div>
    )),
    [feed],
  );

  return (
    <>
      <ZbModal open onClose={onClose} label={tool.name} maxWidth="w-[1080px] max-w-full" className="p-0 h-[660px] max-h-[92vh] flex flex-col overflow-hidden">
        <button onClick={onClose} className="absolute top-3.5 right-4 z-10 w-[30px] h-[30px] rounded-[9px] flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft text-[15px]">✕</button>

        {/* 头部横条 */}
        <div className="flex items-center gap-3.5 px-6 pt-5 pr-14 shrink-0">
          <ToolIcon tool={tool} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-[17px] font-semibold">{tool.name}</h2>
              {isNew && <span className="rounded-full bg-accent px-2 py-px text-[10px] font-bold text-white">NEW</span>}
              <span className={`pill ${type.bg} ${type.fg} font-medium`}>{TYPE_LABELS[tool.type]}</span>
              <span className="pill bg-soft dark:bg-[#262533] text-t2">
                适用部门：{tool.departments?.length ? (tool.departments.includes('全部') ? '全部部门' : tool.departments.join(' / ')) : tool.department}
              </span>
            </div>
            <div className="mt-[3px] text-[11px] text-t3">{tool.owner} · 累计使用 {usage.toLocaleString()} 次 · 上线于 {tool.onlineAt || '—'}</div>
          </div>
          <button className="btn-primary !text-[13px] h-[38px] shrink-0 inline-flex items-center" onClick={openTool}>
            打开工具
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="ml-[5px]"><path d="M2.5 8h10M8.5 4l4 4-4 4" /></svg>
          </button>
        </div>

        {/* 主体：三行两列网格（行级对齐） */}
        <div className="flex-1 min-h-0 mt-3.5 mx-6 mb-4 grid gap-3" style={{ gridTemplateColumns: '62% 1fr', gridTemplateRows: 'auto 240px minmax(0,1fr)' }}>

          {/* 行1 左：基本信息 */}
          <div className="min-h-0 card !rounded-[12px] !border-line p-3 flex flex-col">
            <div className="text-[13px] font-semibold mb-2">基本信息</div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 leading-[18px] text-xs">
              <span><span className="text-[11px] text-t3">类型</span> {TYPE_LABELS[tool.type]}</span>
              <span><span className="text-[11px] text-t3">负责人</span> {tool.owner}</span>
              {!!tool.departments?.length && <span><span className="text-[11px] text-t3">适用部门</span> {tool.departments.join('、')}</span>}
              <span><span className="text-[11px] text-t3">地址</span> <span className="font-mono text-accentText">{tool.url}</span></span>
              {tool.docUrl && (
                <a href={tool.docUrl} className="ml-auto inline-flex items-center gap-1.5 text-xs text-accentText hover:underline" title="点击下载产品说明书">
                  产品说明书下载
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13.5h10" /></svg>
                </a>
              )}
            </div>
          </div>

          {/* 行1 右：当前版本 */}
          <div className="min-h-0 card !rounded-[12px] !border-line p-3 flex flex-col">
            <div className="text-[13px] font-semibold mb-2">当前版本</div>
            <div className="flex items-center gap-2.5 text-xs text-t2 leading-[18px]">
              {curVer ? (
                <>
                  <span className="rounded-md bg-accentSoft px-2 py-[2px] font-mono text-[11px] font-semibold text-accentText shrink-0">{curVer.version}</span>
                  <span className="truncate">{curVer.note}</span>
                  <span className="ml-auto text-[11px] text-t3 shrink-0">{curVer.date}</span>
                </>
              ) : (
                <span className="text-t3">上线于 {tool.onlineAt || '—'}</span>
              )}
            </div>
          </div>

          {/* 行2 左：截图轮播（无截图 → 占位） */}
          <div className="min-h-0">
            {shots.length ? (
              <div className="relative h-full rounded-[11px] border border-line overflow-hidden cursor-zoom-in" onClick={() => setLightbox(true)}>
                <img src={shots[shotIdx]} alt="" className="w-full h-full object-cover" />
                {shots.length > 1 && (
                  <>
                    <button className="absolute left-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white text-[16px] leading-none flex items-center justify-center hover:bg-black/75" onClick={(e) => { e.stopPropagation(); setShotIdx((i) => (i - 1 + shots.length) % shots.length); }}>‹</button>
                    <button className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white text-[16px] leading-none flex items-center justify-center hover:bg-black/75" onClick={(e) => { e.stopPropagation(); setShotIdx((i) => (i + 1) % shots.length); }}>›</button>
                  </>
                )}
                {shots.length > 1 && <span className="absolute right-2.5 bottom-2 rounded-md bg-black/55 px-2 py-[2px] text-[10.5px] text-white">{shotIdx + 1} / {shots.length}</span>}
              </div>
            ) : (
              <div className="h-full rounded-[11px] border-[1.6px] border-dashed border-line bg-soft flex flex-col items-center justify-center gap-2">
                <span className={`w-[52px] h-[52px] rounded-[14px] flex items-center justify-center text-2xl font-semibold ${deptStyle.bg} ${deptStyle.fg}`}>{tool.icon}</span>
                <span className="text-xs text-t2">暂无页面截图</span>
                <span className="text-[11px] text-t3">在「上传工具 · 更新版本」中补充截图后展示</span>
              </div>
            )}
          </div>

          {/* 行2 右：弹幕评价 */}
          <div className="min-h-0 card !rounded-[12px] !border-line p-3 flex flex-col">
            <div className="flex items-center gap-2.5 mb-2 shrink-0">
              <span className="text-warn text-sm tracking-wider">★★★★★</span>
              <span className="text-[15px] font-bold text-ok">{summary?.avg != null ? summary.avg.toFixed(1) : '—'}</span>
              <span className="text-[11px] text-t3">{summary?.count || 0} 条评价</span>
            </div>
            <div ref={feedRef} className="flex-1 min-h-0 rounded-[10px] border border-line bg-soft dark:bg-[#171622] flex flex-col justify-end gap-2 p-2.5 overflow-hidden">
              {feed.length ? feedItems : (
                <div className="m-auto flex flex-col items-center gap-2 text-xs text-t3">
                  <span className="text-2xl opacity-50">💬</span>
                  暂无评价 · 打个分发条弹幕吧
                </div>
              )}
            </div>
          </div>

          {/* 行3 左：项目描述（上传时的「项目描述」，内置工具附带使用步骤） */}
          <div className="min-h-0 card !rounded-[12px] !border-line p-3 flex flex-col">
            <div className="text-[13px] font-semibold mb-2">项目描述</div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1">
              {tool.desc ? (
                <p className="text-xs text-t2 leading-[1.7] whitespace-pre-wrap mb-2">{tool.desc}</p>
              ) : null}
              {tool.steps?.length ? tool.steps.map((s, i) => (
                <div key={i} className="flex gap-2 text-xs text-t2 leading-[1.6] mb-2">
                  <span className="w-[18px] h-[18px] mt-px rounded-full bg-accentSoft text-accentText text-[10.5px] font-mono flex items-center justify-center shrink-0">{i + 1}</span>
                  <span>{s}</span>
                </div>
              )) : null}
              {!tool.desc && !tool.steps?.length && (
                <p className="text-xs text-t2 leading-relaxed">项目描述暂未补充，可联系负责人 {tool.owner} 获取使用指引，或直接打开工具体验。</p>
              )}
            </div>
          </div>

          {/* 行3 右：星级评价框 */}
          <div className="min-h-0 card !rounded-[12px] !border-line p-3 flex flex-col">
            <div className="flex items-center gap-1 mb-0.5 shrink-0">
              {[1, 2, 3, 4, 5].map((i) => (
                <button type="button" disabled={sending} aria-label={`${i} 星`}
                  key={i}
                  className={`text-[22px] leading-none cursor-pointer transition-transform hover:scale-110 ${(hoverN || stars) >= i ? 'text-warn' : 'text-[#D5D5DC] dark:text-[#3A3947]'}`}
                  onMouseEnter={() => setHoverN(i)}
                  onMouseLeave={() => setHoverN(0)}
                  onClick={() => setStars(i)}
                >
                  ★
                </button>
              ))}
              <span className={`ml-2 text-[11px] ${sendErr ? 'text-danger' : 'text-t3'}`}>
                {sendErr || (stars ? `${STAR_TEXT[stars]}（${stars} 星）已选` : '点击星星评分（最多五星）')}
              </span>
            </div>
            <div className="relative flex-1 min-h-0 mt-2">
              <textarea
                value={comment}
                disabled={sending}
                maxLength={100}
                onChange={(e) => { setComment(e.target.value); if (sendErr) setSendErr(''); }}
                placeholder="写下你的使用评价…"
                className="w-full h-full rounded-[10px] border border-line bg-card text-t1 text-[12.5px] leading-5 resize-none outline-none focus:border-accent pt-2 px-3 pb-12 overflow-hidden"
              />
              <div className="absolute right-2.5 bottom-2.5 flex items-center gap-2.5">
                <span className={`text-[10px] font-mono ${n >= 100 ? 'text-danger' : 'text-t3'}`}>{n}/100</span>
                <button
                  className="h-[30px] rounded-[9px] bg-accent px-[15px] text-[12.5px] text-white hover:opacity-90"
                  disabled={sending} onClick={send}
                >
                  {sending ? '发送中…' : '发送'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </ZbModal>

      {/* 灯箱（ZbModal 外的兄弟节点：卡片 anim-pop 的 transform 会把内部 fixed 变成相对卡片定位；
          pointer-events-auto 抵消 Radix 滚动锁在 body 上的 pointer-events:none） */}
      {lightbox && shots.length > 0 && (
        <div className="fixed inset-0 z-[60] bg-black/85 flex flex-col items-center justify-center gap-3.5 pointer-events-auto" onClick={() => setLightbox(false)}>
          <img src={shots[shotIdx]} alt="" className="max-w-[88vw] max-h-[74vh] rounded-xl border border-white/15" onClick={(e) => e.stopPropagation()} />
          <div className="flex items-center gap-4 text-[12.5px] text-[#C9C4DC]">
            <button className="rounded-[9px] bg-white/10 px-4 py-[7px] text-white" onClick={(e) => { e.stopPropagation(); setShotIdx((i) => (i - 1 + shots.length) % shots.length); }}>←</button>
            <span className="font-mono">{shotIdx + 1} / {shots.length}</span>
            <button className="rounded-[9px] bg-white/10 px-4 py-[7px] text-white" onClick={(e) => { e.stopPropagation(); setShotIdx((i) => (i + 1) % shots.length); }}>→</button>
            <span className="text-t3">点击空白或 ESC 关闭</span>
          </div>
        </div>
      )}
    </>
  );
}
