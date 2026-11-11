/**
 * 部门库「共享可见部门（只读）」端到端回归（2026-11-03）
 *
 * 起一个临时门户（独立 DATA_DIR、固定策略表）+ 假 MxsDoc / 假语义网关，验证：
 *   1. admin 可设置/撤销部门库的 readDepts；非法部门名与库归属部门被归一化剔除；
 *   2. 被共享部门（咨询所）在库列表/写权限探测/目录读取/搜索（关键词+语义）中可见，且只读、可下载；
 *   3. 未共享部门（研究院）看不到该库；共享部门看不到别部门库；
 *   4. 库维护员（非 admin）不能设置共享部门，但能看到已共享名单；
 *   5. 审计落 kb-audit.jsonl。
 *
 * 用法：node --test scripts/test-kb-dept-share.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORTAL_READY_TIMEOUT_MS = 20000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve)).catch(() => {});
}
async function freePort() {
  const s = http.createServer(() => {});
  const port = await listen(s);
  await closeServer(s);
  return port;
}
function jsonResponse(res, obj) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'JSESSIONID=test-session; Path=/',
  });
  res.end(JSON.stringify(obj));
}
function fakeMxsDoc() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const u = new URL(req.url, 'http://fake');
      if (u.pathname.endsWith('/User/login.do')) return jsonResponse(res, { status: 'ok', data: {} });
      if (u.pathname.endsWith('/Repos/getReposList.do')) {
        return jsonResponse(res, { status: 'ok', data: [
          { id: 14, name: '政技部知识库', path: '/repos' },
          { id: 8, name: '研究院知识库', path: '/repos' },
          { id: 16, name: '公司公开库', path: '/repos' },
        ] });
      }
      if (u.pathname.endsWith('/Doc/searchDoc.do')) {
        return jsonResponse(res, { status: 'ok', data: [
          { vid: 14, reposName: '政技部知识库', name: '债券计划表.xlsx', path: '', size: 10, content: Buffer.from('政技部债券计划').toString('base64') },
          { vid: 8, reposName: '研究院知识库', name: '研究院内部报告.pdf', path: '', size: 10, content: Buffer.from('研究院内部报告').toString('base64') },
        ] });
      }
      return jsonResponse(res, { status: 'ok', data: [] });
    });
  });
}
function fakeSemanticGateway() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => jsonResponse(res, { mode: 'semantic', items: [
      { vid: 14, repos: '政技部', name: '债券计划表-语义命中.pdf', path: '', preview: '债券', score: 0.9 },
      { vid: 8, repos: '研究院', name: '研究院报告-语义命中.pdf', path: '', preview: '报告', score: 0.8 },
    ] }));
  });
}
async function waitPortal(base, child, log) {
  const deadline = Date.now() + PORTAL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('门户进程提前退出：\n' + log());
    try {
      const r = await fetch(base + '/api/auth/me');
      if (r.status === 401) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('门户启动超时：\n' + log());
}
async function login(base, username, password) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, `登录失败 ${username}: ${JSON.stringify(j)}`);
  return j.token;
}
async function call(base, token, apiPath, options = {}) {
  const r = await fetch(base + apiPath, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const repoOf = (body, id) => (body.repos || []).find((r) => String(r.id) === String(id));

test('department read sharing: read-only visibility, scoped search and admin-only configuration', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillharbor-kb-share-'));
  fs.writeFileSync(path.join(dir, 'kb-perms.json'), JSON.stringify({ repos: {
    14: { tier: 'dept', dept: '政技部', owner: '', maintainers: ['liuyang'], maintSet: true, whitelist: [] },
    8: { tier: 'dept', dept: '研究院', owner: '', maintainers: ['lidan'], maintSet: true, whitelist: [] },
    16: { tier: 'public', dept: '总经办', owner: '', maintainers: [], maintSet: true, whitelist: [], name: '公司公开库' },
  } }, null, 2));

  const upstream = fakeMxsDoc();
  const gateway = fakeSemanticGateway();
  const upPort = await listen(upstream);
  const gwPort = await listen(gateway);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.cjs', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      MXSDOC_BASE_URL: `http://127.0.0.1:${upPort}/DocSystem`,
      MXSDOC_SVC_PASSWORD: 'test-svc-read',
      MXSDOC_SVC_W_PASSWORD: 'test-svc-write',
      MXSDOC_ADMIN_PASSWORD: 'test-admin',
      KB_BRIDGE_SECRET: 'test-bridge-secret',
      SKILL_GATEWAY_BASE: `http://127.0.0.1:${gwPort}`,
      SKILL_GATEWAY_TOKEN: 'test-gateway-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await closeServer(upstream);
    await closeServer(gateway);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitPortal(base, child, () => log);
  const admin = await login(base, 'admin', 'admin123');
  const maintainer = await login(base, 'liuyang', '123456');
  const consulting = await login(base, 'huangyating', '123456');
  const research = await login(base, 'lidan', '123456');

  /* 1. 管理端：设置共享部门（非法部门名、库归属部门自动剔除） */
  const set = await call(base, admin, '/api/kb/repo-config', {
    method: 'POST',
    body: JSON.stringify({ reposId: 14, maintainers: ['liuyang'], readDepts: ['咨询所', '政技部', '不存在部门'] }),
  });
  assert.equal(set.body.ok, true, JSON.stringify(set.body));
  assert.deepEqual(set.body.readDepts, ['咨询所']);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'kb-perms.json'), 'utf8'));
  assert.deepEqual(stored.repos['14'].readDepts, ['咨询所']);
  /* 未传 readDepts 的保存（如只改维护员）不清空既有共享名单 */
  const keep = await call(base, admin, '/api/kb/repo-config', {
    method: 'POST', body: JSON.stringify({ reposId: 14, maintainers: ['liuyang'] }),
  });
  assert.equal(keep.body.ok, true, JSON.stringify(keep.body));
  assert.deepEqual(keep.body.readDepts, ['咨询所']);

  /* 2. 被共享部门：可见、只读、可下载；列表徽标与权限探测一致 */
  const consultingRepos = await call(base, consulting, '/api/kb/repos');
  const sharedRepo = repoOf(consultingRepos.body, 14);
  assert.ok(sharedRepo, '咨询所应看到政技部库');
  assert.deepEqual(
    { tier: sharedRepo.tier, readShared: sharedRepo.readShared, canWrite: sharedRepo.canWrite, canManage: sharedRepo.canManage, canDownload: sharedRepo.canDownload },
    { tier: 'dept', readShared: true, canWrite: false, canManage: false, canDownload: true },
  );
  assert.equal(repoOf(consultingRepos.body, 8), undefined, '咨询所不应看到研究院库');
  assert.ok(repoOf(consultingRepos.body, 16), '公开库仍然全员可见');
  const consultingPerm = await call(base, consulting, '/api/kb/perm?reposId=14');
  assert.deepEqual(
    { canWrite: consultingPerm.body.canWrite, readShared: consultingPerm.body.readShared, canDownload: consultingPerm.body.canDownload },
    { canWrite: false, readShared: true, canDownload: true },
  );
  const readOk = await call(base, consulting, '/api/kb/list?reposId=14');
  assert.equal(readOk.body.ok, true, JSON.stringify(readOk.body));
  const readDenied = await call(base, consulting, '/api/kb/list?reposId=8');
  assert.equal(readDenied.body.ok, false);
  assert.match(readDenied.body.message, /无权访问或不存在/);
  const uploadDenied = await call(base, consulting, '/api/kb/upload?reposId=14', { method: 'POST' });
  assert.equal(uploadDenied.status, 403);
  assert.match(uploadDenied.body.message, /跨部门共享库仅可浏览\/下载/);
  const configDenied = await call(base, consulting, '/api/kb/repo-config?reposId=14');
  assert.equal(configDenied.body.ok, false);
  assert.match(configDenied.body.message, /仅库负责人\/维护员\/管理员/);

  /* 3. 搜索（关键词 + 语义）只来自可见库 */
  const consultingSearch = await call(base, consulting, '/api/kb/search?q=' + encodeURIComponent('债券'));
  assert.equal(consultingSearch.body.ok, true, JSON.stringify(consultingSearch.body));
  const consultingVids = new Set(consultingSearch.body.items.map((x) => String(x.reposId)));
  assert.ok(consultingVids.has('14'), '共享库应进入咨询所搜索结果');
  assert.equal(consultingVids.has('8'), false, '研究院库不应进入咨询所搜索结果');
  const researchSearch = await call(base, research, '/api/kb/search?q=' + encodeURIComponent('债券'));
  const researchVids = new Set(researchSearch.body.items.map((x) => String(x.reposId)));
  assert.equal(researchVids.has('14'), false, '未共享部门不应搜到政技部库');

  /* 4. 库维护员：可见且可写、能看到共享名单，但不能改共享部门 */
  assert.equal(repoOf(await call(base, maintainer, '/api/kb/repos').then((r) => r.body), 14).readShared, false);
  const maintainerPerm = await call(base, maintainer, '/api/kb/perm?reposId=14');
  assert.deepEqual({ canWrite: maintainerPerm.body.canWrite, readShared: maintainerPerm.body.readShared }, { canWrite: true, readShared: false });
  const maintainerCfg = await call(base, maintainer, '/api/kb/repo-config?reposId=14');
  assert.deepEqual({ isAdmin: maintainerCfg.body.isAdmin, readDepts: maintainerCfg.body.readDepts }, { isAdmin: false, readDepts: ['咨询所'] });
  const maintainerSet = await call(base, maintainer, '/api/kb/repo-config', {
    method: 'POST', body: JSON.stringify({ reposId: 14, maintainers: ['liuyang'], readDepts: ['研究院'] }),
  });
  assert.equal(maintainerSet.body.ok, false);
  assert.match(maintainerSet.body.message, /仅管理员可设置共享部门/);

  /* 5. 撤销共享后立即失效 */
  const revoke = await call(base, admin, '/api/kb/repo-config', {
    method: 'POST', body: JSON.stringify({ reposId: 14, maintainers: ['liuyang'], readDepts: [] }),
  });
  assert.deepEqual(revoke.body.readDepts, []);
  const afterRevoke = await call(base, consulting, '/api/kb/perm?reposId=14');
  assert.equal(afterRevoke.body.canWrite, false);
  assert.equal(afterRevoke.body.readShared, false);
  const afterRevokeList = await call(base, consulting, '/api/kb/list?reposId=14');
  assert.equal(afterRevokeList.body.ok, false);

  /* 6. 审计留痕 */
  const audit = fs.readFileSync(path.join(dir, 'kb-audit.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const events = audit.filter((e) => e.action === 'repo-config' && String(e.reposId) === '14');
  assert.ok(events.some((e) => Array.isArray(e.readDepts) && e.readDepts.includes('咨询所')), '设置共享部门应写审计');
  assert.ok(events.some((e) => Array.isArray(e.readDepts) && e.readDepts.length === 0), '撤销共享应写审计');
});
