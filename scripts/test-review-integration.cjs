/* Real portal HTTP tests. A controlled loopback registry exposes approval races;
 * --gateway/--python additionally starts the real gateway in isolated data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { makeZip } = require('../server/lib/zip-writer.cjs');
const root = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|systemdrive)$/i.test(key)));
const password = 'review-fixture-only';
const skill = (name, desc = 'Fixture purpose') => `---\nname: ${name}\ndescription: ${desc}\n---\n# Instructions\nReview materials.\n`;
const graph = (version = 'v1.0.2') => ({ schemaVersion: 1, slug: 'bound', version, kind: 'agent', source: 'manifest', entry: 'SKILL.md', components: [{ id: 'check', name: 'Check', kind: 'script', path: 'check.py', status: 'ready' }], dependencies: [], steps: [], warnings: [] });
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function freeBase() { const server = http.createServer(); const base = await listen(server); await new Promise(resolve => server.close(resolve)); return base; }
function launch(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env: { ...cleanEnv(), ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  const capture = bytes => { output = (output + bytes).slice(-10000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture); child.on('error', error => capture(error.message));
  return { child, output: () => output };
}
async function stop(process) { if (!process || process.child.exitCode !== null || process.child.signalCode !== null) return; const done = new Promise(resolve => process.child.once('exit', resolve)); process.child.kill(); await Promise.race([done, wait(2000)]); if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL'); }
async function request(base, route, bearer, json, method = json === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + route, { method, headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}
async function ready(base, route, process) { for (let attempt = 0; attempt < 100; attempt++) { assert.equal(process.child.exitCode, null, process.output()); try { const r = await fetch(base + route); if ([200, 401].includes(r.status)) return; } catch {} await wait(50); } throw new Error(process.output()); }
function seedUsers(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'users.json'), JSON.stringify(['admin', 'uploader'].map(username => { const salt = 'review-' + username; return { username, name: 'Fixture ' + username, role: username === 'admin' ? 'admin' : 'user', dept: 'Fixture', salt, hash: crypto.scryptSync(password, salt, 32).toString('hex'), ep: 1 }; })));
}
const snapshot = directory => {
  const files = {};
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files[path.relative(directory, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } }
  walk(directory); return files;
};
function portalEnv(directory, gatewayBase, portalBase) { return { DATA_DIR: directory, BIND_HOST: '127.0.0.1', SERVICE_DOCKER: 'mock', DISABLE_ALERT_POLL: '1', PORTAL_URL: portalBase, SKILL_GATEWAY_BASE: gatewayBase, SKILL_GATEWAY_TOKEN: 'fixture-only', MXSDOC_BASE_URL: 'http://127.0.0.1:1', ONE_API_BASE: 'http://127.0.0.1:1', FRPC_ADMIN_BASE: 'http://127.0.0.1:1', MCP_SERVER_URL: 'http://127.0.0.1:1/mcp' }; }

test('admin selected review is read-only and approval guards survive real HTTP concurrency', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-review-http-')); seedUsers(directory);
  const ids = ['review', 'doubleapprove', 'rejectfailed', 'stale', 'badrevision', 'rejectonline', 'legacy', 'approvereject', 'recheckafterwait', 'rekindrevision', 'malformedbody', 'rejectmalformed', 'reviewdraft', 'reviewrejected', 'staleapprove', 'stalereject', 'badtoken'];
  const records = ids.map(id => ({ id, u: 'uploader', n: 'Fixture uploader', name: 'Project ' + id, desc: 'Current purpose', kind: id === 'legacy' ? 'link' : 'skill', url: id === 'legacy' ? 'https://example.test/' : undefined, status: id === 'rejectfailed' ? 'deploy_failed' : id === 'rejectonline' ? 'online' : 'pending', packageRevision: 2, report: { verdict: 'ok', packageRoot: '', packageEntry: 'SKILL.md', structure: graph() } }));
  records[0].updateOf = 'skill:bound';
  Object.assign(records[0], { d: 'Current department', updateNote: 'Current developer note', smartAnalysis: { modelContext: 'PRIVATE_MODEL_CONTEXT' }, smartChoices: { choice: 'PRIVATE_CHOICES' }, smartAnalysisSourceHash: 'PRIVATE_SOURCE_HASH', cachePath: 'PRIVATE_CACHE_PATH', apiKey: 'PRIVATE_SECRET' });
  Object.assign(records[0].report, { lines: ['Current parse line'], entry: 'SKILL.md', rules: [{ id: 'A2', level: 'warn', msg: 'Current rule', fix: 'Current fix', apiKey: 'PRIVATE_RULE_SECRET' }], assistance: { manifestYaml: 'PRIVATE_MANIFEST', modelContext: 'PRIVATE_ASSISTANCE_CONTEXT' }, secret: 'PRIVATE_REPORT_SECRET' });
  records[0].report.structure.apiKey = 'PRIVATE_GRAPH_SECRET';
  for (const record of records) record.createdAt = Date.now();
  fs.writeFileSync(path.join(directory, 'uploads.json'), JSON.stringify(records));
  for (const id of ids) { const dir = path.join(directory, 'tmp', id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), skill(id)); fs.writeFileSync(path.join(dir, 'check.py'), 'raise Exception("must not execute")'); }
  records.find(item => item.id === 'reviewdraft').status = 'draft';
  for (const id of ['staleapprove', 'stalereject', 'badtoken']) Object.assign(records.find(item => item.id === id), { kind: 'link', name: 'Before name', desc: 'Before purpose', url: 'https://example.test/before', report: { verdict: 'ok' } });
  fs.writeFileSync(path.join(directory, 'uploads.json'), JSON.stringify(records));
  let barrier, inspectBarrier, publishCount = 0, gatewayDown = false, dependencyDisabled = false, baselineMode = true, portal;
  const calls = [];
  const gateway = http.createServer(async (req, res) => {
    req.resume(); calls.push(req.url);
    const respond = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (gatewayDown) return respond({ detail: 'unavailable' }, 503);
    if (req.url === '/api/skills') { if (barrier) { barrier.arrived.resolve(); await barrier.release.promise; } return respond([]); }
    if (req.url === '/api/skills/inspect') { if (inspectBarrier) { inspectBarrier.arrived.resolve(); await inspectBarrier.release.promise; } return respond({ root: '', entry: 'SKILL.md', structure: { ...graph(), dependencies: [{ id: 'lookup', slug: 'lookup', name: 'Lookup', required: true, status: dependencyDisabled ? 'disabled' : 'ready' }] }, errors: [], warnings: [] }); }
    if (req.url === '/api/skills/bound') return baselineMode ? respond({ slug: 'bound', current_version: 'v1.0.1', display_name: 'Original bound', description: 'Original purpose' }) : respond({ detail: 'missing' }, 404);
    if (req.url === '/api/skills/bound/structure?version=v1.0.1') return respond({ ...graph('v1.0.1'), components: [{ id: 'check', name: 'Check', kind: 'script', path: 'old.py', status: 'ready' }] });
    if (req.url === '/api/skills/upload') { publishCount++; return respond({ slug: 'published-' + publishCount, version: 'v1.0.2' }); }
    if (req.method === 'GET' && /^\/api\/skills\/(bound|published)/.test(req.url)) return respond({ detail: 'missing' }, 404);
    return respond({});
  });
  const gatewayBase = await listen(gateway), portalBase = await freeBase();
  t.after(async () => { barrier?.release.resolve(); inspectBarrier?.release.resolve(); await stop(portal); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  portal = launch(process.execPath, ['server.cjs', new URL(portalBase).port], root, portalEnv(directory, gatewayBase, portalBase)); await ready(portalBase, '/api/auth/me', portal);
  const admin = (await request(portalBase, '/api/auth/login', undefined, { username: 'admin', password })).data.token;
  const user = (await request(portalBase, '/api/auth/login', undefined, { username: 'uploader', password })).data.token;
  const review = id => request(portalBase, `/api/admin/uploads/${id}/review`, admin);
  const approve = (id, body = { revision: 2 }) => request(portalBase, `/api/admin/uploads/${id}/approve`, admin, body);
  const reject = (id, body = { revision: 2, reason: 'Needs changes' }) => request(portalBase, `/api/admin/uploads/${id}/reject`, admin, body);
  const row = async id => (await request(portalBase, '/api/admin/uploads', admin)).data.rows.find(item => item.id === id);

  await t.test('permissions and a selected read do not persist package or registry mutations', async () => {
    assert.equal((await request(portalBase, '/api/admin/uploads/review/review')).status, 403);
    assert.equal((await request(portalBase, '/api/admin/uploads/review/review', user)).status, 403);
    const before = snapshot(directory); const beforeCalls = calls.length;
    const result = await review('review'); assert.equal(result.status, 200); assert.equal(result.data.ok, true); assert.equal(result.data.check.state, 'complete');
    assert.deepEqual(snapshot(directory), before); assert.ok(calls.slice(beforeCalls).includes('/api/skills/bound/structure?version=v1.0.1'));
    assert.equal(result.data.update.target.id, 'skill:bound'); assert.ok(result.data.update.changes.some(change => change.field === 'functions'));
    assert.equal(result.data.reviewToken, crypto.createHash('sha256').update(JSON.stringify(await row('review'))).digest('hex'));
    assert.ok(result.data.record, 'review returns its selected public record');
    assert.equal(result.data.record.name, result.data.summary.name); assert.equal(result.data.record.desc, result.data.summary.purpose);
    assert.equal(result.data.record.d, 'Current department'); assert.equal(result.data.record.updateNote, 'Current developer note');
    assert.equal(result.data.record.report.entry, 'SKILL.md'); assert.deepEqual(result.data.record.report.lines, ['Current parse line']);
    assert.doesNotMatch(JSON.stringify(result.data.record), /PRIVATE_/);
    assert.equal(publishCount, 0);
  });
  for (const action of ['approve', 'reject']) await t.test(`an old ${action} review token cannot survive rejection, metadata edits and resubmission at the same package revision`, async () => {
    const id = 'stale' + action, source = path.join(directory, 'tmp', id), beforeSource = snapshot(source);
    const before = (await review(id)).data, previousToken = before.reviewToken || '0'.repeat(64);
    assert.equal(before.revision, 2); assert.equal(before.summary.purpose, 'Before purpose');
    const rejected = await reject(id, { revision: 2, reviewToken: previousToken, reason: 'Fix purpose' }); assert.equal(rejected.data.ok, true, JSON.stringify(rejected));
    const changed = await request(portalBase, `/api/uploads/${id}/draft`, user, { revision: 2, name: 'After name', desc: 'After purpose' });
    assert.equal(changed.data.ok, true); assert.equal(changed.data.revision, 2);
    const submitted = await request(portalBase, '/api/uploads/submit', user, { id, name: 'After name', desc: 'After purpose', url: 'https://example.test/after', departments: ['Fixture'], tags: ['Updated'], category: 'Updated category', icon: '新', updateNote: 'After developer note', revision: 2 });
    assert.equal(submitted.data.ok, true, JSON.stringify(submitted));
    const beforeAttempt = await row(id); assert.equal(beforeAttempt.packageRevision, 2); assert.equal(beforeAttempt.status, 'pending');
    const stale = await (action === 'approve' ? approve(id, { revision: 2, reviewToken: previousToken }) : reject(id, { revision: 2, reviewToken: previousToken, reason: 'Old review' }));
    assert.equal(stale.status, 409, JSON.stringify(stale)); assert.deepEqual(await row(id), beforeAttempt); assert.deepEqual(snapshot(source), beforeSource);
    const fresh = (await review(id)).data; assert.match(fresh.reviewToken, /^[a-f0-9]{64}$/); assert.notEqual(fresh.reviewToken, previousToken);
    assert.equal(fresh.revision, 2); assert.equal(fresh.summary.purpose, 'After purpose');
    assert.ok(fresh.record, 'a refreshed token must come with the refreshed displayed record');
    assert.equal(fresh.record.name, 'After name'); assert.equal(fresh.record.desc, 'After purpose'); assert.equal(fresh.record.url, 'https://example.test/after');
    assert.equal(fresh.record.updateNote, 'After developer note'); assert.deepEqual(fresh.record.departments, ['Fixture']); assert.deepEqual(fresh.record.tags, ['Updated']);
    assert.equal(fresh.record.category, 'Updated category'); assert.equal(fresh.record.icon, '新'); assert.equal(fresh.record.kind, 'link');
    assert.equal(fresh.record.status, fresh.status); assert.equal(fresh.record.packageRevision, fresh.revision);
    assert.equal(fresh.reviewToken, crypto.createHash('sha256').update(JSON.stringify(await row(id))).digest('hex'));
    const handled = await (action === 'approve' ? approve(id, { revision: fresh.revision, reviewToken: fresh.reviewToken }) : reject(id, { revision: fresh.revision, reviewToken: fresh.reviewToken, reason: 'Current review' }));
    assert.equal(handled.data.ok, true, JSON.stringify(handled));
    const final = await row(id); assert.equal(final.status, action === 'approve' ? 'online' : 'rejected');
    if (action === 'approve') assert.equal(final.deployedUrl, 'https://example.test/after');
    else assert.deepEqual(snapshot(source), beforeSource);
  });
  await t.test('malformed and mismatched optional review tokens return 409 without changing source or record', async () => {
    const before = await row('badtoken'), source = path.join(directory, 'tmp', 'badtoken'), beforeSource = snapshot(source);
    for (const reviewToken of [null, 123, '', 'not-a-review-token', '0'.repeat(64)]) for (const action of [approve, reject]) {
      const result = await action('badtoken', { revision: 2, reviewToken }); assert.equal(result.status, 409, JSON.stringify(result));
      assert.deepEqual(await row('badtoken'), before); assert.deepEqual(snapshot(source), beforeSource);
    }
  });
  await t.test('live dependency state, missing source and failed gateway remain explicit', async () => {
    dependencyDisabled = true; assert.equal((await review('review')).data.check.state, 'blocked'); dependencyDisabled = false;
    gatewayDown = true; assert.equal((await review('review')).data.check.state, 'unknown'); gatewayDown = false;
    const dir = path.join(directory, 'tmp', 'review'); fs.renameSync(dir, dir + '-held');
    try { const result = await review('review'); assert.equal(result.data.check.state, 'unknown'); assert.equal(result.data.check.sourceAvailable, false); }
    finally { fs.renameSync(dir + '-held', dir); }
  });
  await t.test('a delayed inspection rejects both metadata and status changes without writing its own state', async () => {
    for (const id of ['reviewdraft', 'reviewrejected']) {
      inspectBarrier = { arrived: deferred(), release: deferred() };
      const pending = review(id);
      await Promise.race([inspectBarrier.arrived.promise, pending.then(result => { throw new Error('Review did not reach inspection: ' + JSON.stringify(result)); })]);
      const changed = id === 'reviewdraft' ? await request(portalBase, `/api/uploads/${id}/draft`, user, { revision: 2, name: 'Changed during review', desc: 'New current purpose' }) : await reject(id);
      assert.equal(changed.data.ok, true, JSON.stringify(changed));
      const afterChange = fs.readFileSync(path.join(directory, 'uploads.json'), 'utf8');
      inspectBarrier.release.resolve(); inspectBarrier = null;
      const result = await pending; assert.equal(result.status, 409, JSON.stringify(result));
      assert.equal(fs.readFileSync(path.join(directory, 'uploads.json'), 'utf8'), afterChange);
    }
  });
  await t.test('optional revisions reject stale and malformed writes, old clients remain supported', async () => {
    baselineMode = false;
    assert.equal((await approve('stale', { revision: 1 })).status, 409);
    assert.equal((await reject('stale', { revision: 1 })).status, 409);
    assert.equal((await approve('badrevision', { revision: '2' })).status, 400);
    assert.equal((await reject('badrevision', { revision: 2.5 })).status, 400);
    assert.equal((await approve('legacy', {})).data.ok, true);
    assert.equal((await reject('rejectonline')).status, 409);
  });
  await t.test('deploy_failed rejection retains every source byte', async () => {
    const dir = path.join(directory, 'tmp', 'rejectfailed'), before = snapshot(dir);
    const result = await reject('rejectfailed'); assert.equal(result.data.ok, true); assert.equal((await row('rejectfailed')).status, 'rejected'); assert.deepEqual(snapshot(dir), before);
  });
  await t.test('malformed approval and rejection bodies fail without retaining a mutation lock', async () => {
    for (const [id, action] of [['malformedbody', 'approve'], ['rejectmalformed', 'reject']]) {
      const response = await fetch(portalBase + `/api/admin/uploads/${id}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: '{"' });
      assert.equal(response.status, 400); await response.arrayBuffer();
      assert.equal((await reject(id)).data.ok, true);
    }
  });
  await t.test('two approvals waiting on registry checks publish exactly once', async () => {
    barrier = { arrived: deferred(), release: deferred() }; const before = publishCount;
    const first = approve('doubleapprove'); await barrier.arrived.promise;
    const second = approve('doubleapprove'); await wait(80); barrier.release.resolve();
    const results = await Promise.all([first, second]); barrier = null;
    assert.equal(results.filter(result => result.data.ok).length, 1, JSON.stringify(results)); assert.ok(results.some(result => result.status === 409)); assert.equal(publishCount - before, 1);
  });
  await t.test('approval mutation lock also rejects a concurrent rejection', async () => {
    barrier = { arrived: deferred(), release: deferred() }; const first = approve('approvereject'); await barrier.arrived.promise;
    const rejection = await reject('approvereject');
    const busyReview = await review('approvereject');
    const rekind = await request(portalBase, '/api/admin/uploads/approvereject/rekind', admin, { kind: 'web' });
    barrier.release.resolve(); barrier = null; const approval = await first;
    assert.equal(rejection.status, 409); assert.equal(busyReview.status, 409); assert.equal(rekind.status, 409); assert.equal(approval.data.ok, true);
  });
  await t.test('admin type changes invalidate an earlier reviewed revision', async () => {
    const result = await request(portalBase, '/api/admin/uploads/rekindrevision/rekind', admin, { kind: 'web' }); assert.equal(result.data.ok, true);
    assert.equal((await row('rekindrevision')).packageRevision, 3);
    assert.equal((await reject('rekindrevision')).status, 409);
    assert.equal((await reject('rekindrevision', { revision: 3 })).data.ok, true);
  });
  await t.test('approval rechecks status after asynchronous registry validation', async () => {
    barrier = { arrived: deferred(), release: deferred() }; const before = publishCount; const first = approve('recheckafterwait'); await barrier.arrived.promise;
    const changed = await request(portalBase, '/api/admin/uploads/recheckafterwait/offline', admin, {}); assert.equal(changed.data.ok, true);
    barrier.release.resolve(); barrier = null; const result = await first;
    assert.equal(result.status, 409); assert.equal(publishCount, before); assert.equal((await row('recheckafterwait')).status, 'offline');
  });
});

const argv = process.argv.slice(2);
const argument = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const gatewayRepo = argument('--gateway') || process.env.GATEWAY_REPO;
test('real Python gateway reviews current staged packages and the exact published baseline without writes', { skip: !gatewayRepo, timeout: 90000 }, async t => {
  const checkout = path.resolve(gatewayRepo);
  const python = argument('--python') || process.env.GATEWAY_PYTHON || path.join(checkout, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(fs.existsSync(path.join(checkout, 'skill_gateway/api.py')));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-review-real-'));
  const portalData = path.join(temporary, 'portal'), gatewayData = path.join(temporary, 'gateway');
  seedUsers(portalData); fs.mkdirSync(gatewayData);
  const tokens = path.join(gatewayData, 'tokens.json'); fs.writeFileSync(tokens, '{}');
  const gatewayBase = await freeBase(); let portalBase = await freeBase(); while (portalBase === gatewayBase) portalBase = await freeBase();
  let gateway, portal;
  t.after(async () => { await stop(portal); await stop(gateway); assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); fs.rmSync(temporary, { recursive: true, force: true }); });
  gateway = launch(python, ['-m', 'uvicorn', 'skill_gateway.api:app', '--host', '127.0.0.1', '--port', new URL(gatewayBase).port], checkout, {
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', GATEWAY_DATA_DIR: gatewayData, GATEWAY_DB: path.join(gatewayData, 'gateway.db'), GATEWAY_STATIC_TOKENS: tokens,
    GATEWAY_ADMIN_TOKEN: 'fixture-only', GATEWAY_AUTH_MODE: 'static', GATEWAY_WEB_UI: 'off', GATEWAY_API_HOST: '127.0.0.1', GATEWAY_MCP_HOST: '127.0.0.1', GATEWAY_MCP_PORT: '1',
    GATEWAY_ONEAPI_BASE_URL: 'http://127.0.0.1:1', GATEWAY_SkillHarbor_PORTAL_BASE: 'http://127.0.0.1:1', GATEWAY_KB_BASE_URL: 'http://127.0.0.1:1', GATEWAY_EMBED_BASE_URL: 'http://127.0.0.1:1', SkillHarbor_SYNC_URL: 'http://127.0.0.1:1/api/ip-name-map', ARCHIVE_BASE_URL: 'http://127.0.0.1:1',
  });
  await ready(gatewayBase, '/api/health', gateway);
  portal = launch(process.execPath, ['server.cjs', new URL(portalBase).port], root, portalEnv(portalData, gatewayBase, portalBase));
  await ready(portalBase, '/api/auth/me', portal);
  const admin = (await request(portalBase, '/api/auth/login', undefined, { username: 'admin', password })).data.token;
  const user = (await request(portalBase, '/api/auth/login', undefined, { username: 'uploader', password })).data.token;
  const postForm = async (base, route, bearer, bytes, fields) => {
    const form = new FormData(); form.append('file', new Blob([bytes]), 'fixture.zip'); for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const response = await fetch(base + route, { method: 'POST', headers: { Authorization: 'Bearer ' + bearer }, body: form, signal: AbortSignal.timeout(15000) });
    const result = { status: response.status, data: await response.json() }; assert.equal(result.status, 200, JSON.stringify(result)); assert.notEqual(result.data.ok, false, JSON.stringify(result)); return result.data;
  };
  const archive = files => makeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));
  const agent = (version, scriptPath, dependency = false) => archive({
    'bundle/agent.yaml': JSON.stringify({ schemaVersion: 1, id: 'review-bound', kind: 'agent', version, entry: 'SKILL.md', components: [{ id: 'check', name: '核对材料', kind: 'script', path: scriptPath }], dependencies: dependency ? [{ id: 'lookup', name: '平台核验', source: 'registry', slug: 'review-dependency', required: true }] : [], steps: [{ id: 'verify', task: '核对材料并检索', executor: 'dispatch', targets: ['component:check', ...(dependency ? ['dependency:lookup'] : [])] }] }),
    'bundle/SKILL.md': skill('review-bound', 'Review version ' + version),
    ['bundle/' + scriptPath]: 'raise Exception("review must never execute this file")\n',
  });
  const uploadGateway = (bytes, version, slug, update = false) => postForm(gatewayBase, '/api/skills/upload', 'fixture-only', bytes, { version, display_name: 'Fixture ' + slug, owner: 'Fixture uploader', ...(update ? { slug } : {}) });
  await uploadGateway(archive({ 'SKILL.md': skill('review-dependency') }), '1.0.0', 'review-dependency');
  await uploadGateway(agent('1.0.1', 'scripts/older.py'), '1.0.1', 'review-bound');
  await uploadGateway(agent('1.0.2', 'scripts/current.py'), '1.0.2', 'review-bound', true);
  const parsed = await postForm(portalBase, '/api/uploads/parse', user, agent('1.0.3', 'scripts/new.py', true), { kind: 'skill' });
  assert.notEqual(parsed.report.verdict, 'fail', JSON.stringify(parsed.report));
  const submitted = await request(portalBase, '/api/uploads/submit', user, { id: parsed.id, name: 'Fixture review-bound', desc: 'Review new materials', updateOf: 'skill:review-bound', updateNote: 'Add platform lookup', revision: 0 });
  assert.equal(submitted.data.ok, true, JSON.stringify(submitted));
  const review = () => request(portalBase, `/api/admin/uploads/${parsed.id}/review`, admin);
  await t.test('real inspect has no registry, upload, source, version or usage mutation', async () => {
    assert.equal((await request(portalBase, `/api/admin/uploads/${parsed.id}/review`, user)).status, 403);
    const beforeUploads = fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8');
    const beforeSource = snapshot(path.join(portalData, 'tmp', parsed.id)); const beforeRegistry = snapshot(path.join(gatewayData, 'skills'));
    const beforeDetail = (await request(gatewayBase, '/api/skills/review-bound', 'fixture-only')).data;
    const result = await review(); assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.check.state, 'complete', JSON.stringify(result)); assert.equal(result.data.resourceType, 'agent');
    assert.equal(result.data.summary.functions[0].path, 'scripts/new.py'); assert.equal(result.data.summary.functions[1].slug, 'review-dependency');
    assert.ok(result.data.record, 'real gateway review includes the selected record snapshot');
    assert.equal(result.data.record.name, result.data.summary.name); assert.equal(result.data.record.desc, result.data.summary.purpose);
    assert.equal(result.data.record.updateOf, 'skill:review-bound'); assert.equal(result.data.record.updateNote, 'Add platform lookup');
    assert.equal(result.data.record.report.entry, parsed.report.entry); assert.equal(result.data.record.report.structure.components[0].path, 'scripts/new.py');
    assert.equal(result.data.update.target.version, 'v1.0.2'); assert.equal(result.data.update.proposedVersion, 'v1.0.3');
    const change = result.data.update.changes.find(item => item.field === 'functions');
    assert.ok(change.before.some(line => line.includes('scripts/current.py'))); assert.ok(!change.before.some(line => line.includes('scripts/older.py')));
    assert.equal(fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), beforeUploads);
    assert.deepEqual(snapshot(path.join(portalData, 'tmp', parsed.id)), beforeSource); assert.deepEqual(snapshot(path.join(gatewayData, 'skills')), beforeRegistry);
    const afterDetail = (await request(gatewayBase, '/api/skills/review-bound', 'fixture-only')).data;
    assert.equal(afterDetail.current_version, beforeDetail.current_version); assert.equal(afterDetail.calls_total, beforeDetail.calls_total);
  });
  await t.test('the selected web record preserves the actual preview entry and metadata without persistence', async () => {
    const web = await postForm(portalBase, '/api/uploads/parse', user, archive({ 'site/current.html': '<!doctype html><meta charset="utf-8"><title>Current web</title><h1>Current page</h1>' }), { kind: 'web' });
    assert.equal((await request(portalBase, '/api/uploads/submit', user, { id: web.id, name: 'Current web', desc: 'Current preview purpose', departments: ['Fixture'], tags: ['Preview'], updateNote: 'Current preview note', revision: 0 })).data.ok, true);
    const beforeUploads = fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), beforeSource = snapshot(path.join(portalData, 'tmp', web.id));
    const response = await request(portalBase, `/api/admin/uploads/${web.id}/review`, admin); assert.equal(response.status, 200, JSON.stringify(response));
    const result = response.data; assert.ok(result.record); assert.equal(result.record.kind, 'web'); assert.equal(result.record.report.entry, 'site/current.html');
    assert.equal(result.record.name, result.summary.name); assert.equal(result.record.desc, result.summary.purpose); assert.equal(result.record.updateNote, 'Current preview note');
    const current = JSON.parse(beforeUploads).find(item => item.id === web.id); assert.equal(result.reviewToken, crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex'));
    assert.equal(fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), beforeUploads); assert.deepEqual(snapshot(path.join(portalData, 'tmp', web.id)), beforeSource);
  });
  await t.test('ordinary skills retain runtime declarations through smart analysis, atomic apply, review, version comparison and publication without changing original bytes', async () => {
    const requirementVersions = [['Browser with network access', 'Host API credential'], ['Host Python 3.11']];
    const originalMarkdown = skill('runtime-roundtrip', 'Declared host environment is not a missing package function');
    const markdownHash = crypto.createHash('sha256').update(originalMarkdown).digest('hex');
    for (let index = 0; index < requirementVersions.length; index++) {
      const runtimeRequirements = requirementVersions[index], version = `1.0.${index}`;
      const bytes = archive({ 'SKILL.md': originalMarkdown, 'assets/data.bin': Buffer.from([0, 255, 128, 13, 10]), 'agent.yaml': JSON.stringify({ schemaVersion: 1, id: 'runtime-roundtrip', kind: 'skill', version, entry: 'SKILL.md', components: [], dependencies: [], steps: [], runtimeRequirements }) });
      const originalHash = crypto.createHash('sha256').update(bytes).digest('hex');
      const uploaded = await postForm(portalBase, '/api/uploads/parse', user, bytes, { kind: 'skill' });
      const directory = path.join(portalData, 'tmp', uploaded.id), beforeFiles = snapshot(directory);
      const analysisResponse = await request(portalBase, `/api/uploads/${uploaded.id}/analyze`, user, { revision: 0, ...(index ? { updateOf: 'skill:runtime-roundtrip' } : {}) });
      assert.equal(analysisResponse.status, 200, JSON.stringify(analysisResponse)); assert.equal(analysisResponse.data.ok, true, JSON.stringify(analysisResponse));
      const analyzed = analysisResponse.data; assert.equal(analyzed.analysis.status, 'ready', JSON.stringify(analyzed.analysis)); assert.equal(analyzed.analysis.kind, 'skill');
      assert.deepEqual(analyzed.analysis.runtimeRequirements, runtimeRequirements); assert.deepEqual(analyzed.report.structure.runtimeRequirements, runtimeRequirements);
      assert.equal(analyzed.analysis.modelContext, undefined); assert.deepEqual(analyzed.report.structure.dependencies, []); assert.deepEqual(analyzed.report.structure.components, []);
      assert.equal(snapshot(directory)['SKILL.md'], beforeFiles['SKILL.md']); assert.equal(snapshot(directory)['assets/data.bin'], beforeFiles['assets/data.bin']);
      assert.match(fs.readFileSync(path.join(directory, 'agent.yaml'), 'utf8'), /runtimeRequirements/);
      const submission = await request(portalBase, '/api/uploads/submit', user, { id: uploaded.id, revision: analyzed.revision, name: analyzed.analysis.resource.name, desc: 'Ordinary skill with host runtime requirements', ...(index ? { updateOf: 'skill:runtime-roundtrip', updateNote: 'Change runtime declaration' } : {}) });
      assert.equal(submission.data.ok, true, JSON.stringify(submission));
      const beforeReview = fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8');
      const checkedResponse = await request(portalBase, `/api/admin/uploads/${uploaded.id}/review`, admin); assert.equal(checkedResponse.status, 200, JSON.stringify(checkedResponse));
      const checked = checkedResponse.data; assert.equal(checked.check.state, 'attention', JSON.stringify(checked)); assert.deepEqual(checked.summary.runtimeRequirements, runtimeRequirements);
      assert.deepEqual(checked.record.report.structure.runtimeRequirements, runtimeRequirements); assert.equal(fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), beforeReview);
      if (index) {
        assert.equal(checked.update.target.version, 'v1.0.0'); const changed = checked.update.changes.find(item => item.field === 'runtimeRequirements');
        assert.deepEqual(changed.before, requirementVersions[0]); assert.deepEqual(changed.after, runtimeRequirements);
      }
      const approved = await request(portalBase, `/api/admin/uploads/${uploaded.id}/approve`, admin, { revision: checked.revision, reviewToken: checked.reviewToken }); assert.equal(approved.data.ok, true, JSON.stringify(approved));
      const current = (await request(portalBase, '/api/uploads/mine', user)).data.rows.find(item => item.id === uploaded.id); assert.equal(current.publishSlug, 'runtime-roundtrip', JSON.stringify(approved));
      const published = await request(gatewayBase, `/api/skills/runtime-roundtrip/structure?version=v${version}`, 'fixture-only'); assert.equal(published.status, 200, JSON.stringify(published)); assert.deepEqual(published.data.runtimeRequirements, runtimeRequirements);
      const publishedMarkdown = fs.readFileSync(path.join(gatewayData, 'skills', 'runtime-roundtrip', 'versions', 'v' + version, 'SKILL.md'));
      assert.equal(crypto.createHash('sha256').update(publishedMarkdown).digest('hex'), markdownHash);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(portalData, 'upload-originals', uploaded.id + '.bin'))).digest('hex'), originalHash);
    }
    assert.deepEqual((await request(gatewayBase, '/api/skills/runtime-roundtrip/structure?version=v1.0.0', 'fixture-only')).data.runtimeRequirements, requirementVersions[0]);
  });
  await t.test('an ordinary instruction calling an unverifiable host tool is publishable with a runtime declaration and unchanged source', async () => {
    const original = '---\nname: runtime-host-tool\ndescription: 交付文件\n---\n调用 `present_files` 展示成果。\n';
    const bytes = archive({ 'SKILL.md': original }), originalHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const uploaded = await postForm(portalBase, '/api/uploads/parse', user, bytes, { kind: 'skill' });
    const analysisResponse = await request(portalBase, `/api/uploads/${uploaded.id}/analyze`, user, { revision: 0 });
    assert.equal(analysisResponse.status, 200, JSON.stringify(analysisResponse)); assert.equal(analysisResponse.data.ok, true, JSON.stringify(analysisResponse));
    const analyzed = analysisResponse.data; assert.equal(analyzed.analysis.status, 'ready', JSON.stringify(analyzed.analysis)); assert.equal(analyzed.analysis.kind, 'skill');
    assert.deepEqual(analyzed.analysis.runtimeRequirements, ['present_files']); assert.deepEqual(analyzed.report.structure.runtimeRequirements, ['present_files']);
    assert.deepEqual(analyzed.report.structure.components, []); assert.deepEqual(analyzed.report.structure.dependencies, []); assert.deepEqual(analyzed.report.structure.steps, []);
    assert.equal((await request(portalBase, '/api/uploads/submit', user, { id: uploaded.id, revision: analyzed.revision, name: analyzed.analysis.resource.name, desc: 'Runtime host tool declaration' })).data.ok, true);
    const checked = (await request(portalBase, `/api/admin/uploads/${uploaded.id}/review`, admin)).data;
    assert.equal(checked.check.state, 'attention'); assert.deepEqual(checked.summary.runtimeRequirements, ['present_files']);
    const approval = await request(portalBase, `/api/admin/uploads/${uploaded.id}/approve`, admin, { revision: checked.revision, reviewToken: checked.reviewToken }); assert.equal(approval.data.ok, true, JSON.stringify(approval));
    const current = (await request(portalBase, '/api/uploads/mine', user)).data.rows.find(item => item.id === uploaded.id); assert.equal(current.publishSlug, 'runtime-host-tool', JSON.stringify(approval));
    const structure = await request(gatewayBase, '/api/skills/runtime-host-tool/structure?version=v1.0.0', 'fixture-only'); assert.equal(structure.status, 200); assert.deepEqual(structure.data.runtimeRequirements, ['present_files']);
    assert.deepEqual(fs.readFileSync(path.join(gatewayData, 'skills', 'runtime-host-tool', 'versions', 'v1.0.0', 'SKILL.md')), Buffer.from(original));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(portalData, 'upload-originals', uploaded.id + '.bin'))).digest('hex'), originalHash);
  });
  await t.test('disabling a previously ready real dependency immediately blocks review', async () => {
    const disabled = await request(gatewayBase, '/api/skills/review-dependency/status?status=disabled', 'fixture-only', {}); assert.equal(disabled.status, 200, JSON.stringify(disabled));
    const result = await review(); assert.equal(result.data.check.state, 'blocked'); assert.equal(result.data.summary.functions.find(item => item.slug === 'review-dependency').status, 'disabled');
    assert.equal((await request(gatewayBase, '/api/skills/review-dependency/status?status=enabled', 'fixture-only', {})).status, 200);
  });
  await t.test('a real existing manifest version is blocked before approval', async () => {
    await uploadGateway(agent('1.0.3', 'scripts/already-published.py'), '1.0.3', 'review-bound', true);
    const result = await review(); assert.equal(result.data.check.state, 'blocked');
    assert.ok(result.data.check.issues.some(item => item.level === 'error' && /版本/.test(item.message)));
    assert.equal(result.data.update.state, 'available'); assert.equal(result.data.update.target.version, 'v1.0.3');
  });
  await t.test('source expiration and real gateway unavailability produce unknown', async () => {
    const source = path.join(portalData, 'tmp', parsed.id); fs.renameSync(source, source + '-held');
    try { const result = await review(); assert.equal(result.data.check.state, 'unknown'); assert.equal(result.data.check.sourceAvailable, false); }
    finally { fs.renameSync(source + '-held', source); }
    await stop(gateway); const result = await review(); assert.equal(result.data.check.state, 'unknown'); assert.equal(result.data.check.sourceAvailable, true);
  });
});
