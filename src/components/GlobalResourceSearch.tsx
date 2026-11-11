import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getToken } from '../services/api';
import type { Skill, Tool } from '../types';

export type ResourceTab = 'tools' | 'agents' | 'skills';
type KnowledgeHit = { name: string; repos?: string; sources?: string[] };
type KnowledgeState = { status: 'idle' | 'loading' | 'ready' | 'error' | 'signin'; items: KnowledgeHit[] };

interface Props {
  tools: Tool[];
  skills: Skill[];
  skillsLoading: boolean;
  skillsError: boolean;
  onRetrySkills: () => void;
  onTool: (tool: Tool) => void;
  onSkill: (skill: Skill) => void;
  onShowAll: (tab: ResourceTab, query: string) => void;
  onKnowledge: (query: string) => void;
}

const HOT_WORDS = ['PPT 制作', '可研模板', '投标台账', '产业链招商图谱'];

/** Local matches remain usable while the independent knowledge request loads or fails. */
export default function GlobalResourceSearch({ tools, skills, skillsLoading, skillsError, onRetrySkills, onTool, onSkill, onShowAll, onKnowledge }: Props) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [open, setOpen] = useState(false);
  const [knowledge, setKnowledge] = useState<KnowledgeState>({ status: 'idle', items: [] });
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const controller = useRef<AbortController>();
  const resultsId = useId();
  const matches = useMemo(() => {
    const keyword = submitted.toLocaleLowerCase();
    const includes = (name: string, desc = '') => name.toLocaleLowerCase().includes(keyword) || desc.toLocaleLowerCase().includes(keyword);
    return {
      tools: tools.filter(item => includes(item.name, item.desc)),
      agents: skills.filter(item => item.kind === 'agent' && includes(item.name, item.desc)),
      skills: skills.filter(item => item.kind !== 'agent' && includes(item.name, item.desc)),
    };
  }, [tools, skills, submitted]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('[role="dialog"]')) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (event.key === 'Escape' && rootRef.current?.contains(document.activeElement)) {
        setOpen(false);
        inputRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      request.current++;
      controller.current?.abort();
    };
  }, []);

  const search = async (value = query) => {
    const current = ++request.current;
    controller.current?.abort();
    const word = value.trim();
    if (!word) { setOpen(false); return; }
    setSubmitted(word);
    setOpen(true);
    setKnowledge({ status: 'loading', items: [] });
    const abort = new AbortController();
    controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 12000);
    try {
      const token = getToken();
      const response = await fetch(`/api/kb/search?q=${encodeURIComponent(word)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'same-origin', signal: abort.signal,
      });
      if (response.status === 401) {
        if (current === request.current) setKnowledge({ status: 'signin', items: [] });
        return;
      }
      if (!response.ok) throw new Error('Knowledge search unavailable');
      const body = await response.json();
      if (body.ok === false || !Array.isArray(body.items)) throw new Error('Invalid knowledge search response');
      const items = body.items.filter((item: KnowledgeHit) => item && typeof item.name === 'string');
      if (current === request.current) setKnowledge({ status: 'ready', items });
    } catch {
      if (current === request.current) setKnowledge({ status: 'error', items: [] });
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const closeAndSelect = (select: () => void) => {
    // Search result buttons unmount on selection; the persistent input is the return target for details.
    inputRef.current?.focus();
    setOpen(false);
    select();
  };
  const totalLocal = matches.tools.length + matches.agents.length + matches.skills.length;

  return (
    <div ref={rootRef} className="relative mt-5 max-w-[800px]">
      <form role="search" aria-label="全站资源搜索" onSubmit={event => { event.preventDefault(); void search(); }}
        className="search-field card flex h-[50px] items-center gap-3 rounded-[14px] px-3.5 shadow-sm">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-t3"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input ref={inputRef} type="search" aria-label="搜索工具、智能体、技能和知识库" aria-expanded={open} aria-controls={open ? resultsId : undefined}
          value={query} onChange={event => {
            request.current++;
            controller.current?.abort();
            setQuery(event.target.value);
            setOpen(false);
          }} placeholder="搜工具、智能体、技能、知识库文档…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-t3" />
        <kbd className="rounded-md bg-soft px-2 py-0.5 text-[11px] text-t2" aria-hidden="true">Ctrl K</kbd>
        <button type="submit" className="btn-primary !px-4 !py-2">搜索</button>
      </form>
      {open && (
        <section id={resultsId} aria-label="全站搜索结果"
          className="absolute left-0 right-0 top-[58px] z-30 max-h-[min(440px,calc(100dvh-280px))] overflow-y-auto overscroll-contain rounded-[14px] border border-line bg-card shadow-[0_16px_40px_rgba(16,18,35,0.18)]">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <h2 className="truncate text-xs font-medium text-t2">“{submitted}”的搜索结果</h2>
            <button type="button" aria-label="关闭搜索结果" className="rounded-md px-2 py-1 text-xs text-t2 hover:bg-soft" onClick={() => { setOpen(false); inputRef.current?.focus(); }}>关闭</button>
          </div>
          {(['tools', 'agents', 'skills'] as const).map(tab => {
            const list = matches[tab];
            if (!list.length) return null;
            const title = tab === 'tools' ? '工具' : tab === 'agents' ? '智能体' : '技能';
            return (
              <div key={tab} className="border-b border-line last:border-0">
                <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3 text-xs">
                  <h3 className="font-semibold text-t2">{title}<span className="ml-2 font-normal text-t3">{list.length}</span></h3>
                  <button type="button" className="rounded px-1 py-1 text-accentText hover:underline" onClick={() => closeAndSelect(() => onShowAll(tab, submitted))}>查看全部{title}（{list.length}） →</button>
                </div>
                {list.slice(0, 3).map(item => (
                  <button key={item.id} type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-soft"
                    onClick={() => closeAndSelect(() => tab === 'tools' ? onTool(item as Tool) : onSkill(item as Skill))}>
                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{item.name}</span>
                    <span className="max-w-[40%] truncate text-[11px] text-t3">{tab === 'tools' ? '工具' : `${title} · ${(item as Skill).category}`}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {skillsLoading && <p role="status" className="px-4 py-3 text-xs text-t2">智能体与技能正在加载…</p>}
          {skillsError && <div role="alert" className="px-4 py-3 text-xs text-t2">智能体与技能暂时无法加载。<button type="button" className="ml-2 rounded text-accentText underline" onClick={() => { inputRef.current?.focus(); onRetrySkills(); }}>重新加载资源</button></div>}
          {knowledge.status === 'loading' && <p role="status" className="px-4 py-4 text-xs text-t2">知识库检索中…</p>}
          {knowledge.status === 'signin' && <div className="flex items-center justify-between gap-3 bg-soft px-4 py-4 text-xs text-t2">
            <span>登录后可搜索知识库。</span><button type="button" className="shrink-0 rounded text-accentText underline" onClick={() => closeAndSelect(() => onKnowledge(submitted))}>登录并搜索知识库</button>
          </div>}
          {knowledge.status === 'error' && (
            <div role="alert" className="flex items-center justify-between gap-3 bg-soft px-4 py-4 text-xs text-t2">
              <span>知识库暂时无法搜索，请稍后重试。</span>
              <button type="button" className="shrink-0 rounded text-accentText underline" onClick={() => { inputRef.current?.focus(); void search(submitted); }}>重试知识库搜索</button>
            </div>
          )}
          {knowledge.status === 'ready' && knowledge.items.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3 text-xs">
                <h3 className="font-semibold text-t2">知识库<span className="ml-2 font-normal text-t3">本次命中 {knowledge.items.length} 条</span></h3>
                <button type="button" className="rounded px-1 py-1 text-accentText hover:underline" onClick={() => closeAndSelect(() => onKnowledge(submitted))}>查看全部知识库结果 →</button>
              </div>
              {knowledge.items.slice(0, 4).map((item, index) => (
                <button key={`${item.name}-${index}`} type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-soft"
                  onClick={() => closeAndSelect(() => onKnowledge(item.name))}>
                  <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{item.name}</span>
                  <span className="max-w-[40%] truncate text-[11px] text-t3">{item.repos}{item.sources?.includes('semantic') ? ' · 语义' : ''}</span>
                </button>
              ))}
            </div>
          )}
          {knowledge.status === 'ready' && !knowledge.items.length && totalLocal > 0 && <p className="px-4 py-3 text-xs text-t3">知识库中没有匹配的文档。</p>}
          {knowledge.status === 'ready' && !knowledge.items.length && !totalLocal && !skillsLoading && !skillsError && <p role="status" className="px-4 py-5 text-center text-xs text-t2">没有找到匹配的资源，试试更短的关键词或描述用途。</p>}
        </section>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-t3">
        <span>试试搜索</span>
        {HOT_WORDS.map(word => <button key={word} type="button" className="rounded py-1 text-accentText hover:underline" onClick={() => { setQuery(word); void search(word); }}>{word}</button>)}
      </div>
    </div>
  );
}
