const { collectSkillPackage, nextSkillVersion, safeRelative } = require('./skill-package.cjs');
const { makeZip } = require('./zip-writer.cjs');
const crypto = require('node:crypto');
const { normalizeRuntimeRequirements } = require('./smart-upload.cjs');

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const revisionOf = rec => Number.isInteger(rec.packageRevision) ? rec.packageRevision : 0;
const reviewTokenOf = rec => crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex');
const matchesReviewToken = (rec, body) => !Object.hasOwn(body, 'reviewToken') || typeof body.reviewToken === 'string' && /^[a-f0-9]{64}$/.test(body.reviewToken) && body.reviewToken === reviewTokenOf(rec);
function runtimeRequirementsOf(value) {
  try { return normalizeRuntimeRequirements(value && Object.hasOwn(value, 'runtimeRequirements') ? value.runtimeRequirements : []); }
  catch { return null; }
}

const publicString = value => typeof value === 'string' ? value : undefined;
const publicNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const publicBoolean = value => typeof value === 'boolean' ? value : undefined;
const oneOf = values => value => values.includes(value) ? value : undefined;
const arrayOf = convert => value => Array.isArray(value) ? value.map(convert).filter(item => item !== undefined) : undefined;
const nullable = convert => value => value === null ? null : convert(value);
const publicPath = value => {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  try { return safeRelative(value, true); } catch { return undefined; }
};
const project = shape => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, convert] of Object.entries(shape)) if (Object.hasOwn(value, key)) {
    const safe = convert(value[key]);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
};
const publicStep = project({ id: publicString, task: publicString, executor: oneOf(['dispatch', 'self']), targets: arrayOf(publicString), input: publicString, output: publicString });
const publicGraph = project({
  schemaVersion: publicNumber, slug: publicString, version: publicString, kind: oneOf(['agent', 'skill']), source: oneOf(['manifest', 'legacy']), entry: publicPath,
  components: arrayOf(project({ id: publicString, name: publicString, kind: oneOf(['skill', 'script']), path: publicPath, visibility: oneOf(['internal', 'public']), status: publicString })),
  dependencies: arrayOf(project({ id: publicString, name: publicString, source: oneOf(['registry']), slug: publicString, required: publicBoolean, status: publicString, candidates: arrayOf(publicString) })),
  steps: arrayOf(publicStep), warnings: arrayOf(publicString), runtimeRequirements: value => runtimeRequirementsOf({ runtimeRequirements: value }) || undefined,
});
const publicReport = project({
  verdict: oneOf(['ok', 'warn', 'fail']), lines: arrayOf(publicString), entry: nullable(publicPath), warns: publicNumber,
  rules: arrayOf(project({ id: publicString, level: oneOf(['error', 'warn']), msg: publicString, fix: publicString })), structure: publicGraph,
});
const recordStrings = ['id', 'u', 'n', 'd', 'filename', 'name', 'desc', 'icon', 'iconUrl', 'iconBg', 'url', 'category', 'rejectReason', 'deployedUrl', 'deployError', 'publishSlug', 'updateOf', 'updateNote', 'updateVersion', 'rekindNote'];
const recordNumbers = ['packageRevision', 'sizeMB', 'createdAt', 'submittedAt', 'approvedAt', 'rejectedAt'];
const publicRecord = project({
  ...Object.fromEntries(recordStrings.map(key => [key, publicString])), ...Object.fromEntries(recordNumbers.map(key => [key, publicNumber])),
  kind: oneOf(['web', 'skill', 'file', 'link', 'service']), resourceType: oneOf(['agent', 'skill', 'tool']),
  status: oneOf(['draft', 'pending', 'deploying', 'deploy_failed', 'online', 'rejected', 'offline']), departments: arrayOf(publicString), tags: arrayOf(publicString),
  healthCheck: project({ at: publicNumber, status: value => typeof value === 'string' ? value : publicNumber(value) }), report: publicReport,
});

// This display projection belongs to the same immutable selected record as the
// review token. Explicit schemas prevent future private report fields leaking.
const reviewRecordOf = rec => ({ ...publicRecord(rec), packageRevision: revisionOf(rec) });
function validGraph(graph) {
  return graph && graph.schemaVersion === 1 && ['manifest', 'legacy'].includes(graph.source) && ['agent', 'skill'].includes(graph.kind) && text(graph.slug) && text(graph.version) && text(graph.entry)
    && Array.isArray(graph.components) && graph.components.every(item => item && text(item.id) && text(item.path) && ['skill', 'script'].includes(item.kind))
    && Array.isArray(graph.dependencies) && graph.dependencies.every(item => item && text(item.id) && typeof item.required === 'boolean')
    && Array.isArray(graph.steps) && graph.steps.every(item => item && text(item.id) && ['dispatch', 'self'].includes(item.executor) && Array.isArray(item.targets) && item.targets.every(target => typeof target === 'string'))
    && runtimeRequirementsOf(graph) !== null;
}

function functionsOf(graph, rec, live = true) {
  if (!graph) return list(rec.smartAnalysis?.resource?.functions).map((item, index) => ({
    id: text(item.id) || `snapshot-${index + 1}`, name: text(item.name), source: item.source === 'registry' ? 'registry' : 'package',
    kind: item.kind === 'script' ? 'script' : 'skill', status: 'unknown', required: item.required !== false,
    ...(item.path ? { path: text(item.path) } : {}), ...(item.slug ? { slug: text(item.slug) } : {}),
  }));
  const items = [
    ...list(graph.components).map(item => ({ id: text(item.id), name: text(item.name) || text(item.id), source: 'package', kind: item.kind === 'script' ? 'script' : 'skill', status: live ? text(item.status) || 'unknown' : 'unknown', required: true, path: text(item.path) })),
    ...list(graph.dependencies).map(item => ({ id: text(item.id), name: text(item.name) || text(item.slug) || text(item.id), source: 'registry', kind: 'skill', status: live ? text(item.status) || 'unknown' : 'unknown', required: item.required !== false, ...(item.slug ? { slug: text(item.slug) } : {}) })),
  ];
  if (graph.kind === 'skill' && !items.length) items.push({ id: 'entry', name: rec.name || graph.slug || '主技能', source: 'package', kind: 'skill', status: live ? 'ready' : 'unknown', required: true, path: text(graph.entry) });
  return items;
}

function summaryOf(rec, graph, live) {
  return { name: text(rec.name) || text(rec.smartAnalysis?.resource?.name) || text(graph?.slug), purpose: text(rec.desc) || text(rec.smartAnalysis?.resource?.description),
    runtimeRequirements: runtimeRequirementsOf(graph || (rec.kind === 'skill' ? rec.smartAnalysis : null)) || [],
    functions: functionsOf(graph, rec, live), steps: list(graph?.steps).map(step => ({ id: text(step.id), task: text(step.task), executor: step.executor === 'dispatch' ? 'dispatch' : 'self', targets: list(step.targets).map(text) })) };
}

function comparison(rec, graph) {
  const summary = summaryOf(rec, graph, true);
  // Include identity and path, not only display names. These are structure/metadata
  // comparisons: package contents are never executed or represented as a code diff.
  const values = {
    name: [summary.name], purpose: [summary.purpose],
    functions: summary.functions.filter(item => item.source === 'package').map(({ status, ...item }) => JSON.stringify(item)),
    dependencies: summary.functions.filter(item => item.source === 'registry').map(({ status, ...item }) => JSON.stringify(item)),
    steps: list(graph?.steps).map(step => JSON.stringify({ id: step.id, task: step.task, executor: step.executor, targets: step.targets, input: step.input || '', output: step.output || '' })),
    runtimeRequirements: summary.runtimeRequirements,
    entry: graph ? [text(graph.entry)] : [text(rec.report?.entry) || text(rec.filename)],
    resourceType: [graph?.kind || rec.kind || ''], category: [text(rec.category)], tags: list(rec.tags).map(text),
    departments: list(rec.departments).map(text), icon: [text(rec.icon)], iconUrl: [text(rec.iconUrl)], iconBg: [text(rec.iconBg)], url: [text(rec.url)],
  };
  const targetNames = new Map(summary.functions.map(item => [`${item.source === 'package' ? 'component' : 'dependency'}:${item.id}`, item.name]));
  for (const item of summary.functions) if (summary.functions.filter(candidate => candidate.id === item.id).length === 1) targetNames.set(item.id, item.name);
  const readable = { ...values,
    functions: summary.functions.filter(item => item.source === 'package').map(item => `${item.name}（包内${item.kind === 'script' ? '脚本' : '技能'}，${item.path || '未指定位置'}；标识 ${item.id}）`),
    dependencies: summary.functions.filter(item => item.source === 'registry').map(item => `${item.name}（平台技能，${item.slug ? '绑定 ' + item.slug : '未绑定固定资源'}；${item.required ? '必需' : '可选'}；标识 ${item.id}）`),
    steps: list(graph?.steps).map(step => `${step.task || step.id}（步骤 ${step.id}，${step.executor === 'dispatch' ? '分派执行' : '自行完成'}${step.targets?.length ? '：' + step.targets.map(target => targetNames.get(target) || `目标无法确认（${target}）`).join('、') : ''}${step.input ? '；输入：' + step.input : ''}${step.output ? '；产出：' + step.output : ''}）`),
  };
  return { values, readable };
}
const labels = { name: '名称', purpose: '用途', functions: '包内功能与路径', dependencies: '平台依赖', steps: '执行步骤', runtimeRequirements: '运行环境要求', entry: '入口路径', resourceType: '资源类型', category: '分类', tags: '业务标签', departments: '适用部门', icon: '图标文字', iconUrl: '图标图片', iconBg: '图标背景', url: '访问地址' };
function changesBetween(before, after) {
  return Object.keys(labels).filter(field => JSON.stringify(before.values[field]) !== JSON.stringify(after.values[field])).map(field => ({ field, label: labels[field], before: before.readable[field], after: after.readable[field] }));
}

/** Read-only, selected-record review. It inspects the exact staged package and
 * current registry state; submission snapshots are explicitly unverified fallbacks. */
async function buildUploadReview({ rec, directory, inspect, fetchJson, tools = [], uploads = [], skillDepartments = {} }) {
  const issues = [];
  const issue = (level, message) => { if (message && !issues.some(item => item.level === level && item.message === message)) issues.push({ level, message }); };
  let graph = rec.kind === 'skill' && validGraph(rec.report?.structure) ? rec.report.structure : null, live = false, sourceAvailable = false, unknown = false;
  if (rec.kind === 'skill' && runtimeRequirementsOf(rec.report?.structure || rec.smartAnalysis) === null) {
    unknown = true; issue('warn', '提交快照中的运行环境声明格式无效，请重新整理后审核。');
  }
  if (rec.kind === 'skill') {
    let bytes;
    try {
      const files = collectSkillPackage(directory, '', null);
      if (!files.length) throw new Error('empty package');
      bytes = makeZip(files); sourceAvailable = true;
    } catch {
      unknown = true; issue('warn', '暂存源文件已过期或无法安全读取；以下概览仅来自提交快照，尚未完成当前核查。');
    }
    if (bytes) {
      try {
        const inspected = await inspect(bytes, rec.updateOf?.startsWith('skill:') ? rec.updateOf.slice(6) : undefined);
        if (!validGraph(inspected.structure)) throw new Error('incomplete inspection');
        graph = inspected.structure; live = true;
        for (const message of list(inspected.errors)) issue('error', text(message));
        for (const message of [...list(inspected.warnings), ...list(graph.warnings)]) issue('warn', text(message));
        if (rec.report?.packageRoot !== undefined && (rec.report.packageRoot !== inspected.root || rec.report.packageEntry !== inspected.entry)) issue('error', '当前包入口与提交时不一致，请驳回后重新整理。');
        for (const item of functionsOf(graph, rec)) {
          if (item.status === 'unknown') { unknown = true; issue('warn', `「${item.name}」未返回当前可用状态。`); }
          else if (item.status !== 'ready') issue(item.required ? 'error' : 'warn', `「${item.name}」当前状态：${item.status}${item.required ? '（必需）' : '（可选）'}。`);
        }
      } catch (error) {
        if (error.status === 422 || error.status === 400) issue('error', '当前包未通过安全或结构核查：' + error.message);
        else { unknown = true; issue('warn', '技能中心暂不可用，未完成当前包与依赖核查；以下概览仅来自提交快照。'); }
      }
    }
  } else {
    if (rec.kind === 'link') sourceAvailable = /^https?:\/\//.test(rec.url || '');
    else {
      try {
        const files = collectSkillPackage(directory, '', null);
        sourceAvailable = files.length > 0;
        if (sourceAvailable && rec.report?.entry && !files.some(file => file.name === rec.report.entry)) issue('error', '暂存文件中未找到提交时的入口：' + rec.report.entry);
      } catch { sourceAvailable = false; }
    }
    if (!sourceAvailable) { unknown = true; issue('warn', '源文件或链接已不可用，尚未完成当前核查。'); }
    if (!rec.report?.verdict) { unknown = true; issue('warn', '缺少提交检查记录，请人工核对项目材料。'); }
    for (const rule of list(rec.report?.rules)) if (['error', 'warn'].includes(rule.level)) issue(rule.level, text(rule.msg));
    if (rec.report?.verdict === 'fail' && !issues.some(item => item.level === 'error')) issue('error', '提交时的项目检查未通过。');
    if (rec.report?.verdict === 'warn' && !issues.some(item => item.level === 'warn')) issue('warn', '提交检查存在提示，请核对原始材料。');
    issue('info', '已核对当前材料是否存在，并展示提交时的检查记录；未运行工具或探测外部链接。');
  }
  const summary = summaryOf(rec, graph, live);
  if (summary.runtimeRequirements.length) issue('warn', live ? '请核对运行环境要求，平台尚未验证其实际可用性。' : '显示的是提交快照中的运行环境要求，尚未验证实际可用性。');
  if (rec.kind !== 'skill') {
    summary.functions = [{ id: 'entry', name: { web: '网页工具', service: '服务端应用', file: '客户端程序', link: '链接工具' }[rec.kind] || '工具', source: 'package', kind: 'script', status: sourceAvailable ? 'ready' : 'unknown', required: true,
      ...(rec.report?.entry || rec.filename ? { path: rec.report?.entry || rec.filename } : {}) }];
    summary.steps = [];
  }
  let update;
  if (rec.updateOf) {
    update = { target: { id: rec.updateOf, name: rec.updateOf.split(':').slice(1).join(':') }, state: 'unavailable', changes: [] };
    try {
      let baseline, baselineGraph;
      if (rec.updateOf.startsWith('skill:')) {
        const slug = rec.updateOf.slice(6);
        const detail = await fetchJson('/api/skills/' + encodeURIComponent(slug));
        if (detail.slug !== slug || !text(detail.current_version)) throw new Error('bound resource is unavailable');
        update.target = { id: rec.updateOf, name: detail.display_name || detail.name || slug, version: detail.current_version };
        baselineGraph = await fetchJson(`/api/skills/${encodeURIComponent(slug)}/structure?version=${encodeURIComponent(detail.current_version)}`);
        if (!validGraph(baselineGraph) || baselineGraph.slug !== slug || text(baselineGraph.version).replace(/^v/i, '') !== detail.current_version.replace(/^v/i, '')) throw new Error('baseline version does not match');
        const prior = uploads.filter(item => item.kind === 'skill' && item.status === 'online' && item.publishSlug === slug).sort((a, b) => (b.updatedAt || b.approvedAt || b.createdAt || 0) - (a.updatedAt || a.approvedAt || a.createdAt || 0))[0] || {};
        baseline = { ...prior, name: update.target.name, desc: detail.description || prior.desc || '', kind: 'skill', category: detail.category || prior.category || '', departments: skillDepartments[slug] || prior.departments || ['全部'], tags: prior.tags || [] };
        update.proposedVersion = live && graph.source === 'manifest' ? graph.version : text(rec.updateVersion) || nextSkillVersion(detail.current_version);
        if (!live) throw new Error('proposed source is unverified');
        if (graph.source === 'manifest') {
          const proposed = text(graph.version).replace(/^v/i, '');
          const versions = [detail.current_version, ...list(detail.versions).map(item => typeof item === 'string' ? item : item?.version)];
          if (versions.some(version => text(version).replace(/^v/i, '') === proposed)) issue('error', `更新版本 ${graph.version} 已存在，请驳回后修改包清单版本。`);
        }
      } else if (rec.updateOf.startsWith('tool:')) {
        const target = tools.find(item => item.id === rec.updateOf.slice(5) && !item.deleted);
        if (!target) throw new Error('bound tool is unavailable');
        const prior = uploads.find(item => item.id === target.uploadId) || {};
        baseline = { ...prior, ...target, kind: { local: 'web', download: 'file', service: 'service' }[target.type] || 'link' };
        update.target = { id: rec.updateOf, name: target.name || target.id, ...(target.version ? { version: String(target.version) } : {}) };
        if (rec.updateVersion) update.proposedVersion = String(rec.updateVersion);
        if (!sourceAvailable) throw new Error('proposed source is unavailable');
      } else throw new Error('invalid binding');
      update.changes = changesBetween(comparison(baseline, baselineGraph), comparison(rec, graph));
      update.state = 'available';
    } catch {
      unknown = true; issue('warn', '无法读取绑定更新对象的准确当前版本或本次源文件，暂不提供更新比较；未按名称猜测原项目。');
    }
  }
  const state = issues.some(item => item.level === 'error') ? 'blocked' : unknown ? 'unknown' : issues.some(item => item.level === 'warn') ? 'attention' : 'complete';
  return { ok: true, id: rec.id, revision: revisionOf(rec), record: reviewRecordOf(rec), status: rec.status, resourceType: rec.kind === 'skill' ? graph?.kind || (rec.resourceType === 'agent' ? 'agent' : 'skill') : 'tool', summary,
    check: { state, checkedAt: Date.now(), sourceAvailable, issues }, ...(update ? { update } : {}) };
}

module.exports = { buildUploadReview, revisionOf, reviewTokenOf, matchesReviewToken };
