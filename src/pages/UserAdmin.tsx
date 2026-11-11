import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from '../services/api';
import { ZbModal } from '../components/ZbModal';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../components/ui/dropdown-menu';

/* =====================================================================
 * 组织管理 v2.1（2026-10-14 原型拍板）：部门字典驱动——部门归属是知识库权限的源头。
 * 布局：左部门栏（负责人常驻+⋯菜单）/ 右部门概览卡+人员表（⋯菜单，单一状态）。
 * 操作全部收进 ⋯ 菜单；禁用人员默认不进表（顶栏开关）；调岗带实时影响预览。
 * 2026-10-20 shadcn/ui 落地试点：弹窗→ZbModal（Radix Dialog 底座）、⋯菜单→DropdownMenu，
 * 视觉与手写版一致；ESC/外点关闭、键盘导航为净增能力。
 * ===================================================================== */

interface User {
  username: string;
  name: string;
  role: 'user' | 'admin';
  dept: string;
  title?: string;
  lastLoginIp?: string;
  lastLoginAt?: number;
  maintains?: string[];
}
interface Dept {
  name: string;
  head: string;
  count: number;
  libId?: string;
  libName?: string;
  maintainers?: string[];
  owner?: string;
}

const fmtLogin = (t?: number) => {
  if (!t) return '';
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function UserAdmin() {
  const [users, setUsers] = useState<User[]>([]);
  const [disabledUsers, setDisabledUsers] = useState<User[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [unassigned, setUnassigned] = useState(0);
  const [q, setQ] = useState('');
  const [selDept, setSelDept] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [toast, setToast] = useState('');
  /* 弹窗 */
  const [showAdd, setShowAdd] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [showAddDept, setShowAddDept] = useState(false);
  const [headDept, setHeadDept] = useState<Dept | null>(null);
  const [renameDept, setRenameDept] = useState<Dept | null>(null);
  const [form, setForm] = useState({ username: '', name: '', dept: '', title: '' });
  const [editForm, setEditForm] = useState({ name: '', dept: '', title: '', role: 'user' });
  const [headForm, setHeadForm] = useState({ head: '', syncKb: true });
  const [deptForm, setDeptForm] = useState({ name: '', createLib: true });
  const [renameForm, setRenameForm] = useState('');
  const [formError, setFormError] = useState('');

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2600);
  };

  const reload = async () => {
    const [ur, dr] = await Promise.all([api.users.list(), api.org.depts()]);
    if (ur.ok) {
      setUsers(ur.users || []);
      setDisabledUsers(ur.disabled || []);
    }
    if (dr.ok) {
      setDepts(dr.depts || []);
      setUnassigned(dr.unassigned || 0);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const byName = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of [...users, ...disabledUsers]) m.set(u.username, u);
    return m;
  }, [users, disabledUsers]);
  const headName = (u: string) => byName.get(u)?.name || u;

  const filtered = useMemo(() => {
    let list = showDisabled ? [...users, ...disabledUsers] : users;
    if (selDept) list = list.filter((u) => u.dept === selDept);
    const k = q.trim();
    if (k) list = list.filter((u) => u.username.includes(k) || u.name.includes(k) || (u.title || '').includes(k));
    return list;
  }, [users, disabledUsers, showDisabled, selDept, q]);

  const curDept = depts.find((d) => d.name === selDept) || null;

  /* ---- 操作 ---- */
  const toggleDisable = async (username: string) => {
    const isDis = disabledUsers.some((x) => x.username === username);
    const r = isDis ? await api.users.enable(username) : await api.users.disable(username);
    flash(r.message || '已更新');
    reload();
  };
  const removeUser = async (username: string) => {
    const r = await api.users.remove(username);
    flash(r.ok ? r.message || '已删除' : r.message || '删除失败');
    reload();
  };
  const resetPassword = async (username: string) => {
    const r = await api.users.reset(username);
    flash(r.message || '已重置为初始密码 123456');
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!/^[a-z]+$/.test(form.username)) return setFormError('用户名需为小写字母拼音');
    if (!form.name.trim()) return setFormError('请填写姓名');
    if (!form.dept) return setFormError('请选择部门');
    const r = await api.users.add({ username: form.username, name: form.name, dept: form.dept, deptShort: form.dept, title: form.title });
    if (!r.ok) return setFormError(r.message || '新增失败');
    setShowAdd(false);
    setForm({ username: '', name: '', dept: '', title: '' });
    flash('已新增，初始密码 123456，请通知本人首登后修改密码');
    reload();
  };
  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    setFormError('');
    if (!editForm.name.trim()) return setFormError('请填写姓名');
    const r = await api.users.edit(editUser.username, {
      name: editForm.name, dept: editForm.dept, title: editForm.title,
      ...(editUser.username !== 'admin' ? { role: editForm.role } : {}),
    });
    if (!r.ok) return setFormError(r.message || '保存失败');
    const moved = editForm.dept !== editUser.dept;
    setEditUser(null);
    flash(moved ? '已保存（部门库可见性已实时切换）' : '已保存');
    reload();
  };
  const submitAddDept = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!deptForm.name.trim()) return setFormError('请填写部门名称');
    const r = await api.org.addDept(deptForm.name.trim(), deptForm.createLib);
    if (!r.ok) return setFormError(r.message || '新增失败');
    setShowAddDept(false);
    setDeptForm({ name: '', createLib: true });
    flash('部门已新增' + (r.note || ''));
    reload();
  };
  const submitHead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!headDept || !headForm.head) return;
    const r = await api.org.setHead(headDept.name, headForm.head, headForm.syncKb);
    if (!r.ok) return flash(r.message || '设置失败');
    setHeadDept(null);
    flash('负责人已设置' + (r.note || ''));
    reload();
  };
  const submitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameDept) return;
    setFormError('');
    if (!renameForm.trim()) return setFormError('请填写新名称');
    const r = await api.org.renameDept(renameDept.name, renameForm.trim());
    if (!r.ok) return setFormError(r.message || '重命名失败');
    setRenameDept(null);
    flash(`已重命名（${r.moved || 0} 人归属同步${r.note || ''}）`);
    setSelDept(renameForm.trim());
    reload();
  };
  const delDept = async (name: string) => {
    if (!confirm(`确认删除部门「${name}」？（仅允许删除无在职人员的部门）`)) return;
    const r = await api.org.delDept(name);
    flash(r.ok ? '已删除' : r.message || '删除失败');
    if (r.ok && selDept === name) setSelDept('');
    reload();
  };

  return (
    <div className="flex flex-col gap-4 relative">
      {toast && (
        <div className="anim-fade fixed top-20 right-8 z-50 rounded-xl bg-okSoft text-ok text-xs px-4 py-2.5 shadow-lg">{toast}</div>
      )}

      {/* 顶部工具条 */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="w-[220px] h-[34px] rounded-[10px] bg-soft dark:bg-card dark:border border-line flex items-center px-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索姓名 / 拼音 / 岗位…" className="w-full bg-transparent outline-none text-xs placeholder:text-t3" />
        </div>
        <span className="pill bg-soft text-t2">在职 <b className="font-mono">{users.length}</b></span>
        <button
          className={`pill ${showDisabled ? 'bg-accentSoft text-accentText' : 'bg-soft text-t2'} border border-line`}
          onClick={() => setShowDisabled(!showDisabled)}
        >{showDisabled ? '隐藏' : '显示'}禁用 <b className="font-mono">{disabledUsers.length}</b></button>
        <span className="pill bg-soft text-t2">部门 <b className="font-mono">{depts.length}</b></span>
        {unassigned > 0 && <span className="pill bg-dangerSoft text-danger">未分配 <b className="font-mono">{unassigned}</b></span>}
        <span className="flex-1" />
        <a className="btn-ghost !text-[13px]" href={`/api/admin/org/export?token=${encodeURIComponent(getToken() || '')}`}>导出花名册</a>
        <button className="btn-ghost !text-[13px]" onClick={() => { setShowAddDept(true); setDeptForm({ name: '', createLib: true }); setFormError(''); }}>＋ 新增部门</button>
        <button className="btn-primary" onClick={() => { setShowAdd(true); setForm({ username: '', name: '', dept: selDept || '', title: '' }); setFormError(''); }}>＋ 新增人员</button>
      </div>

      <div className="flex gap-4 items-stretch">
        {/* 左：部门栏（负责人常驻 + ⋯ 菜单，单一状态） */}
        <div className="card w-[236px] shrink-0 flex flex-col !p-0 overflow-visible">
          <div className="px-3.5 pt-3 pb-1.5 text-[11px] font-bold text-t3 tracking-widest">部门</div>
          <div
            className={`flex items-center gap-1.5 px-3 py-2 text-[13px] cursor-pointer border-l-[2.5px] ${!selDept ? 'border-accentText text-accentText font-semibold bg-accentSoft/40' : 'border-transparent text-t2 hover:bg-soft dark:hover:bg-white/[0.03]'}`}
            onClick={() => setSelDept('')}
          >
            <span className="flex-1">全部</span>
            <span className="text-[11px] text-t3 font-mono">{users.length}</span>
          </div>
          {depts.map((d) => (
            <div
              key={d.name}
              className={`flex items-center gap-1.5 px-3 pr-2 py-2 text-[13px] cursor-pointer border-l-[2.5px] ${selDept === d.name ? 'border-accentText text-accentText font-semibold bg-accentSoft/40' : 'border-transparent text-t2 hover:bg-soft dark:hover:bg-white/[0.03]'}`}
              onClick={() => setSelDept(d.name)}
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate" title={d.name}>{d.name}</span>
                <span className="block text-[10.5px] text-t3 font-normal truncate max-w-[140px]">{d.head ? `负责人 ${headName(d.head)}` : '未设负责人'}</span>
              </span>
              <span className="text-[11px] text-t3 font-mono shrink-0">{d.count}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                  <button className="shrink-0 w-6 h-6 rounded-md text-t3 hover:text-t1 hover:bg-line/60 font-bold">⋯</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[118px]">
                  <DropdownMenuItem onClick={() => { setHeadDept(d); setHeadForm({ head: d.head || '', syncKb: true }); }}>设置负责人</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setRenameDept(d); setRenameForm(d.name); setFormError(''); }}>重命名</DropdownMenuItem>
                  <DropdownMenuItem className="text-[#DC2626]" onClick={() => delDept(d.name)}>删除部门</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
          <div className="mt-auto border-t border-line px-3.5 py-2 text-[11px] text-t3 bg-soft dark:bg-transparent flex justify-between">
            <span>未分配人员</span>
            <b className={`font-mono ${unassigned ? 'text-danger' : 'text-t3'}`}>{unassigned}</b>
          </div>
        </div>

        {/* 右：部门概览卡 + 人员表 */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {curDept && (
            <div className="card px-4 py-3 flex items-center gap-4 flex-wrap">
              <span className="text-[14px] font-bold">{curDept.name}</span>
              <span className="text-[12px] text-t2">负责人 <b className="text-t1">{curDept.head ? headName(curDept.head) : '未设置'}</b> · {curDept.count} 人</span>
              <span className="text-[12px] text-t2">知识库 <b className="text-t1">{curDept.libName || curDept.name + '知识库'}</b> {curDept.libId ? <span className="pill bg-okSoft text-ok !text-[10px]">正常</span> : <span className="pill bg-warnSoft text-warn !text-[10px]">未创建</span>}</span>
              <span className="text-[12px] text-t2">维护员 <b className="text-t1">{(curDept.maintainers || []).map(headName).join('、') || '—'}</b></span>
              <span className="flex-1" />
              <button className="btn-ghost !text-[12.5px] !py-1.5" onClick={() => { setHeadDept(curDept); setHeadForm({ head: curDept.head || '', syncKb: true }); }}>设负责人</button>
            </div>
          )}

          <div className="card flex-1 min-w-0 overflow-visible">
            <div className="flex bg-soft dark:bg-[#16151F] border-b border-line">
              <span className="th flex-1 min-w-[180px]">用户（姓名 / 拼音 / 岗位）</span>
              <span className="th w-[104px]">部门</span>
              <span className="th w-[120px] hidden xl:block">库维护</span>
              <span className="th w-[118px] hidden lg:block">最近登录</span>
              <span className="th w-[70px]">状态</span>
              <span className="th w-[44px]" />
            </div>
            {filtered.map((u) => {
              const disabled = disabledUsers.some((d) => d.username === u.username);
              return (
                <div key={u.username} className="relative flex items-center border-b border-line last:border-0 hover:bg-soft/60 dark:hover:bg-white/[0.03]">
                  <div className="td flex-1 min-w-[180px]">
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-full bg-accentSoft text-accentText flex items-center justify-center text-xs font-medium shrink-0">{u.name[0]}</span>
                      <span className="min-w-0">
                        <span className="text-t1 font-medium text-[13px]">{u.name}</span>
                        <span className="font-mono text-[11px] text-t3 ml-1.5">{u.username}</span>
                        {u.role === 'admin' && <span className="pill bg-accentSoft text-accentText !text-[10px] ml-1.5">管理员</span>}
                        {u.title ? <span className="block text-[11px] text-t3">{u.title}</span> : null}
                      </span>
                    </div>
                  </div>
                  <span className="td w-[104px]"><span className={`pill !text-[11px] ${selDept === u.dept ? 'bg-accentSoft text-accentText' : 'bg-[#E8F0FE] text-[#1A73E8]'}`}>{u.dept}</span></span>
                  <span className="td w-[120px] hidden xl:block">
                    {(u.maintains || []).length ? (
                      <span className="flex flex-wrap gap-1">{u.maintains!.map((m) => <span key={m} className="pill bg-[#E6F7F1] text-[#059669] !text-[10px]">{m}</span>)}</span>
                    ) : <span className="text-t3 text-xs">—</span>}
                  </span>
                  <span className="td w-[118px] hidden lg:block">
                    {u.lastLoginIp ? (
                      <>
                        <span className="font-mono text-[11px]">{u.lastLoginIp}</span>
                        <span className="block text-[10px] text-t3">{fmtLogin(u.lastLoginAt)}</span>
                      </>
                    ) : <span className="text-t3">—</span>}
                  </span>
                  <span className="td w-[70px]">{disabled ? <span className="pill bg-soft text-t3">已禁用</span> : <span className="pill bg-okSoft text-ok">正常</span>}</span>
                  <span className="td w-[44px]">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <button className="w-6 h-6 rounded-md text-t3 hover:text-t1 hover:bg-line/60 font-bold">⋯</button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[104px]">
                        <DropdownMenuItem onClick={() => { setEditUser(u); setEditForm({ name: u.name, dept: u.dept, title: u.title || '', role: u.role }); setFormError(''); }}>编辑</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => resetPassword(u.username)}>重置密码</DropdownMenuItem>
                        {u.username !== 'admin' && (
                          <>
                            <DropdownMenuItem className={disabled ? 'text-ok' : 'text-warn'} onClick={() => toggleDisable(u.username)}>{disabled ? '启用' : '禁用'}</DropdownMenuItem>
                            <DropdownMenuItem className="text-[#DC2626]" onClick={() => { if (confirm(`确认删除 ${u.name}（${u.username}）？将同步移出各知识库名单并吊销其 AI 通道令牌。`)) removeUser(u.username); }}>删除</DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </div>
              );
            })}
            {filtered.length === 0 && <div className="p-12 text-center text-sm text-t3">没有匹配的人员</div>}
          </div>
        </div>
      </div>

      {/* 新增人员 */}
      <ZbModal open={showAdd} onClose={() => setShowAdd(false)} label="新增人员" maxWidth="max-w-[420px]">
        <h2 className="text-[15px] font-semibold mb-4">新增人员</h2>
        <form onSubmit={submitAdd} className="flex flex-col gap-3.5">
          {[
            { label: '用户名（姓名全拼）', key: 'username', ph: '如 zhangsan' },
            { label: '姓名', key: 'name', ph: '如 张三' },
            { label: '岗位（可选）', key: 'title', ph: '如 商务助理' },
          ].map((fl) => (
            <div key={fl.key}>
              <label className="text-xs text-t2 mb-1.5 block">{fl.label}</label>
              <input value={(form as Record<string, string>)[fl.key]} onChange={(e) => setForm({ ...form, [fl.key]: e.target.value })} placeholder={fl.ph}
                className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1 placeholder:text-t3" />
            </div>
          ))}
          <div>
            <label className="text-xs text-t2 mb-1.5 block">部门（决定其部门知识库可见性）</label>
            <select value={form.dept} onChange={(e) => setForm({ ...form, dept: e.target.value })} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1">
              <option value="">请选择…</option>
              {depts.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
            </select>
          </div>
          {formError && <div className="anim-fade rounded-lg bg-warnSoft text-warn text-xs px-3 py-2">{formError}</div>}
          <div className="flex gap-2.5 justify-end mt-1">
            <button type="button" className="btn-ghost" onClick={() => setShowAdd(false)}>取消</button>
            <button type="submit" className="btn-primary">创建</button>
          </div>
          <div className="text-[11px] text-t3 leading-relaxed">创建后初始密码为 123456，请通知本人首次登录后修改密码。</div>
        </form>
      </ZbModal>

      {/* 编辑人员（调岗实时影响预览） */}
      <ZbModal open={!!editUser} onClose={() => setEditUser(null)} label="编辑人员" maxWidth="max-w-[430px]">
        {editUser && (
          <>
            <h2 className="text-[15px] font-semibold mb-1">编辑人员</h2>
            <div className="text-[12px] text-t3 mb-4">{editUser.name}（{editUser.username}）{editUser.lastLoginIp ? ` · 最近登录 ${editUser.lastLoginIp} ${fmtLogin(editUser.lastLoginAt)}` : ''}</div>
            <form onSubmit={submitEdit} className="flex flex-col gap-3.5">
              <div>
                <label className="text-xs text-t2 mb-1.5 block">姓名</label>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1" />
              </div>
              <div>
                <label className="text-xs text-t2 mb-1.5 block">岗位</label>
                <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1" />
              </div>
              <div>
                <label className="text-xs text-t2 mb-1.5 block">部门</label>
                <select value={editForm.dept} onChange={(e) => setEditForm({ ...editForm, dept: e.target.value })} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1">
                  {depts.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                </select>
              </div>
              {editUser.username !== 'admin' && (
                <div>
                  <label className="text-xs text-t2 mb-1.5 block">角色</label>
                  <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1">
                    <option value="user">普通员工</option>
                    <option value="admin">管理员</option>
                  </select>
                </div>
              )}
              {editForm.dept !== editUser.dept && (
                <div className="rounded-[10px] bg-soft dark:bg-card border border-line px-3 py-2.5 text-[12px] text-t2 leading-relaxed">
                  <b>调岗影响</b>（保存后实时生效）：
                  <br />
                  <span className="text-warn">－ 失去：{editUser.dept}知识库（本部门可见）</span>
                  <br />
                  <span className="text-ok">＋ 获得：{editForm.dept}知识库（本部门可见）</span>
                  <br />
                  不变：公司公开库；已有的库维护身份保留（跨部门维护合法，如需收回请在库权限操作）
                </div>
              )}
              {formError && <div className="anim-fade rounded-lg bg-warnSoft text-warn text-xs px-3 py-2">{formError}</div>}
              <div className="flex gap-2.5 justify-end mt-1">
                <button type="button" className="btn-ghost" onClick={() => setEditUser(null)}>取消</button>
                <button type="submit" className="btn-primary">保存</button>
              </div>
            </form>
          </>
        )}
      </ZbModal>

      {/* 新增部门（可同步建库） */}
      <ZbModal open={showAddDept} onClose={() => setShowAddDept(false)} label="新增部门" maxWidth="max-w-[400px]">
        <h2 className="text-[15px] font-semibold mb-1">新增部门</h2>
        <div className="text-[12px] text-t3 mb-4">部门进入字典，新增/编辑人员时可选</div>
        <form onSubmit={submitAddDept} className="flex flex-col gap-3.5">
          <div>
            <label className="text-xs text-t2 mb-1.5 block">部门名称（无需带"知识库"后缀）</label>
            <input value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} placeholder="如 投资部" className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1 placeholder:text-t3" />
          </div>
          <label className="flex items-center gap-2 text-xs text-t2 cursor-pointer">
            <input type="checkbox" checked={deptForm.createLib} onChange={(e) => setDeptForm({ ...deptForm, createLib: e.target.checked })} />
            同步创建「部门名+知识库」（部门成员可见可下载）
          </label>
          {formError && <div className="anim-fade rounded-lg bg-warnSoft text-warn text-xs px-3 py-2">{formError}</div>}
          <div className="flex gap-2.5 justify-end mt-1">
            <button type="button" className="btn-ghost" onClick={() => setShowAddDept(false)}>取消</button>
            <button type="submit" className="btn-primary">创建</button>
          </div>
        </form>
      </ZbModal>

      {/* 设置负责人 */}
      <ZbModal open={!!headDept} onClose={() => setHeadDept(null)} label="设置负责人" maxWidth="max-w-[400px]">
        {headDept && (
          <>
            <h2 className="text-[15px] font-semibold mb-1">{headDept.name} · 设置负责人</h2>
            <div className="text-[12px] text-t3 mb-4">负责人须为本部门在职成员</div>
            <form onSubmit={submitHead} className="flex flex-col gap-3.5">
              <div>
                <label className="text-xs text-t2 mb-1.5 block">负责人</label>
                <select value={headForm.head} onChange={(e) => setHeadForm({ ...headForm, head: e.target.value })} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1">
                  <option value="">请选择…</option>
                  {users.filter((u) => u.dept === headDept.name).map((u) => <option key={u.username} value={u.username}>{u.name}（{u.username}）</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-t2 cursor-pointer">
                <input type="checkbox" checked={headForm.syncKb} onChange={(e) => setHeadForm({ ...headForm, syncKb: e.target.checked })} />
                同步设为「{headDept.name}知识库」负责人（加入维护员并授予可写）
              </label>
              <div className="flex gap-2.5 justify-end mt-1">
                <button type="button" className="btn-ghost" onClick={() => setHeadDept(null)}>取消</button>
                <button type="submit" className="btn-primary">保存</button>
              </div>
            </form>
          </>
        )}
      </ZbModal>

      {/* 部门重命名 */}
      <ZbModal open={!!renameDept} onClose={() => setRenameDept(null)} label="重命名部门" maxWidth="max-w-[400px]">
        {renameDept && (
          <>
            <h2 className="text-[15px] font-semibold mb-1">重命名部门</h2>
            <div className="text-[12px] text-t3 mb-4">{renameDept.name} → ？（人员归属同步更新；知识库名保持原名，权限关联自动跟随）</div>
            <form onSubmit={submitRename} className="flex flex-col gap-3.5">
              <div>
                <label className="text-xs text-t2 mb-1.5 block">新名称</label>
                <input value={renameForm} onChange={(e) => setRenameForm(e.target.value)} className="w-full h-10 rounded-xl bg-soft dark:bg-card border border-line px-3 text-sm outline-none focus:border-accent text-t1" />
              </div>
              {formError && <div className="anim-fade rounded-lg bg-warnSoft text-warn text-xs px-3 py-2">{formError}</div>}
              <div className="flex gap-2.5 justify-end mt-1">
                <button type="button" className="btn-ghost" onClick={() => setRenameDept(null)}>取消</button>
                <button type="submit" className="btn-primary">重命名</button>
              </div>
            </form>
          </>
        )}
      </ZbModal>
    </div>
  );
}
