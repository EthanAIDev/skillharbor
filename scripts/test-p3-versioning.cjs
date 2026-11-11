/* P3 版本化部署端到端验证：releases/sites 结构、URL 全生命周期稳定、一键回滚、保留策略、文件类、存量兼容
 * 用法：
 *   DATA_DIR=./data-p3 PORT=8815 node server.cjs &
 *   node scripts/test-p3-versioning.cjs http://127.0.0.1:8815 ./data-p3
 */
const fs = require('fs');
const path = require('path');
const { makeZip } = require('./lib-zip.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8815';
const DATA_DIR = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data-p3'));
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };
const html = (m) => `<!doctype html><meta charset="utf-8"><h1>${m}</h1>`;

(async () => {
  /* 存量兼容前提：手工摆一个旧版 t9 目录（模拟 t2/t3 旧工具），全程不得被动 */
  const upDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(path.join(upDir, 't9'), { recursive: true });
  fs.writeFileSync(path.join(upDir, 't9', 'index.html'), html('legacy'));

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录');
  const auth = { Authorization: 'Bearer ' + login.token };

  const deploy = async (marker, updateOf, note) => {
    const fd = new FormData();
    fd.append('kind', 'web');
    fd.append('file', new Blob([makeZip([['app/index.html', Buffer.from(html(marker))]])]), `v-${marker}.zip`);
    const up = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
    if (!up.ok) throw new Error('parse failed: ' + JSON.stringify(up.report?.rules || up.message));
    const sub = await fetch(BASE + '/api/uploads/submit', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: up.id, name: '版本化测试工具', desc: 'P3', updateOf, updateNote: note || '版本迭代' }),
    }).then(j);
    if (!sub.ok) throw new Error('submit failed: ' + sub.message);
    const appr = await fetch(`${BASE}/api/admin/uploads/${up.id}/approve`, { method: 'POST', headers: auth }).then(j);
    if (!appr.ok) throw new Error('approve failed: ' + appr.message);
    return { id: up.id, url: appr.url, message: appr.message };
  };
  const bodyOf = async (u) => (await fetch(BASE + u)).text();
  const releasesOf = (id) => fs.readdirSync(path.join(upDir, 'releases', 'u' + id)).filter((d) => /^v\d+$/.test(d)).sort((a, b) => +a.slice(1) - +b.slice(1));

  /* 1. 首次部署 v1：sites URL 生效 */
  const d1 = await deploy('VERSION-A');
  const rel1 = /\/files\/uploads\/sites\/(u[a-z0-9]+)\//.exec(d1.url);
  assert(!!rel1, `URL 指向 sites/ 新体系（${d1.url}）`);
  const siteId = rel1[1];
  assert((await bodyOf(d1.url)).includes('VERSION-A'), 'v1 内容经 sites URL 可访问');
  assert(fs.existsSync(path.join(upDir, 'sites', siteId)), 'sites 符号链接已建立');
  assert(deepEquals(releasesOf(d1.id), ['v1']), `releases 仅 v1（${releasesOf(d1.id)}）`);

  /* 2. 更新部署 v2：URL 完全不变，内容切换 */
  const d2 = await deploy('VERSION-B', `tool:up1`);
  assert(d2.url === d1.url, `更新后 URL 不变（${d2.url}）`);
  assert((await bodyOf(d1.url)).includes('VERSION-B'), 'URL 已切换到 v2 内容');
  assert(deepEquals(releasesOf(d1.id), ['v1', 'v2']), 'releases 保留 v1+v2');

  /* 3. 一键回滚：内容回到 v1，URL 仍不变，历史记录 rollback */
  const rb = await fetch(`${BASE}/api/admin/uploads/${d1.id}/rollback`, { method: 'POST', headers: auth }).then(j);
  assert(rb.ok && /v1/.test(rb.message || ''), `回滚成功（${rb.message}）`);
  assert((await bodyOf(d1.url)).includes('VERSION-A'), '回滚后 URL 内容回到 v1');
  const hist = await fetch(`${BASE}/api/admin/deployments?tool=${siteId}`, { headers: auth }).then(j);
  assert((hist.rows || []).length >= 3 && hist.rows[0].type === 'rollback', `部署历史含 rollback（共 ${hist.rows?.length} 条，最新 ${hist.rows?.[0]?.version}/${hist.rows?.[0]?.type}）`);

  /* 4. 连续更新 v3/v4：保留策略生效（当前+2 历史，v1 被清理），回滚到 v2 */
  await deploy('VERSION-C', 'tool:up1');
  await deploy('VERSION-D', 'tool:up1');
  assert(deepEquals(releasesOf(d1.id), ['v2', 'v3', 'v4']), `保留最近 3 个版本（${releasesOf(d1.id)}）`);
  assert((await bodyOf(d1.url)).includes('VERSION-D'), '当前为 v4 内容');
  const rb2 = await fetch(`${BASE}/api/admin/uploads/${d1.id}/rollback`, { method: 'POST', headers: auth }).then(j);
  assert(rb2.ok && /v3/.test(rb2.message || ''), `再次回滚到 v3（${rb2.message}）`);
  assert((await bodyOf(d1.url)).includes('VERSION-C'), '回滚后为 v3 内容');

  /* 5. 早期版本回滚边界：v2 可再回一次，v1 已清理则优雅拒绝 */
  const rb3 = await fetch(`${BASE}/api/admin/uploads/${d1.id}/rollback`, { method: 'POST', headers: auth }).then(j);
  assert(rb3.ok && /v2/.test(rb3.message || ''), `连续回滚到 v2（${rb3.message}）`);
  const rb4 = await fetch(`${BASE}/api/admin/uploads/${d1.id}/rollback`, { method: 'POST', headers: auth }).then(j);
  assert(rb4.ok === false, `v1 已清理后回滚被优雅拒绝（${rb4.message}）`);

  /* 6. 文件类工具：同样走 releases/sites，URL 独立 */
  const ffd = new FormData();
  ffd.append('kind', 'file');
  ffd.append('file', new Blob([Buffer.from('file tool content')]), '报表工具.xlsx');
  const fup = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: ffd }).then(j);
  await fetch(BASE + '/api/uploads/submit', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: fup.id, name: '文件类版本测试', desc: 'P3' }),
  }).then(j);
  const fAppr = await fetch(`${BASE}/api/admin/uploads/${fup.id}/approve`, { method: 'POST', headers: auth }).then(j);
  assert(fAppr.ok && /\/sites\//.test(fAppr.url || ''), `文件类也走 sites 体系（${fAppr.url}）`);
  const fStatus = await fetch(BASE + fAppr.url).then((r) => r.status);
  assert(fStatus === 200, `文件类 URL 可下载（HTTP ${fStatus}）`);

  /* 7. 存量兼容：t9 旧目录 URL 全程 200 */
  const legacy = await fetch(BASE + '/files/uploads/t9/index.html').then((r) => r.status);
  assert(legacy === 200, '存量 t 目录 URL 不受影响（HTTP 200）');

  console.log(process.exitCode ? 'P3 VERSIONING: FAILED' : 'P3 VERSIONING: ALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });

function deepEquals(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
