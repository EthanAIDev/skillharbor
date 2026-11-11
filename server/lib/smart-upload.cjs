const { applyPreparedManifest, manifestPath, preparationReport } = require('./package-preparation.cjs');

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = (message, status = 400) => Object.assign(new Error(message), { status });

function normalizeRuntimeRequirements(value) {
  if (!Array.isArray(value) || value.length > 128) throw error('运行环境要求格式无效，请重新识别');
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(item)) throw error('运行环境要求格式无效，请重新识别');
    const requirement = item.trim();
    if (!requirement || Array.from(requirement).length > 256) throw error('运行环境要求格式无效，请重新识别');
    if (!result.includes(requirement)) result.push(requirement);
  }
  return result;
}

function validateChoices(value = {}) {
  if (!plain(value) || Object.keys(value).length > 64) throw error('请选择页面提供的选项');
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof item !== 'string' || !item || item.length > 512) throw error('确认选项无效，请刷新后重试');
  }
  return { ...value };
}

function validateAnalysis(value) {
  if (!plain(value) || !['ready', 'question', 'blocked'].includes(value.status) || !['agent', 'skill', 'tool'].includes(value.kind)) throw error('未收到有效的项目识别结果');
  const resource = value.resource;
  if (!plain(resource) || typeof resource.name !== 'string' || typeof resource.description !== 'string' || !Array.isArray(resource.functions) || resource.functions.some(item => !plain(item) || typeof item.name !== 'string' || !['package', 'registry'].includes(item.source))) throw error('项目识别结果不完整，请重新识别');
  if (!Array.isArray(value.issues) || value.issues.some(item => !plain(item) || typeof item.code !== 'string' || typeof item.message !== 'string') || typeof value.repairText !== 'string') throw error('项目检查结果不完整，请重新识别');
  if (value.status === 'question') {
    const q = value.question;
    if (!plain(q) || typeof q.id !== 'string' || !q.id || typeof q.prompt !== 'string' || !q.prompt || !Array.isArray(q.options) || !q.options.length || q.options.some(o => !plain(o) || typeof o.id !== 'string' || !o.id || typeof o.label !== 'string' || !o.label || typeof o.description !== 'string') || new Set(q.options.map(o => o.id)).size !== q.options.length) throw error('待确认的问题不完整，请重新识别');
  }
  value.runtimeRequirements = normalizeRuntimeRequirements(Object.hasOwn(value, 'runtimeRequirements') ? value.runtimeRequirements : []);
  return value;
}

function publicAnalysis(value) {
  const { modelContext, needsAi, ...safe } = value;
  return { ...safe, runtimeRequirements: normalizeRuntimeRequirements(Object.hasOwn(value, 'runtimeRequirements') ? value.runtimeRequirements : []) };
}

function newResourceIdentity(base, draftId) {
  if (typeof base !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(base) || !/^[a-z0-9]+$/.test(draftId)) throw error('项目标识无效，请重新上传');
  return `${base.slice(0, 100).replace(/[._-]+$/, '')}-${draftId.slice(-8)}`;
}

async function readJsonResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw error('项目识别服务未返回结果');
  const parts = []; let length = 0; let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      length += value.length;
      if (length > 4 * 1024 * 1024) throw error('项目识别结果过大，请精简说明后重试');
      parts.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw error('项目识别服务返回格式异常，请稍后重试'); }
    if (!response.ok) throw error(response.status === 422 ? '项目包未通过安全或结构检查，请重新打包上传' : '项目识别服务暂不可用，请稍后重试', response.status === 422 ? 422 : 502);
    return data;
  } finally { if (!completed) await reader.cancel().catch(() => {}); }
}

async function requestAnalysis(base, headers, bytes, options) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'project.zip');
  for (const key of ['slug', 'version', 'identity']) if (options[key]) form.append(key, options[key]);
  form.append('choices', JSON.stringify(options.choices || {}));
  if (options.proposal) form.append('proposal', JSON.stringify(options.proposal));
  const response = await fetch(base + '/api/skills/analyze', { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000) });
  return validateAnalysis(await readJsonResponse(response));
}

/** Orchestrates one owned draft under the portal's mutation lock. No user input is a filename or a manifest. */
async function analyzeDraft({ rec, user, body, directory, sourceBytes, sourceHash, gatewayBase, headers, collect, makeZip, inspect, save, lookupTarget, findToolMatches, findSkillMatches, proposeAI, assertEditable }) {
  const previousRevision = rec.packageRevision || 0;
  if (!Number.isInteger(body.revision) || body.revision !== previousRevision) throw error('草稿已变化，请刷新后继续整理', 409);
  const incomingChoices = validateChoices(body.choices);
  const choices = { ...validateChoices(rec.smartChoices), ...incomingChoices };
  const pending = rec.smartIdentityQuestion;
  // A past answer cannot override a later explicitly confirmed publication intent.
  const publicationChoice = pending && rec.smartAnalysis?.status === 'question' && rec.smartAnalysis.question?.id === 'publication-identity' ? incomingChoices['publication-identity'] : undefined;
  const intent = rec.smartPublicationIntent;
  if (body.newResource === true && body.updateOf) throw error('请只选择一种发布方式');
  let updateOf = Object.hasOwn(body, 'updateOf') ? String(body.updateOf || '') : intent ? String(intent.target || '') : String(rec.updateOf || '');
  const choosingUpdate = !!body.updateOf || pending && publicationChoice && publicationChoice !== 'new';
  let newResource = body.newResource === true || !choosingUpdate && (!Object.hasOwn(body, 'updateOf') && intent?.mode === 'new' || pending && publicationChoice === 'new');
  if (newResource) updateOf = '';
  else if (!Object.hasOwn(body, 'updateOf') && pending && publicationChoice && publicationChoice !== 'new') {
    updateOf = publicationChoice === 'update' ? pending.target : pending.targets?.[publicationChoice];
    if (!updateOf) throw error('发布对象已变化，请重新选择', 409);
  }
  if (!updateOf && rec.updateOf && !newResource) throw error('请选择更新原项目，或明确发布为新项目', 409);
  let target = updateOf ? await lookupTarget(updateOf, user) : null;
  const displayMetadata = { ...(target?.displayMetadata || {}) };
  if (updateOf && (rec.updateOf === updateOf || rec.smartPublicationIntent?.target === updateOf)) {
    for (const key of ['icon', 'iconUrl', 'iconBg', 'url', 'tags', 'departments', 'category']) if (Object.hasOwn(rec, key)) displayMetadata[key] = rec[key];
  }
  if (updateOf && rec.kind === 'link' && rec.url) displayMetadata.url = rec.url;
  if (target?.uploadKind && target.uploadKind !== rec.kind) throw error('项目类型与原工具不同，请重新选择发布对象');
  let generatedIdentity = updateOf ? '' : rec.smartNewIdentity || '';
  const bytes = rec.kind === 'skill' ? sourceBytes || makeZip(collect(directory, '', null)) : null;
  const gatewayChoices = Object.fromEntries(Object.entries(choices).filter(([key]) => key !== 'publication-identity'));
  const options = { choices: gatewayChoices, ...(updateOf?.startsWith('skill:') ? { slug: updateOf.slice(6), version: target.nextVersion } : {}), ...(generatedIdentity ? { identity: generatedIdentity } : {}) };
  let result;
  let acceptedProposal;
  const toolSourceReport = rec.smartToolReport || rec.report;
  if (rec.kind === 'skill') {
    if (updateOf && !updateOf.startsWith('skill:')) throw error('请选择已有智能体或技能作为更新对象');
    result = await requestAnalysis(gatewayBase, headers, bytes, options);
    if (result.needsAi && result.modelContext) {
      const proposed = await proposeAI(result.modelContext, user);
      if (proposed.proposal) {
        acceptedProposal = proposed.proposal;
        result = await requestAnalysis(gatewayBase, headers, bytes, { ...options, proposal: acceptedProposal });
      } else result.aiNotice = proposed.unavailable || '自动理解暂不可用，已保留识别结果，请确认下面的问题。';
    }
  } else {
    const name = rec.name || rec.parsedNames?.[0] || String(rec.filename || '新项目').replace(/\.[^.]+$/, '');
    const kindName = { web: '网页工具', service: '服务端应用', file: '客户端程序', link: '链接工具' }[rec.kind] || '工具';
    result = { status: toolSourceReport?.verdict === 'fail' ? 'blocked' : 'ready', kind: 'tool', resource: { name, description: rec.desc || '', functions: [{ name: kindName, source: 'package' }] }, issues: [], repairText: '请检查项目包是否包含实际可用的入口和运行文件，补齐后重新上传。', engine: 'rules' };
  }
  let identityQuestion = pending;
  let suggestedSkills = [];
  if (rec.kind === 'skill' && result.identity && !updateOf) {
    const existing = await lookupTarget('skill:' + result.identity, user, { allowMissing: true, allowForeign: true });
    if (existing) {
      if (!existing.owned || newResource) {
        generatedIdentity = generatedIdentity || newResourceIdentity(result.identity, rec.id);
        result = await requestAnalysis(gatewayBase, headers, bytes, { ...options, identity: generatedIdentity, ...(acceptedProposal ? { proposal: acceptedProposal } : {}) });
        newResource = true;
        result.resource.name = `${result.resource.name.slice(0, 22)}（新项目）`;
      } else {
        identityQuestion = { target: 'skill:' + existing.slug };
        result = { ...result, status: 'question', question: { id: 'publication-identity', prompt: '这是新项目，还是更新你已发布的项目？', options: [
          { id: 'update', label: `更新「${existing.name}」`, description: '发布新版本，保留原项目和历史版本。' },
          { id: 'new', label: '发布为新的项目', description: '创建独立资源，原项目继续保留。' }
        ] }, issues: [] };
      }
    } else if (!newResource && !generatedIdentity && findSkillMatches) suggestedSkills = await findSkillMatches(result.resource.name, user);
  } else if (rec.kind !== 'skill' && result.status !== 'blocked' && !updateOf && !newResource) {
    const matches = findToolMatches(result.resource.name, user);
    if (matches.length === 1) {
      identityQuestion = { target: 'tool:' + matches[0].id };
      result = { ...result, status: 'question', question: { id: 'publication-identity', prompt: '这是新项目，还是更新你已发布的工具？', options: [
        { id: 'update', label: `更新「${matches[0].name}」`, description: '替换为本次新版，保留原工具与使用记录。' },
        { id: 'new', label: '发布为新的项目', description: '创建独立工具，原工具继续保留。' }
      ] } };
    }
  }
  if (rec.kind === 'skill' && !updateOf && suggestedSkills.length && result.status !== 'blocked') {
    const options = suggestedSkills.map(item => ({ id: 'update:' + item.slug, label: `更新「${item.name}」`, description: '你已发布的项目；将发布新版本并保留历史版本。' }));
    identityQuestion = { targets: Object.fromEntries(suggestedSkills.map(item => ['update:' + item.slug, 'skill:' + item.slug])) };
    result = { ...result, status: 'question', question: { id: 'publication-identity', prompt: '发现同名的本人项目，请确认本次发布对象。', options: [...options, { id: 'new', label: '发布为新的项目', description: '创建独立资源，原项目继续保留。' }] }, issues: [] };
  }
  if (!updateOf && (generatedIdentity || newResource && pending && publicationChoice === 'new')) result.resource.name = rec.smartAnalysis?.newResource && rec.smartAnalysis.resource.name.endsWith('（新项目）') ? rec.smartAnalysis.resource.name : `${result.resource.name.replace(/（新项目）$/, '').slice(0, 22)}（新项目）`;
  if (updateOf) result.resource.name = target.name;
  if (updateOf) result.displayMetadata = displayMetadata;
  validateAnalysis(result);
  const nextRevision = previousRevision + 1;
  result.revision = nextRevision;
  result.updateOf = updateOf;
  result.newResource = !updateOf && (result.status !== 'question' || newResource === true);
  result.identityConfirmed = !!(rec.smartAnalysis?.identityConfirmed || body.newResource === true || Object.hasOwn(body, 'updateOf') && body.updateOf || pending && publicationChoice);
  if (result.assistance) result.assistance.revision = nextRevision;
  let report;
  let assistance;
  if (result.status === 'ready' && rec.kind === 'skill') {
    assistance = result.assistance;
    if (!assistance?.manifestYaml || !assistance.inspection || assistance.errors?.length) throw error('项目结构尚未通过检查，请补充说明后重试', 422);
    const name = manifestPath(assistance);
    const files = collect(directory, '', null).filter(file => file.name !== name);
    files.push({ name, data: Buffer.from(assistance.manifestYaml, 'utf8') });
    const final = await inspect(makeZip(files), updateOf.startsWith('skill:') ? updateOf.slice(6) : undefined);
    if (final.structure?.slug !== result.identity || final.structure?.kind !== result.kind) throw error('整理结果与实际项目不一致，请重新识别', 422);
    let runtimeRequirements;
    try { runtimeRequirements = normalizeRuntimeRequirements(Object.hasOwn(final.structure, 'runtimeRequirements') ? final.structure.runtimeRequirements : []); }
    catch { throw error('实际项目的运行环境要求格式无效，请重新识别', 422); }
    if (JSON.stringify(runtimeRequirements) !== JSON.stringify(result.runtimeRequirements)) throw error('运行环境要求与实际项目不一致，请重新识别', 422);
    final.structure.runtimeRequirements = runtimeRequirements;
    assistance.inspection = final;
    assistance.errors = [...new Set([...(assistance.errors || []), ...(final.errors || [])])];
    report = preparationReport(assistance, true);
    if (report.verdict === 'fail') {
      result.status = 'blocked';
      result.issues = [{ code: 'final-inspection', message: '部分必要功能当前不可用，请补齐后重新识别。' }];
      result.repairText = '请检查项目中必须调用的功能是否已包含在包内，或对应的平台能力是否可用；补齐后重新上传完整项目包。';
      delete result.assistance;
      assistance = null;
    }
  } else if (result.status === 'ready') report = toolSourceReport;
  else report = { ...(rec.report || {}), verdict: 'fail', lines: [result.question?.prompt || result.issues[0]?.message || '项目尚未整理完成'], rules: [{ id: 'S1', level: 'error', msg: result.question?.prompt || result.issues[0]?.message || '请完成项目确认', fix: '在自动整理页面继续处理' }], ...(result.assistance ? { assistance: result.assistance } : {}) };
  assertEditable();
  const before = { ...rec };
  const commit = () => {
    const publicationIntent = result.identityConfirmed || result.status === 'ready' ? { mode: updateOf ? 'update' : 'new', target: updateOf } : rec.smartPublicationIntent;
    const savedChoices = { ...choices };
    if (result.status === 'ready') delete savedChoices['publication-identity'];
    Object.assign(rec, { ...(result.status === 'ready' && updateOf ? displayMetadata : {}), report, smartChoices: savedChoices, smartAnalysis: publicAnalysis(result), packageRevision: nextRevision, updatedAt: Date.now(), updateOf: result.status === 'ready' ? updateOf || undefined : rec.updateOf, smartPublicationIntent: publicationIntent, smartIdentityQuestion: result.status === 'ready' ? undefined : identityQuestion, smartNewIdentity: generatedIdentity || undefined, ...(rec.kind !== 'skill' ? { smartToolReport: toolSourceReport } : {}), ...(sourceHash ? { smartAnalysisSourceHash: sourceHash } : {}) });
    save();
  };
  try {
    if (assistance) applyPreparedManifest(directory, assistance, commit);
    else commit();
  } catch (cause) {
    for (const key of Object.keys(rec)) if (!Object.hasOwn(before, key)) delete rec[key];
    Object.assign(rec, before);
    throw cause;
  }
  return { ok: true, id: rec.id, analysis: publicAnalysis(result), report, revision: nextRevision };
}

module.exports = { validateAnalysis, publicAnalysis, newResourceIdentity, validateChoices, analyzeDraft, normalizeRuntimeRequirements };
