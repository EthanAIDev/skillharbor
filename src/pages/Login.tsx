import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';

export default function Login() {
  const { login } = useAuth();
  const { dark, toggle } = useTheme();
  const nav = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const r = await login(username, password);
    setLoading(false);
    if (r.ok) nav((location.state as { from?: string } | null)?.from || '/');
    else setError(r.error || '登录失败');
  };

  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center bg-bg px-4">
      <div className="hero-halo hero-halo-1 anim-fade" style={{ width: 560, height: 480, left: -80, top: -120 }} />
      <div className="hero-halo hero-halo-2 anim-fade" style={{ width: 620, height: 520, right: -60, bottom: -140 }} />

      <button
        onClick={toggle}
        className="absolute top-5 right-5 w-9 h-9 rounded-[10px] border border-line bg-card flex items-center justify-center text-t2 hover:text-t1"
      >
        {dark ? '☀' : '☾'}
      </button>

      <div className="relative w-full max-w-[400px] card p-8 anim-pop">
        <div className="flex flex-col items-center gap-3 mb-7">
          <span className="w-12 h-12 rounded-2xl bg-accent flex items-center justify-center text-white font-bold text-xl">S</span>
          <div className="text-center">
            <h1 className="text-lg font-semibold">SkillHarbor</h1>
            <p className="text-xs text-t3 mt-1">Self-hosted AI tools & skills portal</p>
          </div>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <div>
            <label className="text-xs text-t2 mb-1.5 block">用户名</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="姓名全拼，如 liudan"
              autoFocus
              className="w-full h-11 rounded-xl bg-soft dark:bg-card border border-line px-3.5 text-sm outline-none focus:border-accent transition-colors text-t1 placeholder:text-t3"
            />
          </div>
          <div>
            <label className="text-xs text-t2 mb-1.5 block">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="默认密码 123456"
              className="w-full h-11 rounded-xl bg-soft dark:bg-card border border-line px-3.5 text-sm outline-none focus:border-accent transition-colors text-t1 placeholder:text-t3"
            />
          </div>

          {error && (
            <div className="anim-fade rounded-lg bg-warnSoft text-warn text-xs px-3 py-2.5 leading-relaxed">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="btn-primary mt-1 h-11 !text-sm w-full disabled:opacity-50"
          >
            {loading ? <span className="spinner" /> : '登 录'}
          </button>
        </form>

        <p className="mt-5 text-[11px] text-t3 leading-relaxed text-center">
          Demo seed: admin / admin123 · alice or bob / 123456 — change passwords after first login
          <br />
          遇到问题请联系管理员（admin）
        </p>
      </div>
    </div>
  );
}
