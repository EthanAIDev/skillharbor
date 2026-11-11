const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAnalysis, publicAnalysis, newResourceIdentity, validateChoices, analyzeDraft } = require('../server/lib/smart-upload.cjs');

const sample = () => ({ status: 'question', kind: 'skill', identity: 'example', resource: { name: '示例', description: '整理资料', functions: [] }, question: { id: 'entry', prompt: '主要做什么？', options: [{ id: 'a', label: '编写报告', description: '生成新报告' }] }, issues: [], repairText: '', modelContext: { files: ['private uploaded text'] } });
test('an invalid upstream analysis cannot become a publishable or answerable result', () => {
  assert.equal(validateAnalysis(sample()).status, 'question');
  for (const patch of [{ status: 'complete' }, { resource: null }, { kind: 'unknown' }, { question: { id: 'x', prompt: '', options: [] } }, { issues: [null] }]) assert.throws(() => validateAnalysis({ ...sample(), ...patch }));
});
test('the browser summary excludes model context while retaining the actual business question', () => {
  const result = publicAnalysis(sample());
  assert.equal(result.modelContext, undefined);
  assert.equal(result.question.options[0].label, '编写报告');
  assert.equal(sample().modelContext.files[0], 'private uploaded text');
});
test('runtime requirements are validated, normalized and retained without exposing model context', () => {
  const result = validateAnalysis({ ...sample(), runtimeRequirements: ['  Browser with network access  ', 'API credential configured by the host', 'Browser with network access', '😀'.repeat(256)] });
  assert.deepEqual(result.runtimeRequirements, ['Browser with network access', 'API credential configured by the host', '😀'.repeat(256)]);
  const safe = publicAnalysis(result); assert.deepEqual(safe.runtimeRequirements, result.runtimeRequirements); assert.equal(safe.modelContext, undefined);
  assert.deepEqual(validateAnalysis(sample()).runtimeRequirements, []);
  assert.deepEqual(validateAnalysis({ ...sample(), runtimeRequirements: ['\uFEFF Browser \uFEFF', 'Browser'] }).runtimeRequirements, ['Browser']);
  assert.deepEqual(validateAnalysis({ ...sample(), runtimeRequirements: Array(128).fill('Browser') }).runtimeRequirements, ['Browser']);
  for (const runtimeRequirements of [null, {}, 'Browser', [null], [1], [''], ['  '], ['a'.repeat(257)], ['😀'.repeat(257)], Array(129).fill('Browser'), ['Browser\u0000tool'], ['Browser\u0085tool'], ['\nBrowser\n']]) assert.throws(() => validateAnalysis({ ...sample(), runtimeRequirements }));
});
test('invalid Unicode scalars cannot enter ready analysis or its browser response', () => {
  for (const name of ['\uD800', '\uDFFF', '\uDC00\uD800', 'tool\uD800name']) {
    const result = { ...sample(), status: 'ready', runtimeRequirements: [name] };
    assert.throws(() => validateAnalysis(result));
    assert.throws(() => publicAnalysis(result));
  }
  assert.deepEqual(validateAnalysis({ ...sample(), runtimeRequirements: ['😀'.repeat(256)] }).runtimeRequirements, ['😀'.repeat(256)]);
});

test('a new identity is stable for its draft and cannot introduce invalid slug characters', () => {
  assert.equal(newResourceIdentity('existing-agent', 'u123456789'), 'existing-agent-23456789');
  assert.equal(newResourceIdentity('existing-agent', 'u123456789'), newResourceIdentity('existing-agent', 'u123456789'));
  assert.match(newResourceIdentity('a'.repeat(200), 'u123456789'), /^[a-z0-9][a-z0-9-]{0,119}$/);
  assert.throws(() => newResourceIdentity('../../escape', 'u123456789'));
});
test('question answers must be a bounded plain mapping of opaque identifiers', () => {
  assert.deepEqual(validateChoices({ entry: 'option-a' }), { entry: 'option-a' });
  for (const bad of [[], 'a', { x: {} }, { x: 'a'.repeat(513) }, JSON.parse('{"__proto__":"a"}')]) assert.throws(() => validateChoices(bad));
});

test('tool identity questions cannot turn a valid original parse into a permanent error', async () => {
  for (const answer of ['new', 'update']) {
    const rec = { id: 'utool1234', kind: 'web', filename: 'sample.html', parsedNames: ['示例工具'], packageRevision: 0, status: 'draft', report: { verdict: 'ok', rules: [], lines: [] } };
    const options = { rec, user: { username: 'owner', name: '负责人' }, directory: '', save: () => {}, lookupTarget: async () => ({ name: '示例工具', owned: true, uploadKind: 'web' }), findToolMatches: () => [{ id: 'tool-a', name: '示例工具' }], assertEditable: () => {} };
    const first = await analyzeDraft({ ...options, body: { revision: 0 } });
    assert.equal(first.analysis.status, 'question');
    assert.equal(rec.report.verdict, 'fail');
    const second = await analyzeDraft({ ...options, body: { revision: 1, choices: { 'publication-identity': answer } } });
    assert.equal(second.analysis.status, 'ready');
    assert.equal(rec.report.verdict, 'ok');
    assert.equal(rec.smartChoices['publication-identity'], undefined);
    const third = await analyzeDraft({ ...options, body: { revision: 2 } });
    assert.equal(third.analysis.status, 'ready');
    assert.equal(third.analysis.updateOf, answer === 'update' ? 'tool:tool-a' : '');
  }
});

test('an explicitly confirmed tool publication intent is not replaced by an old identity answer', async () => {
  const rec = { id: 'utool5678', kind: 'web', filename: 'sample.html', parsedNames: ['示例工具'], packageRevision: 0, status: 'draft', report: { verdict: 'ok', rules: [], lines: [] } };
  const options = { rec, user: { username: 'owner', name: '负责人' }, directory: '', save: () => {}, lookupTarget: async target => ({ name: target, owned: true, uploadKind: 'web' }), findToolMatches: () => [{ id: 'original', name: '示例工具' }], assertEditable: () => {} };
  await analyzeDraft({ ...options, body: { revision: 0 } });
  await analyzeDraft({ ...options, body: { revision: 1, choices: { 'publication-identity': 'update' } } });
  assert.equal(rec.updateOf, 'tool:original');
  await analyzeDraft({ ...options, body: { revision: 2, newResource: true } });
  await analyzeDraft({ ...options, body: { revision: 3 } });
  assert.equal(rec.updateOf, undefined);
  await analyzeDraft({ ...options, body: { revision: 4, updateOf: 'tool:other' } });
  await analyzeDraft({ ...options, body: { revision: 5 } });
  assert.equal(rec.updateOf, 'tool:other');
});

test('a fresh confirmed update inherits target settings and preserves later draft edits', async () => {
  const rec = { id: 'umeta1234', kind: 'web', filename: 'sample.html', parsedNames: ['示例工具'], packageRevision: 0, status: 'draft', report: { verdict: 'ok', rules: [], lines: [] } };
  const settings = { tags: ['既有标签'], departments: ['咨询部'], category: '既有分类', icon: '原', iconBg: '#123456' };
  const options = { rec, user: { username: 'owner', name: '负责人' }, directory: '', save: () => {}, lookupTarget: async () => ({ name: '原工具', owned: true, uploadKind: 'web', displayMetadata: settings }), findToolMatches: () => [], assertEditable: () => {} };
  const result = await analyzeDraft({ ...options, body: { revision: 0, updateOf: 'tool:original' } });
  assert.deepEqual(result.analysis.displayMetadata, settings);
  assert.deepEqual(rec.tags, ['既有标签']);
  assert.deepEqual(rec.departments, ['咨询部']);
  rec.tags = ['高级手改'];
  const next = await analyzeDraft({ ...options, body: { revision: 1 } });
  assert.deepEqual(next.analysis.displayMetadata.tags, ['高级手改']);
  assert.deepEqual(rec.tags, ['高级手改']);
});
test('strict inspection cannot drop a declared runtime requirement before the manifest is atomically applied', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
  const { collectSkillPackage } = require('../server/lib/skill-package.cjs');
  const { makeZip } = require('../server/lib/zip-writer.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-runtime-strict-'));
  const original = '---\nname: runtime-fixture\ndescription: Runtime fixture\n---\nOriginal instructions must remain unchanged.\n';
  fs.writeFileSync(path.join(directory, 'SKILL.md'), original);
  const requirements = ['Browser and host credential'];
  const manifest = { schemaVersion: 1, id: 'runtime-fixture', kind: 'skill', version: '1.0.0', entry: 'SKILL.md', components: [], dependencies: [], steps: [], runtimeRequirements: requirements };
  const structure = { ...manifest, source: 'manifest', slug: manifest.id, warnings: [] };
  const assistance = { root: '', manifestPath: 'agent.yaml', candidates: [], files: [], manifest, manifestYaml: JSON.stringify(manifest), errors: [], warnings: [], inspection: { root: '', entry: 'SKILL.md', structure, errors: [], warnings: [] }, needsSelection: false };
  const analysis = { status: 'ready', kind: 'skill', identity: manifest.id, resource: { name: 'Runtime fixture', description: 'Runtime fixture', functions: [] }, runtimeRequirements: requirements, issues: [], repairText: '', assistance };
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(analysis)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const record = { id: 'uruntimefixture', kind: 'skill', status: 'draft', packageRevision: 0, report: { verdict: 'ok' } }, before = JSON.stringify(record);
  let saves = 0;
  const options = { rec: record, user: { username: 'owner', name: 'Owner' }, body: { revision: 0 }, directory, gatewayBase: `http://127.0.0.1:${server.address().port}`, headers: {}, collect: collectSkillPackage, makeZip,
    lookupTarget: async () => null, findSkillMatches: async () => [], proposeAI: async () => ({}), assertEditable: () => {}, save: () => { saves++; } };
  for (const runtimeRequirements of [[], null]) {
    await assert.rejects(analyzeDraft({ ...options, inspect: async () => ({ root: '', entry: 'SKILL.md', errors: [], warnings: [], structure: { ...structure, runtimeRequirements } }) }), /运行环境|环境要求/);
    assert.equal(JSON.stringify(record), before); assert.equal(saves, 0); assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), original); assert.equal(fs.existsSync(path.join(directory, 'agent.yaml')), false);
  }
  const result = await analyzeDraft({ ...options, inspect: async () => ({ root: '', entry: 'SKILL.md', errors: [], warnings: [], structure }) });
  assert.deepEqual(result.analysis.runtimeRequirements, requirements); assert.deepEqual(result.report.structure.runtimeRequirements, requirements);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'agent.yaml'), 'utf8')).runtimeRequirements, requirements); assert.equal(saves, 1); assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), original);
});
