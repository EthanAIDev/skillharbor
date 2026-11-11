const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPreparedManifest, preparationReport, stageValidatedPackage } = require('../server/lib/package-preparation.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-prepare-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('zeb-prepare-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'bundle'));
  fs.writeFileSync(path.join(dir, 'bundle', 'SKILL.md'), 'main original bytes');
  fs.writeFileSync(path.join(dir, 'bundle', 'asset.bin'), Buffer.from([0, 255, 7, 9]));
  return dir;
}

test('applying a prepared manifest preserves entry, binary files and exact existing filename', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'bundle', 'AGENT.YAML'), 'old manifest');
  let committed = false;
  applyPreparedManifest(dir, { root: 'bundle', manifestPath: 'bundle/AGENT.YAML', manifestYaml: 'schemaVersion: 1\n' }, () => { committed = true; });
  assert.equal(committed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'bundle', 'AGENT.YAML'), 'utf8'), 'schemaVersion: 1\n');
  assert.equal(fs.readFileSync(path.join(dir, 'bundle', 'SKILL.md'), 'utf8'), 'main original bytes');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'bundle', 'asset.bin')), Buffer.from([0, 255, 7, 9]));
  assert.equal(fs.readdirSync(path.join(dir, 'bundle')).length, 3);
});

test('failed metadata persistence restores the exact previous manifest', t => {
  const dir = fixture(t);
  const target = path.join(dir, 'bundle', 'agent.yaml');
  const original = Buffer.from([239,187,191,35,32,111,108,100,13,10]);
  fs.writeFileSync(target, original);
  assert.throws(() => applyPreparedManifest(dir, { root: 'bundle', manifestPath: 'bundle/agent.yaml', manifestYaml: 'new' }, () => { throw new Error('disk full'); }), /disk full/);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.readdirSync(path.join(dir, 'bundle')).length, 3);
});

test('failed first application removes only its new manifest', t => {
  const dir = fixture(t);
  assert.throws(() => applyPreparedManifest(dir, { root: 'bundle', manifestPath: 'bundle/agent.yaml', manifestYaml: 'new' }, () => { throw new Error('save failed'); }), /save failed/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bundle')).sort(), ['SKILL.md', 'asset.bin']);
});

test('manifest edits cannot overwrite another file or escape the selected package', t => {
  const dir = fixture(t);
  for (const name of ['bundle/SKILL.md', '../agent.yaml', 'elsewhere/agent.yaml', '/agent.yaml']) {
    assert.throws(() => applyPreparedManifest(dir, { root: 'bundle', manifestPath: name, manifestYaml: 'bad' }, () => {}));
  }
  assert.equal(fs.readFileSync(path.join(dir, 'bundle', 'SKILL.md'), 'utf8'), 'main original bytes');
});

test('a report remains blocked until the user applies a valid inspected draft', () => {
  const assistance = { root: 'bundle', manifestPath: 'bundle/agent.yaml', manifestYaml: 'x', errors: [], warnings: [], inspection: { root: 'bundle', entry: 'main/SKILL.md', structure: { kind: 'agent', components: [], dependencies: [] }, names: ['sample'], errors: [], warnings: [] } };
  assert.equal(preparationReport(assistance, false).verdict, 'fail');
  assert.ok(preparationReport(assistance, false).rules.some(r => r.level === 'error'));
  assert.equal(preparationReport(assistance, true).verdict, 'ok');
  const blocked = preparationReport({ ...assistance, inspection: { ...assistance.inspection, errors: ['Missing required dependency'] } }, true);
  assert.equal(blocked.verdict, 'fail');
  assert.ok(blocked.rules.some(r => r.msg.includes('Missing required dependency')));
});

test('staging rejects unsafe paths and preserves all safe sibling files', t => {
  const dir = fixture(t);
  assert.throws(() => stageValidatedPackage(path.join(dir, 'unsafe'), [{ name: '../escape.txt', data: Buffer.from('bad') }]));
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
  const destination = path.join(dir, 'staged');
  stageValidatedPackage(destination, [{ name: 'main/SKILL.md', data: Buffer.from('main') }, { name: 'scripts/run.py', data: Buffer.from('print(1)') }]);
  assert.equal(fs.readFileSync(path.join(destination, 'scripts/run.py'), 'utf8'), 'print(1)');
});
