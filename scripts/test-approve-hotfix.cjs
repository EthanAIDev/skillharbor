/* 热修端到端验证：网页工具（带截图）上传 → 提交 → 审批通过 → 落位断言
 * 用法：先以隔离数据目录启动服务，再跑本脚本：
 *   DATA_DIR=./data-hotfix PORT=8811 node server.cjs &
 *   node scripts/test-approve-hotfix.cjs http://127.0.0.1:8811 ./data-hotfix
 */
const fs = require('fs');
const path = require('path');
const { makeZip, PNG_1x1 } = require('./lib-zip.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8811';
const DATA_DIR = process.argv[3] || path.join(__dirname, '..', 'data-hotfix');
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };

const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>热修测试工具</title><h1>hotfix e2e</h1><script src="./app.js"></script>', 'utf8');
const zipBuf = makeZip([
  ['test-tool/src/index.html', html],
  ['test-tool/src/app.js', Buffer.from('console.log("ok")', 'utf8')],
]);

(async () => {
  /* 1. 管理员登录 */
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录（默认密码 admin123）');
  const auth = { Authorization: 'Bearer ' + login.token };

  /* 2. 上传网页包 → 解析 */
  const fd = new FormData();
  fd.append('kind', 'web');
  fd.append('file', new Blob([zipBuf]), 'test-tool.zip');
  const up = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
  assert(up.ok && up.report?.verdict === 'ok', `网页包解析成功（entry=${up.report?.entry}）`);
  const id = up.id;

  /* 3. 传 1 张截图 */
  const shotFd = new FormData();
  shotFd.append('type', 'shot');
  shotFd.append('file', new Blob([PNG_1x1]), '封面.png');
  const mat = await fetch(`${BASE}/api/uploads/${id}/material`, { method: 'POST', headers: auth, body: shotFd }).then(j);
  assert(mat.ok && mat.shots?.length === 1, `截图上传（shots=${mat.shots}）`);

  /* 4. 提交审核 */
  const sub = await fetch(BASE + '/api/uploads/submit', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: '热修测试工具', desc: '端到端验证审批落位', tags: ['测试'] }),
  }).then(j);
  assert(sub.ok, `提交审核（${sub.message || ''}）`);

  /* 5. 审批通过（修复点：不应 500，应返回 ok） */
  const appr = await fetch(`${BASE}/api/admin/uploads/${id}/approve`, { method: 'POST', headers: auth }).then(j);
  assert(appr.ok, `审批通过（${appr.message || ''}）`);

  /* 6. 落位断言（P3 起发布产物落 releases/<u<uploadId>>/v1/，经 sites/ 符号链接对外） */
  assert(/\/files\/uploads\/sites\/u[a-z0-9]+\//.test(appr.url || ''), `部署 URL 指向 sites 体系（${appr.url}）`);
  const vDir = path.join(DATA_DIR, 'uploads', 'releases', 'u' + id, 'v1');
  const entries = fs.existsSync(vDir) ? fs.readdirSync(vDir) : [];
  assert(!entries.includes('_shots') && !entries.includes('_docs'), `发布目录只含网页包本体（${entries}）`);
  assert(entries.some((x) => x === 'test-tool'), '网页包已复制进版本目录');
  assert(fs.existsSync(path.join(DATA_DIR, 'uploads', 'sites', 'u' + id)), 'sites 符号链接已建立');
  const extra = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'extraTools.json'), 'utf8'));
  const entry = extra.find((t) => t.uploadId === id);
  assert(entry && entry.status === 'online', '工具卡片已上线（extraTools.json）');
  assert(fs.existsSync(path.join(DATA_DIR, 'uploads', 'materials', entry.id, 'shot-1.png')), `截图已落位 materials/${entry.id}/shot-1.png`);
  assert(!fs.existsSync(path.join(DATA_DIR, 'tmp', id)), '临时目录在全部落位后才清理');
  assert(Array.isArray(entry.shots) && entry.shots.length === 1 && /shot-1\.png$/.test(entry.shots[0]), `卡片截图 URL 指向 materials（${entry?.shots?.[0]}）`);

  /* 7. 重复审批应幂等失败（不 500） */
  const again = await fetch(`${BASE}/api/admin/uploads/${id}/approve`, { method: 'POST', headers: auth }).then(j);
  assert(again.ok === false && /已上线|过期/.test(again.message || ''), `重复审批被优雅拒绝（${again.message}）`);

  console.log(process.exitCode ? 'HOTFIX E2E: FAILED' : 'HOTFIX E2E: ALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
