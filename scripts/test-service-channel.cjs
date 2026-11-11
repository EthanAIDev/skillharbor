/* P4 服务型工具通道端到端验证（mock 模式：SERVICE_DOCKER=mock 起服务，跳过真实 docker 执行）
 * 用法：
 *   DATA_DIR=./data-svc SERVICE_DOCKER=mock PORT=8816 node server.cjs &
 *   node scripts/test-service-channel.cjs http://127.0.0.1:8816 ./data-svc
 * 生产服务器（有 docker）可去掉 SERVICE_DOCKER=mock 验证真实容器链路（构建用 node:20-alpine 需可拉取）。 */
const fs = require('fs');
const path = require('path');
const { makeZip } = require('./lib-zip.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8816';
const DATA_DIR = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data-svc'));
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };
const ruleIds = (rep) => (rep.rules || []).filter((r) => r.level === 'error').map((r) => r.id);

/* 一个最小 express 应用：package.json（含 start）+ server.js（监听 process.env.PORT） */
const APP_PKG = JSON.stringify({ name: 'demo-baozhang', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { express: '^4.19.0' } });
const APP_JS = [
  "const express = require('express');",
  "const app = express();",
  "app.get('/', (q, s) => s.send('ok-demo'));",
  "app.listen(process.env.PORT || 3000);",
].join('\n');
const DOCKERFILE = ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'RUN npm install --omit=dev', 'EXPOSE 8080', 'CMD ["npm", "start"]', ''].join('\n');

const upload = async (auth, zipData, filename, kind) => {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([zipData]), filename);
  return fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
};
const submit = (auth, id, extra = {}) =>
  fetch(BASE + '/api/uploads/submit', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: '电子报账演示系统', desc: '演示服务型工具通道', icon: '服', tags: ['业务提效'], departments: ['Platform'], ...extra }),
  }).then(j);
const approve = (auth, id) => fetch(`${BASE}/api/admin/uploads/${id}/approve`, { method: 'POST', headers: auth }).then(j);
const rollback = (auth, id) => fetch(`${BASE}/api/admin/uploads/${id}/rollback`, { method: 'POST', headers: auth }).then(j);
const offline = (auth, id) => fetch(`${BASE}/api/admin/uploads/${id}/offline`, { method: 'POST', headers: auth }).then(j);

(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  const auth = { Authorization: 'Bearer ' + login.token };

  /* 1. 结构校验 */
  let r = await upload(auth, makeZip([['readme.txt', Buffer.from('hi')]]), 'no-engine.zip', 'service');
  assert(r.ok && r.report.verdict === 'fail' && ruleIds(r.report).includes('S1'), 'S1：无 Dockerfile/package.json 拦截');
  r = await upload(auth, makeZip([['package.json', Buffer.from(JSON.stringify({ name: 'x', scripts: {} }))], ['server.js', Buffer.from('')]]), 'no-start.zip', 'service');
  assert(r.ok && r.report.verdict === 'fail' && ruleIds(r.report).includes('S1'), 'S1：package.json 无 start 脚本拦截');

  /* 1b. S3 外置数据库/缓存依赖硬拦截；S4 原生模块预警不拦截 */
  const PG_PKG = JSON.stringify({ name: 'demo-pg', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { express: '^4.19.0', pg: '^8.11.0' } });
  r = await upload(auth, makeZip([['package.json', Buffer.from(PG_PKG)], ['server.js', Buffer.from(APP_JS)]]), 'pg-app.zip', 'service');
  assert(r.ok && r.report.verdict === 'fail' && ruleIds(r.report).includes('S3'), 'S3：Node 依赖 pg（外置数据库）拦截');
  r = await upload(auth, makeZip([['requirements.txt', Buffer.from('flask==3.0.0\nredis==5.0.0\n')], ['Dockerfile', Buffer.from('FROM python:3.12-alpine\nCOPY . /app\nWORKDIR /app\nEXPOSE 8000\nCMD ["python","app.py"]')], ['app.py', Buffer.from('print(1)')]]), 'py-redis.zip', 'service');
  assert(r.ok && r.report.verdict === 'fail' && ruleIds(r.report).includes('S3'), 'S3：requirements.txt 依赖 redis 拦截（Python 包）');
  const SQLITE_PKG = JSON.stringify({ name: 'demo-sqlite', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { express: '^4.19.0', 'better-sqlite3': '^11.0.0' } });
  r = await upload(auth, makeZip([['package.json', Buffer.from(SQLITE_PKG)], ['server.js', Buffer.from(APP_JS)]]), 'sqlite-app.zip', 'service');
  assert(r.ok && r.report.verdict !== 'fail' && !ruleIds(r.report).includes('S3'), 'S3：SQLite 方案不误伤（better-sqlite3 不是外置服务）');
  assert(r.report.rules.some((x) => x.id === 'S4' && x.level === 'warn'), 'S4：原生模块（better-sqlite3 + 无 Dockerfile）预警');

  /* 2. express 包（package.json 路线）：R2 不应触发，端口默认 3000 */
  r = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS)]]), 'baozhang-app.zip', 'service');
  assert(r.ok && r.report.verdict === 'ok', `package.json 路线解析通过（verdict=${r.report.verdict}）`);
  assert(!ruleIds(r.report).includes('R2') && !r.report.rules.some((x) => x.id === 'R2'), '服务通道不触发 R2 后端依赖规则');
  assert(r.report.containerPort === 3000, `未声明端口默认 3000（=${r.report.containerPort}）`);
  const appA = r.id;

  /* 3. Dockerfile 路线（外层目录包裹）：EXPOSE 识别 + 构建根目录 */
  r = await upload(auth, makeZip([['baozhang/Dockerfile', Buffer.from(DOCKERFILE)], ['baozhang/package.json', Buffer.from(APP_PKG)], ['baozhang/server.js', Buffer.from(APP_JS)]]), 'baozhang-df.zip', 'service');
  assert(r.ok && r.report.verdict === 'ok' && r.report.containerPort === 8080, `EXPOSE 识别 8080（=${r.report.containerPort}）`);
  assert(r.report.dockerRoot === 'baozhang', `构建根目录识别（=${r.report.dockerRoot}）`);

  /* 4. 敏感信息警示保留 */
  r = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS)], ['config/api_key.txt', Buffer.from('apikey=sk-1234567890abcdefghij')]]), 'secret.zip', 'service');
  assert(r.ok && r.report.verdict === 'warn' && r.report.rules.some((x) => x.id === 'R9'), 'R9 密钥警示保留（warn 不阻断）');

  /* 5. 部署链路（mock）：提交 → 审批 → releases 落位 + 自动 Dockerfile + 端口登记 + 卡片 */
  r = await submit(auth, appA);
  assert(r.ok, '提交成功');
  r = await approve(auth, appA);
  assert(r.ok, `审批部署成功（${r.message || ''}）`);
  const uploadsJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'uploads.json'), 'utf8'));
  const rec = uploadsJson.find((x) => x.id === appA);
  assert(rec.status === 'online', `记录 online（=${rec.status}）`);
  const svcReg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'services.json'), 'utf8'));
  const siteKey = 'u' + appA;
  const svc = svcReg[siteKey];
  assert(svc && svc.port >= 18200 && svc.port <= 18399, `端口登记在 18200 段（=${svc && svc.port}）`);
  assert(/^http:\/\/[\d.]+:\d+$/.test(rec.deployedUrl), `URL 指向独立端口（=${rec.deployedUrl}）`);
  const vDir = path.join(DATA_DIR, 'uploads', 'releases', siteKey, 'v1');
  assert(fs.existsSync(path.join(vDir, 'package.json')), '产物落位 releases/v1');
  assert(fs.existsSync(path.join(vDir, 'Dockerfile')), '无原生 Dockerfile 时自动生成');
  const extra = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'extraTools.json'), 'utf8'));
  const card = extra.find((x) => x.uploadId === appA);
  assert(card && card.type === 'service' && card.url === rec.deployedUrl, `卡片 type=service 且 URL 一致（=${card && card.type}）`);
  const deps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'deployments.json'), 'utf8'));
  assert(deps.some((d) => d.tool === siteKey && d.version === 'v1'), '部署历史记 v1');

  /* 6. 更新部署：端口沿用 + v2 */
  const up = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS + '\n// v2')]]), 'baozhang-v2.zip', 'service');
  r = await submit(auth, up.id, { updateOf: 'tool:' + card.id, updateNote: 'v2 修复' });
  assert(r.ok, '更新提交成功');
  r = await approve(auth, up.id);
  assert(r.ok, '更新部署成功');
  const svc2 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'services.json'), 'utf8'))[siteKey];
  assert(svc2.port === svc.port, `更新沿用原端口（${svc.port} → ${svc2.port}）`);
  assert(fs.existsSync(path.join(DATA_DIR, 'uploads', 'releases', siteKey, 'v2')), 'v2 版本目录落位');

  /* 7. 回滚到 v1（端点按首次部署的 uploadId 定位工具，更新记录不改变卡位的 uploadId） */
  r = await rollback(auth, appA);
  assert(r.ok, `回滚成功（${r.message || ''}）`);
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'uploads', 'releases', siteKey, 'meta.json'), 'utf8'));
  assert(meta.current === 'v1', `meta.current=v1（=${meta.current}）`);

  /* 8. 保留策略：回滚态下继续部署 v3 / v4 → 保留最近 3 版（v2/v3/v4），最旧的 v1 随新版本部署成功自动清理 */
  for (const v of [3, 4]) {
    const up2 = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS + `\n// v${v}`)]]), `baozhang-v${v}.zip`, 'service');
    r = await submit(auth, up2.id, { updateOf: 'tool:' + card.id, updateNote: `v${v}` });
    r = await approve(auth, up2.id);
    assert(r.ok, `v${v} 部署成功`);
  }
  const relDir = path.join(DATA_DIR, 'uploads', 'releases', siteKey);
  assert(!fs.existsSync(path.join(relDir, 'v1')), '最旧 v1 随 v4 部署成功自动清理（目录）');
  assert(fs.existsSync(path.join(relDir, 'v2')) && fs.existsSync(path.join(relDir, 'v4')), '保留最近 3 版（v2/v3/v4）');

  /* 9. 更新提交类型锁定（须在工具在线时验证）：服务包更新的工具现被判为 service，用 auto 上传的纯网页包更新 → 明确拒绝 */
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>z</body></html>')]]), 'wrong-update.zip', 'auto');
  const wuId = r.id;
  assert(r.ok && r.detected === 'web', '错误通道更新包按 auto 识别为 web');
  const wu = await submit(auth, wuId, { name: '电子报账演示系统', desc: 'x', icon: '服', tags: ['业务提效'], departments: ['全部'], updateOf: 'tool:' + card.id, updateNote: '错通道更新' });
  assert(!wu.ok && /通道/.test(wu.message || ''), `更新类型不符明确拒绝（${(wu.message || '').slice(0, 40)}）`);

  /* 10. 下线 */
  r = await offline(auth, appA);
  assert(r.ok, '下线成功');

  /* 11. 网页工具通道不受影响（R2 仍拦截 express） */
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>x</body></html>')], ['package.json', Buffer.from(APP_PKG)]]), 'web-with-express.zip', 'web');
  assert(r.ok && ruleIds(r.report).includes('R2'), '网页工具通道 R2 仍拦截后端依赖（分流正确）');

  /* 11. 免选类型（kind=auto）：检测分发正确性 */
  r = await upload(auth, makeZip([['SKILL.md', Buffer.from('---\nname: 自动识别技能\ndescription: 测试用\n---\n\n内容')]]), 'auto-skill.zip', 'auto');
  assert(r.ok && r.detected === 'skill', `auto 检测 SKILL.md → 技能（${r.detected}）`);
  assert(r.ok && r.report.lines.some((l) => l.includes('自动识别')), 'auto 解析日志注明判定依据');
  /* 网页工具配套技能：入口 HTML 浅于 SKILL.md → 判网页；反向（SKILL.md 浅）仍判技能 */
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>x</body></html>')], ['.workbuddy/skills/verify/SKILL.md', Buffer.from('---\nname: 配套技能\ndescription: 工具内置\n---\n\n内容')]]), 'auto-web-skill.zip', 'auto');
  assert(r.ok && r.detected === 'web', `auto 检测 入口HTML+配套技能（嵌套 SKILL.md）→ 网页（${r.detected}）`);
  r = await upload(auth, makeZip([['SKILL.md', Buffer.from('---\nname: 主技能\ndescription: 测试用\n---\n\n内容')], ['docs/index.html', Buffer.from('<html><body>doc</body></html>')]]), 'auto-skill-web.zip', 'auto');
  assert(r.ok && r.detected === 'skill', `auto 检测 根SKILL.md+嵌套HTML → 技能（${r.detected}）`);
  r = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS)]]), 'auto-svc.zip', 'auto');
  assert(r.ok && r.detected === 'service', `auto 检测 package.json+start → 服务型（${r.detected}）`);
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>x</body></html>')], ['a.css', Buffer.from('b{}')]]), 'auto-web.zip', 'auto');
  assert(r.ok && r.detected === 'web', `auto 检测纯静态 → 网页（${r.detected}）`);
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>x</body></html>')], ['package.json', Buffer.from(APP_PKG)]]), 'auto-mixed.zip', 'auto');
  assert(r.ok && r.detected === 'service', `auto 混合包（静态页+后端脚本）→ 服务型（${r.detected}）`);
  /* 1417 式：HTML 在构建目录外 → S2 warn；部署自动修复（包根上下文 + 目录结构 Dockerfile，不动文件） */
  r = await upload(auth, makeZip([['server/package.json', Buffer.from(APP_PKG)], ['server/server.js', Buffer.from(APP_JS)], ['电子报账系统.html', Buffer.from('<html><body>页面</body></html>')]]), '1417-like.zip', 'service');
  assert(r.ok && r.report.verdict === 'warn' && r.report.rules.some((x) => x.id === 'S2'), 'S2：HTML 在构建目录外预警');
  const s2Id = r.id;
  r = await submit(auth, s2Id, { name: 'S2自动修复演示', desc: 'x', icon: 'S2', tags: ['业务提效'], departments: ['全部'] });
  r = await approve(auth, s2Id);
  assert(r.ok, 'S2 包审批部署成功');
  const s2Rel = path.join(DATA_DIR, 'uploads', 'releases', 'u' + s2Id, 'v1');
  const genDf = fs.readFileSync(path.join(s2Rel, 'Dockerfile'), 'utf8');
  assert(genDf.includes('COPY . /app/') && genDf.includes('WORKDIR /app/server'), 'S2 修复：包根 Dockerfile 保持目录结构（COPY . /app/ + WORKDIR /app/server）');
  assert(!fs.existsSync(path.join(s2Rel, 'server', '电子报账系统.html')), 'S2 修复：不再把文件复制进 server/（目录结构原样保留）');
  const s2Svc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'services.json'), 'utf8'))['u' + s2Id];
  assert(s2Svc && Array.isArray(s2Svc.autoFixed) && s2Svc.autoFixed.includes('电子报账系统.html'), 'S2 修复留痕（services.autoFixed）');

  /* 12b. 共享 MySQL：包内 data/*.sql → 自动建库建号，连接信息落 services.json 并跨版本保留（mock docker 下导入按空库检查跳过属预期路径） */
  fs.mkdirSync(path.join(DATA_DIR, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'secrets', 'mysql-root.password'), 'test-root-pw');
  r = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS)], ['data/init.sql', Buffer.from('CREATE TABLE t(id INT);')]]), 'mysql-svc.zip', 'service');
  assert(r.ok && (r.report.lines.some((l) => String(l).includes('SQL 导出'))), 'MySQL 包解析注明 SQL 导出将自动导入');
  const myId = r.id;
  r = await submit(auth, myId, { name: 'MySQL工具演示', desc: 'x', icon: 'M', tags: ['业务提效'], departments: ['全部'] });
  r = await approve(auth, myId);
  assert(r.ok, 'MySQL 包审批部署成功');
  const mySvc0 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'services.json'), 'utf8'))['u' + myId];
  assert(mySvc0 && mySvc0.mysql && mySvc0.mysql.db === 'skillharbor_u' + myId && mySvc0.mysql.password.length >= 16, '建库建号落 services.json（随机口令）');
  /* 更新部署：mysql 连接信息跨版本保留 */
  const up2 = await upload(auth, makeZip([['package.json', Buffer.from(APP_PKG)], ['server.js', Buffer.from(APP_JS + '\n// v2')]]), 'mysql-v2.zip', 'service');
  const myCard = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'extraTools.json'), 'utf8')).find((x) => x.uploadId === myId);
  r = await submit(auth, up2.id, { updateOf: 'tool:' + myCard.id, updateNote: 'v2' });
  assert(r.ok, `MySQL 工具更新提交成功（${r.message || ''}）`);
  r = await approve(auth, up2.id);
  assert(r.ok, `MySQL 工具更新部署成功（${r.message || ''}）`);
  const mySvc1 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'services.json'), 'utf8'))['u' + myId];
  assert(mySvc1.mysql && mySvc1.mysql.password === mySvc0.mysql.password, '更新部署后 mysql 连接信息保留');

  /* 12. 管理员改判（rekind）：待审 web → service；更新提交不可改判 */
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>y</body></html>')]]), 'rekind-src.zip', 'auto');
  const rkId = r.id;
  await submit(auth, rkId, { name: '改判演示', desc: 'x', icon: '改', tags: ['业务提效'], departments: ['全部'] });
  let rk = await fetch(`${BASE}/api/admin/uploads/${rkId}/rekind`, { method: 'POST', headers: auth, body: JSON.stringify({}) }).then(j);
  rk = await fetch(`${BASE}/api/admin/uploads/${rkId}/rekind`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'service' }) }).then(j);
  assert(rk.ok && rk.message.includes('服务型'), `改判 web→service 成功（${rk.message}）`);
  rk = await fetch(`${BASE}/api/admin/uploads/${rkId}/rekind`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'skill' }) }).then(j);
  assert(rk.ok, '再次改判 service→skill 成功（未提交前可反复）');

  /* 14. GBK 文件名 zip（Windows 中文压缩工具，2026-09-17 结构洞工具部署失败根因）：
   * 条目名 GBK 字节 → 解压为正确中文名（不再 U+FFFD 乱码），与包内 Dockerfile/代码引用对得上 */
  const GBK_HEX = 'D7CAD4B4D0ADCDACB7D6CEF6'; // 「资源协同分析」GBK 字节（自检防手误）
  const gkbName = Buffer.concat([Buffer.from(GBK_HEX, 'hex'), Buffer.from('.html')]);
  assert(new TextDecoder('gbk').decode(gkbName) === '资源协同分析.html', 'GBK 字节自检（用例前提：hex 确为该名）');
  r = await upload(auth, makeZip([
    ['package.json', Buffer.from(JSON.stringify({ name: 'gbk-demo', version: '1.0.0', scripts: { start: 'node server.js' } }))],
    ['server.js', Buffer.from(APP_JS)],
    [gkbName, Buffer.from('<html><body>GBK</body></html>')],
  ]), 'gbk-names.zip', 'service');
  assert(r.ok && r.report.verdict === 'ok', `GBK zip 解析通过（${(r.report?.verdict || '')}）`);
  assert(!JSON.stringify(r.report).includes('\uFFFD'), '解析报告无 U+FFFD 乱码（GBK 兜底生效）');
  const gbkId = r.id;
  await submit(auth, gbkId, { name: 'GBK文件名演示系统', desc: 'GBK 条目名回归用例', icon: 'G', tags: ['业务提效'], departments: ['全部'] });
  r = await approve(auth, gbkId);
  assert(r.ok, `GBK zip 审批部署成功（${r.message || ''}）`);
  const gbkRel = path.join(DATA_DIR, 'uploads', 'releases', 'u' + gbkId, 'v1');
  assert(fs.existsSync(path.join(gbkRel, '资源协同分析.html')), 'GBK 名文件落位 releases 为正确中文名');

  /* 15. auto 检测与改判（见上方 11-12 组） */
  console.log(process.exitCode ? 'SERVICE CHANNEL: FAILED' : 'SERVICE CHANNEL: ALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
