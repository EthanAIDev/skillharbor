import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';
import StatsDashboard from './admin/StatsDashboard';
import ReviewCenter from './admin/ReviewCenter';
import ToolsAdmin from './admin/ToolsAdmin';
import SkillsManage, { type SkillsManageTab } from './admin/SkillsManage';
import ServicesAdmin from './admin/ServicesAdmin';
import EvalsAdmin from './admin/EvalsAdmin';
import UsersAdmin from './admin/UsersAdmin';
import OpsDashboard from './admin/OpsDashboard';
import SettingsAdmin from './admin/SettingsAdmin';

type View = 'stats' | 'review' | 'tools' | 'skills' | 'services' | 'evals' | 'users' | 'ops' | 'settings';

/** 旧链接兼容：gw-* 为技能管理迁出网关控制台期间的深链 key；kb 为已下线的知识库权限矩阵（MxsDoc 个人授权层已废弃，指回组织管理） */
const VIEW_ALIAS: Record<string, View> = {
  uploads: 'review', tools: 'tools', users: 'users', logins: 'users', stats: 'stats', kb: 'users',
  'gw-skills': 'skills', 'gw-logs': 'skills',
};

const VIEW_KEYS: View[] = ['stats', 'review', 'tools', 'skills', 'services', 'evals', 'users', 'ops', 'settings'];
function viewFromQuery(query: URLSearchParams): View {
  const v = query.get('view') || '';
  if ((VIEW_KEYS as string[]).includes(v)) return v as View;
  return VIEW_ALIAS[v] || 'stats';
}

const TITLES: Record<View, string> = {
  stats: '统计看板',
  review: '审核中心',
  tools: '工具管理',
  skills: '技能管理',
  services: '服务运维',
  evals: '评价管理',
  users: '组织管理',
  ops: '运营总览',
  settings: '系统设置',
};

/** 技能管理页签深链（飞书告警卡片「去处理」→ /#/admin?view=skills&tab=alerts） */
function skillsTabFromQuery(query: URLSearchParams): SkillsManageTab {
  const t = query.get('tab') || (query.get('view') === 'gw-logs' ? 'logs' : 'skills');
  return t === 'logs' || t === 'alerts' || t === 'dependencies' ? t : 'skills';
}

/** 管理后台外壳：侧边栏与顶栏固定，仅内容区滚动；技能管理回归门户（网关控制台退役） */
export default function Admin() {
  const { dark, toggle } = useTheme();
  const { session } = useAuth();
  const [query, setQuery] = useSearchParams();
  const view = viewFromQuery(query);
  const skillsTab = skillsTabFromQuery(query);
  const [statsToolId, setStatsToolId] = useState('');
  const logsSkill = query.get('skill') || '';
  const [pendingCount, setPendingCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);

  const refreshBadges = () => {
    api.uploads.adminList('pending').then((r) => r.ok && setPendingCount((r.rows || []).length));
    api.gateway.alerts({ status: 'open' }).then((a) => Array.isArray(a) && setAlertCount(a.length)).catch(() => {});
  };
  useEffect(refreshBadges, [view]);

  // Router state survives refresh and follows browser back/forward navigation.
  const navigateView = (next: View, tab?: SkillsManageTab, skill?: string) => {
    const params = new URLSearchParams();
    params.set('view', next);
    if (next === 'skills' && tab) params.set('tab', tab);
    if (next === 'skills' && tab === 'logs' && skill) params.set('skill', skill);
    setQuery(params);
  };

  if (!session || session.role !== 'admin') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg flex-col gap-4">
        <p className="text-sm text-t3">该页面仅管理员可见</p>
        <Link to="/" className="btn-primary">返回首页</Link>
      </div>
    );
  }

  const menus: { key: View; label: string; badge?: number }[] = [
    { key: 'stats', label: '统计看板' },
    { key: 'review', label: '审核中心', badge: pendingCount },
    { key: 'tools', label: '工具管理' },
    { key: 'skills', label: '技能管理', badge: alertCount },
    { key: 'services', label: '服务运维' },
    { key: 'evals', label: '评价管理' },
    { key: 'users', label: '组织管理' },
    { key: 'ops', label: '运营总览' },
    { key: 'settings', label: '系统设置' },
  ];
  const menuGroups: { label: string; keys: View[] }[] = [
    { label: '资源与审核', keys: ['review', 'tools', 'skills', 'evals'] },
    { label: '运行与统计', keys: ['stats', 'services', 'ops'] },
    { label: '组织与设置', keys: ['users', 'settings'] },
  ];

  return (
    <div className="h-full overflow-hidden flex bg-bg">
      {/* 侧边栏（固定） */}
      <aside className="w-[232px] shrink-0 h-full bg-card border-r border-line flex flex-col">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
          <span className="w-[26px] h-[26px] rounded-lg bg-accent flex items-center justify-center text-white font-bold text-[13px]">Z</span>
          <div>
            <div className="text-[13px] font-semibold">SkillHarbor 管理后台</div>
            <div className="text-[10px] text-t3">内容与权限管理</div>
          </div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-3 flex flex-col gap-1">
          {menuGroups.map((group, index) => <div key={group.label} role="group" aria-labelledby={`admin-nav-${index}`} className="mb-2">
            <h2 id={`admin-nav-${index}`} className="px-3 pt-2 pb-1 text-[11px] text-t2 font-medium">{group.label}</h2>
            {group.keys.map(key => menus.find(menu => menu.key === key)!).map((n) => (
            <button
              key={n.key}
              aria-current={view === n.key ? 'page' : undefined}
              onClick={() => {
                navigateView(n.key);
                if (n.key === 'stats') setStatsToolId('');
              }}
              className={`text-[13px] text-left px-3 py-2.5 rounded-[10px] w-full flex items-center gap-2 transition-colors ${
                view === n.key ? 'bg-accentSoft text-accentText font-medium' : 'text-t2 hover:text-t1'
              }`}
            >
              {n.label}
              {n.badge ? (
                <span className="rounded-full bg-warnSoft text-warn px-[7px] py-px text-[10px] font-semibold font-mono">{n.badge}</span>
              ) : null}
            </button>
            ))}
          </div>)}
        </nav>

        <div className="px-3 pb-4 pt-2 border-t border-line flex flex-col gap-0.5">
          <button onClick={toggle} className="text-left px-3 py-2 text-xs text-t3 hover:text-t1">
            {dark ? '切换浅色主题' : '切换深色主题'}
          </button>
          <Link to="/" className="px-3 py-1.5 text-xs text-t3 hover:text-t1">
            ← 返回门户首页
          </Link>
        </div>
      </aside>

      {/* 主区：顶栏固定，内容区滚动 */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <header className="h-14 shrink-0 bg-card border-b border-line px-6 flex items-center gap-3" data-view={view}>
          <h1 className="text-[17px] font-semibold">{TITLES[view]}</h1>
          {view === 'skills' && <span className="text-xs text-t2">智能体与 AI 技能</span>}
          {view === 'review' && pendingCount > 0 && (
            <span className="pill bg-warnSoft text-warn font-medium">{pendingCount} 条待审</span>
          )}
          {view === 'skills' && alertCount > 0 && (
            <span className="pill bg-dangerSoft text-danger font-medium">{alertCount} 条告警待处理</span>
          )}
        </header>
        <main className="flex-1 min-h-0 overflow-y-auto">
          {view === 'stats' ? (
            <StatsDashboard
              focusToolId={statsToolId}
              onDoneFocus={() => setStatsToolId('')}
              onOpenSkillLogs={(slug) => navigateView('skills', 'logs', slug)}
            />
          ) : view === 'review' ? (
            <ReviewCenter onOpenAlerts={() => navigateView('skills', 'alerts')} onChanged={refreshBadges} />
          ) : view === 'tools' ? (
            <ToolsAdmin />
          ) : view === 'skills' ? (
            <SkillsManage tab={skillsTab} onTab={(tab) => navigateView('skills', tab, logsSkill)} onAlertsChange={refreshBadges} initialLogSkill={logsSkill} />
          ) : view === 'services' ? (
            <ServicesAdmin />
          ) : view === 'evals' ? (
            <EvalsAdmin />
          ) : view === 'ops' ? (
            <OpsDashboard />
          ) : view === 'settings' ? (
            <SettingsAdmin />
          ) : (
            <UsersAdmin />
          )}
        </main>
      </div>
    </div>
  );
}
