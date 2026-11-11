/* 方案A 接入观测回归：stubs 心跳记录 + /api/admin/skill-sync 接入清单 + 鉴权
 * 用法（门户指向 mock 网关，隔离生产）：
 *   DATA_DIR=./data-cov PORT=8816 SKILL_GATEWAY_BASE=http://127.0.0.1:8899 node server.cjs &
 *   node scripts/test-sync-coverage.cjs http://127.0.0.1:8816
 */
const http = require('http');

const BASE = process.argv[2] || 'http://127.0.0.1:8816';
const GW_PORT = 8899;
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };

const gw = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify([{ slug: 'demo', name: 'demo', display_name: '演示技能', status: 'enabled', current_version: 'v1.0.0' }]));
});

(async () => {
  await new Promise((r) => gw.listen(GW_PORT, r));

  /* 未登录访问 stubs（真实场景：ps1 无鉴权拉取）×2 → 两条心跳 */
  let r = await fetch(BASE + '/api/skill-stubs/all').then(j);
  assert(r.mcp && Array.isArray(r.stubs) && r.stubs.length === 1, `壳技能数据正常（stubs=${r.stubs?.length}）`);
  await fetch(BASE + '/api/skill-stubs/all').then(j);

  /* 接入清单需要管理员鉴权 */
  const st = (await fetch(BASE + '/api/admin/skill-sync')).status;
  assert(st === 401 || st === 403, `未登录拒绝（HTTP ${st}）`);

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录');

  r = await fetch(BASE + '/api/admin/skill-sync', { headers: { Authorization: 'Bearer ' + login.token } }).then(j);
  const row = r.rows?.find((x) => x.ip === '127.0.0.1');
  assert(r.ok && !!row, `心跳已记录（rows=${r.rows?.length}）`);
  assert(row && row.count >= 2, `心跳计数正确（count=${row?.count}）`);
  assert(row && row.name === (login.session?.name || ''), `IP→姓名映射（name=${row?.name}）`);
  assert(row && row.stale === false, `24h 内不标红（stale=${row?.stale}）`);
  assert(r.staffTotal >= 1 && r.staffCovered >= 1, `员工覆盖统计（${r.staffCovered}/${r.staffTotal}）`);

  gw.close();
  /* Windows 下 close 与 keep-alive 连接竞态会触发 libuv 断言：稍等再退出 */
  setTimeout(() => process.exit(process.exitCode || 0), 500);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
