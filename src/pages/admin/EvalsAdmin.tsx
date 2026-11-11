import { useEffect, useState } from 'react';
import { api } from '../../services/api';

/** 管理后台 · 评价管理：全量记录、筛选、复核剔除、删除、导出 CSV */
export default function EvalsAdmin() {
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState({ target: '', vote: '', flag: '', q: '' });
  const [toast, setToast] = useState('');

  const load = async () => {
    const r = await api.evals.adminList(f);
    if (r.ok) setRows(r.rows || []);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 2000);
  };

  const flag = async (id: string, fl: 'ok' | 'excluded') => {
    const r = await api.evals.flag(id, fl);
    if (r.ok) {
      flash(r.message);
      load();
    } else flash(r.message || '操作失败');
  };
  const remove = async (id: string) => {
    if (!confirm('确认删除这条评价？删除后不可恢复')) return;
    const r = await api.evals.remove(id);
    if (r.ok) {
      flash('已删除');
      load();
    } else flash(r.message || '删除失败');
  };

  const suspects = rows.filter((r) => r.flag === 'suspect').length;

  return (
    <div className="p-6 flex flex-col gap-4 relative">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      {/* 筛选 */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="w-[240px] h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line flex items-center px-3">
          <input
            value={f.q}
            onChange={(e) => setF({ ...f, q: e.target.value })}
            placeholder="搜索用户 / 评语关键词…"
            className="w-full bg-transparent outline-none text-xs placeholder:text-t3"
          />
        </div>
        <select value={f.vote} onChange={(e) => setF({ ...f, vote: e.target.value })} className="h-[34px] rounded-[10px] bg-soft dark:bg-card border border-line px-2.5 text-xs outline-none text-t2">
          <option value="">全部方向</option>
          <option value="1">推荐</option>
          <option value="-1">不推荐</option>
        </select>
        <select value={f.flag} onChange={(e) => setF({ ...f, flag: e.target.value })} className="h-[34px] rounded-[10px] bg-soft dark:bg-card border border-line px-2.5 text-xs outline-none text-t2">
          <option value="">全部状态</option>
          <option value="ok">正常</option>
          <option value="suspect">疑似异常</option>
          <option value="excluded">已剔除</option>
        </select>
        <span className="flex-1" />
        {suspects > 0 && <span className="pill bg-warnSoft text-warn font-normal">待复核 {suspects} 条</span>}
        <a href={api.evals.exportUrl()} className="btn-ghost !text-xs" download>导出 CSV</a>
      </div>

      {/* 表格 */}
      <div className="card overflow-x-auto">
        <div className="flex bg-soft dark:bg-[#16151F] border-b border-line min-w-[980px]">
          <span className="th w-[130px]">时间</span>
          <span className="th flex-1 min-w-[180px]">对象</span>
          <span className="th w-[150px]">用户（部门）</span>
          <span className="th w-[76px]">方向</span>
          <span className="th flex-1 min-w-[220px]">评语</span>
          <span className="th w-[120px]">IP</span>
          <span className="th w-[88px]">状态</span>
          <span className="th w-[150px]">操作</span>
        </div>
        {rows.map((e) => (
          <div
            key={e.id}
            className={`flex border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03] min-w-[980px] ${e.flag === 'suspect' ? 'bg-warnSoft/50 dark:bg-warnSoft/10' : ''}`}
          >
            <span className="td w-[130px] font-mono text-[11px]">{new Date(e.t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="td flex-1 min-w-[180px] truncate" title={e.tn || e.target}>{e.tn || e.target}</span>
            <span className="td w-[150px]">
              {e.n} <span className="text-[11px] text-t3">({e.d})</span>
            </span>
            <span className={`td w-[76px] ${e.v === 1 ? 'text-ok' : 'text-danger'}`}>{e.v === 1 ? '推荐' : '不推荐'}</span>
            <span className="td flex-1 min-w-[220px] truncate" title={e.c}>{e.c || <span className="text-t3">（未填写）</span>}</span>
            <span className="td w-[120px] font-mono text-[11px]">{e.ip}</span>
            <span className="td w-[88px]">
              {e.flag === 'excluded' ? (
                <span className="pill bg-soft text-t3 font-normal">已剔除</span>
              ) : e.flag === 'suspect' ? (
                <span className="pill bg-warnSoft text-warn font-normal">疑似异常</span>
              ) : (
                <span className="pill bg-okSoft text-ok font-normal">正常</span>
              )}
            </span>
            <span className="td w-[150px] whitespace-nowrap">
              {e.flag === 'excluded' ? (
                <button className="text-ok hover:underline mr-3" onClick={() => flag(e.id, 'ok')}>恢复计入</button>
              ) : (
                <button className="text-warn hover:underline mr-3" onClick={() => flag(e.id, 'excluded')}>剔除</button>
              )}
              <button className="text-t3 hover:text-danger hover:underline" onClick={() => remove(e.id)}>删除</button>
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="p-12 text-center text-sm text-t3">暂无评价记录</div>}
      </div>
      <p className="text-xs text-t3">规则：同 IP 多账号集中评价自动标黄待复核；剔除后不计入好评率；导出 CSV 可用 Excel 打开</p>
    </div>
  );
}
