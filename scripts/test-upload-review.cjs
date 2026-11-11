const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildUploadReview } = require('../server/lib/upload-review.cjs');
const graph = (patch = {}) => ({ schemaVersion: 1, slug: 'target', version: 'v1.0.2', kind: 'agent', source: 'manifest', entry: 'SKILL.md', components: [{ id: 'check', name: 'Check', kind: 'script', path: 'scripts/check.py', status: 'ready' }], dependencies: [{ id: 'lookup', name: 'Lookup', slug: 'lookup', required: true, status: 'ready' }], steps: [{ id: 's1', task: 'Check', executor: 'dispatch', targets: ['check', 'lookup'] }], warnings: [], ...patch });
const rec = patch => ({ id: 'fixture', kind: 'skill', name: 'Project', desc: 'Review materials', status: 'pending', packageRevision: 3, report: { structure: graph() }, ...patch });
async function run(t, record = rec(), options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-review-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: fixture\ndescription: review\n---\n');
  return buildUploadReview({ rec: record, directory, inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph(), errors: [], warnings: [] }), fetchJson: async () => { throw new Error('unavailable'); }, tools: [], uploads: [], ...options });
}
test('live inspection preserves function identity, path, dependencies and steps without changing the record', async t => {
  const record = rec(); const before = JSON.stringify(record);
  const result = await run(t, record);
  assert.equal(result.revision, 3); assert.equal(result.check.state, 'complete');
  assert.equal(result.summary.functions[0].path, 'scripts/check.py');
  assert.equal(result.summary.functions[1].slug, 'lookup');
  assert.deepEqual(result.summary.steps[0].targets, ['check', 'lookup']);
  assert.equal(JSON.stringify(record), before);
});
test('live disabled dependencies override a ready submission snapshot', async t => {
  const result = await run(t, rec(), { inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ dependencies: [{ id: 'lookup', name: 'Lookup', slug: 'lookup', required: true, status: 'disabled' }] }), errors: [], warnings: [] }) });
  assert.equal(result.check.state, 'blocked'); assert.equal(result.summary.functions[1].status, 'disabled');
});
test('missing source and unavailable gateway never claim a complete check', async t => {
  const missing = await run(t, rec(), { directory: path.join(os.tmpdir(), 'missing-review-' + process.pid + Date.now()) });
  assert.equal(missing.check.state, 'unknown'); assert.equal(missing.check.sourceAvailable, false); assert.equal(missing.summary.functions[0].status, 'unknown');
  const offline = await run(t, rec(), { inspect: async () => { throw new Error('gateway unavailable'); } });
  assert.equal(offline.check.state, 'unknown'); assert.equal(offline.check.sourceAvailable, true);
});
test('update baseline pins the exact bound id and current version, retaining structural differences', async t => {
  const requested = [];
  const result = await run(t, rec({ updateOf: 'skill:target' }), { fetchJson: async route => {
    requested.push(route);
    if (route === '/api/skills/target') return { slug: 'target', display_name: 'Original', current_version: 'v1.0.1', description: 'Old purpose', category: 'Old' };
    if (route === '/api/skills/target/structure?version=v1.0.1') return graph({ version: 'v1.0.1', components: [{ id: 'check', name: 'Check', kind: 'script', path: 'scripts/old.py', status: 'ready' }] });
    throw new Error('must not guess same-name resource');
  } });
  assert.deepEqual(requested, ['/api/skills/target', '/api/skills/target/structure?version=v1.0.1']);
  assert.equal(result.update.state, 'available'); assert.equal(result.update.target.id, 'skill:target'); assert.equal(result.update.target.version, 'v1.0.1');
  assert.ok(result.update.changes.some(change => change.field === 'functions' && change.before.some(value => value.includes('scripts/old.py')) && change.after.some(value => value.includes('scripts/check.py'))));
});
test('missing bound baseline is unavailable, while a new submission has no guessed update', async t => {
  const result = await run(t, rec({ updateOf: 'skill:deleted' }));
  assert.equal(result.update.state, 'unavailable'); assert.equal(result.update.target.id, 'skill:deleted'); assert.deepEqual(result.update.changes, []);
  const fresh = await run(t, rec()); assert.equal(fresh.update, undefined);
});
test('tool baseline uses only the exact tool binding and compares display metadata', async t => {
  const result = await run(t, rec({ kind: 'link', url: 'https://example.test/new', updateOf: 'tool:up2', tags: ['new'], report: { verdict: 'ok' } }), { tools: [{ id: 'up1', name: 'Project', desc: 'Wrong target' }, { id: 'up2', name: 'Original tool', desc: 'Old tool', url: 'https://example.test/old', tags: ['old'], type: 'external', status: 'online' }] });
  assert.equal(result.resourceType, 'tool'); assert.equal(result.update.target.id, 'tool:up2'); assert.equal(result.update.target.name, 'Original tool');
  assert.ok(result.update.changes.some(change => change.field === 'tags' && change.before[0] === 'old' && change.after[0] === 'new'));
});
test('verified graph kind wins over an obsolete submitted resource type', async t => {
  const result = await run(t, rec({ resourceType: 'agent' }), { inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ kind: 'skill' }), errors: [], warnings: [] }) });
  assert.equal(result.resourceType, 'skill');
});
test('malformed live graphs never produce a complete check', async t => {
  for (const structure of [graph({ kind: 'tool' }), graph({ source: null }), graph({ schemaVersion: '1' }), graph({ components: [null] }), graph({ steps: [{ id: 'bad', targets: null }] }), graph({ slug: '' })]) {
    const result = await run(t, rec(), { inspect: async () => ({ root: '', entry: 'SKILL.md', structure, errors: [], warnings: [] }) });
    assert.equal(result.check.state, 'unknown');
  }
});
test('update comparisons are readable without parsing raw JSON', async t => {
  const result = await run(t, rec({ updateOf: 'skill:target' }), { fetchJson: async route => route.includes('/structure?') ? graph({ version: 'v1.0.1', components: [] }) : { slug: 'target', current_version: 'v1.0.1', display_name: 'Original' } });
  for (const change of result.update.changes) for (const value of [...change.before, ...change.after]) assert.doesNotMatch(value, /^\{[\s\S]*\}$/);
});
test('manifest versions colliding with the current or any historical version block review', async t => {
  for (const versions of [[], [{ version: 'v1.0.2' }]]) {
    const current = versions.length ? 'v1.0.3' : 'v1.0.2';
    const result = await run(t, rec({ updateOf: 'skill:target' }), { fetchJson: async route => route.includes('/structure?') ? graph({ version: current }) : { slug: 'target', current_version: current, versions } });
    assert.equal(result.check.state, 'blocked'); assert.ok(result.check.issues.some(item => item.level === 'error' && /版本/.test(item.message)));
    assert.equal(result.update.state, 'available');
  }
});
test('legacy update review reports the submitted version that approval will try', async t => {
  const result = await run(t, rec({ updateOf: 'skill:target', updateVersion: '9.2.8' }), {
    inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ kind: 'skill', source: 'legacy' }), errors: [], warnings: [] }),
    fetchJson: async route => route.includes('/structure?') ? graph({ version: 'v1.0.1' }) : { slug: 'target', current_version: 'v1.0.1' },
  });
  assert.equal(result.update.proposedVersion, '9.2.8');
});
test('readable step differences resolve qualified targets and never guess an ambiguous bare id', async t => {
  const collisionGraph = graph({ components: [{ id: 'check', name: 'Package check', kind: 'script', path: 'scripts/check.py', status: 'ready' }], dependencies: [{ id: 'check', name: 'Registry check', slug: 'lookup', required: true, status: 'ready' }], steps: [{ id: 's1', task: 'Check materials', executor: 'dispatch', targets: ['component:check', 'dependency:check', 'check'] }] });
  const result = await run(t, rec({ updateOf: 'skill:target' }), {
    inspect: async () => ({ root: '', entry: 'SKILL.md', structure: collisionGraph, errors: [], warnings: [] }),
    fetchJson: async route => route.includes('/structure?') ? graph({ version: 'v1.0.1', steps: [] }) : { slug: 'target', current_version: 'v1.0.1' },
  });
  const change = result.update.changes.find(item => item.field === 'steps');
  assert.match(change.after[0], /Package check、Registry check、目标无法确认（check）/);
});
test('review record projects the same submitted metadata and safely deep copies only public report fields', async t => {
  const record = rec({ u: 'uploader', n: 'Uploader', d: 'Operations', resourceType: 'agent', filename: 'current.zip', sizeMB: 1.2,
    icon: '核', iconUrl: '/files/uploads/icons/current.png', iconBg: '#123456', url: 'https://example.test/current', departments: ['Operations'], tags: ['check'], category: 'Review',
    createdAt: 1, submittedAt: 2, approvedAt: 3, rejectedAt: 4, rejectReason: 'Fix this', deployedUrl: '/files/current', deployError: 'Fixture error', healthCheck: { at: 5, status: 404, entry: '/index.html', cachePath: 'PRIVATE_HEALTH_PATH' }, publishSlug: 'target', updateOf: 'skill:target', updateNote: 'Current update note', updateVersion: '2.0.0', rekindNote: 'Current type note',
    smartAnalysis: { modelContext: 'PRIVATE_MODEL_CONTEXT' }, smartChoices: { choice: 'PRIVATE_CHOICES' }, smartAnalysisSourceHash: 'PRIVATE_SOURCE_HASH', sourcePath: 'PRIVATE_SOURCE_PATH', apiKey: 'PRIVATE_SECRET',
    report: { verdict: 'warn', lines: ['Current parse line'], entry: 'bundle/index.html', warns: 1,
      rules: [{ id: 'A2', level: 'warn', msg: 'Check current dependency', fix: 'Confirm target', apiKey: 'PRIVATE_RULE_SECRET' }],
      structure: { ...graph(), modelContext: 'PRIVATE_GRAPH_CONTEXT', components: [{ ...graph().components[0], cachePath: 'PRIVATE_COMPONENT_PATH' }] },
      assistance: { manifestYaml: 'PRIVATE_MANIFEST', modelContext: 'PRIVATE_ASSISTANCE_CONTEXT' }, serverCache: 'PRIVATE_REPORT_PATH' },
  });
  const before = JSON.stringify(record), result = await run(t, record);
  assert.ok(result.record, 'review must return its own record snapshot');
  for (const key of ['id', 'u', 'n', 'd', 'kind', 'resourceType', 'packageRevision', 'filename', 'sizeMB', 'name', 'desc', 'icon', 'iconUrl', 'iconBg', 'url', 'status', 'departments', 'tags', 'category', 'createdAt', 'submittedAt', 'approvedAt', 'rejectedAt', 'rejectReason', 'deployedUrl', 'deployError', 'publishSlug', 'updateOf', 'updateNote', 'updateVersion', 'rekindNote']) assert.deepEqual(result.record[key], record[key], key);
  assert.deepEqual(result.record.healthCheck, { at: 5, status: 404 });
  assert.equal(result.record.report.entry, 'bundle/index.html'); assert.deepEqual(result.record.report.lines, ['Current parse line']);
  assert.equal(result.record.report.rules[0].fix, 'Confirm target'); assert.equal(result.record.report.structure.components[0].path, 'scripts/check.py');
  assert.doesNotMatch(JSON.stringify(result.record), /PRIVATE_/);
  result.record.departments.push('Changed response'); result.record.report.lines.push('Changed response'); result.record.report.structure.components[0].name = 'Changed response';
  assert.equal(JSON.stringify(record), before, 'record projection must not share nested mutable objects');
});
test('review record strips absolute server paths while keeping safe package-relative graph paths', async t => {
  const result = await run(t, rec({ report: { verdict: 'ok', lines: [], entry: 'C:\\private-cache\\index.html', structure: graph({ components: [{ id: 'unsafe', name: 'Unsafe path', kind: 'script', path: '/tmp/private-cache/run.py', status: 'ready' }, { id: 'safe', name: 'Safe path', kind: 'script', path: 'scripts/run.py', status: 'ready' }] }) } }));
  assert.ok(result.record, 'review must return a safe record snapshot');
  assert.equal(result.record.report.entry, undefined); assert.equal(result.record.report.structure.components[0].path, undefined);
  assert.equal(result.record.report.structure.components[1].path, 'scripts/run.py'); assert.doesNotMatch(JSON.stringify(result.record), /private-cache/);
});
test('live runtime requirements are preserved as unverified environment notices, never registry functions', async t => {
  const requirements = ['Browser with network access', 'Host API credential'];
  const record = rec({ report: { structure: graph({ runtimeRequirements: ['Old snapshot requirement'] }) } });
  const result = await run(t, record, { inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ runtimeRequirements: requirements }), errors: [], warnings: [] }) });
  assert.deepEqual(result.summary.runtimeRequirements, requirements); assert.equal(result.check.state, 'attention');
  assert.ok(result.check.issues.some(issue => issue.level === 'warn' && /未验证|未核实/.test(issue.message)));
  assert.deepEqual(result.record.report.structure.runtimeRequirements, ['Old snapshot requirement']);
  assert.equal(result.summary.functions.length, 2); assert.ok(!result.summary.functions.some(item => requirements.includes(item.name)));
});
test('source expiration may show declared runtime requirements but stays unknown, and required missing still blocks', async t => {
  const requirements = ['Browser'];
  const missingSource = await run(t, rec({ report: { structure: graph({ runtimeRequirements: requirements }) } }), { directory: path.join(os.tmpdir(), 'absent-runtime-' + process.pid + Date.now()) });
  assert.deepEqual(missingSource.summary.runtimeRequirements, requirements); assert.equal(missingSource.check.state, 'unknown');
  const missingFunction = await run(t, rec(), { inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ runtimeRequirements: requirements, dependencies: [{ id: 'missing', name: 'Missing internal function', required: true, status: 'missing' }] }), errors: [], warnings: [] }) });
  assert.equal(missingFunction.check.state, 'blocked'); assert.deepEqual(missingFunction.summary.runtimeRequirements, requirements);
});
test('runtime version differences use exact live and pinned baseline graphs, and malformed live declarations are unknown', async t => {
  const record = rec({ updateOf: 'skill:target', report: { structure: graph({ runtimeRequirements: ['Wrong old record requirement'] }) } });
  const result = await run(t, record, {
    inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ runtimeRequirements: ['Current host environment'] }), errors: [], warnings: [] }),
    fetchJson: async route => route.includes('/structure?') ? graph({ version: 'v1.0.1', runtimeRequirements: ['Exact baseline environment'] }) : { slug: 'target', current_version: 'v1.0.1' },
  });
  const change = result.update.changes.find(item => item.field === 'runtimeRequirements'); assert.ok(change);
  assert.deepEqual(change.before, ['Exact baseline environment']); assert.deepEqual(change.after, ['Current host environment']); assert.equal(result.check.state, 'attention');
  for (const runtimeRequirements of [null, {}, [''], ['a'.repeat(257)], ['Runtime\u0001environment']]) {
    const invalid = await run(t, rec(), { inspect: async () => ({ root: '', entry: 'SKILL.md', structure: graph({ runtimeRequirements }), errors: [], warnings: [] }) });
    assert.equal(invalid.check.state, 'unknown');
  }
  const malformedSnapshot = await run(t, rec({ report: { structure: graph({ runtimeRequirements: { modelContext: 'PRIVATE_INVALID_RUNTIME' } }) } }));
  assert.equal(malformedSnapshot.check.state, 'unknown'); assert.ok(malformedSnapshot.check.issues.some(issue => /环境.*格式/.test(issue.message)));
  assert.doesNotMatch(JSON.stringify(malformedSnapshot.record), /PRIVATE_INVALID_RUNTIME/);
  assert.deepEqual((await run(t, rec())).summary.runtimeRequirements, []);
});
