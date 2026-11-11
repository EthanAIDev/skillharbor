/* Real HTTP regression: portal upload -> smart analysis -> confirmation -> approval.
 * Usage: node scripts/test-smart-upload-integration.cjs --gateway <gateway-checkout> --python <venv-python>
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
const { spawn } = require('node:child_process');
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
const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${body}</h1></body></html>`;
const manifestZip = (id, version, body) => zip({
  'agent.yaml': JSON.stringify({ schemaVersion: 1, id, kind: 'agent', version, entry: 'SKILL.md', components: [], dependencies: [], steps: [] }),
  'SKILL.md': skill(`display-for-${id}`, body),
});
const dispatch = target => `## 任务映射表\n| 任务 | 分派技能 |\n|---|---|\n| 整理材料 | \`${target}\` |\n`;
const proseFiles = name => ({
  'SKILL.md': skill(name, '## 工作流程\n收到材料后，调用材料核对完成审查。\n'),
  'modules/check.md': skill('材料核对', '核对真实材料。'),
});
const proposalFor = context => ({ resolutions: context.references.map(ref => ({ referenceId: ref.id, targetId: ref.targetIds[0], evidence: { fileId: ref.fileId, line: ref.line, quote: ref.quote } })) });
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

test('isolated smart upload analyzes, confirms and publishes across real HTTP', { timeout: 180000 }, async t => {
  assert.ok(fs.existsSync(path.join(gatewayRepo, 'skill_gateway/api.py')), 'Pass --gateway pointing to the gateway checkout.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-smart-integration-'));
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
  let gateway, portal, modelServer;
  let modelMode = 'unavailable', modelGate;
  const modelCalls = [], modelErrors = [];
  const modelKey = 'synthetic-package-ai-key';
  t.after(async () => {
    modelGate?.release?.();
    await Promise.all([stop(portal), stop(gateway)]);
    if (modelServer) await new Promise(resolve => modelServer.close(resolve));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
    assert.ok(relative.startsWith('zeb-smart-integration-') && !relative.includes(path.sep) && !relative.startsWith('..'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  try {
    modelServer = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks));
        const context = JSON.parse(payload.messages.find(item => item.role === 'user').content);
        assert.deepEqual(Object.keys(context).sort(), ['candidates', 'files', 'references', 'registry']);
        assert.ok(context.references.length > 0);
        modelCalls.push({ context, mode: modelMode });
        modelGate?.entered?.();
        if (modelGate) await modelGate.wait;
        if (modelMode === 'unavailable') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'synthetic unavailable' })); return; }
        const proposal = proposalFor(context);
        if (modelMode === 'forged') proposal.resolutions[0].evidence.quote = 'This evidence was never in the upload.';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal) } }] }));
      } catch (error) { modelErrors.push(error.message); res.writeHead(500); res.end('{}'); }
    });
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
    const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
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
      PACKAGE_AI_BASE: modelBase, PACKAGE_AI_KEY: modelKey,
      FRPC_ADMIN_BASE: isolatedUpstream, MCP_SERVER_URL: `${isolatedUpstream}/mcp`,
    });
    await ready(portalBase, '/api/auth/me', portal);

    const login = async username => success(await request(portalBase, '/api/auth/login', { json: { username, password } })).token;
    const ownerToken = await login('uploader'), adminToken = await login('admin'), otherToken = await login('other');
    const gw = async route => success(await request(gatewayBase, route, { token }));
    const originals = new Map();
    // Represent what this test client has received, never silently fetch a newer server revision before submitting.
    const confirmedRevisions = new Map();
    const parse = async (bytes, filename = 'smart.zip') => {
      const form = new FormData(); form.append('file', new Blob([bytes]), filename); form.append('kind', 'auto');
      const parsed = success(await request(portalBase, '/api/uploads/parse', { token: ownerToken, form }));
      originals.set(parsed.id, Buffer.from(bytes));
      assert.deepEqual(fs.readFileSync(path.join(portalData, 'upload-originals', parsed.id + '.bin')), Buffer.from(bytes));
      return parsed;
    };
    const rawAnalyze = (parsed, body, bearer = ownerToken) => request(portalBase, `/api/uploads/${parsed.id}/analyze`, { token: bearer, json: body });
    const analyze = async (parsed, revision = 0, extra = {}) => {
      const result = success(await rawAnalyze(parsed, { revision, ...extra }));
      assert.equal(result.id, parsed.id);
      assert.equal(result.revision, revision + 1);
      assert.equal(result.analysis.revision, result.revision);
      assert.ok(!Object.hasOwn(result.analysis, 'modelContext'), 'internal model context must not reach the browser');
      assert.doesNotMatch(JSON.stringify(result), new RegExp(modelKey));
      confirmedRevisions.set(parsed.id, result.revision);
      return result;
    };
    const mine = async parsed => success(await request(portalBase, '/api/uploads/mine', { token: ownerToken })).rows.find(row => row.id === parsed.id);
    const submit = (parsed, name, extra = {}) => request(portalBase, '/api/uploads/submit', { token: ownerToken, json: { id: parsed.id, revision: confirmedRevisions.get(parsed.id), name, desc: 'Synthetic smart-upload integration', category: 'Fixture', tags: ['测试'], departments: ['全部'], ...extra } });
    const approve = parsed => request(portalBase, `/api/admin/uploads/${parsed.id}/approve`, { token: adminToken, json: {} });
    const draft = (parsed, body, bearer = ownerToken) => request(portalBase, `/api/uploads/${parsed.id}/draft`, { token: bearer, json: body });
    const draftDir = parsed => path.join(portalData, 'tmp', parsed.id);
    const registry = () => fileSnapshot(path.join(gatewayData, 'skills'));
    const state = parsed => ({ files: fileSnapshot(draftDir(parsed)), uploads: fs.readFileSync(path.join(portalData, 'uploads.json'), 'utf8'), registry: registry(), originals: fileSnapshot(path.join(portalData, 'upload-originals')) });
    const publish = async (parsed, result, extra = {}) => {
      assert.equal(result.analysis.status, 'ready', JSON.stringify(result.analysis));
      assert.notEqual(result.report.verdict, 'fail');
      success(await submit(parsed, result.analysis.resource.name, { revision: result.revision, ...extra }));
      const approval = success(await approve(parsed));
      const rec = await mine(parsed);
      assert.equal(rec.status, 'online', JSON.stringify(approval));
      assert.equal(rec.publishSlug, result.analysis.identity, JSON.stringify(approval));
      assert.deepEqual(fs.readFileSync(path.join(portalData, 'upload-originals', parsed.id + '.bin')), originals.get(parsed.id));
      assert.equal(rec.originalSha256, sha256(originals.get(parsed.id)));
      const detail = await gw(`/api/skills/${rec.publishSlug}`);
      const published = fileSnapshot(path.join(gatewayData, 'skills', rec.publishSlug, 'versions', detail.current_version));
      assert.ok(!Object.keys(published).some(name => name.includes('upload-originals') || name.includes('upload-analysis') || name === parsed.id + '.bin'), 'original archives and analysis snapshots must never enter the published package');
      return { rec, detail, published };
    };
    const publishTool = async (parsed, result, content, extra = {}) => {
      assert.equal(result.analysis.kind, 'tool');
      assert.equal(result.analysis.status, 'ready', JSON.stringify(result.analysis));
      assert.notEqual(result.report.verdict, 'fail');
      success(await submit(parsed, result.analysis.resource.name, { revision: result.revision, ...extra }));
      success(await approve(parsed));
      const rec = await mine(parsed);
      assert.equal(rec.status, 'online');
      const deployed = new URL(rec.deployedUrl, portalBase);
      assert.equal(deployed.origin, portalBase);
      const served = await fetch(deployed, { signal: AbortSignal.timeout(5000) });
      assert.equal(served.status, 200);
      assert.equal(await served.text(), content);
      assert.deepEqual(fs.readFileSync(path.join(portalData, 'upload-originals', parsed.id + '.bin')), originals.get(parsed.id));
      const entries = JSON.parse(fs.readFileSync(path.join(portalData, 'extraTools.json'), 'utf8'));
      const tool = rec.updateOf ? entries.find(item => item.id === rec.updateOf.slice(5)) : entries.find(item => item.uploadId === rec.id);
      assert.ok(tool);
      return { rec, tool };
    };
    const seed = async (slug, owner = 'Fixture uploader', displayName = slug) => {
      const form = new FormData();
      form.append('file', new Blob([zip({ 'SKILL.md': skill(slug) })]), 'seed.zip');
      form.append('version', 'v1.0.0'); form.append('owner', owner); form.append('display_name', displayName);
      success(await request(gatewayBase, '/api/skills/upload', { token, form }));
    };
    const unchangedOriginalFiles = (files, tree, prefix = '') => {
      for (const [name, bytes] of Object.entries(files)) assert.equal(tree[name.slice(prefix.length)], sha256(Buffer.from(bytes)), name);
    };

    await t.test('ordinary skill automatically normalizes as a skill and publishes without technical editing', async () => {
      const files = { 'SKILL.md': skill('smart-plain'), 'assets/template.txt': 'Preserve the original template.\r\n' };
      const parsed = await parse(zip(files));
      const beforeRegistry = registry();
      const result = await analyze(parsed);
      assert.equal(result.analysis.status, 'ready');
      assert.equal(result.analysis.kind, 'skill');
      assert.equal(result.analysis.engine, 'rules');
      assert.equal(result.analysis.newResource, true);
      assert.equal(result.report.structure.kind, 'skill');
      assert.deepEqual(registry(), beforeRegistry);
      unchangedOriginalFiles(files, fileSnapshot(draftDir(parsed)));
      assert.ok(fs.existsSync(path.join(draftDir(parsed), 'agent.yaml')));
      const published = await publish(parsed, result);
      unchangedOriginalFiles(files, published.published);
      assert.equal((await gw('/api/skills/smart-plain/structure')).kind, 'skill');
    });

    await t.test('named Markdown entries without a SKILL.md filename reach smart entry selection', async () => {
      const files = { 'main.md': skill('smart-named-entry'), 'parts/calculator.md': skill('smart-named-component'), 'assets/data.bin': Buffer.from([0, 128, 255]) };
      const parsed = await parse(zip(files), 'named-markdown.zip');
      assert.equal(parsed.kind, 'skill', 'frontmatter-only Markdown projects must enter the skill channel');
      const first = await analyze(parsed);
      assert.equal(first.analysis.status, 'question', JSON.stringify(first.analysis));
      const q = first.analysis.question;
      const selected = q.options.find(option => option.label === 'smart-named-entry');
      assert.ok(selected, JSON.stringify(q));
      const ready = await analyze(parsed, first.revision, { choices: { [q.id]: selected.id } });
      assert.equal(ready.analysis.status, 'ready');
      assert.equal(ready.analysis.kind, 'skill');
      assert.equal(ready.report.packageEntry, 'main.md');
      unchangedOriginalFiles(files, (await publish(parsed, ready)).published);
    });

    await t.test('an explicit nested agent outranks a root HTML template during automatic detection', async () => {
      const files = {
        'main/orchestrator.md': skill('smart-explicit-agent', dispatch('parts/helper/SKILL.md')).replace('description:', 'type: agent\ndescription:'),
        'parts/helper/SKILL.md': skill('smart-explicit-helper'),
        'index.html': html('Bundled template', 'Template retained by the agent'),
      };
      const parsed = await parse(zip(files), 'agent-with-template.zip');
      assert.equal(parsed.kind, 'skill', 'an explicit agent declaration must not be hidden by a shallower HTML template');
      const ready = await analyze(parsed);
      assert.equal(ready.analysis.status, 'ready', JSON.stringify(ready.analysis));
      assert.equal(ready.analysis.kind, 'agent');
      assert.equal(ready.report.packageEntry, 'main/orchestrator.md');
      assert.ok(ready.analysis.resource.functions.some(item => item.name === 'smart-explicit-helper'));
      unchangedOriginalFiles(files, (await publish(parsed, ready)).published);
    });

    await t.test('an agent reports its real package functions while preserving arbitrary sibling layout', async () => {
      const files = { 'SKILL.md': skill('smart-coordinator', dispatch('modules/chapter.md')), 'modules/chapter.md': skill('章节整理'), 'assets/data.bin': Buffer.from([0, 255, 128, 13, 10]), 'templates/note.md': '# 示例模板\n' };
      const parsed = await parse(zip(files));
      const result = await analyze(parsed);
      assert.equal(result.analysis.status, 'ready');
      assert.equal(result.analysis.kind, 'agent');
      assert.deepEqual(result.analysis.resource.functions, [{ name: '章节整理', source: 'package' }]);
      assert.equal(result.report.structure.steps.length, 1);
      const published = await publish(parsed, result);
      unchangedOriginalFiles(files, published.published);
      const component = result.report.structure.components[0];
      assert.equal((await gw(`/api/skills/smart-coordinator/components/${component.id}`)).content, files['modules/chapter.md']);
    });

    await t.test('multiple entry questions have no default and accept only the returned opaque option', async () => {
      const files = { 'outer/first/SKILL.md': skill('smart-first'), 'outer/second/SKILL.md': skill('smart-second'), 'outer/assets/保真.bin': Buffer.from([0, 128, 255, 13, 10]), 'outer/sibling.txt': 'Never discard sibling files.' };
      const parsed = await parse(zip(files));
      const first = await analyze(parsed);
      assert.equal(first.analysis.status, 'question');
      const q = first.analysis.question;
      assert.equal(q.options.length, 2);
      assert.ok(q.options.every(option => !Object.hasOwn(option, 'selected') && !Object.keys(files).includes(option.id)));
      unchangedOriginalFiles(files, fileSnapshot(draftDir(parsed)));
      assert.equal(Object.keys(fileSnapshot(draftDir(parsed))).length, Object.keys(files).length);
      assert.equal((await submit(parsed, 'Unanswered entry')).data.ok, false);
      const selected = q.options.find(option => option.label === 'smart-second');
      assert.ok(selected);
      const second = await analyze(parsed, first.revision, { choices: { [q.id]: selected.id } });
      assert.equal(second.analysis.status, 'ready', JSON.stringify(second.analysis));
      assert.equal(second.report.packageRoot, 'outer');
      assert.equal(second.report.packageEntry, 'second/SKILL.md');
      const repeated = await analyze(parsed, second.revision);
      assert.equal(repeated.analysis.status, 'ready', 'reanalyzing a normalized package must not treat saved entry choices as obsolete questions');
      assert.equal(repeated.report.packageEntry, 'second/SKILL.md');
      const published = await publish(parsed, repeated);
      unchangedOriginalFiles(files, published.published, 'outer/');
      assert.equal((await mine(parsed)).smartChoices[q.id], selected.id);
    });

    await t.test('missing required functions remain blocked and cannot enter review', async () => {
      const bytes = zip({ 'SKILL.md': skill('smart-missing', dispatch('absent-required-skill')) });
      const parsed = await parse(bytes);
      const before = registry();
      const result = await analyze(parsed);
      assert.equal(result.analysis.status, 'blocked');
      assert.ok(result.analysis.issues.some(issue => issue.code === 'missing_dependency'));
      assert.match(result.analysis.repairText, /absent-required-skill/);
      assert.equal(result.report.verdict, 'fail');
      assert.equal((await submit(parsed, 'Missing required function')).data.ok, false);
      assert.deepEqual(registry(), before);
      assert.deepEqual(fs.readFileSync(path.join(portalData, 'upload-originals', parsed.id + '.bin')), bytes);
    });

    await t.test('an unavailable model retains the real business question and user selection resolves it', async () => {
      modelMode = 'unavailable';
      const parsed = await parse(zip(proseFiles('smart-ai-unavailable')));
      const beforeCalls = modelCalls.length;
      const result = await analyze(parsed);
      assert.equal(modelCalls.length, beforeCalls + 1);
      assert.equal(result.analysis.status, 'question');
      assert.equal(result.analysis.engine, 'rules');
      assert.match(result.analysis.aiNotice, /暂不可用|超时/);
      assert.equal((await submit(parsed, 'Unanswered model fallback')).data.ok, false);
      const q = result.analysis.question;
      const ready = await analyze(parsed, result.revision, { choices: { [q.id]: q.options[0].id } });
      assert.equal(ready.analysis.status, 'ready');
      assert.equal(modelCalls.length, beforeCalls + 1, 'explicit user evidence must not call the model again');
      await publish(parsed, ready);
    });

    await t.test('model proposals cross the real Node and gateway evidence checks before publication', async () => {
      modelMode = 'valid';
      const files = proseFiles('smart-ai-valid');
      const parsed = await parse(zip(files));
      const beforeCalls = modelCalls.length;
      const result = await analyze(parsed);
      assert.equal(modelCalls.length, beforeCalls + 1);
      assert.equal(result.analysis.status, 'ready', JSON.stringify(result.analysis));
      assert.equal(result.analysis.engine, 'ai');
      assert.ok(result.analysis.evidence.some(item => item.source === 'ai'));
      const { context } = modelCalls.at(-1);
      const ref = context.references[0];
      assert.equal(context.files.find(item => item.id === ref.fileId).text.split(/\r?\n/)[ref.line - 1], ref.quote);
      assert.ok(context.candidates.some(item => item.id === ref.targetIds[0]));
      unchangedOriginalFiles(files, (await publish(parsed, result)).published);
    });

    await t.test('forged model evidence is rejected by both the portal client and actual gateway analyzer', async () => {
      modelMode = 'forged';
      const bytes = zip(proseFiles('smart-ai-forged'));
      const parsed = await parse(bytes);
      const before = registry();
      const result = await analyze(parsed);
      assert.equal(result.analysis.status, 'question');
      assert.equal(result.analysis.engine, 'rules');
      assert.ok(result.analysis.aiNotice);
      assert.equal((await submit(parsed, 'Forged proposal')).data.ok, false);
      const proposal = proposalFor(modelCalls.at(-1).context);
      proposal.resolutions[0].evidence.quote = 'Forged evidence';
      const form = new FormData(); form.append('file', new Blob([bytes]), 'forged.zip'); form.append('proposal', JSON.stringify(proposal));
      const gatewayResult = success(await request(gatewayBase, '/api/skills/analyze', { token, form }));
      assert.equal(gatewayResult.status, 'blocked');
      assert.ok(gatewayResult.issues.some(issue => issue.code === 'invalid_proposal'));
      assert.deepEqual(registry(), before);
    });

    await t.test('an exact owned identity asks new or update and only an explicit answer binds the update', async () => {
      await seed('smart-owned');
      const original = await gw('/api/skills/smart-owned');
      const parsed = await parse(skill('smart-owned', 'Updated owned content'), 'owned.md');
      const first = await analyze(parsed);
      assert.equal(first.analysis.status, 'question');
      assert.equal(first.analysis.question.id, 'publication-identity');
      assert.deepEqual(first.analysis.question.options.map(option => option.id).sort(), ['new', 'update']);
      assert.ok(!(await mine(parsed)).updateOf);
      assert.equal((await submit(parsed, 'Unconfirmed ownership')).data.ok, false);
      assert.deepEqual(await gw('/api/skills/smart-owned'), original);
      const ready = await analyze(parsed, first.revision, { choices: { 'publication-identity': 'update' } });
      assert.equal(ready.analysis.status, 'ready', JSON.stringify(ready.analysis));
      assert.equal(ready.analysis.updateOf, 'skill:smart-owned');
      assert.equal((await mine(parsed)).updateOf, 'skill:smart-owned');
      const published = await publish(parsed, ready, { updateNote: 'Explicit confirmed update' });
      assert.equal(published.detail.current_version, 'v1.0.1');
      assert.equal(fs.readFileSync(path.join(gatewayData, 'skills/smart-owned/versions/v1.0.0/SKILL.md'), 'utf8'), skill('smart-owned'));
    });

    await t.test('canceling a confirmed update requires explicit new-resource normalization', async () => {
      await seed('smart-unbind');
      const original = fileSnapshot(path.join(gatewayData, 'skills/smart-unbind'));
      const parsed = await parse(skill('smart-unbind', 'New standalone content'), 'unbind.md');
      const bound = await analyze(parsed, 0, { updateOf: 'skill:smart-unbind' });
      assert.equal(bound.analysis.status, 'ready');
      const before = state(parsed);
      assert.equal((await rawAnalyze(parsed, { revision: bound.revision, updateOf: '' })).status, 409);
      assert.deepEqual(state(parsed), before);
      const copied = await analyze(parsed, bound.revision, { updateOf: '', newResource: true });
      assert.equal(copied.analysis.status, 'ready');
      assert.notEqual(copied.analysis.identity, 'smart-unbind');
      assert.equal(copied.analysis.newResource, true);
      assert.ok(!(await mine(parsed)).updateOf);
      await publish(parsed, copied);
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/smart-unbind')), original);
    });

    await t.test('choosing new for an exact owned identity preserves the original and publishes a distinct copy', async () => {
      await seed('smart-copy-choice');
      const original = fileSnapshot(path.join(gatewayData, 'skills/smart-copy-choice'));
      const parsed = await parse(skill('smart-copy-choice', 'Independent new copy'), 'copy.md');
      const first = await analyze(parsed);
      assert.equal(first.analysis.question.id, 'publication-identity');
      const copied = await analyze(parsed, first.revision, { choices: { 'publication-identity': 'new' } });
      assert.equal(copied.analysis.status, 'ready', JSON.stringify(copied.analysis));
      assert.notEqual(copied.analysis.identity, 'smart-copy-choice');
      assert.equal(copied.analysis.newResource, true);
      assert.ok(!(await mine(parsed)).updateOf);
      await publish(parsed, copied);
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/smart-copy-choice')), original);
    });

    await t.test('same-name owned resources offer exact update choices and never guess the first match', async () => {
      await seed('smart-match-a', 'Fixture uploader', '同名项目');
      await seed('smart-match-b', 'Fixture uploader', '同名项目');
      const originalA = fileSnapshot(path.join(gatewayData, 'skills/smart-match-a'));
      const bytes = skill('smart-unmatched-identity', 'Chosen business update').replace('description:', 'display_name: 同名项目\ndescription:');
      const parsed = await parse(bytes, 'matches.md');
      const first = await analyze(parsed);
      assert.equal(first.analysis.status, 'question');
      assert.equal(first.analysis.question.id, 'publication-identity');
      assert.deepEqual(first.analysis.question.options.map(option => option.id).sort(), ['new', 'update:smart-match-a', 'update:smart-match-b']);
      assert.ok(!(await mine(parsed)).updateOf);
      const ready = await analyze(parsed, first.revision, { choices: { 'publication-identity': 'update:smart-match-b' } });
      assert.equal(ready.analysis.status, 'ready', JSON.stringify(ready.analysis));
      assert.equal(ready.analysis.updateOf, 'skill:smart-match-b');
      assert.equal((await publish(parsed, ready, { updateNote: 'Choose the second exact target' })).detail.current_version, 'v1.0.1');
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/smart-match-a')), originalA);
    });

    await t.test('an update intent survives entry questions without changing the confirmed binding prematurely', async () => {
      await seed('smart-intent-owner');
      const original = fileSnapshot(path.join(gatewayData, 'skills/smart-intent-owner'));
      const files = { 'a/SKILL.md': skill('smart-intent-main'), 'b/SKILL.md': skill('smart-intent-sibling'), 'assets/data.bin': Buffer.from([0, 128, 255]) };
      const parsed = await parse(zip(files));
      const first = await analyze(parsed, 0, { updateOf: 'skill:smart-intent-owner' });
      assert.equal(first.analysis.status, 'question');
      assert.ok(!(await mine(parsed)).updateOf, 'an unanswered business question cannot alter the committed binding');
      assert.equal((await mine(parsed)).smartPublicationIntent.target, 'skill:smart-intent-owner');
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/smart-intent-owner')), original);
      const q = first.analysis.question;
      const selected = q.options.find(option => option.label === 'smart-intent-main');
      assert.ok(selected);
      const ready = await analyze(parsed, first.revision, { choices: { [q.id]: selected.id } });
      assert.equal(ready.analysis.status, 'ready');
      assert.equal(ready.analysis.updateOf, 'skill:smart-intent-owner');
      assert.equal((await mine(parsed)).updateOf, 'skill:smart-intent-owner');
      const result = await publish(parsed, ready, { updateNote: 'Confirmed pending intent after entry selection' });
      assert.equal(result.detail.current_version, 'v1.0.1');
      unchangedOriginalFiles(files, result.published);
    });

    await t.test('a foreign identity becomes a separate new resource without overwriting its owner', async () => {
      await seed('smart-foreign', 'Fixture other');
      const original = fileSnapshot(path.join(gatewayData, 'skills/smart-foreign'));
      const parsed = await parse(manifestZip('smart-foreign', '3.0.0', 'Must create a different identity'));
      const result = await analyze(parsed);
      assert.equal(result.analysis.status, 'ready');
      assert.notEqual(result.analysis.identity, 'smart-foreign');
      assert.equal(result.analysis.newResource, true);
      assert.ok(!result.analysis.updateOf);
      await publish(parsed, result);
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/smart-foreign')), original);
    });

    await t.test('cross-user requests and stale revisions cannot change a draft', async () => {
      const parsed = await parse(skill('smart-guards'), 'guards.md');
      const before = state(parsed);
      for (const bearer of [otherToken, adminToken]) {
        assert.equal((await rawAnalyze(parsed, { revision: 0 }, bearer)).status, 404);
        assert.equal((await draft(parsed, { name: 'Hijacked' }, bearer)).status, 404);
      }
      assert.equal((await rawAnalyze(parsed, {})).status, 409);
      assert.deepEqual(state(parsed), before);
      const result = await analyze(parsed);
      const after = state(parsed);
      assert.equal((await rawAnalyze(parsed, { revision: 0 })).status, 409);
      assert.equal((await draft(parsed, { revision: 0, name: 'Stale' })).status, 409);
      assert.deepEqual(state(parsed), after);
      success(await submit(parsed, result.analysis.resource.name));
      const pending = state(parsed);
      assert.equal((await rawAnalyze(parsed, { revision: result.revision })).status, 409);
      assert.deepEqual(state(parsed), pending);
    });

    await t.test('the draft lock blocks concurrent analysis, metadata changes and submission', async () => {
      modelMode = 'valid';
      const parsed = await parse(zip(proseFiles('smart-lock')));
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const blocked = new Promise(resolve => { release = resolve; });
      modelGate = { entered, release, wait: blocked };
      const first = rawAnalyze(parsed, { revision: 0 });
      let barrierTimer;
      try {
        await Promise.race([started, new Promise((_, reject) => { barrierTimer = setTimeout(() => reject(new Error('model did not reach the controlled concurrency barrier')), 5000); })]);
        assert.equal((await rawAnalyze(parsed, { revision: 0 })).status, 409);
        assert.equal((await draft(parsed, { revision: 0, name: 'Concurrent change' })).status, 409);
        assert.equal((await submit(parsed, 'Concurrent submission')).status, 409);
      } finally { clearTimeout(barrierTimer); release(); modelGate = undefined; }
      const ready = success(await first);
      assert.equal(ready.revision, 1);
      assert.equal(ready.analysis.status, 'ready');
      await publish(parsed, ready);
    });

    await t.test('saved business metadata and original bytes survive rejection and resubmission', async () => {
      const parsed = await parse(skill('smart-rejected'), 'rejected.md');
      const ready = await analyze(parsed);
      success(await draft(parsed, { revision: ready.revision, name: 'Saved business title', desc: 'Saved explanation', updateNote: 'Saved note' }));
      const saved = await mine(parsed);
      assert.equal(saved.name, 'Saved business title'); assert.equal(saved.desc, 'Saved explanation'); assert.equal(saved.updateNote, 'Saved note');
      assert.equal(saved.packageRevision, ready.revision);
      assert.deepEqual(saved.smartAnalysis, ready.analysis);
      success(await submit(parsed, saved.name, { desc: saved.desc }));
      success(await request(portalBase, `/api/admin/uploads/${parsed.id}/reject`, { token: adminToken, json: { reason: 'Revise business explanation' } }));
      assert.equal((await mine(parsed)).status, 'rejected');
      const revised = await analyze(parsed, ready.revision);
      assert.equal(revised.analysis.status, 'ready');
      success(await draft(parsed, { revision: revised.revision, desc: 'Revised explanation' }));
      await publish(parsed, revised, { desc: 'Revised explanation' });
      assert.equal((await mine(parsed)).desc, 'Revised explanation');
    });

    await t.test('smart submission requires the exact revision the client confirmed', async () => {
      const parsed = await parse(skill('smart-submit-revision'), 'submit-revision.md');
      const first = await analyze(parsed);
      const second = await analyze(parsed, first.revision);
      assert.equal(first.revision, 1);
      assert.equal(second.revision, 2);
      const before = state(parsed);
      for (const revision of [first.revision, undefined, String(second.revision)]) {
        const denied = await submit(parsed, second.analysis.resource.name, { revision });
        assert.equal(denied.status, 409, JSON.stringify(denied));
        assert.equal(denied.data.ok, false);
        assert.equal((await mine(parsed)).status, 'draft');
        assert.deepEqual(state(parsed), before, 'missing or stale confirmation must not enter review or change stored state');
      }
      await publish(parsed, second);
      const legacy = await parse(skill('legacy-explicit-revision'), 'legacy-revision.md');
      const legacyBefore = state(legacy);
      assert.equal((await submit(legacy, 'Legacy revision fixture', { revision: 1 })).status, 409);
      assert.deepEqual(state(legacy), legacyBefore, 'provided revisions are checked even before any smart analysis');
      success(await submit(legacy, 'Legacy revision fixture', { revision: 0 }));
      success(await approve(legacy));
      assert.equal((await mine(legacy)).publishSlug, 'legacy-explicit-revision');
    });

    await t.test('same-name tool questions restore the source report for both update and new answers', async () => {
      const beforeRegistry = registry();
      const title = 'Smart tool source';
      const initialContent = html(title, 'Original tool content');
      const initial = await parse(zip({ 'index.html': initialContent, 'README.md': skill('web-documentation', 'Instructions for the website, not an agent declaration.') }), 'smart-tool.zip');
      assert.equal(initial.kind, 'web', 'a website with an ordinary named README must remain a web tool');
      const initialReady = await analyze(initial);
      assert.equal(initialReady.analysis.status, 'ready');
      const initialPublished = await publishTool(initial, initialReady, initialContent);
      const updatedContent = html(title, 'Updated tool content');
      const update = await parse(updatedContent, 'smart-tool-update.html');
      const question = await analyze(update);
      assert.equal(question.analysis.status, 'question');
      assert.equal(question.analysis.question.id, 'publication-identity');
      assert.equal(question.report.verdict, 'fail');
      assert.notEqual((await mine(update)).smartToolReport.verdict, 'fail');
      const updated = await analyze(update, question.revision, { choices: { 'publication-identity': 'update' } });
      assert.equal(updated.analysis.status, 'ready', JSON.stringify(updated.analysis));
      assert.deepEqual(updated.report, update.report, 'the question must not overwrite the original valid tool report');
      assert.equal(updated.analysis.updateOf, `tool:${initialPublished.tool.id}`);
      const updateAgain = await analyze(update, updated.revision);
      assert.equal(updateAgain.analysis.status, 'ready');
      assert.equal(updateAgain.analysis.updateOf, updated.analysis.updateOf);
      const updatedPublished = await publishTool(update, updateAgain, updatedContent, { updateNote: 'Confirmed tool update' });
      assert.equal(updatedPublished.tool.id, initialPublished.tool.id);
      assert.equal(updatedPublished.rec.deployedUrl, initialPublished.rec.deployedUrl);
      const copiedContent = html(title, 'Independent tool content');
      const copy = await parse(copiedContent, 'smart-tool-copy.html');
      const copyQuestion = await analyze(copy);
      assert.equal(copyQuestion.analysis.status, 'question');
      assert.equal(copyQuestion.analysis.question.id, 'publication-identity');
      const copied = await analyze(copy, copyQuestion.revision, { choices: { 'publication-identity': 'new' } });
      assert.equal(copied.analysis.status, 'ready', JSON.stringify(copied.analysis));
      assert.deepEqual(copied.report, copy.report);
      assert.equal(copied.analysis.newResource, true);
      assert.ok(!copied.analysis.updateOf);
      const copyAgain = await analyze(copy, copied.revision);
      assert.equal(copyAgain.analysis.status, 'ready');
      assert.equal(copyAgain.analysis.newResource, true);
      assert.ok(!copyAgain.analysis.updateOf);
      const copiedPublished = await publishTool(copy, copyAgain, copiedContent);
      assert.notEqual(copiedPublished.tool.id, initialPublished.tool.id);
      assert.notEqual(copiedPublished.rec.deployedUrl, initialPublished.rec.deployedUrl);
      const originalResponse = await fetch(new URL(initialPublished.rec.deployedUrl, portalBase), { signal: AbortSignal.timeout(5000) });
      assert.equal(await originalResponse.text(), updatedContent, 'publishing the copy must not replace the updated original tool');
      assert.deepEqual(registry(), beforeRegistry);
    });

    await t.test('later explicit publication intent survives retries without replaying a past identity answer', async () => {
      await seed('smart-intent-first');
      await seed('smart-intent-other');
      const firstFiles = fileSnapshot(path.join(gatewayData, 'skills/smart-intent-first'));
      const parsed = await parse(skill('smart-intent-first', 'Content for the final selected target'), 'intent-change.md');
      const question = await analyze(parsed);
      assert.equal(question.analysis.question.id, 'publication-identity');
      const initialUpdate = await analyze(parsed, question.revision, { choices: { 'publication-identity': 'update' } });
      assert.equal(initialUpdate.analysis.updateOf, 'skill:smart-intent-first');
      assert.equal(initialUpdate.analysis.status, 'ready');
      const confirmed = await mine(parsed);
      assert.ok(!confirmed.smartIdentityQuestion);
      assert.ok(!Object.hasOwn(confirmed.smartChoices, 'publication-identity'));
      const copied = await analyze(parsed, initialUpdate.revision, { newResource: true });
      assert.equal(copied.analysis.status, 'ready');
      assert.equal(copied.analysis.newResource, true);
      assert.notEqual(copied.analysis.identity, 'smart-intent-first');
      const copiedAgain = await analyze(parsed, copied.revision);
      assert.equal(copiedAgain.analysis.status, 'ready');
      assert.equal(copiedAgain.analysis.identity, copied.analysis.identity);
      assert.equal(copiedAgain.analysis.newResource, true);
      assert.ok(!copiedAgain.analysis.updateOf);
      assert.ok(!(await mine(parsed)).updateOf);
      const other = await analyze(parsed, copiedAgain.revision, { updateOf: 'skill:smart-intent-other' });
      assert.equal(other.analysis.status, 'ready');
      assert.equal(other.analysis.updateOf, 'skill:smart-intent-other');
      const otherAgain = await analyze(parsed, other.revision);
      assert.equal(otherAgain.analysis.status, 'ready');
      assert.equal(otherAgain.analysis.updateOf, 'skill:smart-intent-other');
      assert.equal(otherAgain.analysis.identity, 'smart-intent-other');
      assert.equal((await mine(parsed)).updateOf, 'skill:smart-intent-other');
      assert.equal((await publish(parsed, otherAgain, { updateNote: 'Keep the latest explicit target' })).detail.current_version, 'v1.0.1');
      assert.deepEqual(fileSnapshot(path.join(gatewayData, 'skills/smart-intent-first')), firstFiles);
    });

    await t.test('advanced manifest changes become the source for subsequent smart analysis', async () => {
      const files = { 'SKILL.md': skill('smart-advanced'), 'modules/manual.md': skill('manual-helper', 'Use the manually selected entry.'), 'assets/data.bin': Buffer.from([0, 128, 255, 13, 10]) };
      const parsed = await parse(zip(files));
      const first = await analyze(parsed);
      assert.equal(first.analysis.status, 'ready');
      const manifest = { ...first.analysis.assistance.manifest, kind: 'agent', version: '2.3.0', entry: 'modules/manual.md', components: [], dependencies: [], steps: [{ id: 'manual-step', task: '人工维护流程', targets: [] }] };
      const previewed = success(await request(portalBase, `/api/uploads/${parsed.id}/prepare`, { token: ownerToken, json: { manifest } }));
      assert.deepEqual(previewed.assistance.errors, []);
      const applied = success(await request(portalBase, `/api/uploads/${parsed.id}/prepare`, { token: ownerToken, json: { manifest, revision: first.revision, apply: true } }));
      assert.equal(applied.assistance.revision, 2);
      assert.ok(!(await mine(parsed)).smartAnalysisSourceHash, 'advanced edits must invalidate the prior analysis source');
      const result = await analyze(parsed, applied.assistance.revision);
      assert.equal(result.analysis.status, 'ready', JSON.stringify(result.analysis));
      assert.equal(result.analysis.kind, 'agent');
      assert.equal(result.report.packageEntry, 'modules/manual.md');
      assert.equal(result.report.structure.version, 'v2.3.0');
      assert.equal(result.report.structure.steps[0].task, '人工维护流程');
      assert.equal(result.report.structure.steps[0].id, 'manual-step');
      unchangedOriginalFiles(files, (await publish(parsed, result)).published);
      assert.equal((await gw('/api/skills/smart-advanced/content')).content, files['modules/manual.md']);
    });

    assert.deepEqual(modelErrors, [], 'the model stub must validate every real client request');
  } catch (error) {
    t.diagnostic(`Gateway output:\n${gateway?.output() || '(not started)'}\nPortal output:\n${portal?.output() || '(not started)'}`);
    throw error;
  }
});
