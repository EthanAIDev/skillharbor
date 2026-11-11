import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'skillharbor-usage-v2';
const RESET_KEY = 'skillharbor-usage-reset';
const RESET_EVENT = 'skillharbor-usage-reset';
const CHANGE_EVENT = 'skillharbor-usage-change';

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

/** 后台「使用次数清零」后各端同步：作废该工具在清零时间点之前记录的本地点击增量 */
export function applyUsageResets(resets?: Record<string, number>) {
  if (!resets) return;
  let known: Record<string, number> = {};
  let extra: Record<string, number> = {};
  try {
    known = JSON.parse(localStorage.getItem(RESET_KEY) || '{}');
    extra = read();
  } catch {
    /* ignore */
  }
  let changed = false;
  for (const [id, at] of Object.entries(resets)) {
    if (!at || (known[id] || 0) >= at) continue;
    known[id] = at;
    delete extra[id];
    changed = true;
  }
  if (!changed) return;
  try {
    localStorage.setItem(RESET_KEY, JSON.stringify(known));
    localStorage.setItem(KEY, JSON.stringify(extra));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(RESET_EVENT));
}

/** 使用次数 = 工具基础值 + 本浏览器点击增量（跨端汇总的原始点击在服务端 stats.json，统计看板用） */
export function useUsage() {
  const [extra, setExtra] = useState<Record<string, number>>(read);

  const latest = useRef(extra);
  useEffect(() => {
    const sync = (next: Record<string, number>) => {
      latest.current = next;
      setExtra(next);
    };
    const onReset = () => sync(read());
    const onChange = (event: Event) => sync((event as CustomEvent<Record<string, number>>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === RESET_KEY || event.key === null) sync(read());
    };
    window.addEventListener(RESET_EVENT, onReset);
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(RESET_EVENT, onReset);
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const record = useCallback((id: string) => {
    const next = { ...latest.current, [id]: (latest.current[id] || 0) + 1 };
    latest.current = next;
    setExtra(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* keep this page in sync */ }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  const getUsage = useCallback((id: string, base: number) => base + (extra[id] || 0), [extra]);

  return { record, getUsage };
}
