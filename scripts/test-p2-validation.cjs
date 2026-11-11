/* P2 校验引擎端到端验证：error 拦截 / warn 提示 / 误报回归 / 提交网关
 * 用法（服务需以 ZIP_TOTAL_MB=1 启动以便触发 R7 炸弹规则）：
 *   DATA_DIR=./data-p2 ZIP_TOTAL_MB=1 PORT=8813 node server.cjs &
 *   node scripts/test-p2-validation.cjs http://127.0.0.1:8813 ./data-p2
 */
const fs = require('fs');
const path = require('path');
const { makeZip, HTML } = require('./lib-zip.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8813';
const DATA_DIR = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data-p2'));
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };
const IDX = HTML('t');
const pkg = (files) => makeZip([['test/src/index.html', IDX], ...files]);

(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  assert(login.ok, '管理员登录');
  const auth = { Authorization: 'Bearer ' + login.token };

  const upload = async (zip, filename) => {
    const fd = new FormData();
    fd.append('kind', 'web');
    fd.append('file', new Blob([zip]), filename);
    return fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
  };
  const submit = (id, name) =>
    fetch(BASE + '/api/uploads/submit', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: name || 'P2测试', desc: '校验引擎用例' }),
    }).then(j);
  const errIds = (r) => (r.report?.rules || []).filter((x) => x.level === 'error').map((x) => x.id);
  const warnIds = (r) => (r.report?.rules || []).filter((x) => x.level === 'warn').map((x) => x.id);

  /* 1. 干净包：ok，无 error */
  let r = await upload(pkg([['test/src/app.js', Buffer.from('console.log(1)')], ['test/src/style.css', Buffer.from('body{background:url(bg.png)}')], ['test/src/bg.png', Buffer.from('png')]]), 'clean.zip');
  assert(r.ok && r.report.verdict === 'ok' && errIds(r).length === 0, `干净包通过（verdict=${r.report?.verdict}，errors=${errIds(r)}）`);

  /* 2. 误报回归：王鹏式静态工具（http.server 启动脚本 + bat）不应命中 R2 */
  r = await upload(pkg([
    ['test/一键启动.py', Buffer.from('import http.server\nhttp.server.test(HandlerClass=...)')],
    ['test/启动.bat', Buffer.from('@echo off\nstart http://localhost:8000')],
    ['test/src/serve.py', Buffer.from('# 本地静态预览用\nimport http.server, socketserver\nsocketserver.TCPServer(("", 8000), http.server.SimpleHTTPRequestHandler).serve_forever()')],
  ]), 'wangpeng-like.zip');
  assert(!errIds(r).includes('R2'), `静态启动脚本不误报后台（errors=${errIds(r)}）`);
  const s2 = await submit(r.id, '静态带启动脚本');
  assert(s2.ok === true, `该包可正常提交（${s2.message}）`);

  /* 3. R2 后台模块：package.json express + server.js */
  r = await upload(pkg([
    ['test/package.json', Buffer.from('{"name":"x","dependencies":{"express":"^4.18.0"}}')],
    ['test/server.js', Buffer.from("const express = require('express'); const app = express(); app.listen(3000)")],
  ]), 'backend.zip');
  assert(errIds(r).includes('R2') && r.report.verdict === 'fail', `R2 后台依赖拦截（errors=${errIds(r)}）`);
  const s3 = await submit(r.id, '后台工具');
  assert(s3.ok === false && /校验未通过/.test(s3.message || ''), `提交网关拦截（${s3.message?.slice(0, 60)}）`);

  /* 4. R3 数据库文件 */
  r = await upload(pkg([['test/data/app.sqlite', Buffer.from('sqlite...')]]), 'db.zip');
  assert(errIds(r).includes('R3'), `R3 数据库文件拦截（errors=${errIds(r)}）`);

  /* 5. R4 死链：引用包内不存在的 js */
  r = await upload(makeZip([['test/src/index.html', Buffer.from('<script src="./missing.js"></script><img src="pic.png">')]]), 'deadlink.zip');
  assert(errIds(r).includes('R4'), `R4 死链拦截（errors=${errIds(r)}）`);

  /* 6. R5 绝对路径 */
  r = await upload(makeZip([['test/src/index.html', Buffer.from('<script src="/assets/app.js"></script><a href="file:///C:/x.html">x</a>')]]), 'abs.zip');
  assert(errIds(r).includes('R5'), `R5 绝对路径拦截（errors=${errIds(r)}）`);

  /* 7. R6 zip-slip：不落盘 */
  r = await upload(makeZip([['../evil.txt', Buffer.from('x')], ['test/src/index.html', IDX]]), 'slip.zip');
  assert(errIds(r).includes('R6'), `R6 路径穿越拦截（errors=${errIds(r)}）`);
  assert((fs.readdirSync(path.join(DATA_DIR, 'tmp', r.id)) || []).length === 0, '穿越包未解压落盘');

  /* 7b. Windows 反斜杠分隔符（系统右键压缩产物）：归一为 / 后正常解析，不再误报 R6 */
  const BS = String.fromCharCode(92);
  r = await upload(makeZip([['assets' + BS + 'tailwind.js', Buffer.from('/*tw*/')], ['test' + BS + 'src' + BS + 'index.html', IDX]]), 'bs.zip');
  assert(!errIds(r).includes('R6'), `R6 反斜杠条目不再误拦（errors=${errIds(r)}）`);
  assert(r.report?.lines?.some((l) => String(l).includes('解压成功')), '反斜杠包解压成功');

  /* 8. R7 压缩炸弹（服务以 ZIP_TOTAL_MB=1 启动，2MB 包触发） */
  r = await upload(pkg([['test/big.bin', require('crypto').randomBytes(2 * 1024 * 1024)]]), 'bomb.zip');
  assert(errIds(r).includes('R7'), `R7 总量超限拦截（errors=${errIds(r)}）`);

  /* 8b. 文件数边界：1001 个文件应通过（上限 3000），3001 个应被 R7 拦截 */
  const many = (n) => pkg(Array.from({ length: n }, (_, i) => [`test/f${i}.txt`, Buffer.from('x')]));
  r = await upload(many(1001), 'files1001.zip');
  assert(!errIds(r).includes('R7'), `1001 文件不再误拦（errors=${errIds(r)}）`);
  r = await upload(many(3001), 'files3001.zip');
  assert(errIds(r).includes('R7'), `3001 文件超限拦截（errors=${errIds(r)}）`);

  /* 8c. 开发垃圾剔除：venv/node_modules/.git/pyc 解压前剔除——不计文件数与总量，也不再误触 R2（venv 里的 flask 等） */
  r = await upload(pkg([
    ['venv/Lib/site-packages/flask/__init__.py', Buffer.from('from flask import Flask')],
    ['node_modules/lodash/index.js', Buffer.from('module.exports={}')],
    ['.git/config', Buffer.from('[core]')],
    ['__pycache__/a.pyc', Buffer.from('bin')],
  ]), 'junk.zip');
  assert(!errIds(r).includes('R7') && !errIds(r).includes('R2') && !errIds(r).includes('R4'), `垃圾剔除后正常通过（errors=${errIds(r)}）`);
  assert((r.report?.lines || []).some((l) => String(l).includes('已自动剔除 4 个')), '报告注明剔除数量');

  /* 9. 单文件网页死链（R4） */
  const fd = new FormData();
  fd.append('kind', 'web');
  fd.append('file', new Blob([Buffer.from('<script src="./app.js"></script>')]), 'single.html');
  r = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
  assert(errIds(r).includes('R4'), `单文件网页引用本地资源拦截（errors=${errIds(r)}）`);

  /* 9b. R4 误报防护：内联脚本里的 JS replace 替换串（href="$2"）不是真实引用 */
  const replaceHtml = Buffer.from('<html><body><script>const linked = text.replace(/(https?:\\/\\/[^\\s<]+)/g, \'<a href="$2" target="_blank">$1</a>\');</script></body></html>');
  r = await upload(pkg([['test/src/index.html', replaceHtml]]), 'jsreplace.zip');
  assert(!errIds(r).includes('R4'), `R4 替换串令牌不误拦（errors=${errIds(r)}）`);

  /* 10. warn 级：.env 密钥文件 + 外链 + bat（不阻断） */
  r = await upload(pkg([
    ['test/.env', Buffer.from('API_KEY=abcdefghijklmnopqrst1234\n')],
    ['test/启动.bat', Buffer.from('@echo off')],
    ['test/src/index.html', Buffer.from('<!doctype html><script src="https://cdn.example.com/x.js"></script>')],
  ]), 'warns.zip');
  assert(errIds(r).length === 0 && warnIds(r).includes('R9') && warnIds(r).includes('R8') && warnIds(r).includes('R10'),
    `warn 级不阻断（errors=${errIds(r)}，warns=${warnIds(r)}）`);

  /* 11. 文件类：exe → R10 warn */
  const fd2 = new FormData();
  fd2.append('kind', 'file');
  fd2.append('file', new Blob([Buffer.from('MZ...')]), '安装程序.exe');
  r = await fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd2 }).then(j);
  assert(r.ok && (r.report?.rules || []).some((x) => x.id === 'R10' && x.level === 'warn') && r.report.verdict === 'warn', `文件类 exe 警示（verdict=${r.report?.verdict}）`);

  /* 12. 指引文案存在性（fix 非空） */
  r = await upload(pkg([['test/data/x.db', Buffer.from('db')]]), 'fix.zip');
  const r3 = (r.report?.rules || []).find((x) => x.id === 'R3');
  assert(!!r3?.fix && r3.fix.length > 10, `错误规则带修复指引（fix=${r3?.fix?.slice(0, 30)}…）`);

  console.log(process.exitCode ? 'P2 VALIDATION: FAILED' : 'P2 VALIDATION: ALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
