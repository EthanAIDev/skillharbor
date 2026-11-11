/* Real HTTP regression: portal upload -> inspect -> submit -> approval -> gateway.
 * Usage: node scripts/test-skill-integration.cjs --gateway <gateway-checkout> --python <venv-python>
 * Requires the gateway's Python dependencies. Both servers use fresh temporary data,
 * random loopback ports and synthetic users; existing services/data are never used.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { makeZip } = require('./lib-zip.cjs');

const args = process.argv.slice(2);
const arg = key => args[args.indexOf(key) + 1];
const gatewayRepo = path.resolve(args.includes('--gateway') ? arg('--gateway') : process.env.GATEWAY_REPO || '../skill-gateway');
const python = args.includes('--python') ? arg('--python') : process.env.GATEWAY_PYTHON || (process.platform === 'win32' ? path.join(gatewayRepo, '.venv/Scripts/python.exe') : path.join(gatewayRepo, '.venv/bin/python'));
const portalRepo = path.resolve(__dirname, '..');
const password = 'local-agent-test-only';
const token = 'local-agent-test-only';
const isolatedUpstream = 'http://127.0.0.1:1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const zip = files => makeZip(Object.entries(files).map(([name, content]) => [name, Buffer.from(content)]));
const skill = (name, body = 'Synthetic integration fixture.') => `---\nname: ${name}\ndescription: Local integration fixture\n---\n# Instructions\n${body}\n`;
const manifestZip = (id, version, body) => zip({
  'agent.yaml': JSON.stringify({ schemaVersion: 1, id, kind: 'agent', version, entry: 'SKILL.md', components: [], dependencies: [], steps: [] }),
  'SKILL.md': skill(`display-for-${id}`, body),
});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fileSnapshot(directory) {
  const result = {};
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else result[name] = sha256(fs.readFileSync(path.join(directory, name)));
    }
  };
  if (fs.existsSync(directory)) visit('');
  return result;
}
function gbkZip(files) {
  // Python supplies independent GBK encoding; raw Buffer names deliberately leave EFS unset.
  const encoded = spawnSync(python, ['-c',
    'import json,sys\nprint(json.dumps([name.encode("gbk").hex() for name in json.loads(sys.argv[1])]))',
    JSON.stringify(Object.keys(files))],
  { windowsHide: true, env: { ...cleanEnv(), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.stderr);
  const names = JSON.parse(encoded.stdout);
  const bytes = makeZip(Object.values(files).map((data, index) => [Buffer.from(names[index], 'hex'), Buffer.from(data)]));
  assert.equal(bytes.readUInt16LE(6) & 0x800, 0, 'fixture must not set the UTF-8 filename flag');
  return bytes;
}

function agent(version = '2.4.0', body = version, required = false) {
  return zip({
    'bundle/agent.yaml': `schemaVersion: 1\nid: integration-agent\nkind: agent\nversion: ${version}\nentry: main/SKILL.md\ncomponents:\n  - id: calculator\n    kind: skill\n    path: internal-skills/calc.md\n    visibility: internal\n  - id: calculator-script\n    kind: script\n    path: scripts/calc.py\n    visibility: internal\ndependencies:${required ? '\n  - id: missing\n    source: registry\n    slug: absent-local-dependency\n    required: true' : ' []'}\nsteps:\n  - id: calculate\n    targets: [component:calculator, component:calculator-script]\n`,
    'bundle/main/SKILL.md': skill('integration-agent', body),
    'bundle/internal-skills/calc.md': skill('internal-calculator', `component ${body}`),
    'bundle/scripts/calc.py': `print(${JSON.stringify(`script ${body}`)})\n`,
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function cleanEnv() {
  // Do not inherit credentials or upstream URLs from a developer/production shell.
  const keep = /^(path|pathext|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|systemdrive)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
}

function launch(command, argv, cwd, env) {
  const child = spawn(command, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = data => { output = (output + data).slice(-16000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', error => capture(error.message));
  return { child, output: () => output };
}

async function stop(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    server.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
}

async function ready(base, route, server) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`Local server exited: ${server.output()}`);
    try {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(2500) });
      if (response.status === 200 || response.status === 401) return;
    } catch { /* startup */ }
    await wait(150);
  }
  throw new Error(`Local server failed readiness: ${server.output()}`);
}

async function request(base, route, { token: bearer, json, form, method = json || form ? 'POST' : 'GET' } = {}) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(base + route, {
    method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form, signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  return { status: response.status, data };
}

function success(result) {
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  assert.notEqual(result.data.ok, false, JSON.stringify(result.data));
  return result.data;
}

test('isolated portal and gateway publish real packages across HTTP', { timeout: 120000 }, async t => {
  assert.ok(fs.existsSync(path.join(gatewayRepo, 'skill_gateway/api.py')), 'Pass --gateway pointing to the gateway checkout.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-skill-integration-'));
  const portalData = path.join(temp, 'portal');
  const gatewayData = path.join(temp, 'gateway');
  fs.mkdirSync(portalData); fs.mkdirSync(gatewayData);
  const users = ['admin', 'uploader', 'other'].map(username => {
    const salt = crypto.randomBytes(8).toString('hex');
    return { username, name: `Fixture ${username}`, role: username === 'admin' ? 'admin' : 'user', dept: 'Fixture', deptShort: 'Fixture', salt, hash: crypto.scryptSync(password, salt, 32).toString('hex'), ep: 1, disabled: false };
  });
  fs.writeFileSync(path.join(portalData, 'users.json'), JSON.stringify(users));
  const tokensPath = path.join(gatewayData, 'tokens.json');
  fs.writeFileSync(tokensPath, '{}');
  const gatewayPort = await freePort();
  let portalPort = await freePort();
  while (portalPort === gatewayPort) portalPort = await freePort();
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`, portalBase = `http://127.0.0.1:${portalPort}`;
  let gateway, portal;
  t.after(async () => {
    await Promise.all([stop(portal), stop(gateway)]);
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
    assert.ok(relative.startsWith('zeb-skill-integration-') && !relative.includes(path.sep) && !relative.startsWith('..'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  try {
    gateway = launch(python, ['-m', 'uvicorn', 'skill_gateway.api:app', '--host', '127.0.0.1', '--port', String(gatewayPort)], gatewayRepo, {
      ...cleanEnv(), PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', GATEWAY_DATA_DIR: gatewayData, GATEWAY_DB: path.join(gatewayData, 'gateway.db'), GATEWAY_STATIC_TOKENS: tokensPath,
      GATEWAY_ADMIN_TOKEN: token, GATEWAY_AUTH_MODE: 'static', GATEWAY_WEB_UI: 'off', GATEWAY_API_HOST: '127.0.0.1', GATEWAY_MCP_HOST: '127.0.0.1', GATEWAY_MCP_PORT: '1',
      GATEWAY_ONEAPI_BASE_URL: isolatedUpstream, GATEWAY_SkillHarbor_PORTAL_BASE: isolatedUpstream, GATEWAY_KB_BASE_URL: isolatedUpstream, GATEWAY_EMBED_BASE_URL: isolatedUpstream,
      SkillHarbor_SYNC_URL: `${isolatedUpstream}/api/ip-name-map`, ARCHIVE_BASE_URL: isolatedUpstream,
    });
    await ready(gatewayBase, '/api/health', gateway);
    portal = launch(process.execPath, ['server.cjs', String(portalPort)], portalRepo, {
      ...cleanEnv(), DATA_DIR: portalData, BIND_HOST: '127.0.0.1', SERVICE_DOCKER: 'mock', DISABLE_ALERT_POLL: '1', PORTAL_URL: portalBase,
      SKILL_GATEWAY_BASE: gatewayBase, SKILL_GATEWAY_TOKEN: token, MXSDOC_BASE_URL: isolatedUpstream, ONE_API_BASE: isolatedUpstream,
      FRPC_ADMIN_BASE: isolatedUpstream, MCP_SERVER_URL: `${isolatedUpstream}/mcp`,
    });
    await ready(portalBase, '/api/auth/me', portal);
    const login = async username => success(await request(portalBase, '/api/auth/login', { json: { username, password } })).token;
    const ownerToken = await login('uploader'), adminToken = await login('admin'), otherToken = await login('other');
    const gw = async route => success(await request(gatewayBase, route, { token }));
    const parse = async (bytes, filename = 'fixture.zip', expectSuccess = true, extra = {}) => {
      const form = new FormData(); form.append('file', new Blob([bytes]), filename); form.append('kind', 'auto');
      for (const [key, value] of Object.entries(extra)) form.append(key, value);
      const result = await request(portalBase, '/api/uploads/parse', { token: ownerToken, form });
      return expectSuccess ? success(result) : result.data;
    };
    const submit = (parsed, name, extra = {}) => request(portalBase, '/api/uploads/submit', { token: ownerToken, json: { id: parsed.id, name, desc: 'Synthetic local-only regression', category: 'Fixture', tags: ['测试'], departments: ['全部'], ...extra } });
    const approve = parsed => request(portalBase, `/api/admin/uploads/${parsed.id}/approve`, { token: adminToken, json: {} });
    const mine = async parsed => success(await request(portalBase, '/api/uploads/mine', { token: ownerToken })).rows.find(row => row.id === parsed.id);
    const prepare = (parsed, json = {}, bearer = ownerToken) => request(portalBase, `/api/uploads/${parsed.id}/prepare`, { token: bearer, json });
    const draftDir = parsed => path.join(portalData, 'tmp', parsed.id);
    const registrySnapshot = () => fileSnapshot(path.join(gatewayData, 'skills'));
    const state = parsed => ({ files: fileSnapshot(draftDir(parsed)), uploads: fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), registry: registrySnapshot() });
    const preview = async (parsed, options = {}) => {
      const before = state(parsed);
      const assistance = success(await prepare(parsed, options)).assistance;
      assert.deepEqual(state(parsed), before, 'preview must not change package files, reports, records or registry');
      return assistance;
    };
    const apply = async (parsed, assistance, extra = {}) => success(await prepare(parsed, { manifest: assistance.manifest, revision: assistance.revision, apply: true, ...extra }));
    const publish = async (parsed, name, extra) => {
      assert.notEqual(parsed.report.verdict, 'fail', JSON.stringify(parsed.report));
      success(await submit(parsed, name, extra));
      const approval = success(await approve(parsed));
      const record = await mine(parsed);
      assert.equal(record.status, 'online', JSON.stringify(approval));
      assert.ok(record.publishSlug, `Approval did not publish: ${JSON.stringify(approval)}`);
      return record;
    };

    await t.test('administrator inspection proxy preserves its contract and rejects oversized declarations before buffering', async () => {
      const form = new FormData(); form.append('file', new Blob([agent()]), 'fixture.zip');
      const inspected = success(await request(portalBase, '/api/skill-gateway/api/skills/inspect', { token: adminToken, form }));
      assert.equal(inspected.structure.kind, 'agent');
      assert.equal(inspected.structure.components.length, 2);
      const status = await new Promise((resolve, reject) => {
        const req = http.request(portalBase + '/api/skill-gateway/api/skills/inspect', {
          method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Length': 156 * 1024 * 1024, 'Content-Type': 'multipart/form-data; boundary=oversize' },
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.setTimeout(5000, () => req.destroy(new Error('oversized declaration should fail before body buffering')));
        req.on('error', reject); req.end();
      });
      assert.equal(status, 413);
      assert.deepEqual(await gw('/api/skills'), []);
    });

    await t.test('manifest preview is read-only and publication preserves sibling components', async () => {
      const parsed = await parse(agent());
      assert.equal(parsed.kind, 'skill');
      assert.equal(parsed.report.packageRoot, 'bundle');
      assert.equal(parsed.report.packageEntry, 'main/SKILL.md');
      assert.deepEqual(await gw('/api/skills'), []);
      const record = await publish(parsed, 'Integration agent', { updateVersion: '9.9.9' });
      assert.equal(record.publishSlug, 'integration-agent');
      const detail = await gw('/api/skills/integration-agent');
      assert.equal(detail.current_version, 'v2.4.0', 'manifest version is authoritative');
      assert.deepEqual(await gw('/api/skills/integration-agent/structure?version=v2.4.0'), parsed.report.structure);
      assert.equal((await gw('/api/skills/integration-agent/content?version=v2.4.0')).content, skill('integration-agent', '2.4.0'));
      assert.equal((await gw('/api/skills/integration-agent/components/calculator?version=v2.4.0')).content, skill('internal-calculator', 'component 2.4.0'));
      assert.equal((await gw('/api/skills/integration-agent/components/calculator-script?version=v2.4.0')).content, 'print("script 2.4.0")\n');
      assert.equal((await gw('/api/skills')).length, 1, 'internal components must not be global skills');
    });

    await t.test('manifest updates retain old component versions and exact graph preview', async () => {
      const parsed = await parse(agent('2.4.1'));
      await publish(parsed, 'Ignored renamed display', { updateOf: 'skill:integration-agent', updateNote: 'Fixture update', updateVersion: '8.8.8' });
      assert.equal((await gw('/api/skills/integration-agent')).current_version, 'v2.4.1');
      assert.deepEqual(await gw('/api/skills/integration-agent/structure?version=v2.4.1'), parsed.report.structure);
      assert.match((await gw('/api/skills/integration-agent/components/calculator?version=v2.4.0')).content, /component 2\.4\.0/);
      assert.match((await gw('/api/skills/integration-agent/components/calculator?version=v2.4.1')).content, /component 2\.4\.1/);
    });

    await t.test('manifest version conflicts cannot silently auto-increment or replace bytes', async () => {
      const before = await gw('/api/skills/integration-agent');
      const parsed = await parse(agent('2.4.1', 'replacement that must not publish'));
      success(await submit(parsed, 'Ignored display', { updateOf: 'skill:integration-agent', updateNote: 'Conflict fixture' }));
      const approval = await approve(parsed);
      assert.match(JSON.stringify(approval.data), /version already exists/i);
      assert.ok(!(await mine(parsed)).publishSlug, 'failed publication must not claim a published slug');
      const after = await gw('/api/skills/integration-agent');
      assert.equal(after.current_version, before.current_version);
      assert.deepEqual(after.versions, before.versions);
      assert.doesNotMatch((await gw('/api/skills/integration-agent/content')).content, /replacement/);
    });

    await t.test('legacy single Markdown publishes and a renamed bound update keeps its slug', async () => {
      const original = await parse(skill('legacy-original'), 'original.md');
      assert.equal((await publish(original, 'Legacy fixture')).publishSlug, 'legacy-original');
      const changed = await parse(skill('renamed-frontmatter', 'changed body'), 'changed.md');
      await publish(changed, 'Renamed display', { updateOf: 'skill:legacy-original', updateNote: 'Rename frontmatter' });
      const detail = await gw('/api/skills/legacy-original');
      assert.equal(detail.current_version, 'v1.0.1');
      assert.match((await gw('/api/skills/legacy-original/content')).content, /name: renamed-frontmatter/);
      assert.ok(!(await gw('/api/skills')).some(row => row.slug === 'renamed-frontmatter'));
    });

    await t.test('a v-prefixed existing version increments its own major and minor', async () => {
      // Seed an already-published historical version in this empty gateway only.
      const form = new FormData();
      form.append('file', new Blob([zip({ 'SKILL.md': skill('legacy-high-version') })]), 'historical.zip');
      form.append('version', 'v3.4.9'); form.append('owner', 'Fixture uploader');
      success(await request(gatewayBase, '/api/skills/upload', { token, form }));
      const parsed = await parse(skill('high-version-renamed'), 'high.md');
      await publish(parsed, 'Historical update', { updateOf: 'skill:legacy-high-version', updateNote: 'Advance patch' });
      assert.equal((await gw('/api/skills/legacy-high-version')).current_version, 'v3.4.10');
    });

    await t.test('ambiguous roots and required missing dependencies block submission', async () => {
      const before = (await gw('/api/skills')).map(row => row.slug).sort();
      const ambiguous = await parse(zip({ 'a/SKILL.md': skill('first'), 'b/SKILL.md': skill('second') }), 'ambiguous.zip', false);
      assert.equal(ambiguous.ok, true);
      assert.ok(ambiguous.id, 'safe ambiguous roots must create a repairable draft');
      assert.equal(ambiguous.report.verdict, 'fail');
      assert.equal(ambiguous.report.assistance.needsSelection, true);
      assert.deepEqual(ambiguous.report.assistance.candidates.map(item => item.path).sort(), ['a/SKILL.md', 'b/SKILL.md']);
      assert.equal((await submit(ambiguous, 'Ambiguous fixture')).data.ok, false);
      assert.equal((await mine(ambiguous)).status, 'draft');
      const missing = await parse(agent('5.0.0', 'missing dependency', true));
      assert.equal(missing.report.verdict, 'fail');
      assert.ok(missing.report.rules.some(rule => rule.level === 'error'));
      assert.equal((await submit(missing, 'Missing dependency fixture')).data.ok, false);
      assert.deepEqual((await gw('/api/skills')).map(row => row.slug).sort(), before);
    });

    await t.test('long manifest versions are published without truncation', async () => {
      const version = '2.4.0-preview.20261101.123456';
      const parsed = await parse(agent(version));
      await publish(parsed, 'Version fixture', { updateOf: 'skill:integration-agent', updateNote: 'Long prerelease' });
      assert.equal((await gw('/api/skills/integration-agent')).current_version, `v${version}`);
    });

    await t.test('manifest identity mismatching the selected update target is rejected on submit', async () => {
      const parsed = await parse(agent('6.0.0'));
      const result = await submit(parsed, 'Mismatch fixture', { updateOf: 'skill:legacy-original', updateNote: 'Wrong target' });
      assert.equal(result.data.ok, false, 'must reject before placing an incompatible package in the review queue');
      assert.equal((await mine(parsed)).status, 'draft');
    });

    await t.test('UTF-8 BOM Markdown accepted by gateway inspection also passes portal parsing', async () => {
      const parsed = await parse(`\uFEFF${skill('bom-legacy')}`, 'bom.md');
      assert.notEqual(parsed.report.verdict, 'fail', JSON.stringify(parsed.report));
      const record = await publish(parsed, 'BOM fixture');
      assert.equal(record.publishSlug, 'bom-legacy');
    });

    await t.test('unflagged GBK Chinese ZIP paths publish with matching preview and unchanged file bytes', async () => {
      const files = [
        { name: '中文包/SKILL.md', data: Buffer.from(skill('gbk-fixture', '中文入口，保留包内组件和资产。')) },
        { name: '中文包/internal-skills/计算.md', data: Buffer.from(skill('gbk-calculator', '中文组件：计算 1 + 1。')) },
        { name: '中文包/scripts/执行.py', data: Buffer.from('print("中文脚本")\n') },
        { name: '中文包/assets/模板.bin', data: Buffer.from([0, 255, 128, 13, 10, 42, 195, 169]) },
      ];
      // Encode filenames independently; Buffer names make the test ZIP writer leave EFS unset.
      const encoded = spawnSync(python, ['-c',
        'import json,sys\nprint(json.dumps([name.encode("gbk").hex() for name in json.loads(sys.argv[1])]))',
        JSON.stringify(files.map(file => file.name))],
      { windowsHide: true, env: { ...cleanEnv(), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
      assert.equal(encoded.status, 0, encoded.stderr);
      const names = JSON.parse(encoded.stdout);
      const bytes = makeZip(files.map((file, index) => [Buffer.from(names[index], 'hex'), file.data]));
      assert.equal(bytes.readUInt16LE(6) & 0x800, 0, 'fixture must not set the UTF-8 filename flag');
      const parsed = await parse(bytes, 'legacy-gbk.zip');
      assert.equal(parsed.report.packageRoot, '中文包');
      assert.equal(parsed.report.packageEntry, 'SKILL.md');
      const record = await publish(parsed, 'GBK fixture');
      assert.equal(record.publishSlug, 'gbk-fixture');
      const graph = await gw('/api/skills/gbk-fixture/structure?version=v1.0.0');
      assert.deepEqual(graph, parsed.report.structure);
      for (const file of files) {
        const relative = file.name.slice('中文包/'.length);
        const published = fs.readFileSync(path.join(gatewayData, 'skills/gbk-fixture/versions/v1.0.0', relative));
        assert.deepEqual(published, file.data, `changed bytes or path: ${relative}`);
        if (relative.startsWith('internal-skills/') || relative.startsWith('scripts/')) {
          const component = graph.components.find(item => item.path === relative);
          assert.ok(component, `missing component: ${relative}`);
          const response = await gw(`/api/skills/gbk-fixture/components/${encodeURIComponent(component.id)}?version=v1.0.0`);
          assert.equal(response.content, file.data.toString('utf8'));
        }
      }
    });

    await t.test('nested legacy entries retain sibling scripts and assets in blocked repairable drafts', async () => {
      const skillsBefore = (await gw('/api/skills')).map(row => row.slug).sort();
      const uploadsBefore = success(await request(portalBase, '/api/uploads/mine', { token: ownerToken })).rows.map(row => row.id).sort();
      const created = [];
      for (const wrapper of ['', 'bundle/']) {
        const bytes = zip({
          [`${wrapper}main/SKILL.md`]: skill('must-not-drop-assets', 'Use ../scripts/render.py and ../assets/template.txt'),
          [`${wrapper}scripts/render.py`]: 'print("keep this sibling")\n',
          [`${wrapper}assets/template.txt`]: 'This sibling asset must never be silently discarded.',
        });
        const parsed = await parse(bytes, 'nested-with-siblings.zip', false);
        assert.equal(parsed.ok, true);
        assert.ok(parsed.id);
        created.push(parsed.id);
        assert.equal(parsed.report.verdict, 'fail');
        assert.equal(parsed.report.assistance.root, wrapper.replace(/\/$/, ''));
        assert.equal(parsed.report.assistance.manifest.entry, 'main/SKILL.md');
        assert.equal(Object.keys(fileSnapshot(draftDir(parsed))).length, 3, 'every original sibling must be retained');
        assert.equal((await submit(parsed, 'Unconfirmed outer root')).data.ok, false);
        assert.equal((await mine(parsed)).status, 'draft');
      }
      assert.deepEqual((await gw('/api/skills')).map(row => row.slug).sort(), skillsBefore);
      assert.deepEqual(success(await request(portalBase, '/api/uploads/mine', { token: ownerToken })).rows.map(row => row.id).sort(), [...uploadsBefore, ...created].sort());
    });

    await t.test('unsafe archives never create repairable drafts or registry writes', async () => {
      const before = { uploads: fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), files: fileSnapshot(path.join(portalData, 'tmp')), registry: registrySnapshot() };
      const corrupt = zip({ 'SKILL.md': skill('bad-crc') });
      corrupt[30 + Buffer.byteLength('SKILL.md')] ^= 1;
      const archives = [
        zip({ 'SKILL.md': skill('unsafe-traversal'), '../escape.txt': 'must not write' }),
        makeZip([['SKILL.md', Buffer.from(skill('duplicate'))], ['skill.md', Buffer.from(skill('duplicate-case'))]]),
        corrupt,
      ];
      for (const archive of archives) {
        const parsed = await parse(archive, 'unsafe.zip', false, { resourceType: 'agent' });
        assert.equal(parsed.ok, false, JSON.stringify(parsed));
        assert.ok(!parsed.id, 'unsafe input must never be retained as a repairable draft');
      }
      assert.deepEqual({ uploads: fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), files: fileSnapshot(path.join(portalData, 'tmp')), registry: registrySnapshot() }, before);
    });

    await t.test('ambiguous entry selection previews without writes then publishes every sibling byte', async () => {
      const files = {
        'bundle/main/SKILL.md': skill('repaired-agent', 'Use the selected entry and keep all siblings.'),
        'bundle/second/SKILL.md': skill('sibling-component', 'A sibling entry must not disappear.'),
        'bundle/scripts/render.py': 'print("preserve script")\r\n',
        'bundle/assets/数据.bin': Buffer.from([0, 255, 128, 13, 10, 0, 17, 42]),
        'bundle/README.txt': 'Every original byte matters.\r\n',
      };
      const parsed = await parse(zip(files), 'repair-selection.zip');
      assert.equal(parsed.report.verdict, 'fail');
      assert.equal(parsed.report.assistance.revision, 0);
      const initial = await preview(parsed);
      assert.equal(initial.needsSelection, true);
      assert.equal(initial.manifest, null);
      const selected = await preview(parsed, { entry: 'main/SKILL.md' });
      assert.equal(selected.manifest.id, 'repaired-agent');
      assert.equal(selected.manifest.kind, 'agent');
      assert.equal(selected.root, 'bundle');
      assert.equal(selected.manifestPath, 'bundle/agent.yaml');
      assert.deepEqual(selected.errors, []);
      const manifest = { ...selected.manifest, components: [
        { id: 'sibling', kind: 'skill', path: 'second/SKILL.md', visibility: 'internal' },
        { id: 'render', kind: 'script', path: 'scripts/render.py', visibility: 'internal' },
      ], steps: [{ id: 'render-step', task: 'Render using the sibling', targets: ['component:sibling', 'component:render'] }] };
      const confirmed = await preview(parsed, { entry: 'main/SKILL.md', manifest });
      assert.equal((await submit(parsed, 'Unapplied repair')).data.ok, false, 'preview cannot clear the submission guard');
      const registryBefore = registrySnapshot();
      const applied = await apply(parsed, confirmed);
      assert.equal(applied.assistance.revision, 1);
      assert.notEqual(applied.report.verdict, 'fail');
      assert.deepEqual(registrySnapshot(), registryBefore, 'applying a draft must not publish');
      assert.deepEqual((await mine(parsed)).report, applied.report);
      const expected = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(Buffer.from(bytes))]));
      const actual = fileSnapshot(draftDir(parsed));
      assert.deepEqual(Object.keys(actual).sort(), [...Object.keys(expected), 'bundle/agent.yaml'].sort());
      for (const [name, digest] of Object.entries(expected)) assert.equal(actual[name], digest, name);
      assert.equal(fs.readFileSync(path.join(draftDir(parsed), 'bundle/agent.yaml'), 'utf8'), confirmed.manifestYaml);
      const afterApply = state(parsed);
      assert.equal((await prepare(parsed, { manifest, apply: true, revision: 0 })).status, 409);
      assert.deepEqual(state(parsed), afterApply, 'repeated apply must fail without another file/report mutation');
      const record = await publish({ ...parsed, report: applied.report }, 'Repaired selection agent');
      assert.equal(record.publishSlug, 'repaired-agent');
      assert.deepEqual(await gw('/api/skills/repaired-agent/structure?version=v1.0.0'), applied.report.structure);
      const published = fileSnapshot(path.join(gatewayData, 'skills/repaired-agent/versions/v1.0.0'));
      for (const [name, digest] of Object.entries(expected)) assert.equal(published[name.slice('bundle/'.length)], digest, name);
      assert.equal((await gw('/api/skills/repaired-agent/components/sibling?version=v1.0.0')).content, files['bundle/second/SKILL.md']);
      assert.ok(!(await gw('/api/skills')).some(row => row.slug === 'sibling-component'));
    });

    await t.test('unselected entries, invalid manifests, foreign users and stale revisions cannot apply', async () => {
      const parsed = await parse(zip({ 'a/SKILL.md': skill('guarded-agent'), 'b/SKILL.md': skill('guarded-sibling') }));
      const selected = await preview(parsed, { entry: 'a/SKILL.md' });
      const before = state(parsed);
      const invalid = [
        { apply: true, revision: 0 },
        { apply: true, revision: 0, manifest: {} },
        { apply: true, revision: 0, manifest: { ...selected.manifest, entry: '' } },
        { apply: true, revision: 0, manifest: { ...selected.manifest, entry: '../escape.md' } },
        { apply: true, revision: 0, manifest: { ...selected.manifest, steps: [{ id: 'invalid', targets: ['component:not-declared'] }] } },
        { apply: true, revision: 0, manifest: { ...selected.manifest, components: [{ id: 'absent', kind: 'script', path: 'missing.py' }] } },
        { apply: true, revision: 0, entry: 'b/SKILL.md', manifest: selected.manifest },
        { apply: true, manifest: selected.manifest },
        { apply: true, revision: -1, manifest: selected.manifest },
      ];
      for (const json of invalid) {
        const result = await prepare(parsed, json);
        assert.equal(result.data.ok, false, JSON.stringify({ json, result }));
        assert.deepEqual(state(parsed), before, 'invalid apply must not change files, records or registry');
      }
      for (const bearer of [otherToken, adminToken]) {
        assert.equal((await prepare(parsed, {}, bearer)).status, 404);
        assert.equal((await prepare(parsed, { apply: true, revision: 0, manifest: selected.manifest }, bearer)).status, 404);
        assert.deepEqual(state(parsed), before, 'even administrators cannot edit another uploader draft');
      }
      const applied = await apply(parsed, selected);
      success(await submit({ ...parsed, report: applied.report }, 'Guarded pending agent'));
      const pending = state(parsed);
      assert.equal((await prepare(parsed, { apply: true, revision: 1, manifest: selected.manifest })).status, 409);
      assert.deepEqual(state(parsed), pending, 'submitted packages cannot be edited');
    });

    await t.test('missing required dependencies stay blocked until an exact registry slug is selected and reapplied', async () => {
      const parsed = await parse(agent('1.0.0', 'dependency repair', true));
      const original = await preview(parsed);
      const manifest = { ...original.manifest, id: 'dependency-repaired-agent' };
      const missing = await preview(parsed, { manifest });
      assert.ok(missing.errors.length > 0);
      assert.equal(missing.inspection.structure.dependencies[0].status, 'missing');
      const saved = await apply(parsed, missing);
      assert.equal(saved.assistance.revision, 1);
      assert.equal(saved.report.verdict, 'fail', 'missing dependencies may be saved, never submitted');
      assert.equal((await submit(parsed, 'Dependency repair fixture')).data.ok, false);
      const dependency = await parse(skill('synthetic-exact-dependency'), 'dependency.md');
      await publish(dependency, 'Synthetic exact dependency');
      const unresolved = await preview(parsed);
      assert.ok(unresolved.errors.length > 0, 'publishing a different slug must not guess the intended dependency');
      const repairedManifest = { ...unresolved.manifest, dependencies: [{ id: 'missing', source: 'registry', slug: 'synthetic-exact-dependency', required: true }] };
      const ready = await preview(parsed, { manifest: repairedManifest });
      assert.deepEqual(ready.errors, []);
      assert.equal(ready.inspection.structure.dependencies[0].status, 'ready');
      assert.equal((await submit(parsed, 'Dependency repair fixture')).data.ok, false, 'successful preview alone does not replace the failed report');
      const applied = await apply(parsed, ready);
      assert.equal(applied.assistance.revision, 2);
      const record = await publish({ ...parsed, report: applied.report }, 'Dependency repaired agent');
      assert.equal(record.publishSlug, 'dependency-repaired-agent');
      assert.deepEqual(await gw('/api/skills/dependency-repaired-agent/structure'), applied.report.structure);
    });

    await t.test('GBK repair preserves the existing manifest filename case and every other binary digest', async () => {
      const files = {
        '中文包/AGENT.YAML': 'invalid: [ YAML\n',
        '中文包/主入口/SKILL.md': skill('gbk-repaired-agent', '中文主入口正文。'),
        '中文包/第二入口/SKILL.md': skill('gbk-repair-sibling', '中文兄弟正文。'),
        '中文包/scripts/执行.py': 'print("保留脚本")\r\n',
        '中文包/assets/模板.bin': Buffer.from([0, 128, 255, 13, 10, 129, 0]),
      };
      const parsed = await parse(gbkZip(files), 'repair-gbk.zip');
      assert.equal(parsed.report.verdict, 'fail');
      assert.equal(parsed.report.assistance.manifestPath, '中文包/AGENT.YAML');
      const selected = await preview(parsed, { entry: '主入口/SKILL.md' });
      assert.deepEqual(selected.errors, []);
      assert.equal(selected.manifestPath, '中文包/AGENT.YAML');
      const applied = await apply(parsed, selected);
      const tree = fileSnapshot(draftDir(parsed));
      assert.deepEqual(Object.keys(tree).sort(), Object.keys(files).sort(), 'application replaces the original-case manifest, without adding another');
      assert.equal(tree['中文包/AGENT.YAML'], sha256(Buffer.from(applied.assistance.manifestYaml)));
      for (const [name, bytes] of Object.entries(files)) {
        if (name.endsWith('/AGENT.YAML')) continue;
        assert.equal(tree[name], sha256(Buffer.from(bytes)), name);
      }
      const record = await publish({ ...parsed, report: applied.report }, 'GBK repaired agent');
      assert.equal(record.publishSlug, 'gbk-repaired-agent');
      const published = fileSnapshot(path.join(gatewayData, 'skills/gbk-repaired-agent/versions/v1.0.0'));
      for (const [name, digest] of Object.entries(tree)) assert.equal(published[name.slice('中文包/'.length)], digest, name);
      assert.deepEqual(await gw('/api/skills/gbk-repaired-agent/structure'), applied.report.structure);
    });

    await t.test('bound repair checks update ownership and stable identity before replacing any file', async () => {
      const parsed = await parse(skill('new-display-for-bound-repair'), 'bound-repair.md');
      const ownBinding = { updateOf: 'skill:legacy-original' };
      const bound = await preview(parsed, ownBinding);
      assert.equal(bound.manifest.id, 'legacy-original');
      const manifest = { ...bound.manifest, version: '1.0.2' };
      const before = state(parsed);
      const foreign = new FormData();
      foreign.append('file', new Blob([zip({ 'SKILL.md': skill('foreign-owned') })]), 'foreign.zip');
      foreign.append('owner', 'Fixture other');
      foreign.append('version', 'v1.0.0');
      success(await request(gatewayBase, '/api/skills/upload', { token, form: foreign }));
      const withForeign = state(parsed);
      for (const updateOf of ['skill:foreign-owned', 'skill:does-not-exist', 'tool:wrong-channel']) {
        const result = await prepare(parsed, { updateOf, manifest, revision: 0, apply: true });
        assert.equal(result.data.ok, false, JSON.stringify(result));
        assert.deepEqual(state(parsed), withForeign);
      }
      const mismatch = await preview(parsed, { ...ownBinding, manifest: { ...manifest, id: 'changed-identity' } });
      assert.ok(mismatch.errors.length > 0);
      assert.equal((await prepare(parsed, { ...ownBinding, manifest: mismatch.manifest, revision: 0, apply: true })).data.ok, false);
      assert.deepEqual(state(parsed), withForeign);
      const ready = await preview(parsed, { ...ownBinding, manifest });
      assert.deepEqual(ready.errors, []);
      const applied = await apply(parsed, ready, ownBinding);
      assert.equal((await mine(parsed)).updateOf, 'skill:legacy-original');
      const confirmed = state(parsed);
      for (const updateOf of ['', 'skill:integration-agent']) {
        const result = await submit(parsed, 'Wrong identity after repair', { updateOf, updateNote: 'Wrong binding' });
        assert.equal(result.status, 409);
        assert.equal(result.data.ok, false);
        assert.deepEqual(state(parsed), confirmed, 'submit cannot cancel or change an applied update binding');
      }
      const record = await publish({ ...parsed, report: applied.report }, 'Bound repaired update', { updateNote: 'Omitted binding inherits confirmed identity' });
      assert.equal(record.updateOf, 'skill:legacy-original');
      assert.equal((await gw('/api/skills/legacy-original')).current_version, 'v1.0.2');
      assert.ok(!(await gw('/api/skills')).some(row => row.slug === 'new-display-for-bound-repair'));
      assert.equal(fileSnapshot(draftDir(parsed))['SKILL.md'], before.files['SKILL.md']);
    });

    await t.test('switching a confirmed update to a new resource requires preview and apply of the new identity', async () => {
      const original = await gw('/api/skills/legacy-original');
      const originalFiles = fileSnapshot(path.join(gatewayData, 'skills/legacy-original'));
      const parsed = await parse(skill('unbind-frontmatter'), 'unbind.md');
      const updateOf = 'skill:legacy-original';
      const bound = await preview(parsed, { updateOf });
      bound.manifest.version = '1.0.3';
      const confirmed = await preview(parsed, { updateOf, manifest: bound.manifest });
      await apply(parsed, confirmed, { updateOf });
      assert.equal((await mine(parsed)).updateOf, updateOf);
      const manifest = { ...confirmed.manifest, id: 'explicitly-unbound-agent', version: '1.0.0' };
      const newResource = await preview(parsed, { updateOf: '', manifest });
      assert.deepEqual(newResource.errors, []);
      assert.equal((await mine(parsed)).updateOf, updateOf, 'previewing a new identity must not discard the confirmed update binding');
      const applied = await apply(parsed, newResource, { updateOf: '' });
      assert.equal(applied.assistance.revision, 2);
      assert.ok(!(await mine(parsed)).updateOf, 'successful application explicitly clears the previous binding');
      const record = await publish({ ...parsed, report: applied.report }, 'Explicitly unbound new agent');
      assert.equal(record.publishSlug, 'explicitly-unbound-agent');
      assert.ok(!record.updateOf);
      assert.deepEqual(await gw('/api/skills/legacy-original'), original);
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/legacy-original')), originalFiles, 'unbinding creates a new resource without touching the former target');
    });

    await t.test('new submissions cannot reuse an existing foreign or owned slug without an update binding', async () => {
      for (const [slug, owner] of [['foreign-owned', 'Fixture other'], ['legacy-original', 'Fixture uploader']]) {
        const existing = await gw(`/api/skills/${slug}`);
        assert.equal(existing.owner, owner);
        for (const prepared of [false, true]) {
          const parsed = await parse(manifestZip(slug, '99.0.0', 'This must not append a version to an existing resource.'));
          assert.notEqual(parsed.report.verdict, 'fail');
          if (prepared) {
            const proposed = await preview(parsed);
            const applied = await apply(parsed, proposed);
            assert.notEqual(applied.report.verdict, 'fail');
          }
          const before = state(parsed);
          const submitted = await submit(parsed, `Unique ${slug} ${prepared ? 'fixed' : 'raw'}`);
          assert.equal(submitted.data.ok, false, 'a unique display name cannot bypass stable-slug ownership');
          assert.match(submitted.data.message, /已存在|更新对象|绑定/);
          assert.equal((await mine(parsed)).status, 'draft');
          assert.deepEqual(state(parsed), before, 'rejected unbound submission must not touch records or existing files');
          assert.deepEqual(await gw(`/api/skills/${slug}`), existing);
        }
      }
    });

    await t.test('a slug claimed after submission cannot be overwritten by later approval', async () => {
      const first = await parse(manifestZip('approval-race-agent', '1.0.0', 'Winning approval body'));
      const second = await parse(manifestZip('approval-race-agent', '2.0.0', 'Losing approval must not append'));
      success(await submit(first, 'First pending identity'));
      success(await submit(second, 'Second pending identity'));
      assert.equal((await mine(first)).status, 'pending');
      assert.equal((await mine(second)).status, 'pending');
      success(await approve(first));
      assert.equal((await mine(first)).publishSlug, 'approval-race-agent');
      const before = registrySnapshot();
      const existing = await gw('/api/skills/approval-race-agent');
      const result = await approve(second);
      assert.ok(!(await mine(second)).publishSlug, JSON.stringify(result));
      assert.match(JSON.stringify(result.data), /已存在|更新对象|绑定/);
      assert.deepEqual(registrySnapshot(), before, 'approval must recheck stable identity without appending or replacing versions');
      assert.deepEqual(await gw('/api/skills/approval-race-agent'), existing);
      assert.equal((await gw('/api/skills/approval-race-agent/content')).content, skill('display-for-approval-race-agent', 'Winning approval body'));
    });

    await t.test('concurrent create-only gateway uploads admit exactly one version for a new slug', async () => {
      const versions = ['1.0.0', '2.0.0'];
      const results = await Promise.all(versions.map(async version => {
        const form = new FormData();
        form.append('file', new Blob([manifestZip('atomic-create-agent', version, `Winner version ${version}`)]), 'atomic.zip');
        form.append('version', version); form.append('owner', 'Fixture uploader'); form.append('create_only', 'true');
        return { version, result: await request(gatewayBase, '/api/skills/upload', { token, form }) };
      }));
      const winners = results.filter(({ result }) => result.status >= 200 && result.status < 300);
      assert.equal(winners.length, 1, JSON.stringify(results));
      const loser = results.find(item => item !== winners[0]);
      assert.ok([400, 409].includes(loser.result.status), JSON.stringify(loser));
      assert.match(JSON.stringify(loser.result.data), /already exists.*create_only/i, 'the loser must be refused by the identity guard, not an unrelated failure');
      const winner = winners[0].version;
      const detail = await gw('/api/skills/atomic-create-agent');
      assert.equal(detail.current_version, `v${winner}`);
      assert.deepEqual(fs.readdirSync(path.join(gatewayData, 'skills/atomic-create-agent/versions')), [`v${winner}`]);
      assert.equal((await gw('/api/skills/atomic-create-agent/content')).content, skill('display-for-atomic-create-agent', `Winner version ${winner}`));
    });

    await t.test('rejected skill packages retain files for correction and resubmission', async () => {
      const parsed = await parse(skill('rejected-repair-agent'), 'rejected.md');
      const before = fileSnapshot(draftDir(parsed));
      success(await submit(parsed, 'Rejected repair agent'));
      success(await request(portalBase, `/api/admin/uploads/${parsed.id}/reject`, { token: adminToken, json: { reason: 'Please add a manifest' } }));
      assert.equal((await mine(parsed)).status, 'rejected');
      assert.deepEqual(fileSnapshot(draftDir(parsed)), before, 'rejection must preserve repairable skill source files');
      const prepared = await preview(parsed);
      const applied = await apply(parsed, prepared);
      await publish({ ...parsed, report: applied.report }, 'Rejected repair agent');
    });

    await t.test('schema-invalid manifests require explicit regeneration and retain their stable identity and version', async () => {
      const files = {
        'bundle/agent.yaml': 'schemaVersion: 999\nid: schema-repaired-agent\nkind: agent\nversion: 7.2.1\nentry: main/SKILL.md\ncomponents: []\ndependencies: []\nsteps: []\n',
        'bundle/main/SKILL.md': skill('different-frontmatter-name', 'Keep the original manifest identity and version.'),
        'bundle/assets/original.bin': Buffer.from([255, 0, 128, 2, 4, 7]),
      };
      const parsed = await parse(zip(files), 'schema-repair.zip');
      assert.equal(parsed.report.verdict, 'fail');
      const unchanged = await preview(parsed, { entry: 'main/SKILL.md' });
      assert.ok(unchanged.errors.length > 0, 'selecting the entry alone must not discard an existing schema-invalid manifest');
      assert.equal(unchanged.manifest.schemaVersion, 999);
      const before = state(parsed);
      assert.equal((await prepare(parsed, { manifest: unchanged.manifest, revision: 0, apply: true })).data.ok, false);
      assert.deepEqual(state(parsed), before);
      const regenerated = await preview(parsed, { entry: 'main/SKILL.md', regenerate: true });
      assert.deepEqual(regenerated.errors, []);
      assert.equal(regenerated.manifest.schemaVersion, 1);
      assert.equal(regenerated.manifest.id, 'schema-repaired-agent');
      assert.equal(regenerated.manifest.version, '7.2.1');
      assert.ok(regenerated.warnings.some(message => /手工关系/.test(message)), 'regeneration must disclose that manual relationships need review');
      const applied = await apply(parsed, regenerated);
      const tree = fileSnapshot(draftDir(parsed));
      for (const [name, bytes] of Object.entries(files)) {
        if (!name.endsWith('/agent.yaml')) assert.equal(tree[name], sha256(Buffer.from(bytes)), name);
      }
      await publish({ ...parsed, report: applied.report }, 'Schema repaired agent');
      assert.equal((await gw('/api/skills/schema-repaired-agent')).current_version, 'v7.2.1');
    });

    await t.test('dependency governance proxy is read-only and restricted to administrators', async () => {
      const before = { registry: registrySnapshot(), uploads: fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8') };
      const routes = ['/api/skills/dependency-issues', '/api/skills/synthetic-exact-dependency/dependents'];
      for (const route of routes) {
        for (const bearer of [undefined, ownerToken, otherToken]) {
          const denied = await request(portalBase, '/api/skill-gateway' + route, { token: bearer });
          assert.equal(denied.status, 403);
          assert.equal(denied.data.ok, false);
        }
        const allowed = success(await request(portalBase, '/api/skill-gateway' + route, { token: adminToken }));
        assert.equal(allowed.readOnly, true);
        assert.deepEqual(allowed.errors, []);
        if (route.endsWith('/dependents')) assert.ok(allowed.items.some(item => item.slug === 'dependency-repaired-agent' && item.required === true));
      }
      assert.deepEqual({ registry: registrySnapshot(), uploads: fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8') }, before);
    });

    await t.test('normal web tools still parse, submit and publish and cannot use skill preparation', async () => {
      const before = registrySnapshot();
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>Local tool fixture</title></head><body><h1>Local tool fixture</h1></body></html>';
      const parsed = await parse(html, 'tool.html', true, { resourceType: 'tool' });
      assert.equal(parsed.kind, 'web');
      assert.notEqual(parsed.report.verdict, 'fail');
      const initial = state(parsed);
      assert.equal((await prepare(parsed)).status, 409);
      assert.deepEqual(state(parsed), initial);
      success(await submit(parsed, 'Normal local web tool'));
      success(await approve(parsed));
      const record = await mine(parsed);
      assert.equal(record.status, 'online');
      assert.equal(record.kind, 'web');
      const deployed = new URL(record.deployedUrl, portalBase);
      assert.equal(deployed.origin, portalBase, 'tool content must remain on the isolated temporary portal');
      const served = await fetch(deployed, { signal: AbortSignal.timeout(5000) });
      assert.equal(served.status, 200);
      assert.equal(await served.text(), html);
      assert.deepEqual(registrySnapshot(), before, 'tool publication must not register a skill');
    });

    await t.test('compressed packages above 50MB expanded remain compressed and preserve UTF-8 files', async () => {
      // Generate with Python's independent ZIP implementation, not the portal ZIP writer.
      // The old STORE repack expanded this accepted archive past the gateway's 50MB upload limit.
      const archive = path.join(temp, 'compressed-fixture.zip');
      const block = Buffer.from('Synthetic text fixture 中文 ✓\n');
      const repeats = Math.ceil(51 * 1024 * 1024 / block.length);
      const expectedDigest = crypto.createHash('sha256');
      for (let i = 0; i < repeats; i++) expectedDigest.update(block);
      const generated = spawnSync(python, ['-c',
        'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as z:\n z.writestr("SKILL.md", sys.argv[2])\n z.writestr("assets/中文样本.txt", sys.argv[3].encode("utf-8") * int(sys.argv[4]))',
        archive, skill('compressed-fixture'), block.toString('utf8'), String(repeats)],
      { windowsHide: true, env: { ...cleanEnv(), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
      const bytes = fs.readFileSync(archive);
      assert.ok(bytes.length < 1024 * 1024, 'synthetic incoming archive should be compact');
      const parsed = await parse(bytes, 'compressed-fixture.zip');
      const record = await publish(parsed, 'Compressed fixture');
      assert.equal(record.publishSlug, 'compressed-fixture');
      const published = fs.readFileSync(path.join(gatewayData, 'skills/compressed-fixture/versions/v1.0.0/assets/中文样本.txt'));
      assert.equal(published.length, block.length * repeats);
      assert.equal(crypto.createHash('sha256').update(published).digest('hex'), expectedDigest.digest('hex'));
      assert.equal((await gw('/api/skills/compressed-fixture/content')).content, skill('compressed-fixture'));
    });
  } catch (error) {
    t.diagnostic(`Gateway output:\n${gateway?.output() || '(not started)'}\nPortal output:\n${portal?.output() || '(not started)'}`);
    throw error;
  }
});
