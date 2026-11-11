/* Deterministic HTTP concurrency checks against the real portal process.
 * The loopback gateway is a controlled fixture: package parsing is covered by
 * test-skill-integration.cjs; here its delays expose portal commit boundaries.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const portalRoot = path.resolve(__dirname, '..');

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('portal draft mutations and submissions serialize across asynchronous checks', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-prepare-concurrency-'));
  const password = 'concurrency-fixture-only', salt = 'concurrency-fixture';
  fs.writeFileSync(path.join(directory, 'users.json'), JSON.stringify([{ username: 'fixture', name: 'Fixture', role: 'user',
    dept: 'Fixture', deptShort: 'Fixture', salt, hash: crypto.scryptSync(password, salt, 32).toString('hex'), ep: 1, disabled: false }]));
  const ids = ['changedwhilewaiting', 'prepareinflight', 'slowbody', 'doublesubmit'];
  fs.writeFileSync(path.join(directory, 'uploads.json'), JSON.stringify(ids.map(id => ({ id, u: 'fixture', n: 'Fixture',
    kind: 'skill', status: 'draft', packageRevision: 0, createdAt: Date.now(),
    report: { verdict: 'ok', rules: [], packageRoot: '', packageEntry: 'SKILL.md' } }))));
  for (const id of ids) {
    fs.mkdirSync(path.join(directory, 'tmp', id), { recursive: true });
    fs.writeFileSync(path.join(directory, 'tmp', id, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture only\n---\n# Instructions\n');
  }
  const manifest = { schemaVersion: 1, id: 'fixture', kind: 'agent', version: '1.0.0', entry: 'SKILL.md',
    dependencies: [{ id: 'missing', source: 'registry', slug: 'missing-fixture', required: true }] };
  const inspection = { root: '', entry: 'SKILL.md', errors: ['Required dependency missing-fixture: missing'], warnings: [], names: ['fixture'],
    structure: { schemaVersion: 1, source: 'manifest', slug: 'fixture', version: 'v1.0.0', kind: 'agent', entry: 'SKILL.md', components: [], dependencies: [], steps: [], warnings: [] } };
  const assistance = { root: '', manifestPath: 'agent.yaml', candidates: [{ path: 'SKILL.md', name: 'fixture' }],
    files: [{ path: 'SKILL.md', kind: 'skill' }], manifest, manifestYaml: JSON.stringify(manifest), inspection,
    errors: inspection.errors, warnings: [], needsSelection: false };
  let listBarrier, prepareBarrier, portal, output = '';
  const gateway = http.createServer(async (req, res) => {
    req.resume();
    const respond = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/skills') {
      const barrier = listBarrier;
      if (barrier) { barrier.arrivals++; barrier.arrived.resolve(); await barrier.release.promise; }
      return respond([]);
    }
    if (req.url === '/api/skills/prepare') {
      const barrier = prepareBarrier;
      if (barrier) { barrier.arrived.resolve(); await barrier.release.promise; }
      return respond(assistance);
    }
    if (req.url === '/api/skills/inspect') return respond(inspection);
    if (req.method === 'GET' && req.url === '/api/skills/fixture') return respond({ detail: 'Skill does not exist: fixture' }, 404);
    respond({});
  });
  const gatewayBase = await listen(gateway);
  const portProbe = http.createServer();
  const portalBase = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  t.after(async () => {
    listBarrier?.release.resolve(); prepareBarrier?.release.resolve();
    if (portal && portal.exitCode === null && portal.signalCode === null) {
      const stopped = new Promise(resolve => portal.once('exit', resolve));
      portal.kill();
      await Promise.race([stopped, wait(2000)]);
      if (portal.exitCode === null && portal.signalCode === null) portal.kill('SIGKILL');
    }
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('zeb-prepare-concurrency-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const keep = /^(path|pathext|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata|systemdrive)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.test(key)));
  portal = spawn(process.execPath, ['server.cjs', String(new URL(portalBase).port)], { cwd: portalRoot, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, DATA_DIR: directory, BIND_HOST: '127.0.0.1', SERVICE_DOCKER: 'mock',
      DISABLE_ALERT_POLL: '1', PORTAL_URL: portalBase, SKILL_GATEWAY_BASE: gatewayBase, SKILL_GATEWAY_TOKEN: 'fixture-only',
      MXSDOC_BASE_URL: 'http://127.0.0.1:1', ONE_API_BASE: 'http://127.0.0.1:1', FRPC_ADMIN_BASE: 'http://127.0.0.1:1', MCP_SERVER_URL: 'http://127.0.0.1:1/mcp' } });
  portal.stdout.on('data', bytes => { output = (output + bytes).slice(-4000); });
  portal.stderr.on('data', bytes => { output = (output + bytes).slice(-4000); });
  portal.on('error', error => { output += error.message; });
  let token;
  const request = async (route, body) => {
    const response = await fetch(portalBase + route, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(6000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(portal.exitCode, null, output);
    try { if ((await request('/api/auth/me')).status === 401) break; } catch { /* startup */ }
    await wait(50);
  }
  const loggedIn = await request('/api/auth/login', { username: 'fixture', password });
  assert.equal(loggedIn.data.ok, true, JSON.stringify(loggedIn)); token = loggedIn.data.token;
  const row = async id => (await request('/api/uploads/mine')).data.rows.find(item => item.id === id);
  const submit = id => request('/api/uploads/submit', { id, name: id });
  const apply = id => request(`/api/uploads/${id}/prepare`, { manifest, apply: true, revision: 0 });
  const barrier = () => ({ arrivals: 0, arrived: deferred(), release: deferred() });

  await t.test('an applied repair invalidates an earlier submission waiting on the gateway', async () => {
    listBarrier = barrier();
    const submission = submit('changedwhilewaiting');
    await listBarrier.arrived.promise;
    const applied = await apply('changedwhilewaiting');
    assert.equal(applied.data.ok, true, JSON.stringify(applied));
    assert.equal(applied.data.report.verdict, 'fail');
    listBarrier.release.resolve(); listBarrier = null;
    const result = await submission;
    assert.equal(result.status, 409, JSON.stringify(result));
    const current = await row('changedwhilewaiting');
    assert.equal(current.status, 'draft'); assert.equal(current.packageRevision, 1);
    assert.ok(current.report.rules.some(rule => rule.level === 'error'));
  });

  await t.test('a submission cannot pass while preparation owns the draft', async () => {
    prepareBarrier = barrier();
    const preparation = apply('prepareinflight');
    await prepareBarrier.arrived.promise;
    const result = await submit('prepareinflight');
    assert.equal(result.status, 409, JSON.stringify(result));
    prepareBarrier.release.resolve(); prepareBarrier = null;
    assert.equal((await preparation).data.ok, true);
    assert.equal((await row('prepareinflight')).status, 'draft');
  });

  await t.test('preparation rechecks draft status after receiving a delayed request body', async () => {
    const body = JSON.stringify({ manifest, apply: true, revision: 0 });
    let slow;
    const result = new Promise((resolve, reject) => {
      slow = http.request(portalBase + '/api/uploads/slowbody/prepare', { method: 'POST', headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      } }, res => { let text = ''; res.on('data', bytes => { text += bytes; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); });
      slow.on('error', reject); slow.setTimeout(6000, () => slow.destroy(new Error('slow body fixture timed out')));
      slow.write(body.slice(0, 1));
    });
    // The held body leaves the handler at its readJson await; other requests remain live.
    await wait(50);
    const submitted = await submit('slowbody');
    assert.equal(submitted.data.ok, true, JSON.stringify(submitted));
    slow.end(body.slice(1));
    assert.equal((await result).status, 409);
    assert.equal((await row('slowbody')).packageRevision, 0);
    assert.equal(fs.existsSync(path.join(directory, 'tmp', 'slowbody', 'agent.yaml')), false);
  });

  await t.test('two submissions waiting on the gateway produce one pending record', async () => {
    listBarrier = barrier();
    const first = submit('doublesubmit'), second = submit('doublesubmit');
    for (let attempt = 0; attempt < 100 && listBarrier.arrivals < 2; attempt++) await wait(10);
    assert.equal(listBarrier.arrivals, 2, 'both submissions must reach the controlled gateway delay');
    listBarrier.release.resolve(); listBarrier = null;
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.filter(result => result.data.ok === true).length, 1);
    assert.equal((await row('doublesubmit')).status, 'pending');
  });
});
