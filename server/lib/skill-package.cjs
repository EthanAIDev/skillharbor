const fs = require('node:fs');
const path = require('node:path');

function safeRelative(value, allowEmpty = false) {
  if (typeof value !== 'string' || (!value && !allowEmpty) || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').some(p => p === '..' || p === '.')) {
    throw new Error('技能包路径无效，请重新上传');
  }
  return value;
}

/** Use the root chosen by the gateway inspector, never search again for a SKILL.md. */
function collectSkillPackage(sessionDir, packageRoot, entry) {
  safeRelative(packageRoot, true);
  if (entry !== null) safeRelative(entry);
  const session = fs.realpathSync(sessionDir);
  const root = path.resolve(session, packageRoot);
  const within = (base, target) => target === base || target.startsWith(base + path.sep);
  if (!within(session, root) || !within(session, fs.realpathSync(root))) throw new Error('技能包根目录越界');
  // Reject symlinks even when their destination happens to remain inside the package.
  for (const [part, base] of [[packageRoot, session], [entry || '', root]]) {
    let current = base;
    for (const segment of part.split('/').filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('技能包不支持符号链接');
    }
  }
  if (entry !== null && !fs.statSync(path.join(root, entry)).isFile()) throw new Error('技能包入口已过期，请重新上传');
  const files = [];
  const walk = dir => {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === session && ['_shots', '_docs'].includes(file.name)) continue;
      const full = path.join(dir, file.name);
      if (file.isSymbolicLink()) throw new Error('技能包不支持符号链接');
      if (file.isDirectory()) walk(full);
      else if (file.isFile()) files.push({ name: path.relative(root, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
    }
  };
  walk(root);
  return files;
}

function nextSkillVersion(version) {
  const parts = String(version || '').replace(/^v/i, '').split('.').map(value => parseInt(value, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, (parts[2] || 0) + 1].join('.');
}

async function inspectSkillArchive(base, headers, zipBuffer, slug) {
  const form = new FormData();
  form.append('file', new Blob([zipBuffer]), 'skill-package.zip');
  if (slug) form.append('slug', slug);
  const response = await fetch(base + '/api/skills/inspect', { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof result.detail === 'string' ? result.detail : result.message || `技能包检查失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  if (!result.structure || typeof result.root !== 'string' || !result.entry) throw new Error('技能中心未返回有效包结构，请检查服务版本');
  safeRelative(result.root, true);
  safeRelative(result.entry);
  return result;
}

module.exports = { collectSkillPackage, inspectSkillArchive, nextSkillVersion, safeRelative };
