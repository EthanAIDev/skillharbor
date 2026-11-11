const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSkillPackage, nextSkillVersion } = require('../server/lib/skill-package.cjs');

test('legacy auto-patch preserves a v-prefixed major version', () => {
  assert.equal(nextSkillVersion('v3.4.9'), '3.4.10');
  assert.equal(nextSkillVersion('1.0.0'), '1.0.1');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeb-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (p, text = p) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); };
  put('bundle/agent.yaml'); put('bundle/main/SKILL.md'); put('bundle/internal-skills/calc.md'); put('bundle/scripts/calc.py'); put('_shots/preview.png');
  return { dir, put };
}
test('publishes the inspected package root including sibling components', t => {
  const { dir } = fixture(t);
  const files = collectSkillPackage(dir, 'bundle', 'main/SKILL.md');
  assert.deepEqual(files.map(f => f.name).sort(), ['agent.yaml', 'internal-skills/calc.md', 'main/SKILL.md', 'scripts/calc.py']);
});
test('empty root excludes portal materials, keeps all business files', t => {
  const { dir, put } = fixture(t); put('SKILL.md'); put('_docs/manual.pdf');
  const names = collectSkillPackage(dir, '', 'SKILL.md').map(f => f.name);
  assert.ok(names.includes('bundle/scripts/calc.py'));
  assert.ok(!names.some(n => n.startsWith('_shots/') || n.startsWith('_docs/')));
});
test('rejects a root or entry escaping the upload session', t => {
  const { dir } = fixture(t);
  for (const root of ['../', '..\\', '/tmp', 'C:/outside']) assert.throws(() => collectSkillPackage(dir, root, 'SKILL.md'));
  assert.throws(() => collectSkillPackage(dir, 'bundle', '../SKILL.md'));
  assert.throws(() => collectSkillPackage(dir, 'bundle', 'missing.md'));
});
