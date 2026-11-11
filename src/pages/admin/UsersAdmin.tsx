import { useState } from 'react';
import UserAdmin from '../UserAdmin';
import LoginLogAdmin from './LoginLogAdmin';

/** 用户管理：账号列表 / 登录记录 两页签（原「登录记录」菜单并入此处） */
export default function UsersAdmin() {
  const [tab, setTab] = useState<'accounts' | 'logins'>('accounts');
  return (
    <div className="flex flex-col min-h-full">
      <div className="px-6 pt-5 flex gap-2 items-center">
        {(
          [
            ['accounts', '账号列表'],
            ['logins', '登录记录'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`tab ${tab === k ? 'tab-active' : 'tab-idle'}`}>
            {label}
          </button>
        ))}
        {tab === 'logins' && (
          <span className="flex-1 text-right text-xs text-t3">IP 仅用于安全审计与异常排查，不与任何统计挂钩</span>
        )}
      </div>
      <div className="p-6 pt-4">{tab === 'accounts' ? <UserAdmin /> : <LoginLogAdmin />}</div>
    </div>
  );
}
