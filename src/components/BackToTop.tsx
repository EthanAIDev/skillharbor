import { useEffect, useState } from 'react';

/** 返回顶部：页面滚动超过约一屏后出现在右下角，点击平滑回到顶部 */
export default function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!show) return null;

  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="返回顶部"
      aria-label="返回顶部"
      className="anim-pop fixed bottom-6 right-6 z-40 w-11 h-11 rounded-full card shadow-[0_8px_24px_rgba(0,0,0,0.14)] flex items-center justify-center text-t2 hover:text-t1 hover:-translate-y-0.5 transition-all"
    >
      ↑
    </button>
  );
}
