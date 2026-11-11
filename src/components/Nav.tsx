import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SkillGuideModal from './SkillGuideModal';
import { ZbModal } from './ZbModal';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { api, getToken } from '../services/api';

/** 修改密码弹窗：自助修改（旧密码验证）。改密使口令纪元自增、全部旧会话失效，
 *  成功后提示并延迟登出，要求用新密码重新登录（不保留当前会话）。 */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { logout } = useAuth();
  const oldPwdRef = useRef<HTMLInputElement>(null);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [busy, setBusy] = useState(false);
  /* 输入即校验：确认框有内容时实时比对新密码是否一致 */
  const mismatch = confirmPwd !== '' && newPwd !== confirmPwd;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setOkMsg('');
    if (newPwd.length < 6) return setErr('新密码至少 6 位');
    if (newPwd !== confirmPwd) return setErr('两次输入的新密码不一致');
    setBusy(true);
    const r = await api.changePassword(oldPwd, newPwd);
    setBusy(false);
    if (r.ok) {
      setOkMsg('密码已修改，请重新登录');
      setOldPwd('');
      setNewPwd('');
      setConfirmPwd('');
      /* 延迟 2 秒让用户看清提示，随后强制登出并跳转登录页（改密后所有旧会话已失效） */
      setTimeout(() => {
        logout();
        onClose();
        nav('/login');
      }, 2000);
    } else {
      setErr(r.message || '修改失败');
    }
  };

  return (
    <ZbModal open onClose={onClose} label="修改密码" maxWidth="max-w-[400px]" focusRef={oldPwdRef}>
      <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-t3 hover:text-t1 hover:bg-soft text-lg">
        ✕
      </button>
      <h2 className="text-base font-semibold mb-1">修改密码</h2>
      <p className="text-xs text-t3 mb-5">修改登录密码 · 成功后需使用新密码重新登录</p>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <div>
          <label className="text-xs text-t2 mb-1.5 block">当前密码</label>
          <input
            type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} required
            ref={oldPwdRef}
            className="w-full h-11 rounded-xl bg-soft dark:bg-card border border-line px-3.5 text-sm outline-none focus:border-accent transition-colors text-t1"
          />
        </div>
          <div>
            <label className="text-xs text-t2 mb-1.5 block">新密码（至少 6 位，建议字母 + 数字）</label>
            <input
              type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} required
              className="w-full h-11 rounded-xl bg-soft dark:bg-card border border-line px-3.5 text-sm outline-none focus:border-accent transition-colors text-t1"
            />
          </div>
          <div>
            <label className="text-xs text-t2 mb-1.5 block">确认新密码</label>
            <input
              type="password" value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} required
              className={`w-full h-11 rounded-xl bg-soft dark:bg-card border px-3.5 text-sm outline-none transition-colors text-t1 ${mismatch ? 'border-danger' : 'border-line focus:border-accent'}`}
            />
            {confirmPwd && (
              <p className={`text-[11px] mt-1.5 ${mismatch ? 'text-danger' : 'text-ok'}`}>
                {mismatch ? '✕ 两次输入的新密码不一致' : '✓ 两次输入一致'}
              </p>
            )}
          </div>
          {err && <div className="rounded-lg bg-dangerSoft text-danger text-xs px-3 py-2.5">{err}</div>}
          {okMsg && <div className="rounded-lg bg-okSoft text-ok text-xs px-3 py-2.5">{okMsg}</div>}
          <button type="submit" disabled={busy || !oldPwd || !newPwd || !confirmPwd || mismatch} className="btn-primary mt-1 h-11 !text-sm w-full disabled:opacity-50">
            {busy ? '保存中…' : '保存修改'}
          </button>
          <p className="text-[11px] text-t3 leading-relaxed text-center">忘记密码请联系管理员（admin）重置为默认密码</p>
        </form>
    </ZbModal>
  );
}

export default function Nav() {
  const [guide, setGuide] = useState(false);
  const [bannerOff, setBannerOff] = useState(() => {
    try { return localStorage.getItem('dt-gw-banner') === 'off'; } catch { return false; }
  });
  const nav = useNavigate();
  const { dark, toggle } = useTheme();
  const { session, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  /* 回首页并回顶部：logo 与「首页」共用。跨页导航时先归零滚动，
   *  避免 React Router 换视图后停留在上一个页面的滚动位置；
   *  instant 覆盖全局 scroll-behavior:smooth，避免跨页切换后慢慢滚 */
  const goHome = () => {
    nav('/');
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  };

  return (
    <>
      <header className="sticky top-0 z-40 bg-card/95 backdrop-blur border-b border-line">
      <div className="mx-auto max-w-[1440px] h-16 px-8 flex items-center gap-3">
        <button onClick={goHome} className="flex items-center gap-3 shrink-0">
          <span className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-sm">S</span>
          <span className="font-semibold text-[15px]">SkillHarbor</span>
          <span className="hidden 2xl:inline text-[11px] text-t3">AI tools & skills portal</span>
        </button>

        <div className="flex-1" />

        <nav className="hidden md:flex items-center gap-1 whitespace-nowrap">
          <button onClick={goHome} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
            首页
          </button>
          <button onClick={() => nav('/?sec=tools')} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
            工具库
          </button>
          <button onClick={() => nav('/?sec=skills')} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
            技能库
          </button>
          <button onClick={() => nav('/?sec=agents')} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
            智能体
          </button>
          <button
            onClick={() => nav('/kb')}
            className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors"
          >
            知识库
          </button>
          <button onClick={() => nav('/apihub')} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
            接口中心
          </button>
          <button onClick={() => nav('/workbench')} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
            工作台
          </button>
          <button
            onClick={() => setGuide(true)}
            className="ml-1 px-3 py-1.5 text-[13px] font-medium text-accentText bg-accentSoft hover:bg-accentSoft/70 rounded-lg transition-colors"
            title="一键连接AI Gateway：技能 · 知识库 · 专家 · 数据工具"
          >
            配置 AI 网关
          </button>
          {session?.role === 'admin' && (
            <button onClick={() => nav('/admin')} className="px-3 py-1.5 text-[13px] text-t2 hover:text-t1 rounded-lg hover:bg-soft transition-colors">
              管理后台
            </button>
          )}
        </nav>

        <button
          onClick={toggle}
          title={dark ? '切换到浅色' : '切换到深色'}
          className="w-9 h-9 rounded-[10px] border border-line bg-card flex items-center justify-center text-t2 hover:text-t1 transition-colors"
        >
          {dark ? '☀' : '☾'}
        </button>

        {session && (
          <button onClick={() => nav('/?upload=1')} className="btn-primary shrink-0 hidden sm:inline-flex">
            发布资源
          </button>
        )}

        {/* 用户菜单（未登录显示登录按钮） */}
        {session ? (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-primaryForeground text-[11px] font-medium"
              title={session?.name}
            >
              {session?.name?.[0] || '员'}
            </button>
            {menuOpen && (
              <div className="anim-pop absolute right-0 top-10 w-44 card p-1.5 shadow-xl">
                <div className="px-3 py-2 border-b border-line mb-1">
                  <div className="text-[13px] font-medium">{session?.name}</div>
                  <div className="text-[11px] text-t3 font-mono mt-0.5">{session?.username}</div>
                </div>
                <button
                  onClick={() => { setMenuOpen(false); nav('/workbench'); }}
                  className="w-full text-left px-3 py-2 text-xs text-t2 hover:text-t1 hover:bg-soft rounded-lg"
                >
                  我的工作台
                </button>
                <button
                  onClick={() => { setMenuOpen(false); nav('/?upload=records'); }}
                  className="w-full text-left px-3 py-2 text-xs text-t2 hover:text-t1 hover:bg-soft rounded-lg"
                >
                  上传记录
                </button>
                <button
                  onClick={() => { setMenuOpen(false); setShowSettings(true); }}
                  className="w-full text-left px-3 py-2 text-xs text-t2 hover:text-t1 hover:bg-soft rounded-lg"
                >
                  修改密码
                </button>
                <button
                  onClick={() => { setMenuOpen(false); logout(); nav('/'); }}
                  className="w-full text-left px-3 py-2 text-xs text-t2 hover:text-t1 hover:bg-soft rounded-lg"
                >
                  退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <button onClick={() => nav('/login')} className="btn-primary shrink-0">
            登录
          </button>
        )}
      </div>
      
      </header>
      {/* AI 网关指引横幅（页面文档流：内容顺势下沉；关闭后由顶栏「一键配置AI Gateway」按钮承接入口） */}
        {!bannerOff && (
          <div className="border-t border-accent/20 bg-accentSoft/60 dark:bg-accentSoft/15">
            <div className="mx-auto max-w-[1440px] px-8 h-9 flex items-center justify-center gap-3">
              <span className="text-[12.5px] font-semibold text-accentText shrink-0">AI 网关使用指引</span>
              <span className="text-[11.5px] text-t2 truncate hidden sm:inline">一键连接AI Gateway，技能 · 知识库 · 专家 · 数据工具在 AI 助手中全部可用</span>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  className="rounded-md bg-accent text-primaryForeground px-2.5 py-1 text-[11.5px] font-medium hover:opacity-90 transition-opacity"
                  href={'/api/gateway/install-wb' + (session && getToken() ? `?token=${encodeURIComponent(getToken())}` : '')}
                  download
                  onClick={(e) => {
                    if (!session) { e.preventDefault(); nav('/login'); }
                  }}
                >
                  一键配置
                </a>
                <button className="text-[11.5px] text-accentText hover:underline" onClick={() => setGuide(true)}>
                  完整指引
                </button>
                <button
                  className="w-6 h-6 rounded-md text-t3 hover:text-t1 hover:bg-soft flex items-center justify-center text-sm"
                  title="关闭（下次登录前不再显示）"
                  onClick={() => { setBannerOff(true); try { localStorage.setItem('dt-gw-banner', 'off'); } catch {} }}
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        )}

      {guide && <SkillGuideModal onClose={() => setGuide(false)} />}

      {/* 弹窗不能放在 header 内：backdrop-blur 会让 fixed 后代以 header 为包含块，
          导致弹窗被压进 64px 高的顶栏区域。放 header 外才是相对视口居中。 */}
      {showSettings && <ChangePasswordModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
