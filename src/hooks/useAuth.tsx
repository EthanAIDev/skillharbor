import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken, setToken } from '../services/api';

const SESSION_KEY = 'skillharbor-session';

export interface Session {
  username: string;
  name: string;
  role: 'user' | 'admin';
  dept: string;
  loginAt: number;
}

interface AuthCtx {
  session: Session | null;
  booting: boolean; // 启动时校验令牌中
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  /** 会话失效（令牌过期 / 改密 / 被禁用）时由 API 层调用 */
  expire: () => void;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

function readSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readSession);
  const [booting, setBooting] = useState(true);

  const applySession = useCallback((s: Session | null) => {
    setSession(s);
    try {
      s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // 启动校验：令牌有效则刷新会话信息，无效则清空
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getToken()) {
        setBooting(false);
        return;
      }
      const r = await api.me();
      if (!alive) return;
      if (r.ok && r.session) {
        applySession({ ...r.session, loginAt: Date.now() });
      } else if (r.unauthorized || r.status === 401) {
        setToken('');
        applySession(null);
      }
      // A transient outage says nothing about token validity. Keep the cached
      // session; protected operations still require server authorization.
      setBooting(false);
    })();
    return () => {
      alive = false;
    };
  }, [applySession]);

  const login = useCallback(
    async (username: string, password: string) => {
      const r = await api.login(username.trim().toLowerCase(), password);
      if (r.ok && r.token) {
        setToken(r.token);
        applySession(r.session);
        return { ok: true };
      }
      return { ok: false, error: r.message || '登录失败' };
    },
    [applySession],
  );

  const logout = useCallback(() => {
    setToken('');
    applySession(null);
  }, []);

  const expire = useCallback(() => {
    setToken('');
    applySession(null);
  }, []);

  const value = useMemo(() => ({ session, booting, login, logout, expire }), [session, booting, login, logout, expire]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
