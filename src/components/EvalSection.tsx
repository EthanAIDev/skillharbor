import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type EvalItem, type EvalSummary } from '../services/api';
import { useAuth } from '../hooks/useAuth';

interface Props {
  target: string; // tool:<id> / skill:<slug>
  targetName: string;
}

const fmtDate = (t: number) => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function VotePill({ v }: { v: 1 | -1 }) {
  return v === 1 ? (
    <span className="pill bg-okSoft text-ok font-normal shrink-0">推荐</span>
  ) : (
    <span className="pill bg-dangerSoft text-danger font-normal shrink-0">不推荐</span>
  );
}

function EvalRow({ e, mine }: { e: EvalItem; mine?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 py-2 border-b border-line last:border-0">
      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${mine ? 'bg-accent text-white' : 'bg-accentSoft text-accentText'}`}>
        {e.n?.[0] || '员'}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium">{e.n}</span>
          <span className="text-[10px] text-t3">{e.d}</span>
          <VotePill v={e.v} />
          {e.flag === 'suspect' && <span className="text-[10px] text-warn">同 IP 集中评价 · 待复核</span>}
          <span className="flex-1" />
          <span className="text-[10px] text-t3 font-mono">{fmtDate(e.t)}</span>
        </div>
        {e.c && <p className="text-xs text-t2 leading-relaxed mt-1">{e.c}</p>}
      </div>
    </div>
  );
}

/**
 * 详情弹窗内嵌评价区（Steam 式）：好评率汇总 → 提交/修改我的评价 → 最近评价。
 * 规则：每账号限 1 次可修改；同 IP 多账号集中评价自动标记复核，剔除不计入。
 */
export default function EvalSection({ target, targetName }: Props) {
  // Each target owns its draft and async requests, including when drilling down
  // without closing the surrounding skill dialog.
  return <TargetEvalSection key={target} target={target} targetName={targetName} />;
}

function TargetEvalSection({ target, targetName }: Props) {
  const nav = useNavigate();
  const { session, expire } = useAuth();
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [recent, setRecent] = useState<EvalItem[]>([]);
  const [mine, setMine] = useState<{ v: 1 | -1; c: string } | null>(null);
  const [vote, setVote] = useState<1 | -1 | 0>(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [allItems, setAllItems] = useState<EvalItem[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const alive = useRef(true);
  const loadId = useRef(0);
  const [error, setError] = useState('');

  const load = async () => {
    const id = ++loadId.current;
    const r = await api.evals.get(target);
    if (!alive.current || id !== loadId.current) return;
    if (r.ok) {
      setError('');
      setSummary(r.summary);
      setRecent(r.recent || []);
      setMine(r.mine ? { v: r.mine.v, c: r.mine.c || '' } : null);
      setVote(r.mine?.v || 0);
      setComment(r.mine?.c || '');
    } else setError(r.message || '评价加载失败，请重试');
  };
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; ++loadId.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const submit = async () => {
    if (!vote) return;
    setBusy(true);
    setDone('');
    const r = await api.evals.submit(target, targetName, vote, comment.trim());
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) {
      setMine({ v: vote, c: comment.trim() });
      setDone('已提交，感谢反馈');
      load();
    } else if (r.unauthorized) {
      expire(); // 令牌已失效（过期 / 改密）：清掉本地会话再走登录，避免 /login 弹回首页
      nav('/login', { state: { from: '/' } });
    } else {
      setDone(r.message || '提交失败');
    }
  };

  const openAll = async () => {
    setShowAll(true);
    setLoadingAll(true);
    const r = await api.evals.all(target);
    if (!alive.current) return;
    if (r.ok) { setAllItems(r.items || []); setError(''); }
    else { setError(r.message || '评价加载失败，请重试'); setShowAll(false); }
    setLoadingAll(false);
  };

  const total = summary?.total || 0;
  const upPct = total ? Math.round(((summary?.up || 0) / total) * 100) : 0;

  return (
    <section className="rounded-xl border border-line p-4 flex flex-col gap-3">
      {/* 头 */}
      <div className="flex items-center gap-2.5">
        <h3 className="text-sm font-semibold">用户评价</h3>
        {summary && total > 0 && (
          <span className="pill bg-soft text-t2 font-normal">
            好评率 {summary.rate}% · {total} 条
          </span>
        )}
        <span className="flex-1" />
        {total > 0 && !showAll && (
          <button className="text-[11px] font-medium text-accentText hover:underline" onClick={openAll}>
            查看全部 {total} 条 →
          </button>
        )}
        {showAll && (
          <button className="text-[11px] text-t3 hover:text-t1" onClick={() => setShowAll(false)}>
            收起
          </button>
        )}
      </div>

      {total > 0 && (
        /* 汇总 */
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <span className="font-mono text-[22px] font-semibold leading-none text-ok">{summary?.rate}%</span>
            <span className="text-[11px] text-t3 pb-0.5">好评率</span>
            <span className="flex-1" />
            <span className="text-[11px] text-t3">
              推荐 <b className="text-ok font-mono">{summary?.up}</b> · 不推荐 <b className="text-danger font-mono">{summary?.down}</b>
              {summary && summary.excluded > 0 && <> · 异常已剔除 {summary.excluded}</>}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-dangerSoft overflow-hidden flex">
            <div className="bg-ok h-full" style={{ width: upPct + '%' }} />
          </div>
        </div>
      )}

      {/* 提交 / 我的评价 */}
      {session ? (
        <div className="rounded-xl bg-soft dark:bg-card border border-line p-3 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-t3">{mine ? '我的评价（可随时修改）' : '你觉得这个' + (target.startsWith('skill:') ? '技能' : '工具') + '怎么样？'}</span>
            {mine && <span className="pill bg-okSoft text-ok font-normal">已评价</span>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setVote(1)}
              className={`h-9 px-4 rounded-lg text-xs font-semibold transition-colors ${vote === 1 ? 'bg-okSoft text-ok border border-ok' : 'bg-card border border-line text-t2 hover:text-t1'}`}
            >
              推荐{vote === 1 ? ' ✓' : ''}
            </button>
            <button
              onClick={() => setVote(-1)}
              className={`h-9 px-4 rounded-lg text-xs font-semibold transition-colors ${vote === -1 ? 'bg-dangerSoft text-danger border border-danger' : 'bg-card border border-line text-t2 hover:text-t1'}`}
            >
              不推荐{vote === -1 ? ' ✓' : ''}
            </button>
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 300))}
              placeholder="写点使用感受…（选填，点「不推荐」时建议写明原因）"
              className="flex-1 min-w-[220px] h-9 rounded-lg bg-card border border-line px-3 text-xs outline-none focus:border-accent text-t1 placeholder:text-t3"
            />
            <button onClick={submit} disabled={!vote || busy} className="btn-primary h-9 !text-xs disabled:opacity-50">
              {busy ? '提交中…' : mine ? '修改评价' : '提交评价'}
            </button>
          </div>
          {done && <div className="text-[11px] text-ok">{done}</div>}
        </div>
      ) : (
        <button onClick={() => nav('/login', { state: { from: '/' } })} className="rounded-xl bg-soft dark:bg-card border border-dashed border-line p-3 text-xs text-t2 hover:text-t1 hover:border-accent transition-colors">
          登录后可评价（推荐 / 不推荐 + 评语，每账号限 1 次、可修改）→
        </button>
      )}

      {/* 列表 */}
      {error && <div role="alert" className="text-xs text-danger">{error} <button className="underline" onClick={load}>重试</button></div>}
      {showAll ? (
        loadingAll ? (
          <div className="text-xs text-t3 py-3 text-center">加载中…</div>
        ) : allItems.length ? (
          <div>
            {allItems.map((e) => (
              <EvalRow key={e.id} e={e} mine={e.mine} />
            ))}
          </div>
        ) : (
          <div className="text-xs text-t3 py-3 text-center">暂无评价</div>
        )
      ) : recent.length ? (
        <div>
          {recent.slice(0, 3).map((e) => (
            <EvalRow key={e.id} e={e} mine={e.mine} />
          ))}
        </div>
      ) : (
        <div className="text-xs text-t3 py-2 text-center">还没有评价，来做第一个吧</div>
      )}
    </section>
  );
}
