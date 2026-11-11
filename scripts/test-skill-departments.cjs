/* 技能「适用部门」接口端到端验证：管理员读写 / 权限拦截 / 校验丢弃 / 空数组清除 / dept-usage 回带 applicable
 * 用法：DATA_DIR=<临时目录> PORT=8814 node server.cjs & node scripts/test-skill-departments.cjs http://127.0.0.1:8814
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8814';
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };

(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录');
  const auth = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  // 1. 未登录 / 非管理员拦截
  let r = await fetch(BASE + '/api/admin/skill-departments', { method: 'GET' }).then(j);
  assert(!r.ok, '未登录读取被拦截（401）');
  r = await fetch(BASE + '/api/admin/skill-departments', { method: 'POST', body: JSON.stringify({ slug: 'x', departments: ['全部'] }) }).then(j);
  assert(!r.ok, '未登录写入被拦截（401）');

  // 2. 初始为空
  r = await fetch(BASE + '/api/admin/skill-departments', { headers: auth }).then(j);
  assert(r.ok && Object.keys(r.map || {}).length === 0, '初始配置为空');

  // 3. 保存合法配置（含「全部」）
  r = await fetch(BASE + '/api/admin/skill-departments', {
    method: 'POST', headers: auth, body: JSON.stringify({ slug: 'demo-skill', departments: ['全部'] }),
  }).then(j);
  assert(r.ok && JSON.stringify(r.departments) === '["全部"]', '保存「全部」配置');

  // 4. 保存具体部门 + 非法值丢弃 + 去重（「市场部」为名册实际短名）
  r = await fetch(BASE + '/api/admin/skill-departments', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ slug: 'demo-skill', departments: ['市场部', '不存在的部门', '市场部', ''] }),
  }).then(j);
  assert(r.ok && JSON.stringify(r.departments) === '["市场部"]', '非法部门丢弃、去重（保留名册内短名）');

  // 5. 空 / 缺 departments 清除配置
  r = await fetch(BASE + '/api/admin/skill-departments', {
    method: 'POST', headers: auth, body: JSON.stringify({ slug: 'demo-skill', departments: [] }),
  }).then(j);
  assert(r.ok && r.departments.length === 0, '空数组清除配置');

  // 6. 缺 slug 拒绝
  r = await fetch(BASE + '/api/admin/skill-departments', {
    method: 'POST', headers: auth, body: JSON.stringify({ departments: ['全部'] }),
  }).then(j);
  assert(!r.ok, '缺 slug 拒绝（400）');

  // 7. dept-usage 回带 applicable（技能中心不可达也应回带空 applicable 而非报错）
  r = await fetch(BASE + '/api/skills/dept-usage').then(j);
  assert(r.ok && typeof r.applicable === 'object', 'dept-usage 回带 applicable 字段');

  // 8. 配置落盘后重新保存可读回
  await fetch(BASE + '/api/admin/skill-departments', {
    method: 'POST', headers: auth, body: JSON.stringify({ slug: 'persist-skill', departments: ['市场部', 'Platform'] }),
  });
  r = await fetch(BASE + '/api/admin/skill-departments', { headers: auth }).then(j);
  assert(r.ok && JSON.stringify(r.map['persist-skill']) === '["市场部","Platform"]', '保存后全量读回一致');

  console.log('DONE');
})().catch((e) => { console.error('FAIL | 测试执行异常：' + e.message); process.exitCode = 1; });
