/* P1 稳定性端到端验证：启动恢复 / tmp GC / deploy_failed 重试 / 探活记录 / 优雅拒绝
 * 用法：
 *   先准备种子数据并启动：node scripts/test-p1-stability.cjs seed ./data-p1
 *   DATA_DIR=... PORT=8812 node server.cjs &
 *   node scripts/test-p1-stability.cjs run http://127.0.0.1:8812 ./data-p1
 */
const fs = require('fs');
const path = require('path');
const { makeZip, PNG_1x1, HTML } = require('./lib-zip.cjs');

const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };

function seedData(dir) {
  const now = Date.now();
  const day = 86400000;
  fs.rmSync(dir, { recursive: true, force: true });
  const mk = (id, extra) => ({
    id, u: 'lidan', n: 'Alice Demo', d: 'Platform', kind: 'web', shots: [], doc: '',
    report: { verdict: 'ok', lines: ['✓ ok'], entry: 'test-tool/src/index.html', warns: 0 },
    createdAt: now - day, submittedAt: now - day, ...extra,
  });
  const uploads = [
    mk('ugcold1', { status: 'draft', filename: '旧草稿.zip', createdAt: now - 8 * day }),
    mk('uintr1', { status: 'deploying', name: '中断部署测试', filename: '中断.zip' }),
    mk('ustale1', { status: 'pending', name: '超期未审测试', filename: '超期.zip', submittedAt: now - 31 * day, shots: ['shot-1.png'] }),
  ];
  fs.mkdirSync(path.join(dir), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads.json'), JSON.stringify(uploads));
  fs.writeFileSync(path.join(dir, 'extraTools.json'), '[]');
  const pkg = (root) => {
    fs.mkdirSync(path.join(root, 'test-tool', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test-tool', 'src', 'index.html'), HTML('pkg'));
    fs.writeFileSync(path.join(root, 'test-tool', 'src', 'app.js'), 'console.log(1)');
  };
  const shot = (root) => {
    fs.mkdirSync(path.join(root, '_shots'), { recursive: true });
    fs.writeFileSync(path.join(root, '_shots', 'shot-1.png'), PNG_1x1);
  };
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ugcold1')); fs.writeFileSync(path.join(tmp, 'ugcold1', 'index.html'), 'old draft');
  pkg(path.join(tmp, 'uintr1')); shot(path.join(tmp, 'uintr1'));
  pkg(path.join(tmp, 'ustale1')); shot(path.join(tmp, 'ustale1'));
  fs.mkdirSync(path.join(tmp, 'orphan1')); fs.writeFileSync(path.join(tmp, 'orphan1', 'x.txt'), 'orphan');
  const old = new Date(now - 8 * day);
  fs.utimesSync(path.join(tmp, 'orphan1'), old, old);
  console.log('seeded:', dir);
}

async function run(BASE, DATA_DIR) {
  const j = (r) => r.json();
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录');
  const auth = { Authorization: 'Bearer ' + login.token };
  const listRows = async () => {
    const r = await fetch(BASE + '/api/admin/uploads', { headers: auth }).then(j);
    return r.rows || [];
  };
  const tmp = path.join(DATA_DIR, 'tmp');
  const exists = (p) => fs.existsSync(path.join(tmp, p));

  /* ===== A. 启动恢复 + GC ===== */
  let rows = await listRows();
  const by = (id) => rows.find((x) => x.id === id);
  assert(!by('ugcold1'), 'GC：8 天前的 draft 记录已回收');
  assert(!exists('ugcold1'), 'GC：draft 的 tmp 目录已删除');
  assert(!exists('orphan1'), 'GC：无主 tmp 目录（超 7 天）已删除');
  assert(by('uintr1')?.status === 'deploy_failed' && /中断/.test(by('uintr1').deployError || ''), '启动恢复：deploying → deploy_failed（可重试）');
  assert(by('ustale1')?.status === 'pending', 'GC 不动 pending：超期记录保留（等飞书提醒）');
  assert(exists('uintr1') && exists('ustale1'), '活跃状态的 tmp 目录未误删');

  /* ===== B. deploy_failed 重试 → 部署成功 + 探活 ===== */
  const appr = await fetch(`${BASE}/api/admin/uploads/uintr1/approve`, { method: 'POST', headers: auth }).then(j);
  assert(appr.ok, `deploy_failed 重试部署成功（${appr.message || ''}）`);
  rows = await listRows();
  assert(by('uintr1')?.status === 'online', '重试后状态 online');
  assert(by('uintr1')?.healthCheck?.status === 200, `部署后探活记录（healthCheck=${JSON.stringify(by('uintr1')?.healthCheck)}）`);
  assert(!exists('uintr1'), '成功后 tmp 清理');

  /* ===== C. tmp 缺失 → 优雅拒绝（不产生 deploy_failed） ===== */
  const fd = new FormData();
  fd.append('kind', 'web');
  fd.append('file', new Blob([makeZip([['test-tool/src/index.html', HTML('c')], ['test-tool/src/app.js', Buffer.from('1')]])]), 'c.zip');
  const up = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
  assert(up.ok, '上传解析（场景C）');
  await fetch(BASE + '/api/uploads/submit', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: up.id, name: '临时文件消失场景', desc: 'tmp被外部删除' }),
  }).then(j);
  fs.rmSync(path.join(tmp, up.id), { recursive: true, force: true });
  const c = await fetch(`${BASE}/api/admin/uploads/${up.id}/approve`, { method: 'POST', headers: auth }).then(j);
  assert(c.ok === false && /过期/.test(c.message || ''), `tmp 缺失优雅拒绝（${c.message}）`);
  rows = await listRows();
  assert(by(up.id)?.status === 'pending', '优雅拒绝不产生 deploy_failed');

  /* ===== D. 入口 404 → 上线但探活未通过 + 告警 ===== */
  const fd2 = new FormData();
  fd2.append('kind', 'web');
  fd2.append('file', new Blob([makeZip([['test-tool/src/index.html', HTML('d')]])]), 'd.zip');
  const up2 = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd2 }).then(j);
  await fetch(BASE + '/api/uploads/submit', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: up2.id, name: '入口缺失场景', desc: 'entry 404' }),
  }).then(j);
  fs.rmSync(path.join(tmp, up2.id, 'test-tool', 'src', 'index.html'), { force: true });
  const d = await fetch(`${BASE}/api/admin/uploads/${up2.id}/approve`, { method: 'POST', headers: auth }).then(j);
  assert(d.ok === true && /探活未通过/.test(d.message || ''), `探活失败不回滚、消息提示（${d.message}）`);
  rows = await listRows();
  assert(by(up2.id)?.status === 'online' && by(up2.id)?.healthCheck?.status === 404, `healthCheck 记录 404（${JSON.stringify(by(up2.id)?.healthCheck)}）`);

  console.log(process.exitCode ? 'P1 STABILITY: FAILED' : 'P1 STABILITY: ALL PASS');
}

const mode = process.argv[2];
const a = process.argv[3];
const b = process.argv[4];
if (mode === 'seed') seedData(path.resolve(a));
else if (mode === 'run') run(a, path.resolve(b)).catch((e) => { console.error(e); process.exit(1); });
else { console.log('用法: node test-p1-stability.cjs seed <dataDir> | run <baseUrl> <dataDir>'); process.exit(2); }
