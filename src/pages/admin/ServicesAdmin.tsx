import { useEffect, useState } from 'react';
import { api, type ServiceRow, type ServicesInfo } from '../../services/api';
import SkillsSyncPanel from './SkillsSyncPanel';

const fmtDT = (t?: number) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const HEALTH_TEXT: Record<string, string> = { unreachable: '不可达' };

/** 服务运维：服务型工具的端口占用、容器实时资源（CPU/内存）、镜像与卷占用一览 */
export default function ServicesAdmin() {
  const [data, setData] = useState<ServicesInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      setData(await api.adminServices.list());
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(); }, []);

  const rows = data?.rows || [];
  const live = data?.live;
  const containers = live?.containers || [];
  const stats = live?.stats || {};
  const dfImg = (live?.df || []).find((x) => x.Type === 'Images');
  const dfVol = (live?.df || []).find((x) => x.Type === 'Local Volumes');
  const running = rows.filter((r) => containers.find((c) => c.name === `skillharbor-svc-${r.siteKey}` && c.running)).length;

  const svcOf = (r: ServiceRow) => containers.find((c) => c.name === `skillharbor-svc-${r.siteKey}`);
  const statOf = (r: ServiceRow) => stats[`skillharbor-svc-${r.siteKey}`];

  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center gap-2.5 flex-wrap">
        <h2 className="text-[15px] font-semibold">服务型工具资源一览</h2>
        <span className="pill bg-accentSoft text-accentText font-normal">{rows.length} 个服务</span>
        <span className="flex-1" />
        <span className="text-[11px] text-t3">每容器限额：内存 512M · CPU 1 核 · 数据落 /data 卷</span>
        <button className="btn-ghost !text-xs !h-8" onClick={load} disabled={busy}>
          {busy ? '刷新中…' : '↻ 刷新'}
        </button>
      </div>

      {/* 汇总卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: '服务数 / 运行中', value: `${rows.length} / ${running}` },
          { label: '端口段占用', value: `${rows.length} / ${(data?.portEnd || 18399) - (data?.portBegin || 18200) + 1}` },
          { label: '镜像总占用', value: dfImg?.Size || '—', chip: dfImg?.Reclaimable ? `可回收 ${dfImg.Reclaimable}` : '' },
          { label: '数据卷总占用', value: dfVol?.Size || '—', chip: dfVol?.Reclaimable ? `可回收 ${dfVol.Reclaimable}` : '' },
          { label: '版本保留策略', value: '每工具 3 版', chip: '当前运行版永不清理' },
        ].map((k) => (
          <div key={k.label} className="card p-[14px] flex flex-col gap-1">
            <span className="text-[11px] text-t3">{k.label}</span>
            <span className="font-mono text-[19px] font-semibold leading-none">{k.value}</span>
            {k.chip && <span className="pill bg-soft text-t3 font-normal !text-[10px] mt-0.5 self-start">{k.chip}</span>}
          </div>
        ))}
      </div>

      {live && !live.ok && (
        <div className="rounded-xl bg-warnSoft text-warn text-xs px-4 py-2.5">
          实时容器状态不可用{live.message ? `（${live.message}）` : ''}，以下仅展示端口登记信息。
        </div>
      )}

      {/* 明细表 */}
      <div className="card overflow-x-auto">
        <div className="flex bg-soft dark:bg-[#16151F] border-b border-line min-w-[980px]">
          <span className="th flex-1 min-w-[180px]">工具</span>
          <span className="th w-[104px]">卡片状态</span>
          <span className="th w-[120px]">端口映射</span>
          <span className="th w-[86px]">CPU</span>
          <span className="th w-[130px]">内存（限额 512M）</span>
          <span className="th w-[150px]">容器</span>
          <span className="th w-[128px]">最近探活</span>
          <span className="th w-[150px]">当前镜像</span>
        </div>
        {rows.map((r) => {
          const c = svcOf(r);
          const st = statOf(r);
          const memUse = st?.mem?.split(' / ')[0] || '';
          return (
            <div key={r.siteKey} className="flex items-center border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03] min-w-[980px]">
              <div className="td flex-1 min-w-[180px]">
                <div className="font-medium text-t1 truncate">{r.name}</div>
                <a href={r.url} target="_blank" rel="noreferrer" className="text-[10px] text-accentText font-mono hover:underline truncate block" title={r.url}>{r.url}</a>
              </div>
              <span className="td w-[104px]">
                <span className={`pill font-normal ${r.status === 'online' ? 'bg-okSoft text-ok' : 'bg-soft text-t3'}`}>
                  {r.status === 'online' ? '上线' : r.status === 'offline' ? '已下线' : '卡片缺失'}
                </span>
              </span>
              <span className="td w-[120px] font-mono text-[11px]">{r.port} → {r.containerPort}</span>
              <span className="td w-[86px] font-mono text-[11px]">{st?.cpu || '—'}</span>
              <span className="td w-[130px] font-mono text-[11px]">{st ? `${memUse} / 512MiB` : '—'}</span>
              <span className="td w-[150px]">
                {c ? (
                  <span className={`pill font-normal ${c.running ? 'bg-okSoft text-ok' : 'bg-dangerSoft text-danger'}`}>
                    {c.running ? '运行中' : '已停止'}
                  </span>
                ) : (
                  <span className="pill bg-soft text-t3 font-normal">无容器</span>
                )}
              </span>
              <span className="td w-[128px] text-[11px] text-t3">
                {r.health ? `${HEALTH_TEXT[String(r.health.status)] || r.health.status}${r.health.entry ? ` · 入口${r.health.entry}` : ''} · ${fmtDT(r.health.at)}` : '—'}
              </span>
              <span className="td w-[150px] font-mono text-[10.5px] text-t3 truncate" title={r.image}>{r.image}</span>
            </div>
          );
        })}
        {rows.length === 0 && <div className="p-12 text-center text-sm text-t3">还没有服务型工具部署（当前仅展示服务通道，静态网页工具不占端口）</div>}
        {!data && <div className="p-12 text-center text-sm text-t3">加载中…</div>}
      </div>

      <div className="text-xs text-t3 leading-relaxed">
        说明：端口段 18200-18399 由系统自动分配并登记（更新沿用原端口）；容器限额内存 512M / CPU 1 核，无特权、不挂载宿主目录；
        每工具保留最近 3 个版本（目录与镜像同步清理，当前运行版永不清理）；「可回收」为 Docker 估算的悬空层占用，磁盘紧张时可由管理员手动清理。
      </div>

      <div className="border-t border-line pt-4 mt-2 flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] font-semibold">技能同步接入清单</h2>
          <span className="text-[11px] text-t3">技能网关已独立为 MCP 服务层（管理控制台为外部链接），接入心跳数据源在门户侧</span>
        </div>
        <SkillsSyncPanel />
      </div>
    </div>
  );
}
