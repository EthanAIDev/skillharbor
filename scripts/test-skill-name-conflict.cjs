/* #3 技能重名防线回归：提交 / 改判 / 审批 / 重新上架 四个入口的同名拦截 + 网关停用技能撞名
 * 用法（门户指向 mock 网关，隔离生产）：
 *   DATA_DIR=./data-namecheck PORT=8816 SKILL_GATEWAY_BASE=http://127.0.0.1:8899 node server.cjs &
 *   node scripts/test-skill-name-conflict.cjs http://127.0.0.1:8816
 */
const http = require('http');
const { makeZip } = require('./lib-zip.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8816';
const GW_PORT = 8899;
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };

/* ---------- mock 技能网关：GET /api/skills 返回可变清单 ---------- */
const gwSkills = [
  { slug: 'gw-enabled', name: 'gw-enabled', display_name: '网关已有技能', status: 'enabled', current_version: 'v1.0.0' },
  { slug: 'gw-disabled', name: 'gw-disabled', display_name: '网关停用技能', status: 'disabled', current_version: 'v1.0.0' },
];
const gw = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.startsWith('/api/skills') && req.url !== '/api/skills' ? {} : gwSkills));
});
const gwAdd = (display_name) => gwSkills.push({ slug: 'gw-' + display_name, name: 'gw-' + display_name, display_name, status: 'enabled', current_version: 'v1.0.0' });

const skillZip = (fmName, desc) => makeZip([
  ['SKILL.md', Buffer.from(`---\nname: ${fmName}\ndescription: ${desc}\n---\n\n# ${fmName}\n\n流程步骤一。`)],
]);
const webZip = () => makeZip([['test/src/index.html', Buffer.from('<!doctype html><html><head><title>网页工具</title></head><body>ok</body></html>')]]);

(async () => {
  await new Promise((r) => gw.listen(GW_PORT, r));
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录');
  const auth = { Authorization: 'Bearer ' + login.token };

  const parse = async (zip, filename) => {
    const fd = new FormData();
    fd.append('file', new Blob([zip]), filename);
    return fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
  };
  const submit = (id, name) =>
    fetch(BASE + '/api/uploads/submit', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, desc: '重名校验用例' }),
    }).then(j);
  const admin = (path) => fetch(BASE + path, { method: 'POST', headers: auth }).then(j);

  /* 1. 首个技能正常提交（基准） */
  let r = await parse(skillZip('skill-a', '技能甲触发描述'), 'skill-a.zip');
  assert(r.ok && r.kind === 'skill', `技能包解析为 AI 技能（kind=${r.kind}）`);
  let s = await submit(r.id, '技能甲');
  assert(s.ok === true, `首个技能提交通过（${s.message}）`);

  /* 2. 与在途待审记录同名 → 提交拦截 */
  r = await parse(skillZip('skill-a2', '技能甲触发描述'), 'skill-a2.zip');
  s = await submit(r.id, '技能甲');
  assert(s.ok === false && /同名/.test(s.message || ''), `在途同名拦截（${s.message}）`);

  /* 3. 与网关在线技能同名 → 提交拦截 */
  r = await parse(skillZip('skill-b', '技能乙触发描述'), 'skill-b.zip');
  s = await submit(r.id, '网关已有技能');
  assert(s.ok === false && /技能中心已存在同名/.test(s.message || ''), `网关在线同名拦截（${s.message}）`);

  /* 4. 与网关停用技能同名 → 提交拦截（防日后重新启用撞名） */
  r = await parse(skillZip('skill-b2', '技能乙触发描述'), 'skill-b2.zip');
  s = await submit(r.id, '网关停用技能');
  assert(s.ok === false && /已停用/.test(s.message || ''), `网关停用同名拦截（${s.message}）`);

  /* 5. 提交时无冲突、审批前网关冒出同名 → 审批拦截（网关控制台直传场景） */
  r = await parse(skillZip('skill-c', '技能丙触发描述'), 'skill-c.zip');
  s = await submit(r.id, '技能丙');
  assert(s.ok === true, `提交时无冲突（${s.message}）`);
  gwAdd('技能丙');
  let a = await admin('/api/admin/uploads/' + r.id + '/approve');
  assert(a.ok === false && /无法通过.*同名/.test(a.message || ''), `审批侧兜底拦截（${a.message}）`);

  /* 6. 网页记录（名称故意撞网关）改判为技能 → 改判拦截（网页通道不吃重名校验，改判时才拦） */
  r = await parse(webZip(), 'webtool.zip');
  s = await submit(r.id, '网关已有技能');
  assert(s.ok === true, `同名网页工具可提交（网页通道不校验技能名，${s.message}）`);
  a = await fetch(BASE + '/api/admin/uploads/' + r.id + '/rekind', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'skill' }) }).then(j);
  assert(a.ok === false && /无法改判.*同名/.test(a.message || ''), `改判同名拦截（${a.message}）`);

  /* 7. 重新上架（publish）时网关已有同名 → 拦截（下线期间名字被占） */
  r = await parse(skillZip('skill-d', '技能丁触发描述'), 'skill-d.zip');
  s = await submit(r.id, '技能丁');
  assert(s.ok === true, `技能丁提交通过（${s.message}）`);
  gwAdd('技能丁');
  a = await admin('/api/admin/uploads/' + r.id + '/publish');
  assert(a.ok === false && /无法上架.*同名/.test(a.message || ''), `重新上架同名拦截（${a.message}）`);

  /* 8. 不同名一切如常（对照） */
  r = await parse(skillZip('skill-e', '技能戊触发描述'), 'skill-e.zip');
  s = await submit(r.id, '技能戊-独立名称');
  assert(s.ok === true, `不同名不受影响（${s.message}）`);

  gw.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
