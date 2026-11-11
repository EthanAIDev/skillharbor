import { useEffect, useRef, useState } from 'react';
import KbExplorer from './KbExplorer';
import SkillGuideModal from '../components/SkillGuideModal';
import { useAuth } from '../hooks/useAuth';
import { getToken } from '../services/api';

/* =====================================================================
 * KnowledgeBase —— 知识库独立页（/kb，一级导航直达）
 * 页面头（标题 + 大语义搜索 + 热门词）+ KbExplorer 融合视图 + 经典视图。
 * 头部大搜索经 kb-search-q 信号 + remount 传入 KbExplorer（其初始
 * state 读信号，与旧首页全局搜索同一机制，组件零改动）；
 * kb-open-doc（带文档进入自动开预览）同样由 KbExplorer 挂载时消费。
 * ===================================================================== */

const HOT_WORDS = ['可研模板', '产业规划', '招商政策', '智能体开发'];

export default function KnowledgeBase() {
  const { session } = useAuth();
  const me = session!;
  const [headQ, setHeadQ] = useState('');
  /* 头部大搜索提交：写信号后重挂 KbExplorer（key+1），其 useState 初始化函数读取信号 */
  const [kbKey, setKbKey] = useState(0);
  const [showGuide, setShowGuide] = useState(false);

  /* 旧跳转信号 kb-goto 的清理（信号本身不再需要：独立页无需切 tab） */
  useEffect(() => {
    try { localStorage.removeItem('kb-goto'); } catch {}
  }, []);


  const submitHead = (word?: string) => {
    const w = (word ?? headQ).trim();
    if (!w) return;
    setHeadQ(w);
    try { localStorage.setItem('kb-search-q', w); } catch {}
    setKbKey((k) => k + 1);
  };

  return (
    <div className="mx-auto max-w-[1440px] w-full px-8 flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      {/* ===== 页面头：标题 + 大语义搜索 + 热门词 ===== */}
      <div className="pt-7 pb-4">
        <div className="text-[11px] tracking-[.14em] text-accentText font-bold">KNOWLEDGE BASE</div>
        <div className="flex items-end gap-4 flex-wrap mt-1.5">
          <h1 className="text-[26px] font-bold tracking-tight">知识库 · 公司的大脑，人人可查</h1>
          <span className="text-[12px] text-t3 pb-1.5">公开库 + 部门库 + 私有库 · 语义检索</span>
        </div>
        <div className="mt-4 flex items-center gap-2.5">
          <div className="flex-1 h-[44px] rounded-[12px] border-[1.5px] border-line bg-card flex items-center px-4 gap-2.5 shadow-[0_2px_10px_rgba(15,20,25,.03)] focus-within:border-accent transition-colors">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round" className="shrink-0"><circle cx="9" cy="9" r="6" /><path d="m17.5 17.5-4-4" /></svg>
            <input
              className="bg-transparent outline-none w-full text-[14px] text-t1 placeholder:text-t3"
              placeholder="自然语言提问，如「可研报告的模板有哪些？」"
              value={headQ}
              onChange={(e) => setHeadQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitHead()}
            />
          </div>
          <button className="btn-primary !h-[44px] !px-5" onClick={() => submitHead()}>语义搜索</button>
          <button className="btn-ghost !h-[44px]" onClick={() => setShowGuide(true)}>在 WorkBuddy 里问</button>
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-[12px] text-t3 flex-wrap">
          大家在搜：
          {HOT_WORDS.map((w) => (
            <button key={w} className="text-accentText bg-accentSoft rounded-full px-3 py-[3px] font-medium hover:opacity-80 transition-opacity" onClick={() => submitHead(w)}>
              {w}
            </button>
          ))}
          <span className="ml-auto">负责人可上传维护 · 覆盖上传自动留版本 · 传完即可搜</span>
        </div>
      </div>

      {/* ===== 主区域：融合视图（经典视图已于 2026-10-14 拍板下线） ===== */}
      <div className="flex-1 min-h-0 flex flex-col">
        <KbExplorer key={kbKey} meName={me.name} onGuide={() => setShowGuide(true)} />
      </div>

      {showGuide && <SkillGuideModal onClose={() => setShowGuide(false)} />}
    </div>
  );
}
