/* exe 桌面程序压缩包自动识别（→ 文件下载通道）端到端验证
 * 用法：
 *   DATA_DIR=.tmp-exe-test/data SERVICE_DOCKER=mock PORT=8817 node server.cjs &
 *   node scripts/test-exe-zip.cjs http://127.0.0.1:8817
 * 覆盖：exe/msi zip 分流 file、exe 优先于 html（Electron 未 asar 化形态）、
 * 服务型证据优先于 exe、web/skill/裸 exe/无特征 zip 回归、提交→审批→download 上线全链路。 */
const { makeZip } = require('./lib-zip.cjs');

const BASE = process.argv[2] || 'http://127.0.0.1:8817';
const j = (r) => r.json();
const assert = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); if (!cond) process.exitCode = 1; };
const warnIds = (rep) => (rep.rules || []).filter((r) => r.level === 'warn').map((r) => r.id);

/* 内容不重要（判型只看扩展名），给个 PE 头样子的占位 */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

const upload = async (auth, data, filename) => {
  const fd = new FormData();
  fd.append('kind', 'auto');
  fd.append('file', new Blob([data]), filename);
  return fetch(BASE + '/api/uploads/parse', { method: 'POST', headers: auth, body: fd }).then(j);
};

(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(j);
  const auth = { Authorization: 'Bearer ' + login.token };

  /* 1. exe zip → file（文件下载），不拦截 + R10 审核警示 + 判定依据入日志 */
  let r = await upload(auth, makeZip([
    ['批量盖章工具.exe', EXE],
    ['使用说明.txt', Buffer.from('双击运行，需要 Windows 10 以上')],
    ['config.json', Buffer.from('{}')],
  ]), '批量盖章工具.zip');
  assert(r.ok && r.detected === 'file' && r.kind === 'file', 'exe zip 自动识别为 file（文件下载）');
  assert(r.ok && r.report.verdict !== 'fail', `exe zip 解析不拦截（verdict=${r.report?.verdict}）`);
  assert(warnIds(r.report).includes('R10'), 'R10：包内可执行文件列入审核警示');
  assert((r.report.lines || []).some((l) => l.includes('自动识别：文件下载')), '解析日志注明判定依据');
  assert((r.report.lines || []).some((l) => l.includes('原样分发')), '解析日志注明整包分发行为');
  const exeZipId = r.id;

  /* 2. msi 安装包 → file */
  r = await upload(auth, makeZip([['setup.msi', EXE]]), 'setup.zip');
  assert(r.ok && r.detected === 'file', 'msi 安装包同样分流 file');

  /* 3. exe + html（Electron 未 asar 化形态）→ 仍 file，不被 html 抢成网页 */
  r = await upload(auth, makeZip([
    ['app/我的应用.exe', EXE],
    ['app/resources/index.html', Buffer.from('<html><body>内部资源页</body></html>')],
  ]), 'electron-app.zip');
  assert(r.ok && r.detected === 'file', 'exe 优先于 html：桌面程序包带 html 资源页不误判网页');

  /* 4. 回归：纯网页 zip 仍 web */
  r = await upload(auth, makeZip([['index.html', Buffer.from('<html><body>x</body></html>')]]), 'plain-web.zip');
  assert(r.ok && r.detected === 'web', '回归：纯网页 zip 仍识别 web');

  /* 5. 回归：服务型证据优先于 exe（package.json+start + 顺手带 exe 仍是 service） */
  const PKG = JSON.stringify({ name: 'svc-demo', scripts: { start: 'node server.js' } });
  r = await upload(auth, makeZip([
    ['package.json', Buffer.from(PKG)],
    ['server.js', Buffer.from('require("http").createServer((q,s)=>s.end("ok")).listen(process.env.PORT||3000)')],
    ['tools/helper.exe', EXE],
  ]), 'svc-with-exe.zip');
  assert(r.ok && r.detected === 'service', '回归：后端证据优先于 exe，仍识别 service');

  /* 6. 回归：SKILL.md zip 仍 skill */
  r = await upload(auth, makeZip([['SKILL.md', Buffer.from('---\nname: 测试技能\ndescription: 测试\n---\n内容')]]), 'skill.zip');
  assert(r.ok && r.detected === 'skill', '回归：SKILL.md 仍识别 skill');

  /* 7. 回归：裸 exe（未压缩直传）仍 file */
  r = await upload(auth, EXE, '独立小工具.exe');
  assert(r.ok && r.detected === 'file', '回归：裸 exe 文件仍走 file 通道');

  /* 8. 回归：无 exe 无 html 的 zip 仍按网页分支报 R1（纯数据包不误判成下载） */
  r = await upload(auth, makeZip([['模板.xlsx', Buffer.from('x')], ['说明.txt', Buffer.from('hi')]]), 'templates.zip');
  assert(r.ok && r.detected === 'web' && r.report.verdict === 'fail', '回归：无特征 zip 仍按网页分支给 R1 规范报错');

  /* 9. 全链路：提交 → 审批上线 → 工具类型 download、URL 指向整包文件 */
  const sub = await fetch(BASE + '/api/uploads/submit', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: exeZipId, name: '批量盖章工具', desc: '桌面程序演示：exe 打包上传', icon: '盖', tags: ['业务提效'], departments: ['全部'] }),
  }).then(j);
  assert(sub.ok, `file 类提交通过（${sub.message || ''}）`);
  const ap = await fetch(`${BASE}/api/admin/uploads/${exeZipId}/approve`, { method: 'POST', headers: auth }).then(j);
  assert(ap.ok, `file 类审批上线通过（${ap.message || ''}）`);
  const tools = await fetch(BASE + '/api/tools/extra').then(j);
  const online = (tools.tools || []).find((t) => t.name === '批量盖章工具');
  assert(!!online, '上线工具出现在工具列表');
  assert(online && online.type === 'download', `工具类型为 download（=${online?.type}）`);
  assert(online && /批量盖章工具\.zip$/.test(decodeURIComponent(online.url || '')), `URL 指向整包 zip（=${online?.url}）`);
  assert(online && /^\/files\/uploads\/sites\//.test(online.url || ''), 'URL 走站点目录（版本化 releases）');
})();
