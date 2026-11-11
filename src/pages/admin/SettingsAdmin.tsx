import { useEffect, useState } from 'react';
import { api } from '../../services/api';

/** 系统设置：飞书告警 webhook（数据卷持久化，源码不内置地址） */
export default function SettingsAdmin() {
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 3000);
  };

  useEffect(() => {
    api.alertWebhook.get().then((r) => {
      if (r.ok) setUrl(r.url || '');
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    const v = url.trim();
    if (v && !/^https:\/\//.test(v)) return flash('地址必须以 https:// 开头');
    setBusy(true);
    const r = await api.alertWebhook.set(v);
    setBusy(false);
    setUrl(v);
    flash(r.ok ? r.message || '已保存' : r.message || '保存失败');
  };

  const sendTest = async () => {
    setBusy(true);
    const r = await api.alertWebhook.test();
    setBusy(false);
    flash(r.ok ? r.message || '已发送' : r.message || '发送失败');
  };

  return (
    <div className="p-6 flex flex-col gap-4 relative max-w-[760px]">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      <div className="card p-5 flex flex-col gap-3.5">
        <div className="flex items-center gap-2.5">
          <h3 className="text-[15px] font-semibold">飞书告警推送</h3>
          <span className={`pill font-normal ${url ? 'bg-okSoft text-ok' : 'bg-warnSoft text-warn'}`}>
            {url ? '● 已配置' : '○ 未配置（推送暂停）'}
          </span>
        </div>
        <p className="text-xs text-t2 leading-relaxed">
          待审核提醒、技能中心告警、登录异常等卡片会推送到该飞书群机器人 webhook。
          地址保存在服务端数据卷（不进代码仓库），留空即暂停全部推送。
        </p>
        <div className="flex gap-2.5 items-start">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
            className="flex-1 h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-xs outline-none focus:border-accent text-t1 font-mono"
          />
          <button className="btn-primary !text-xs whitespace-nowrap" disabled={busy || !loaded} onClick={save}>
            {busy ? '处理中…' : '保存'}
          </button>
          <button className="btn-ghost !text-xs whitespace-nowrap" disabled={busy || !url} onClick={sendTest}>
            发送测试卡片
          </button>
        </div>
        <div className="text-[11px] text-t3 leading-relaxed">
          获取方式：飞书群 → 设置 → 群机器人 → 添加「自定义机器人」→ 复制 Webhook 地址。
          地址泄露后可在飞书侧禁用旧机器人重新添加（即完成轮换），再在此更新。
        </div>
      </div>
    </div>
  );
}
