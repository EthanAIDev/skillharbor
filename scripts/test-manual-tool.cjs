/* deploy69 管理后台「手动添加工具」端到端验证 + 「删除」软删除用例
 * 场景：S3 拦截外置数据库包后的正当出路——管理员自行部署后手动登记卡片。
 * 用法（先起隔离服务，与 test-service-channel 相同方式）：
 *   DATA_DIR=<隔离目录> SERVICE_DOCKER=mock PORT=8816 node server.cjs &
 *   DATA_DIR=<同一隔离目录> node scripts/test-manual-tool.cjs http://127.0.0.1:8816 */
const BASE = process.argv[2] || 'http://127.0.0.1:8816';

(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.json());
  const auth = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: auth, body: JSON.stringify(b) }).then((r) => r.json());
  const list = () => fetch(BASE + '/api/tools/extra').then((x) => x.json());
  let pass = 0, fail = 0;
  const assert = (cond, label, extra = '') => {
    console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (cond ? '' : ' ' + extra));
    cond ? pass++ : fail++;
  };

  /* 1. 创建手动工具（service 型，指向管理员自行部署的地址） */
  let r = await post('/api/admin/tools/manual', { name: '合同管理系统', url: 'http://127.0.0.1:18300', type: 'service', desc: '管理员自行部署（负责人：Alice Demo）', tags: ['业务提效'], departments: ['全部'] });
  assert(r.ok && r.id, '手动添加成功', JSON.stringify(r));
  const id = r.id;
  let tools = await list();
  const t = tools.tools.find((x) => x.id === id);
  assert(!!t && t.url === 'http://127.0.0.1:18300' && t.type === 'service' && t.manual === true && t.status === 'online', '首页列表可见且字段正确（url/type/manual/status）', JSON.stringify(t || {}).slice(0, 150));

  /* 2. 入参校验：空 URL / 非 http(s) URL / 重名 */
  r = await post('/api/admin/tools/manual', { name: 'x', url: '' });
  assert(!r.ok, '空 URL 拒绝');
  r = await post('/api/admin/tools/manual', { name: 'x', url: 'ftp://bad' });
  assert(!r.ok && /http/.test(r.message), '非 http(s) URL 拒绝');
  r = await post('/api/admin/tools/manual', { name: '合同管理系统', url: 'http://a' });
  assert(!r.ok && /同名/.test(r.message), '重名拒绝');

  /* 3. 上下架：手动工具无容器生命周期，不应触发端口/镜像登记检查 */
  r = await post('/api/admin/tools/' + id + '/status', { status: 'offline' });
  assert(r.ok, '下架成功（无容器生命周期报错）', JSON.stringify(r));
  tools = await list();
  assert(!tools.tools.some((x) => x.id === id), '下架后首页隐藏');
  r = await post('/api/admin/tools/' + id + '/status', { status: 'online' });
  assert(r.ok, '上架成功（手动工具不查容器登记）', JSON.stringify(r));

  /* 4. 编辑改 URL（手动登记类可改访问地址） */
  r = await post('/api/admin/tools/' + id + '/edit', { url: 'http://127.0.0.1:18301', desc: '改后' });
  assert(r.ok, '编辑改 URL 成功');
  tools = await list();
  assert(tools.tools.find((x) => x.id === id)?.url === 'http://127.0.0.1:18301', '改后 URL 生效');

  /* 5. 删除（软删除）：首页与管理名册隐藏，extraTools.json 记录保留（deleted 标记），可校验文件态 */
  r = await post('/api/admin/tools/' + id + '/delete');
  assert(r.ok, '删除成功', JSON.stringify(r));
  tools = await list();
  assert(!tools.tools.some((x) => x.id === id), '删除后首页隐藏');
  const roster = await fetch(BASE + '/api/admin/tools', { headers: auth }).then((x) => x.json());
  assert(!roster.extra.some((x) => x.id === id), '删除后管理名册隐藏');
  if (process.env.DATA_DIR) {
    const fs = require('fs');
    const arr = JSON.parse(fs.readFileSync(process.env.DATA_DIR + '/extraTools.json', 'utf8'));
    const rec = arr.find((x) => x.id === id);
    assert(!!rec && rec.deleted === true && rec.status === 'offline' && rec.url === 'http://127.0.0.1:18301', 'extraTools.json 记录保留且带 deleted 标记（软删除不物理清除）');
  }
  r = await post('/api/admin/tools/' + id + '/delete');
  assert(!r.ok, '重复删除拒绝');
  r = await post('/api/admin/tools/no-such-tool/delete');
  assert(!r.ok, '删除不存在的工具拒绝');

  /* 6. 内置工具软删除：首页 builtinOffline 隐藏 + 管理端 builtinDeleted 名单；重新「上架」即恢复 */
  r = await post('/api/admin/tools/1/delete');
  assert(r.ok, '内置工具删除成功', JSON.stringify(r));
  tools = await list();
  assert((tools.builtinOffline || []).includes('1'), '删除后首页 builtinOffline 含该内置工具（隐藏）');
  const roster2 = await fetch(BASE + '/api/admin/tools', { headers: auth }).then((x) => x.json());
  assert((roster2.builtinDeleted || []).includes('1') && !(roster2.builtinOffline || []).includes('1'), '管理端 builtinDeleted 含该工具且不计入已下架');
  r = await post('/api/admin/tools/1/status', { status: 'online' });
  assert(r.ok, '内置工具重新上架成功（清除删除标记 = 恢复路径）');
  tools = await list();
  assert(!(tools.builtinOffline || []).includes('1'), '恢复后首页重新可见');

  console.log((fail ? 'MANUAL TOOL: FAILED' : 'MANUAL TOOL: ALL PASS') + `（${pass} 通过，${fail} 失败）`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
