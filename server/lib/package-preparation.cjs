const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeRelative } = require('./skill-package.cjs');

function manifestPath(assistance) {
  const root = safeRelative(assistance.root, true);
  const name = safeRelative(assistance.manifestPath || [root, 'agent.yaml'].filter(Boolean).join('/'));
  const parts = name.split('/');
  if (parts.pop().toLowerCase() !== 'agent.yaml' || parts.join('/') !== root) throw new Error('只允许修改所选包根的 agent.yaml');
  if (name.includes('\0')) throw new Error('清单路径无效');
  return name;
}

async function prepareSkillArchive(base, headers, zipBuffer, options = {}) {
  const form = new FormData();
  form.append('file', new Blob([zipBuffer]), 'skill-package.zip');
  if (options.entry) form.append('entry', options.entry);
  if (options.manifest !== undefined) form.append('manifest', JSON.stringify(options.manifest));
  if (options.slug) form.append('slug', options.slug);
  if (options.regenerate === true) form.append('regenerate', 'true');
  const response = await fetch(base + '/api/skills/prepare', { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof result.detail === 'string' ? result.detail : result.message || `结构修正暂不可用（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  if (typeof result.root !== 'string' || !Array.isArray(result.candidates) || !Array.isArray(result.files) || !Array.isArray(result.errors) || !Array.isArray(result.warnings)) throw new Error('技能中心未返回有效的结构修正结果');
  safeRelative(result.root, true);
  for (const item of [...result.files, ...result.candidates]) safeRelative(item.path);
  if (result.manifestYaml) {
    manifestPath(result);
    if (typeof result.manifestYaml !== 'string' || Buffer.byteLength(result.manifestYaml) > 2 * 1024 * 1024) throw new Error('包清单超过 2MB 限制');
  }
  return result;
}

function preparationReport(assistance, applied) {
  const inspected = assistance.inspection;
  const errors = [...new Set([...(assistance.errors || []), ...(inspected?.errors || [])])];
  const warnings = [...new Set([...(assistance.warnings || []), ...(inspected?.warnings || [])])];
  if (!applied) errors.unshift(assistance.needsSelection ? '请选择主入口，确认结构并应用清单后再提交审核' : '请确认结构并应用清单后再提交审核');
  if (applied && !inspected) errors.unshift('包结构尚未通过检查');
  const entry = inspected ? [inspected.root, inspected.entry].filter(Boolean).join('/') : null;
  return {
    verdict: errors.length ? 'fail' : warnings.length ? 'warn' : 'ok',
    lines: [applied ? '✓ 已应用包清单并重新检查' : '✓ 原文件已保存在草稿中，等待确认结构', ...errors.map(x => '✗ ' + x), ...warnings.map(x => '⚠ ' + x)],
    entry, warns: warnings.length,
    rules: [...errors.map(msg => ({ id: 'A3', level: 'error', msg, fix: '在结构修正区完成调整并重新检查' })), ...warnings.map(msg => ({ id: 'A2', level: 'warn', msg, fix: '请核对依赖状态' }))],
    ...(inspected ? { packageRoot: inspected.root, packageEntry: inspected.entry, structure: inspected.structure } : {}),
    assistance,
  };
}

/** The caller must first have the gateway validate archive safety. This second boundary protects the local filesystem. */
function stageValidatedPackage(destination, entries) {
  if (fs.existsSync(destination)) throw new Error('上传草稿目录已存在');
  const seen = new Set();
  for (const entry of entries) {
    safeRelative(entry.name);
    if (entry.name.includes('\0') || seen.has(entry.name.toLowerCase())) throw new Error('压缩包包含冲突路径');
    seen.add(entry.name.toLowerCase());
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.resolve(destination, entry.name);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('上传文件路径越界');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { flag: 'wx' });
  }
}

/** Replace one generated manifest. A failed metadata commit restores the original file byte-for-byte. */
function applyPreparedManifest(sessionDir, assistance, commit) {
  const relative = manifestPath(assistance);
  if (typeof assistance.manifestYaml !== 'string' || !assistance.manifestYaml) throw new Error('尚未生成可应用的清单');
  const root = fs.realpathSync(sessionDir);
  const target = path.resolve(root, relative);
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('包清单路径不支持符号链接');
  }
  if (!target.startsWith(root + path.sep) || !fs.realpathSync(path.dirname(target)).startsWith(root + path.sep) && path.dirname(target) !== root) throw new Error('包清单路径越界');
  if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error('包清单必须是普通文件');
  const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const temporary = target + '.prepare-' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, assistance.manifestYaml, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    try { commit(); }
    catch (error) {
      if (previous === null) fs.unlinkSync(target);
      else {
        fs.writeFileSync(temporary, previous, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, target);
      }
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { prepareSkillArchive, preparationReport, stageValidatedPackage, applyPreparedManifest, manifestPath };
