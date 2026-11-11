import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getToken } from '../services/api';

type RecentDocument = { name: string; repos?: string; edit_ts?: string | number };
type State = { status: 'loading' | 'ready' | 'error'; items: RecentDocument[] };

function shortDate(timestamp?: string | number) {
  const value = Number(timestamp);
  if (!value) return '';
  const date = new Date(value > 1e12 ? value : value * 1000);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function KnowledgeActivity() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ status: 'loading', items: [] });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setState({ status: 'loading', items: [] });
    const load = async () => {
      try {
        const token = getToken();
        const response = await fetch('/api/skill-gateway/api/kb/recent?n=5', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Knowledge activity unavailable');
        const body = await response.json();
        if (body.ok === false || !Array.isArray(body.items)) throw new Error('Invalid knowledge activity response');
        if (current) setState({ status: 'ready', items: body.items.filter((item: RecentDocument) => item && typeof item.name === 'string') });
      } catch {
        if (current) setState({ status: 'error', items: [] });
      } finally { window.clearTimeout(timeout); }
    };
    void load();
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);

  return (
    <div className="card rounded-[14px] p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 rounded text-[13.5px] font-semibold"><span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-warn" />知识库动态</h3>
        <Link to="/kb" className="rounded text-xs text-accentText hover:underline">进入知识库 →</Link>
      </div>
      {state.status === 'loading' && <p role="status" className="py-5 text-xs text-t2">正在加载知识库动态…</p>}
      {state.status === 'error' && <div role="alert" className="py-5 text-xs text-t2">知识库动态暂时无法加载。<button type="button" onClick={() => { headingRef.current?.focus({ preventScroll: true }); setAttempt(value => value + 1); }} className="ml-2 rounded text-accentText underline">重新加载</button></div>}
      {state.status === 'ready' && !state.items.length && <p className="py-5 text-xs text-t3">暂无可展示的动态</p>}
      {state.status === 'ready' && state.items.length > 0 && (
        <><p role="status" className="sr-only">已加载 {state.items.length} 条知识库动态</p><ul className="mt-2.5">
          {state.items.map((item, index) => (
            <li key={`${item.name}-${index}`} className="flex items-center gap-2.5 border-b border-line/60 py-3 text-xs last:border-0">
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate text-t2" title={item.name}>《{item.name.replace(/\.md$/, '')}》{item.repos ? ` · ${item.repos}` : ''}</span>
              <span className="shrink-0 text-[11px] text-t3">{shortDate(item.edit_ts)}</span>
            </li>
          ))}
        </ul></>
      )}
    </div>
  );
}
