/* deploy66 服务容器业务数据持久化——真实 docker 编排回归（17 断言）
 * 覆盖 runServiceContainer / svcRemoveWithSnapshot 的完整数据链路：
 *   场景1  旧容器运行中 + 存活数据（server 子目录布局）→ 同布局重建，数据迁移 + 卷快照 + HTTP 存活
 *   场景2  旧容器已停止（模拟崩溃后重建）→ docker cp 对停止容器同样有效，数据不丢
 *   场景3  布局变化（dockerRoot: server → 根）+ 新镜像内置旧 data.json → 存活数据落到新布局路径并覆盖镜像数据
 *   场景4  全新部署（无旧容器、无卷数据）→ 不报错，镜像内置 data.json 保留
 *   场景A  下架（快照进卷 + 移除容器）→ 重新上架：旧容器不可读时从 /data 卷快照兜底恢复
 *   场景B  卷也无数据（全新环境首次部署）→ 正常部署不报错
 * 用法：node scripts/test-svc-data-persist.cjs   （本机需可用 docker；构建用 node:20-alpine）
 * 注意：本文件中 runServiceContainer / svcRemoveWithSnapshot / svcDataDirs / dockerCpIfExists /
 *       svcVolScript 与 server.cjs 同名实现保持一致（改 server.cjs 时人工同步此处）。 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-persist-regress-'));
const SERVICES = {};
let passed = 0, failed = 0;
const check = (name, cond) => { cond ? (passed++, console.log(`  ✓ ${name}`)) : (failed++, console.log(`  ✗ ${name}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: opts.timeout || 180000, maxBuffer: opts.maxBuffer || 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 300)));
      else resolve({ stdout: String(stdout) });
    });
  });
}

/* ===== 以下与 server.cjs 同名实现保持一致 ===== */
function svcDataDirs(dockerRoot) {
  const list = [];
  if (dockerRoot && typeof dockerRoot === 'string') {
    const rel = dockerRoot.replace(/^\/+|\/+$/g, '');
    if (rel) list.push('/app/' + rel);
  }
  list.push('/app/server', '/app');
  return [...new Set(list)];
}
async function dockerCpIfExists(args) {
  try { await docker(['cp', ...args], { timeout: 60000 }); return true; } catch { return false; }
}
function svcVolScript(dirs) {
  const list = dirs.map((d) => "'" + String(d).replace(/'/g, '') + "'").join(' ');
  return `for d in ${list}; do [ -f "$d/data.json" ] && cp "$d/data.json" /data/data.json && break; done`;
}
async function svcRemoveWithSnapshot(siteKey) {
  const cname = 'skillharbor-svc-' + siteKey;
  const dirs = svcDataDirs(SERVICES[siteKey]?.dockerRoot);
  await docker(['exec', cname, 'sh', '-c', svcVolScript(dirs)]).catch(() => {});
  const stage = path.join(TMP_DIR, 'svc-data', siteKey);
  fs.mkdirSync(stage, { recursive: true });
  for (const dir of dirs) {
    if (await dockerCpIfExists([`${cname}:${dir}/data.json`, path.join(stage, 'data.json')])) break;
  }
  await docker(['rm', '-f', cname]).catch(() => {});
}
async function runServiceContainer(siteKey, tag, port, containerPort, dockerRoot) {
  const cname = 'skillharbor-svc-' + siteKey;
  const dirs = svcDataDirs(dockerRoot ?? SERVICES[siteKey]?.dockerRoot);
  const stage = path.join(TMP_DIR, 'svc-data', siteKey);
  fs.mkdirSync(stage, { recursive: true });
  let stagedDir = '';
  for (const dir of dirs) {
    if (await dockerCpIfExists([`${cname}:${dir}/data.json`, path.join(stage, 'data.json')])) { stagedDir = dir; break; }
  }
  if (!stagedDir && fs.existsSync(path.join(stage, 'data.json'))) {
    stagedDir = '（最近暂存）';
    console.log(`  [stage] 沿用最近一次暂存（部署失败重试/重新上架场景）`);
  }
  if (!stagedDir) {
    try {
      const r = await docker(['run', '--rm', '-v', `skillharbor-svc-${siteKey}-data:/data:ro`, 'node:20-alpine', 'cat', '/data/data.json'],
        { timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
      const text = String(r.stdout || '').trim();
      if (text.startsWith('{')) {
        fs.writeFileSync(path.join(stage, 'data.json'), text);
        stagedDir = '/data（卷快照恢复）';
        console.log(`  [vol-restore] 旧容器不可读，从 /data 卷快照恢复`);
      }
    } catch { /* 卷里也没有（首次部署等） */ }
  }
  if (stagedDir) console.log(`  [stage] ${stagedDir}`);
  await docker(['rm', '-f', cname]).catch(() => {});
  await docker(['create', '--name', cname,
    '--restart', 'unless-stopped',
    '-p', `${port}:${containerPort}`,
    '-e', `PORT=${containerPort}`,
    '-v', `skillharbor-svc-${siteKey}-data:/data`,
    '--memory', '512m', '--cpus', '1',
    tag]);
  if (stagedDir) {
    let restoredDir = '';
    for (const dir of dirs) {
      if (await dockerCpIfExists([path.join(stage, 'data.json'), `${cname}:${dir}/data.json`])) { restoredDir = dir; break; }
    }
    console.log(`  [restore] → ${restoredDir || 'FAILED（stage 保留于 ' + stage + '）'}`);
  }
  await startWithRetry(cname);
  await docker(['exec', cname, 'sh', '-c', svcVolScript(dirs)]).catch(() => {});
}
/* ===== 一致段结束 ===== */

const exec = (c, cmd) => docker(['exec', c, 'sh', '-c', cmd]).then((r) => r.stdout.trim());
const httpIs = async (port, expect) => { try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.ok && (await r.text()) === expect; } catch { return false; } };
/* Docker Desktop 高负载下偶发 CLI 抖动（报错但实际已执行/端口释放竞态）：start 失败先重试一次再认输 */
async function startWithRetry(cname) {
  try { await docker(['start', cname]); }
  catch (e) { await sleep(3000); await docker(['start', cname]).catch((e2) => { throw new Error(`${e.message} / 重试: ${e2.message}`); }); }
}

(async () => {
  const SITE = 'testpersist', CNAME = 'skillharbor-svc-' + SITE, PORT = 18599;

  console.log('== 准备：两个测试镜像（v1 后端在 server/ 子目录，v2 后端在根） ==');
  const d1 = path.join(TMP_DIR, 'v1'); fs.mkdirSync(path.join(d1, 'server'), { recursive: true });
  fs.writeFileSync(path.join(d1, 'server', 'server.js'), "require('http').createServer((q,s)=>{s.end('v1')}).listen(process.env.PORT||3000)");
  fs.writeFileSync(path.join(d1, 'server', 'data.json'), '{"v":1,"marker":"v1-seed"}'); // 模拟镜像内置种子数据
  fs.writeFileSync(path.join(d1, 'Dockerfile'), 'FROM node:20-alpine\nCOPY . /app\nWORKDIR /app/server\nCMD ["node","server.js"]\n');
  const d2 = path.join(TMP_DIR, 'v2'); fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'server.js'), "require('http').createServer((q,s)=>{s.end('v2')}).listen(process.env.PORT||3000)");
  fs.writeFileSync(path.join(d2, 'Dockerfile'), 'FROM node:20-alpine\nCOPY . /app\nWORKDIR /app\nCMD ["node","server.js"]\n');
  await docker(['build', '-q', '-t', 'svc-regress:v1', d1]);
  await docker(['build', '-q', '-t', 'svc-regress:v2', d2]);
  console.log('  镜像构建完成');

  console.log('== 场景1：旧容器运行中 + 存活数据（server 子目录布局）→ 同布局重建 ==');
  await docker(['run', '-d', '--name', CNAME, '-p', `${PORT}:3000`, '-v', `skillharbor-svc-${SITE}-data:/data`, 'svc-regress:v1']);
  await sleep(800);
  await docker(['exec', CNAME, 'sh', '-c', `echo '{"v":1,"live":"真实生产数据-场景1"}' > /app/server/data.json`]);
  SERVICES[SITE] = { dockerRoot: 'server' };
  await runServiceContainer(SITE, 'svc-regress:v1', PORT, 3000, 'server');
  await sleep(800);
  check('服务活着（新容器运行）', (await exec(CNAME, 'echo running')) === 'running');
  check('业务数据迁移成功（存活数据覆盖镜像种子）', (await exec(CNAME, 'cat /app/server/data.json')).includes('真实生产数据-场景1'));
  check('卷快照已生成', (await exec(CNAME, 'cat /data/data.json')).includes('真实生产数据-场景1'));
  check('HTTP 服务可访问', await httpIs(PORT, 'v1'));

  console.log('== 场景2：旧容器已停止（模拟崩溃）→ 重建数据不丢 ==');
  await docker(['exec', CNAME, 'sh', '-c', `echo '{"v":1,"live":"停止前写入的数据-场景2"}' > /app/server/data.json`]);
  await docker(['stop', CNAME]);
  await runServiceContainer(SITE, 'svc-regress:v1', PORT, 3000, 'server');
  await sleep(800);
  check('停止容器数据迁移成功', (await exec(CNAME, 'cat /app/server/data.json')).includes('停止前写入的数据-场景2'));

  console.log('== 场景3：布局变化（dockerRoot: server → 根）+ 镜像内置旧 data.json ==');
  fs.writeFileSync(path.join(d2, 'data.json'), '{"v":2,"marker":"v2-镜像内置旧数据"}');
  await docker(['build', '-q', '-t', 'svc-regress:v2', d2]);
  await runServiceContainer(SITE, 'svc-regress:v2', PORT, 3000, '');
  await sleep(800);
  check('服务活着且是新版本', await httpIs(PORT, 'v2'));
  check('数据落到新布局路径 /app/data.json 且为存活数据', (await exec(CNAME, 'cat /app/data.json')).includes('停止前写入的数据-场景2'));
  check('旧布局 /app/server/data.json 不再存在', (await exec(CNAME, 'ls /app/server/data.json 2>/dev/null || echo none')) === 'none');
  check('卷快照跟随新布局刷新', (await exec(CNAME, 'cat /data/data.json')).includes('停止前写入的数据-场景2'));

  console.log('== 场景4：全新部署（无旧容器、无卷数据、无历史暂存——真实新工具=新 siteKey） ==');
  await docker(['rm', '-f', CNAME]).catch(() => {});
  await docker(['volume', 'rm', `skillharbor-svc-${SITE}-data`]).catch(() => {});
  delete SERVICES[SITE];
  fs.rmSync(path.join(TMP_DIR, 'svc-data', SITE), { recursive: true, force: true }); // 清历史暂存=模拟全新 siteKey
  await runServiceContainer(SITE, 'svc-regress:v2', PORT, 3000, '');
  await sleep(800);
  check('全新部署成功（容器运行）', (await exec(CNAME, 'echo running')) === 'running');
  check('镜像内置 data.json 保留（无暂存不覆盖）', (await exec(CNAME, 'cat /app/data.json')).includes('v2-镜像内置旧数据'));

  console.log('== 场景A：下架（快照进卷+移除）→ 重新上架（卷兜底恢复） ==');
  await docker(['exec', CNAME, 'sh', '-c', `echo '{"v":2,"live":"下架前的生产数据"}' > /app/data.json`]);
  SERVICES[SITE] = { dockerRoot: '' };
  await svcRemoveWithSnapshot(SITE);
  check('下架后容器已移除', (await docker(['ps', '-a', '--format', '{{.Names}}']).then((r) => !r.stdout.split('\n').includes(CNAME))));
  const volData = await docker(['run', '--rm', '-v', `skillharbor-svc-${SITE}-data:/data:ro`, 'node:20-alpine', 'cat', '/data/data.json']).then((r) => r.stdout.trim());
  check('下架前数据已快照进卷', volData.includes('下架前的生产数据'));
  await runServiceContainer(SITE, 'svc-regress:v2', PORT, 3000, '');
  await sleep(800);
  check('重新上架容器运行', (await exec(CNAME, 'echo running')) === 'running');
  check('重新上架后数据完整恢复（非镜像数据）', (await exec(CNAME, 'cat /app/data.json')).includes('下架前的生产数据'));

  console.log('== 场景B：卷也无数据（全新环境首次部署）==');
  await svcRemoveWithSnapshot(SITE);
  await docker(['volume', 'rm', `skillharbor-svc-${SITE}-data`]).catch(() => {});
  delete SERVICES[SITE];
  fs.rmSync(path.join(TMP_DIR, 'svc-data', SITE), { recursive: true, force: true }); // 清历史暂存=模拟全新 siteKey
  await runServiceContainer(SITE, 'svc-regress:v2', PORT, 3000, '');
  await sleep(800);
  check('全新部署容器运行', (await exec(CNAME, 'echo running')) === 'running');
  check('镜像数据保留', (await exec(CNAME, 'cat /app/data.json')).includes('v2-镜像内置旧数据'));

  console.log('== 场景C：部署失败（镜像缺失）后重试——沿用最近暂存，不回落旧卷快照 ==');
  await docker(['exec', CNAME, 'sh', '-c', `echo '{"v":2,"live":"失败前最后写入的数据"}' > /app/data.json`]);
  let failedAsExpected = false;
  try { await runServiceContainer(SITE, 'svc-regress:not-exist', PORT, 3000, ''); }
  catch (e) { failedAsExpected = true; console.log('  第一次部署失败（预期内）:', e.message.slice(0, 80)); }
  check('坏镜像部署如预期抛错（此时旧容器已删、暂存为最新数据）', failedAsExpected);
  await runServiceContainer(SITE, 'svc-regress:v2', PORT, 3000, '');
  await sleep(800);
  check('重试后容器运行', (await exec(CNAME, 'echo running')) === 'running');
  check('重试后数据 = 失败前的最新暂存（而非卷里的旧快照）', (await exec(CNAME, 'cat /app/data.json')).includes('失败前最后写入的数据'));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await docker(['rm', '-f', CNAME]).catch(() => {});
  await docker(['volume', 'rm', `skillharbor-svc-${SITE}-data`]).catch(() => {});
  await docker(['rmi', 'svc-regress:v1', 'svc-regress:v2']).catch(() => {});
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
