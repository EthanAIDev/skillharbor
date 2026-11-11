import { useCallback, useEffect, useRef, useState } from 'react';

/** 服务器 version.json 的结构（vite.config.ts 构建时生成） */
export interface RemoteVersion {
  version: string;
  buildId: string;
  buildTime: string;
  /** 本次构建的入口 JS 文件名（如 assets/index-xxx.js），用于核对部署完整性 */
  entry?: string;
  notes?: string[];
}

/** normal：正常的「有新版本」；broken：version.json 与实际资源错位（部署不完整） */
export type UpdateMode = 'normal' | 'broken';

export interface UpdateInfo {
  info: RemoteVersion;
  mode: UpdateMode;
}

const POLL_MS = 60_000; // 每 60 秒静默比对一次
const SNOOZE_MS = 10 * 60_000; // 「暂不刷新」后 10 分钟内不再打扰
const SNOOZE_KEY = 'skillharbor.updateSnooze';
/** 提醒卡弹出即记录该 buildId「已送达」：用户此后无论以何种方式刷新页面都不再重弹本版本 */
const NOTIFIED_KEY = 'skillharbor.updateNotified';

interface Snooze {
  buildId: string;
  at: number;
}

function readSnooze(): Snooze | null {
  try {
    const v = JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null');
    if (v && typeof v.buildId === 'string' && typeof v.at === 'number') return v;
  } catch {
    /* localStorage 不可用时视为未静默 */
  }
  return null;
}

function readNotified(): string | null {
  try {
    return localStorage.getItem(NOTIFIED_KEY);
  } catch {
    return null;
  }
}

/** 当前页面实际加载的入口 JS 文件名（与 version.json 的 entry 同格式） */
function currentPageEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/"]');
  if (!el) return null;
  try {
    return new URL(el.src, location.href).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}

/**
 * 平台更新检测：轮询 version.json，与当前构建的 __BUILD_ID__ 比对。
 *
 * 提醒规则：
 * - buildId 一致 → 无更新；
 * - buildId 不一致时核对「页面实际加载的入口文件」与「服务器声明的入口文件」：
 *   · 一致 → 实际资源已是最新（version.json 单独变化不构成真实更新），不打扰；
 *   · 不一致且服务器上声明的文件存在 → normal：正常的「平台已更新」提醒；
 *   · 不一致且服务器上声明的文件不存在 → broken：部署不完整，提醒用户并建议联系管理员。
 * - 弹出提醒卡 = 该 buildId「已送达」（记入 localStorage）。用户点「立即刷新」、
 *   F5、快捷键等任何方式刷新后，页面重载不再重弹同一版本，直到出现更新的版本；
 * - 「暂不刷新」/ ✕ = 该 buildId 静默 10 分钟，期满后重新检测时再次提醒。
 * 仅生产构建启用；dev 下没有 version.json，静默跳过。
 */
export function useVersionCheck() {
  const [remote, setRemote] = useState<UpdateInfo | null>(null);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const info = (await res.json()) as RemoteVersion;
      if (!info?.buildId || info.buildId === __BUILD_ID__) return;

      /* 部署完整性核对：页面实际资源已是最新 → 不打扰 */
      let mode: UpdateMode = 'normal';
      if (info.entry) {
        const pageEntry = currentPageEntry();
        if (pageEntry && pageEntry === info.entry) return;
        try {
          /* 服务器上声明的入口文件是否真实存在：404、或（SPA fallback 场景）返回的
             不是 JS，都说明 version.json 与实际资源错位 = 部署不完整 */
          const probe = await fetch(info.entry, { method: 'HEAD', cache: 'no-store' });
          const ct = probe.headers.get('content-type') || '';
          if (!probe.ok || !/javascript/i.test(ct)) mode = 'broken';
        } catch {
          /* 探测失败按普通更新处理，避免网络抖动误报异常 */
        }
      }

      const snooze = readSnooze();
      if (snooze?.buildId === info.buildId) {
        if (Date.now() - snooze.at < SNOOZE_MS) return; // 10 分钟静默期内
        try {
          localStorage.removeItem(SNOOZE_KEY); // 静默期满，恢复提醒
        } catch {
          /* 忽略存储失败 */
        }
      } else if (readNotified() === info.buildId) {
        return; // 该版本已送达过：刷新后不再重弹
      }

      try {
        localStorage.setItem(NOTIFIED_KEY, info.buildId);
      } catch {
        /* 忽略存储失败：最坏情况是刷新后提醒重现 */
      }
      setRemote({ info, mode });
    } catch {
      /* 网络异常静默，等下一轮 */
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    check();
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('hashchange', check); // 切换路由时顺带检测
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('hashchange', check);
    };
  }, [check]);

  /** 「暂不刷新」/ ✕ /「知道了」：本版本 10 分钟内不再提醒，期满恢复 */
  const snooze = useCallback((info: RemoteVersion) => {
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify({ buildId: info.buildId, at: Date.now() } satisfies Snooze));
    } catch {
      /* 忽略存储失败 */
    }
    setRemote(null);
  }, []);

  return { remote, snooze };
}
