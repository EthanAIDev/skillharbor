const DENIED = Object.freeze({ tier: 'unconfigured', dept: '', visible: false, readShared: false,
  canWrite: false, canDownload: false, canManage: false, legacyWrite: false });

/* 部门库的「共享可见部门」名单归一化（2026-11-03）：
   只接受当前部门字典内的名称，且不允许把库归属部门写进去（本部门本来可见）。
   该名单只授予只读浏览/下载，写与管理权仍只属于本部门维护员与管理员。 */
function normalizeReadDepts(value, ownDept, allowedDepts) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set((allowedDepts || []).map(String));
  const own = String(ownDept || '');
  const out = [];
  for (const raw of value) {
    const name = String(raw ?? '').trim();
    if (!name || name === own) continue;
    if (allowed.size && !allowed.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/* Shared upstream credentials cannot provide a second, per-user permission check. */
function repoPermission(user, repoId, policies) {
  const cfg = policies?.repos?.[String(repoId)];
  if (!cfg || !['public', 'private', 'dept'].includes(cfg.tier)) return { ...DENIED };
  const me = user.username;
  const admin = user.role === 'admin';
  const maintains = (c) => Array.isArray(c?.maintainers) && c.maintainers.includes(me);
  if (cfg.tier === 'public') {
    const otherDept = Object.values(policies.repos).some((c) => c?.tier === 'dept'
      && c.maintSet && (c.owner === me || maintains(c)));
    return { tier: 'public', dept: cfg.dept || '', visible: true, readShared: false, canWrite: admin || maintains(cfg) || otherDept,
      canDownload: true, canManage: admin || maintains(cfg), legacyWrite: false };
  }
  if (cfg.tier === 'private') {
    const own = cfg.owner === me;
    const visible = own || (Array.isArray(cfg.whitelist) && cfg.whitelist.includes(me));
    return { tier: 'private', dept: '', visible, readShared: false, canWrite: visible && own,
      canDownload: visible && (own || cfg.allowDownload !== false), canManage: own, owner: cfg.owner, legacyWrite: false };
  }
  const dept = user.deptShort || user.dept || '';
  const manager = cfg.owner === me || maintains(cfg);
  /* 跨部门共享（readDepts）只读：用户实时部门命中名单即可见；调岗离开即自动失去，无需改规则。
     管理员/维护员不标记 readShared（他们本就以管理身份访问）。 */
  const ownDept = cfg.dept || '';
  const readShared = !admin && !manager && !!ownDept && !!dept && dept !== ownDept
    && Array.isArray(cfg.readDepts) && cfg.readDepts.includes(dept);
  const visible = admin || (!!ownDept && dept === ownDept) || manager || readShared;
  return { tier: 'dept', dept: ownDept, visible, readShared, canWrite: visible && (admin || manager),
    canDownload: visible, canManage: visible && (admin || manager), legacyWrite: false };
}
module.exports = { repoPermission, normalizeReadDepts };
