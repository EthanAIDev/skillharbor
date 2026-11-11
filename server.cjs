/**
 * SkillHarbor 生产服务器（零依赖，Node >= 18：依赖内置 fetch / FormData / AbortSignal.timeout）
 * 用法：node server.cjs [端口]（默认 8900）
 *
 * - 托管 dist/（SPA 回退）+ files/ 静态文件
 * - 代理：/api/one-api/*（管理令牌仅在服务端）、/api/skill-gateway/*、/api/skill-stubs/all
 * - 业务 API（本文件实现，数据落 DATA_DIR，默认 ./data）：
 *   · 鉴权：登录/改密/会话（scrypt 口令 + HMAC 令牌，全端唯一口令源）
 *   · 登录记录（IP/设备/异地标记，仅审计）
 *   · 评价（Steam 式 推荐/不推荐 + 评语，每账号限 1 次可改，异常自动标记）
 *   · 上传（multipart + 零依赖 zip 解析，审核通过自动部署到 /files/uploads/）
 *   · 使用统计（10 秒合并、每日计入上限可配置、同 IP 异常识别）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { makeZip } = require('./server/lib/zip-writer.cjs');
const { collectSkillPackage, inspectSkillArchive, nextSkillVersion } = require('./server/lib/skill-package.cjs');
const { prepareSkillArchive, preparationReport, stageValidatedPackage, applyPreparedManifest, manifestPath: preparedManifestPath } = require('./server/lib/package-preparation.cjs');
const { atomicWriteJSON } = require('./server/lib/atomic-json.cjs');
const { repoPermission, normalizeReadDepts } = require('./server/lib/kb-permissions.cjs');
const { stageKbUpload } = require('./server/lib/kb-upload.cjs');
const { analyzeDraft } = require('./server/lib/smart-upload.cjs');
const { buildUploadReview, revisionOf, reviewTokenOf, matchesReviewToken } = require('./server/lib/upload-review.cjs');

const PORT = Number(process.argv[2] || process.env.PORT || 8900);
const ROOT = path.join(__dirname, 'dist');
const FILES_DIR = path.join(__dirname, 'files');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const ORIGINAL_UPLOADS_DIR = path.join(DATA_DIR, 'upload-originals');
const ANALYSIS_SOURCES_DIR = path.join(DATA_DIR, 'upload-analysis');
const UP_DIR = path.join(DATA_DIR, 'uploads');

for (const d of [DATA_DIR, TMP_DIR, ORIGINAL_UPLOADS_DIR, ANALYSIS_SOURCES_DIR, UP_DIR, path.join(UP_DIR, 'files')]) fs.mkdirSync(d, { recursive: true });

/* ============================== 小工具 ============================== */

const DAY_MS = 86400000;
const ymd = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}
/* 关键业务文件（用户内容，不可再生）：存在却解析失败 → 备份损坏件后拒绝启动，
 * 绝不能静默回退默认值（等于丢掉全部上传记录/工具卡片）。可再生文件仍用 readJSON */
function readCriticalJSON(name, fallback) {
  const v = readJSON(name, undefined);
  if (v !== undefined) return v;
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return fallback;
  const bad = path.join(DATA_DIR, `${name}.bad-${Date.now()}`);
  try { fs.copyFileSync(p, bad); } catch { /* 备份失败也要停，避免覆盖 */ }
  console.error(`[data] ${name} 读取失败，已备份到 ${bad}，拒绝启动（对照每日备份修复后删除 .bad 文件再启动）`);
  process.exit(1);
}
/* 同步原子提交：写入失败抛错，调用方可先持久化再发布内存状态。 */
const writeJSON = (name, value) => atomicWriteJSON(DATA_DIR, name, value);
const nowId = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const ok = (res, obj) => send(res, 200, { ok: true, ...obj });
const fail = (res, code, message) => {
  failServiceAction(); // Includes route-local catches that return a failure instead of throwing.
  return send(res, code, { ok: false, message });
};

function readBody(req, limitMB = 80) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // 已超限：丢弃后续数据不积累内存，也不再 destroy——裸断连会让浏览器 fetch 网络报错而拿不到错误文案，留给调用方先回响应
      size += c.length;
      if (size > limitMB * 1024 * 1024) {
        over = true;
        chunks.length = 0;
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 2);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/** multipart/form-data 解析（零依赖） */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const out = { fields: {}, files: [] };
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next < 0) break;
    // 区块体：去掉结尾 \r\n
    let part = buf.slice(pos + boundary.length, next);
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const head = part.slice(0, headerEnd).toString('utf8');
      const bodyBuf = part.slice(headerEnd + 4);
      const nameM = /name="([^"]*)"/i.exec(head);
      const fileM = /filename="([^"]*)"/i.exec(head);
      const name = nameM ? nameM[1] : '';
      if (fileM && fileM[1]) {
        if (bodyBuf.length) out.files.push({ name, filename: path.basename(fileM[1].replace(/[\\/]/g, '_')), data: bodyBuf });
      } else if (name) {
        out.fields[name] = bodyBuf.toString('utf8');
      }
    }
    pos = next;
  }
  return out;
}

/* ============================== 用户与鉴权 ============================== */

function defaultPwd(u) {
  return u.username === 'admin' ? 'admin123' : '123456';
}
function hashPwd(pwd, salt) {
  return crypto.scryptSync(pwd, salt, 32).toString('hex');
}

let USERS = readJSON('users.json', null);
// users.json 存在却读取/解析失败（磁盘抖动、文件损坏）：备份后拒绝启动，
// 绝不能用种子数据覆盖真实账号（否则全员密码被重置、无管理员可登录）
if (!USERS && fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
  const bad = path.join(DATA_DIR, `users.json.bad-${Date.now()}`);
  try {
    fs.copyFileSync(path.join(DATA_DIR, 'users.json'), bad);
  } catch { /* 备份失败也要停，避免覆盖 */ }
  console.error(`[users] users.json 读取失败，已备份到 ${bad}，拒绝启动（人工检查后删除备份文件再启动）`);
  process.exit(1);
}
if (!USERS) {
  let seed = [];
  try {
    seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'server-seed-users.json'), 'utf8'));
  } catch {
    seed = [];
  }
  USERS = seed.map((u) => {
    const salt = crypto.randomBytes(8).toString('hex');
    return { ...u, salt, hash: hashPwd(defaultPwd(u), salt), ep: 1, disabled: false };
  });
  writeJSON('users.json', USERS);
  console.log(`[users] seeded ${USERS.length} accounts from server-seed-users.json`);
}
const saveUsers = () => writeJSON('users.json', USERS);

// 会话令牌：HMAC(secret, payload) ，payload 含用户名/口令纪元/过期
let SECRET = readJSON('secret.key.json', null)?.k;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  writeJSON('secret.key.json', { k: SECRET });
}
function signToken(u) {
  const b = Buffer.from(JSON.stringify({ u: u.username, ep: u.ep || 1, exp: Date.now() + 7 * DAY_MS })).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b, sig] = token.split('.');
  const expect = Buffer.from(crypto.createHmac('sha256', SECRET).update(b).digest('base64url'));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (p.exp < Date.now()) return null;
    const u = USERS.find((x) => x.username === p.u && !x.disabled);
    if (!u || (u.ep || 1) !== p.ep) return null;
    return u;
  } catch {
    return null;
  }
}
function auth(req, url) {
  const h = req.headers.authorization || '';
  const t = (/^Bearer (.+)$/.exec(h) || [])[1] || url.searchParams.get('token');
  return t ? verifyToken(t) : null;
}
const authed = (ctx) => ctx.user || (ctx.user = auth(ctx.req, ctx.url));
const isAdmin = (ctx) => authed(ctx)?.role === 'admin';

/* 知识库 BFF 机器通道（deploy138，网关 p10 起）：SKILL_GATEWAY_TOKEN 服务令牌 + X-KB-User 指名用户。
 * 网关 kb 工具不再直连 MxsDoc，改以该通道调本服务——会话管理/权限过滤/审计全部收敛在此层。
 * 返回 { u, src }：网页会话 src='web'；机器通道 src='workbuddy'（审计与统计用）。 */
const kbActor = (ctx) => {
  const u = authed(ctx);
  if (u) return { u, src: 'web' };
  const h = ctx.req.headers.authorization || '';
  const t = (/^Bearer (.+)$/.exec(h) || [])[1] || '';
  const svc = process.env.SKILL_GATEWAY_TOKEN || '';
  const uname = String(ctx.req.headers['x-kb-user'] || '').trim();
  if (svc && t === svc && uname) {
    /* uname 兼容两种形态：令牌模式=SkillHarbor username（拼音）；IP 兜底模式=网关 ipmap 的中文名 */
    const u2 = USERS.find((x) => !x.disabled && (x.username === uname || x.name === uname));
    if (u2) return { u: u2, src: 'workbuddy' };
  }
  return { u: null, src: '' };
};

function publicUser(u) {
  return { username: u.username, name: u.name, role: u.role, dept: u.deptShort || u.dept, deptFull: u.dept, title: u.title };
}

/* ============================== 知识库 BFF 公共层（/api/kb/* 与 /api/kb/sso 共用） ============================== */
/* 每用户 MxsDoc 会话池（25 分钟复用；MxsDoc session-timeout 60 分钟）。派生密码规则：
   HMAC-SHA256(f"{username}|{SkillHarbor scrypt hash}", KB_BRIDGE_SECRET) 前 16 位，改密后自愈重置。 */
const KB_SESSIONS = new Map(); // username -> { sid, ts }
const kbBase = () => process.env.MXSDOC_BASE_URL || 'http://127.0.0.1:8110/DocSystem';
const kbBridgePwd = (user, hash) =>
  crypto.createHmac('sha256', process.env.KB_BRIDGE_SECRET || '').update(`${user}|${hash}`).digest('hex').slice(0, 16);
const kbMxLogin = async (user, pwd, signal = AbortSignal.timeout(20000)) => {
  const r = await fetch(`${kbBase()}/User/login.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ userName: user, pwd: Buffer.from(pwd).toString('base64'), rememberMe: 'false' }), signal,
  });
  const rawCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const sid = (rawCookies.join('\n').match(/JSESSIONID=([^;]+)/) || [])[1];
  const body = await r.json().catch(() => ({}));
  return { ok: body.status === 'ok', sid, rawCookies, body };
};
/* 派生密码登录；失败自愈（admin 重置为当前派生值）——与 /api/kb/sso 完全同一套规则 */
async function kbLoginFresh(u) {
  const uname = u.username;
  const MX_ADMIN_PW = process.env.MXSDOC_ADMIN_PASSWORD || '';
  if (!MX_ADMIN_PW || !process.env.KB_BRIDGE_SECRET) return { ok: false, msg: '知识库 SSO 未配置（MXSDOC_ADMIN_PASSWORD / KB_BRIDGE_SECRET）' };
  let last = await kbMxLogin(uname, kbBridgePwd(uname, u.hash));
  if (!last.ok && uname === 'admin') {
    /* admin 门户账号特判（deploy133 同款，2026-10-14 补齐 kbLoginFresh）：不做自愈重置——
       否则 MxsDoc admin 密码被覆盖为派生值，MXSDOC_ADMIN_PASSWORD 根密码通道自锁死。直接用根密码登录。 */
    last = await kbMxLogin('admin', MX_ADMIN_PW);
    if (!last.ok) return { ok: false, msg: '知识库管理员通道不可用（MXSDOC_ADMIN_PASSWORD 与实际不符）' };
  }
  if (!last.ok) {
    const adm = await kbMxLogin('admin', MX_ADMIN_PW);
    if (!adm.sid) return { ok: false, msg: '知识库管理员通道不可用' };
    const list = await (await fetch(`${kbBase()}/Manage/getUserList.do?page=1&searchWord=${encodeURIComponent(uname)}`, {
      method: 'POST', headers: { Cookie: `JSESSIONID=${adm.sid}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' })).json();
    const mu = (list.data || []).find((x) => x.name === uname);
    if (!mu) return { ok: false, msg: '你的账号尚未开通知识库（请联系管理员加入白名单）' };
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const rst = await (await fetch(`${kbBase()}/Manage/editUser.do`, {
      method: 'POST',
      headers: { Cookie: `JSESSIONID=${adm.sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id: String(mu.id), name: uname, realName: mu.realName || u.name, tel: mu.tel || '',
        email: mu.email || '', type: String(mu.type ?? 0), pwd: md5(kbBridgePwd(uname, u.hash)),
      }),
    })).json();
    if (rst.status !== 'ok') return { ok: false, msg: '知识库密码同步失败：' + (rst.msgInfo || '').slice(0, 60) };
    last = await kbMxLogin(uname, kbBridgePwd(uname, u.hash));
  }
  if (!last.ok || !last.sid) {
    const noAccount = /尚未开通/.test(String(last.body?.msgInfo || ''));
    if (noAccount) KB_NO_ACCOUNT.set(uname, Date.now());
    return { ok: false, msg: noAccount ? '你的账号尚未开通知识库写权限（读取不受影响）' : '知识库登录失败，请稍后重试' };
  }
  return { ok: true, sid: last.sid };
}
async function kbSid(u) {
  const no = KB_NO_ACCOUNT.get(u.username);
  if (no) {
    if (Date.now() - no < 10 * 60 * 1000) throw new Error('你的账号尚未开通知识库写权限（读取不受影响）');
    KB_NO_ACCOUNT.delete(u.username);
  }
  const c = KB_SESSIONS.get(u.username);
  if (c && Date.now() - c.ts < 25 * 60 * 1000) return c.sid;
  const r = await kbLoginFresh(u);
  if (!r.ok) throw new Error(r.msg);
  KB_SESSIONS.set(u.username, { sid: r.sid, ts: Date.now() });
  return r.sid;
}
const kbNotLogin = (j) => j && (j.errorCode === 'NOT_LOGIN' || /NOT_LOGIN|未登录/.test(String(j.msgInfo || '')));
async function kbForm(u, apiPath, form) {
  let sid = await kbSid(u);
  const call = (s) => fetch(`${kbBase()}${apiPath}`, {
    method: 'POST',
    headers: { Cookie: `JSESSIONID=${s}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  }).then((r) => r.json());
  let j = await call(sid).catch(() => ({ status: 'fail', msgInfo: '知识库服务网络异常' }));
  if (j.status !== 'ok' && kbNotLogin(j)) {
    KB_SESSIONS.delete(u.username);
    sid = await kbSid(u);
    j = await call(sid).catch(() => ({ status: 'fail', msgInfo: '知识库服务网络异常' }));
  }
  return j;
}
let KB_REPOS_CACHE = null; // { ts, list } 仓库列表缓存（下载 targetPath 需要仓库物理路径）
async function kbRepos(u) {
  if (KB_REPOS_CACHE && Date.now() - KB_REPOS_CACHE.ts < 5 * 60 * 1000) return KB_REPOS_CACHE.list;
  const j = await kbSvcForm('/Repos/getReposList.do', {});
  if (j.status !== 'ok') throw new Error(j.msgInfo || '获取仓库列表失败');
  const list = (j.data || []).map((r) => ({ id: r.id, name: r.name, path: r.path || '' }));
  KB_REPOS_CACHE = { ts: Date.now(), list };
  return list;
}
/* 中文 → MxsDoc 下载参数（base64 + URL 转义；坑位：明文中文会被 ISO-8859-1 解成乱码 500） */
const kbB64 = (s) => encodeURIComponent(Buffer.from(String(s), 'utf8').toString('base64'));

/* admin 会话表单调用（知识库管理通道） */
async function kbAdminForm(apiPath, form, options = {}) {
  const adm = options.sid ? { sid: options.sid } : await kbMxLogin('admin', process.env.MXSDOC_ADMIN_PASSWORD || '');
  if (!adm.sid) throw new Error('知识库管理员通道不可用');
  return fetch(`${kbBase()}${apiPath}`, {
    method: 'POST',
    headers: { Cookie: `JSESSIONID=${adm.sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form), signal: AbortSignal.timeout(120000),
  }).then((r) => {
    if (options.strict && !r.ok) throw new Error('知识库管理员通道响应异常');
    return r.json();
  });
}

/* ---- kb-svc 共享只读会话（全员读取通道，不占用户账号；开源版 50 账号上限的架构消解） ----
   只读五接口（repos/list/search/preview/download）走此通道；写接口仍按用户个人会话（MxsDoc 校验写权限）。 */
const KB_SVC_SESSION = { sid: null, ts: 0 };
const KB_NO_ACCOUNT = new Map(); // username -> ts：无 MxsDoc 账号的用户缓存（10 分钟内写权限探测直接判否，避免反复登录失败）
async function kbSvcSid(signal) {
  if (KB_SVC_SESSION.sid && Date.now() - KB_SVC_SESSION.ts < 25 * 60 * 1000) return KB_SVC_SESSION.sid;
  const pw = process.env.MXSDOC_SVC_PASSWORD || '';
  if (!pw) throw new Error('kb-svc 只读通道未配置（MXSDOC_SVC_PASSWORD）');
  const r = await kbMxLogin('kb-svc', pw, signal);
  if (!r.ok || !r.sid) throw new Error('kb-svc 只读通道登录失败');
  KB_SVC_SESSION.sid = r.sid;
  KB_SVC_SESSION.ts = Date.now();
  return r.sid;
}
async function kbSvcForm(apiPath, form, retry = true, signal = AbortSignal.timeout(20000)) {
  const sid = await kbSvcSid(signal);
  const j = await fetch(`${kbBase()}${apiPath}`, {
    method: 'POST',
    headers: { Cookie: `JSESSIONID=${sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form), signal,
  }).then((r) => r.json()).catch(() => ({ status: 'fail', msgInfo: '知识库只读通道异常' }));
  if (j.status !== 'ok' && kbNotLogin(j) && retry) {
    KB_SVC_SESSION.sid = null;
    return kbSvcForm(apiPath, form, false, signal);
  }
  return j;
}
/* 变更类操作后异步触发向量增量刷新（T2.5：删除/改名/移动的旧路径向量即时清理，fire-and-forget）。
 * 2026-10-20 根修·去抖合并：整夹上传逐文件触发，曾 3 秒内连发 9 次重建把网关 API 堵死——
 * 3 秒静默窗口内多次触发合并为一次（网关侧另有后台线程+并发去重双保险） */
let kbTouchTimer = null;
function kbTouchVectors() {
  if (kbTouchTimer) return;
  kbTouchTimer = setTimeout(() => {
    kbTouchTimer = null;
    fetch(`${process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800'}/api/kb/rebuild-vectors`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + (process.env.SKILL_GATEWAY_TOKEN || '') },
    }).catch(() => {});
  }, 3000);
}

/* 知识库操作审计（jsonl 追加；MxsDoc 侧共享会话记不到个人，溯源在此层完成） */
const KB_AUDIT_FILE = path.join(DATA_DIR, 'kb-audit.jsonl');
function kbAudit(u, action, detail = {}) {
  try {
    fs.appendFileSync(KB_AUDIT_FILE, JSON.stringify({ t: Date.now(), u: u.username, n: u.name, action, ...detail }) + '\n');
  } catch { /* 审计失败不阻断业务 */ }
}

/* ============================== 组织管理（部门字典，2026-10-14）：部门是知识库权限的源头数据 ============================== */
let DEPTS = readJSON('depts.json', null);
if (!Array.isArray(DEPTS) || !DEPTS.length) {
  DEPTS = [
    { name: '总经办', head: 'yangxi' }, { name: '战略部', head: 'songdan' }, { name: '设计院', head: 'caijun' },
    { name: '财务经营部', head: 'liufeiyan' }, { name: '环境科学与碳研究院', head: 'liyongming' }, { name: '市场部', head: 'hancongcong' },
    { name: '咨询所', head: 'mulinlin' }, { name: '研究院', head: 'lidan' }, { name: '新能源所', head: 'wangle' },
    { name: '新能源事业部', head: 'yuanzhifang' }, { name: '规划所', head: 'wudi' }, { name: '董事会', head: 'liuxiaowen' },
    { name: '政技部', head: 'liuyang' }, { name: '投资部', head: 'liulei' },
  ];
  writeJSON('depts.json', DEPTS);
}
const saveDepts = () => writeJSON('depts.json', DEPTS);
const deptNames = () => DEPTS.map((d) => d.name);
/* 用户 → 其维护的部门库列表（组织总览与人员表展示用） */
const kbMaintainsOf = () => {
  const m = {};
  for (const c of Object.values(KBPERMS.repos)) {
    if (c && c.tier === 'dept' && Array.isArray(c.maintainers)) {
      for (const un of c.maintainers) (m[un] = m[un] || []).push(c.dept);
    }
  }
  return m;
};

/* ============================== 知识库三类库权限层（公开/部门/私有，2026-10-14 定稿） ==============================
   公开库=全员；部门库=本部门（调岗自动跟随）；私有库=收窄到个人（同部门也不可见，库主人共享名单只读），
   admin 完全不可见私有库。共享读/写账号只提供物理访问，全部人员权限由 BFF 的明确策略决定。
   未配置的库默认拒绝；旧个人账号迁移兜底和 KB_PERMS_OFF 旁路不再适用。 */
const KB_PERMS_ON = () => true; // 保留路由结构；权限不能被环境变量关闭。
let KBPERMS = readCriticalJSON('kb-perms.json', { repos: {} });
if (!KBPERMS || !KBPERMS.repos || typeof KBPERMS.repos !== 'object' || Array.isArray(KBPERMS.repos))
  throw new Error('知识库权限文件结构无效，拒绝启动');
const saveKbPerms = () => writeJSON('kb-perms.json', KBPERMS);
const kbRepoNameOf = (rid) => ((KB_REPOS_CACHE && KB_REPOS_CACHE.list) || []).find((r) => String(r.id) === String(rid))?.name || '';
const isDeptMaintainerAnywhere = (u) =>
  Object.values(KBPERMS.repos).some((c) => c && c.tier === 'dept' && c.maintSet && (c.owner === u.username || (c.maintainers || []).includes(u.username)));
/* 三类库判定（核心函数）：返回 {tier, visible, canWrite, canDownload, canManage, legacyWrite} */
function kbRepoPerm(u, repoId) {
  return repoPermission(u, repoId, KBPERMS);
}
/* 所有共享账号写入必须具有明确策略；迁移期个人账号兜底已不存在。 */
function kbWriteGate(u, repoId) {
  const p = kbRepoPerm(u, repoId);
  if (!p.visible) return '无权访问或权限尚未配置';
  if (p.canWrite) return null;
  if (p.tier === 'private') return '私有库仅库主人可修改';
  if (p.readShared) return '跨部门共享库仅可浏览/下载，不可修改';
  return '当前库为只读（未列为维护人员）';
}
// A private repository's quota is its current file tree, never the historical upload counter.
const kbRepoQueues = new Map();
let kbPendingWrites = readCriticalJSON('kb-pending-writes.json', {});
if (!kbPendingWrites || typeof kbPendingWrites !== 'object' || Array.isArray(kbPendingWrites)
  || Object.entries(kbPendingWrites).some(([id, record]) => !/^[1-9]\d{0,15}$/.test(id)
    || !record || typeof record.operation !== 'string' || !Number.isFinite(record.startedAt)))
  throw new Error('kb-pending-writes.json 格式异常，拒绝忽略待确认写入');
const kbPendingMessage = '上次知识库操作结果待确认，暂时不能修改；请管理员核实上游操作已结束后恢复';
function kbAssertNoPending(repoId) {
  if (kbPendingWrites[String(repoId)]) throw Object.assign(new Error(kbPendingMessage), { status: 503 });
}
// Call inside the repository queue. A lost response does not cancel a Java-side write.
async function kbPrivateWrite(repoId, operation, action, verify = () => kbCurrentFiles(repoId)) {
  if (KBPERMS.repos[String(repoId)]?.tier !== 'private') return action();
  kbAssertNoPending(repoId);
  const next = { ...kbPendingWrites, [repoId]: { operation, startedAt: Date.now() } };
  writeJSON('kb-pending-writes.json', next); kbPendingWrites = next;
  try {
    const result = await action();
    if (!result || !['ok', 'fail', 'error'].includes(result.status)) throw new Error('知识库响应异常');
    // Even a completed failure may have changed files. Never infer usage from its status.
    await verify(result);
    const settled = { ...kbPendingWrites }; delete settled[repoId];
    writeJSON('kb-pending-writes.json', settled); kbPendingWrites = settled;
    return result;
  } catch (e) {
    throw Object.assign(new Error(kbPendingMessage), { status: 503, cause: e });
  }
}
async function withKbRepoLock(repoId, action) {
  const key = String(repoId), previous = kbRepoQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  kbRepoQueues.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (kbRepoQueues.get(key) === current) kbRepoQueues.delete(key); }
}
function kbQuotaPath(value) {
  if (typeof value !== 'string' || /[\\\0]/.test(value)) throw new Error('文件路径无效');
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (normalized && normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('文件路径无效');
  return normalized ? normalized + '/' : '';
}
async function kbCurrentFiles(repoId) {
  const pending = [{ path: '', name: '', prefix: '' }], seen = new Set(), files = new Map();
  const signal = AbortSignal.timeout(30000);
  let used = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const dir = pending.pop();
    const j = await kbSvcForm('/Repos/getSubDocList.do', { vid: repoId, path: dir.path, name: dir.name,
      ...(dir.docId ? { docId: dir.docId } : {}), sort: '0', needLockState: '0' }, true, signal);
    if (j.status !== 'ok' || !Array.isArray(j.data)) throw new Error('无法核实私有库当前用量，请稍后重试');
    for (const entry of j.data) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || /[\/\\\0]/.test(entry.name)
        || ['.', '..'].includes(entry.name) || kbQuotaPath(entry.path) !== dir.prefix)
        throw new Error('私有库目录数据异常，无法核实用量');
      const key = dir.prefix + entry.name;
      if (seen.has(key)) throw new Error('私有库目录数据重复，无法核实用量');
      seen.add(key);
      if (Number(entry.type) === 2) {
        if (!entry.docId) throw new Error('私有库目录编号缺失');
        pending.push({ path: dir.prefix, name: entry.name, prefix: key + '/', docId: String(entry.docId) });
      } else if (Number(entry.type) === 1) {
        const size = Number(entry.size);
        if (entry.size === null || entry.size === undefined || entry.size === '' || !Number.isSafeInteger(size) || size < 0)
          throw new Error('私有库文件大小异常，无法核实用量');
        used += size;
        if (!Number.isSafeInteger(used)) throw new Error('私有库用量超出可核实范围');
        files.set(key, size);
      } else throw new Error('私有库文件类型异常，无法核实用量');
    }
  }
  return { used, files };
}
function kbPrivateUploadTarget(staged) {
  const allowed = new Set(['reposId', 'path', 'name', 'filePath', 'size', 'checkSum', 'commitMsg']);
  for (const [name, values] of staged.fields) {
    if (!allowed.has(name) || values.length !== 1) throw Object.assign(new Error('私有库上传字段重复或不受支持'), { status: 400 });
  }
  const field = name => staged.fields.get(name)?.[0];
  const name = field('name');
  const file = staged.files[0];
  const directory = kbQuotaPath(field('path') || '');
  if (staged.files.length !== 1 || file.field !== 'uploadFile' || !name || name === '.' || name === '..'
    || /[\/\\\0]/.test(name) || file.filename !== name || (field('filePath') !== undefined && field('filePath') !== name)
    || (field('size') !== undefined && Number(field('size')) !== staged.fileBytes)
    || (field('path') || '') !== directory)
    throw Object.assign(new Error('私有库上传必须指定唯一一致的文件名和大小'), { status: 400 });
  return directory + name;
}
/* ---- kb-svc-w 共享写通道（私有库/同步发布的物理写账号；BFF 负责逻辑鉴权与审计） ---- */
const KB_SVC_W_SESSION = { sid: null, ts: 0 };
async function kbSvcWSid() {
  if (KB_SVC_W_SESSION.sid && Date.now() - KB_SVC_W_SESSION.ts < 25 * 60 * 1000) return KB_SVC_W_SESSION.sid;
  const pw = process.env.MXSDOC_SVC_W_PASSWORD || '';
  if (!pw) throw new Error('kb-svc-w 写通道未配置（MXSDOC_SVC_W_PASSWORD）');
  const r = await kbMxLogin('kb-svc-w', pw);
  if (!r.ok || !r.sid) throw new Error('kb-svc-w 写通道登录失败');
  KB_SVC_W_SESSION.sid = r.sid;
  KB_SVC_W_SESSION.ts = Date.now();
  return r.sid;
}
async function kbSvcWForm(apiPath, form, retry = true, strict = false) {
  const sid = await kbSvcWSid();
  const j = await fetch(`${kbBase()}${apiPath}`, {
    method: 'POST',
    headers: { Cookie: `JSESSIONID=${sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form), signal: AbortSignal.timeout(120000),
  }).then((r) => {
    if (strict && !r.ok) throw new Error('知识库写通道响应异常');
    return r.json();
  }).catch((e) => {
    if (strict) throw e;
    return { status: 'fail', msgInfo: '知识库写通道异常' };
  });
  if (j.status !== 'ok' && kbNotLogin(j) && retry) {
    KB_SVC_W_SESSION.sid = null;
    return kbSvcWForm(apiPath, form, false, strict);
  }
  /* MxsDoc 对写入中路径有短时仓储锁（正在新增/正在移动/正在删除…），并发写同路径时等 900ms 重试一次 */
  if (j.status !== 'ok' && /请稍后重试/.test(String(j.msgInfo || '')) && retry) {
    await new Promise((r2) => setTimeout(r2, 900));
    return kbSvcWForm(apiPath, form, false, strict);
  }
  return j;
}
/* 全部库的写/历史表单统一走 kb-svc-w 共享写通道（spec M1-T1.2，2026-10-14）：
   物理写授权单点授予 kb-svc-w，人员鉴权全部在 BFF（kbWriteGate+维护员名单），commitMsg/审计带真名。
   由此 MxsDoc 个人账号退出历史（消号至 admin/kb-svc/kb-svc-w），免费版 10 人内合规。 */
async function kbFormFor(u, reposId, apiPath, form) {
  if (KBPERMS.repos[String(reposId)]?.tier === 'private' && /^\/Doc\/(addDoc|renameDoc|deleteDoc|moveDoc)\.do$/.test(apiPath)) {
    await kbSvcWSid(); // Login failure occurs before a possible tree mutation.
    return kbPrivateWrite(reposId, apiPath, () => kbSvcWForm(apiPath, form, true, true));
  }
  return kbSvcWForm(apiPath, form);
}
/* 确保 kb-svc-w 账号存在并同步密码为环境值（首次部署/改密后自愈） */
async function kbEnsureSvcW() {
  const pw = process.env.MXSDOC_SVC_W_PASSWORD || '';
  if (!pw) throw new Error('kb-svc-w 写通道未配置（MXSDOC_SVC_W_PASSWORD）');
  const adm = await kbMxLogin('admin', process.env.MXSDOC_ADMIN_PASSWORD || '');
  if (!adm.sid) throw new Error('知识库管理员通道不可用');
  const call = (api, form) => fetch(`${kbBase()}${api}`, {
    method: 'POST', headers: { Cookie: `JSESSIONID=${adm.sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  }).then((r) => r.json());
  const list = await call('/Manage/getUserList.do', { page: 1, searchWord: 'kb-svc-w' });
  let mu = (list.data || []).find((x) => x.name === 'kb-svc-w');
  const md5pwd = crypto.createHash('md5').update(pw).digest('hex');
  if (!mu) {
    const add = await call('/Manage/addUser.do', { name: 'kb-svc-w', realName: '知识库共享写通道', tel: '', email: '', type: 1, pwd: md5pwd });
    if (add.status !== 'ok') throw new Error('kb-svc-w 建号失败：' + (add.msgInfo || '').slice(0, 60));
    const list2 = await call('/Manage/getUserList.do', { page: 1, searchWord: 'kb-svc-w' });
    mu = (list2.data || []).find((x) => x.name === 'kb-svc-w');
  } else {
    await call('/Manage/editUser.do', { id: String(mu.id), name: 'kb-svc-w', realName: '知识库共享写通道', tel: '', email: '', type: String(mu.type ?? 1), pwd: md5pwd });
  }
  if (!mu) throw new Error('kb-svc-w 账号就绪失败');
  return mu.id;
}

/* MxsDoc userId 查询（kb-svc / kb-svc-w 授权用） */
async function kbMxUserId(name) {
  const j = await kbAdminForm('/Manage/getUserList.do', { page: 1, searchWord: name });
  const mu = (j.data || []).find((x) => x.name === name);
  return mu ? mu.id : null;
}

/* ---- 索引健康巡检（T2.6）：记录每日向量总数，骤降>20% 告警入审计（防 10-13 式静默清空复发） ---- */
async function kbIndexHealthCheck() {
  try {
    const r = await fetch(`${process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800'}/api/kb/vector-stats`, {
      headers: { Authorization: 'Bearer ' + (process.env.SKILL_GATEWAY_TOKEN || '') },
    });
    const j = await r.json().catch(() => null);
    if (!j || typeof j.total !== 'number') return;
    const hist = readJSON('kb-index-history.json', []) || [];
    const prev = hist.length ? hist[hist.length - 1] : null;
    const entry = { t: Date.now(), total: j.total, scanned: j.scanned || 0 };
    if (prev && prev.total > 20 && j.total < prev.total * 0.8) {
      entry.alert = `索引骤降 ${prev.total} → ${j.total}`;
      kbAudit({ username: 'system', name: '巡检' }, 'index-health-alert', entry);
    }
    /* 扫描件（无文字层 PDF）攒到阈值时提醒一次 OCR 评估——无感盯条件，不做清单不做约定（拍板 2026-10-15） */
    if ((j.scanned || 0) >= 20 && !(hist.some((h) => h.scanAlert))) {
      entry.scanAlert = true;
      kbAudit({ username: 'system', name: '巡检' }, 'scan-threshold', { scanned: j.scanned, note: '扫描件已达 20 份，可评估接入 OCR' });
    }
    hist.push(entry);
    writeJSON('kb-index-history.json', hist.slice(-400));
  } catch { /* 巡检失败静默，下轮重试 */ }
}
setTimeout(kbIndexHealthCheck, 5 * 60 * 1000);
setInterval(kbIndexHealthCheck, 24 * 60 * 60 * 1000);

/* ---- 网关个人令牌签发（deploy138）：登录人下载一键脚本时自动签发/复用网关 native 令牌 ---- */
const GW_TOKEN_CACHE = new Map(); // username -> { key, ts }
async function ensureGatewayToken(u) {
  const c = GW_TOKEN_CACHE.get(u.username);
  if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.key;
  const base = process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800';
  const authH = { Authorization: 'Bearer ' + (process.env.SKILL_GATEWAY_TOKEN || '') };
  let key = '';
  try {
    const list = await (await fetch(base + '/api/tokens', { headers: authH })).json().catch(() => []);
    const mine = (Array.isArray(list) ? list : []).find((t) => t && t.name === u.username && t.status === 'active');
    if (mine) key = mine.token_key || mine.key || mine.token || '';
    if (!key) {
      const r = await fetch(base + '/api/tokens?name=' + encodeURIComponent(u.username) + '&dept=' + encodeURIComponent(u.deptShort || u.dept || '') + '&note=' + encodeURIComponent('auto:skillharbor一键配置'), { method: 'POST', headers: authH });
      const j = await r.json().catch(() => ({}));
      key = j.token || j.key || '';
    }
  } catch { /* 签发失败降级为无令牌脚本（IP 兜底仍可用） */ }
  if (key) GW_TOKEN_CACHE.set(u.username, { key, ts: Date.now() });
  return key;
}


/* ---- 网关个人令牌吊销（离职/禁用/删除用户时收回 AI 通道身份；best-effort） ---- */
const revokeGatewayToken = (uname) => {
  GW_TOKEN_CACHE.delete(uname);
  const base = process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800';
  fetch(base + '/api/tokens?name=' + encodeURIComponent(uname), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + (process.env.SKILL_GATEWAY_TOKEN || '') },
  }).catch(() => {});
};

/* ---- mini Markdown → HTML（零依赖，覆盖知识库文档常用语法：标题/表格/列表/引用/代码/粗斜体/链接/hr） ---- */
const MD_IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const KB_PREVIEW_HEADERS = {
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function mdInline(t) {
  return escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      try {
        // Resolve only to validate the scheme; keep ordinary relative links intact.
        if (!/[<>]/.test(href) && ['http:', 'https:', 'mailto:'].includes(new URL(href, 'https://preview.invalid/').protocol)) {
          return `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
        }
      } catch { /* Invalid URLs render as plain labels. */ }
      return label;
    });
}
function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const para = [];
  const flush = () => { if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para.length = 0; } };
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (/^```/.test(t)) { /* 围栏代码块 */
      flush(); i++;
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      out.push('<pre class="code">' + code.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
      continue;
    }
    if (t.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]*-{3,}[\s:|-]*\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) { /* 表格 */
      flush();
      const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
      const head = cells(t);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++].trim()));
      out.push('<table><thead><tr>' + head.map((h) => '<th>' + mdInline(h) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) { flush(); out.push('<h' + (h[1].length + 1) + '>' + mdInline(h[2]) + '</h' + (h[1].length + 1) + '>'); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(t)) { flush(); out.push('<blockquote>' + mdInline(t.replace(/^>\s?/, '')) + '</blockquote>'); i++; continue; }
    const li = /^([-*]|\d+\.)\s+/.exec(t);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const tt = lines[i].trim();
        const m = ordered ? /^\d+\.\s+/.exec(tt) : /^[-*]\s+/.exec(tt);
        if (!m) break;
        items.push('<li>' + mdInline(tt.slice(m[0].length)) + '</li>');
        i++;
      }
      out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
      continue;
    }
    if (!t) flush(); else para.push(t);
    i++;
  }
  flush();
  return out.join('\n');
}
const mdPageCss = 'body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#EDEEF4;color:#1F2333}'
  + '.card{max-width:860px;margin:24px auto;background:#fff;border-radius:10px;box-shadow:0 3px 14px rgba(16,18,35,.12);padding:40px 48px;line-height:1.9}'
  + 'h1,h2,h3,h4{line-height:1.5;margin:1.4em 0 .6em}h2{font-size:20px;border-bottom:1px solid #E7E8EF;padding-bottom:.35em}h3{font-size:17px}'
  + 'table{border-collapse:collapse;margin:1em 0;font-size:13.5px;width:100%}th,td{border:1px solid #DDDFE8;padding:7px 11px;text-align:left}th{background:#F6F7FB}'
  + 'blockquote{margin:.8em 0;padding:.5em 1em;border-left:3px solid #5046E5;background:#F6F5FE;color:#4B4670;border-radius:0 8px 8px 0}'
  + 'code{background:#EEF0F6;border-radius:4px;padding:1px 6px;font-size:12.5px;font-family:Consolas,monospace}'
  + 'pre.code{background:#F6F7FB;border-radius:8px;padding:14px 18px;overflow:auto;font-size:12.5px;line-height:1.7;font-family:Consolas,monospace}'
  + 'hr{border:0;border-top:1px solid #E7E8EF;margin:1.6em 0}a{color:#5046E5}ul,ol{padding-left:1.6em}';

/* ============================== 登录记录 ============================== */

let LOGINS = readJSON('logins.json', []);
const saveLogins = () => writeJSON('logins.json', LOGINS.slice(-4000));
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '';
}
function deviceOf(ua) {
  const s = ua || '';
  const os = /Windows/i.test(s) ? 'Windows' : /Mac OS/i.test(s) ? 'Mac' : /Android/i.test(s) ? 'Android' : /Linux/i.test(s) ? 'Linux' : '未知系统';
  const br = /Edg\//i.test(s) ? 'Edge' : /Chrome/i.test(s) ? 'Chrome' : /Firefox/i.test(s) ? 'Firefox' : /Safari/i.test(s) ? 'Safari' : '其他';
  return `${br}·${os}`;
}
function recordLogin(u, req, okFlag) {
  const ip = clientIp(req);
  // 异地判定：该账号历史成功登录 IP ≥2 个且当前 IP 从未出现过
  const hist = LOGINS.filter((l) => l.u === u.username && l.ok).map((l) => l.ip);
  const seen = new Set(hist);
  const remote = okFlag && hist.length >= 2 && !seen.has(ip);
  LOGINS.push({ t: Date.now(), u: u.username, n: u.name, ip, d: deviceOf(req.headers['user-agent']), ok: okFlag, remote });
  saveLogins();
}

/* ============================== 评价 ============================== */

let EVALS = readJSON('evals.json', []);
/* 五星模型迁移：旧二元评价补 s 字段（推荐=5 星 / 不推荐=1 星），幂等 */
{
  let migrated = 0;
  for (const e of EVALS) if (!e.s) { e.s = e.v === 1 ? 5 : 1; migrated++; }
  if (migrated) { writeJSON('evals.json', EVALS); console.log(`[evals] ${migrated} 条旧评价折算为星级`); }
}
const saveEvals = () => writeJSON('evals.json', EVALS);

function evalSummary(target) {
  const rows = EVALS.filter((e) => e.target === target && e.flag !== 'excluded');
  const up = rows.filter((e) => e.v === 1).length;
  const down = rows.length - up;
  const excluded = EVALS.filter((e) => e.target === target && e.flag === 'excluded').length;
  /* 五星模型：均分 + 星级分布（s 字段；旧二元评价按 推荐=5 / 不推荐=1 折算，见启动迁移） */
  const dist = [0, 0, 0, 0, 0];
  let sSum = 0;
  for (const e of rows) {
    const st = Math.min(5, Math.max(1, e.s || (e.v === 1 ? 5 : 1)));
    dist[st - 1]++;
    sSum += st;
  }
  const avg = rows.length ? Math.round((sSum / rows.length) * 10) / 10 : null;
  return { up, down, excluded, total: up + down, rate: up + down ? Math.round((up / (up + down)) * 100) : null, avg, dist, count: rows.length };
}
/** 同一对象 · 同日 · 同 IP ≥3 个不同账号提交评价 → 自动标记 suspect（待复核，仍计入，剔除需管理员） */
function refreshSuspects() {
  const groups = new Map(); // target|day|ip -> Set(username)
  for (const e of EVALS) {
    if (e.flag === 'excluded') continue;
    const k = e.target + '|' + new Date(e.t).toISOString().slice(0, 10) + '|' + e.ip;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(e.u);
  }
  for (const e of EVALS) {
    if (e.flag === 'excluded' || e.reviewed) continue;
    const k = e.target + '|' + new Date(e.t).toISOString().slice(0, 10) + '|' + e.ip;
    e.flag = groups.get(k)?.size >= 3 ? 'suspect' : 'ok';
  }
  saveEvals();
}

/* ============================== 上传（解析 + 部署） ============================== */

let UPLOADS = readCriticalJSON('uploads.json', []);
const PREPARING_UPLOADS = new Set();
const saveUploads = () => writeJSON('uploads.json', UPLOADS);
let EXTRA_TOOLS = readCriticalJSON('extraTools.json', []);
const saveExtra = () => writeJSON('extraTools.json', EXTRA_TOOLS);
/* 工具卡片 ID 分配：取现有最大 up<N> +1，并循环避让已占用号。
 * 2026-10-10 事故根因：审核发号曾用「数组长度 +1」，与最大号不一致（软删记录留在数组、外部恢复灌数）时必撞车；
 * 撞号后 find 永远命中前一条，删除/下架/编辑全打到错误记录上 */
function nextUpId() {
  let n = EXTRA_TOOLS.reduce((m, t) => Math.max(m, +((/^up(\d+)$/.exec(t.id) || [])[1] || 0)), 0) + 1;
  while (EXTRA_TOOLS.some((t) => t.id === 'up' + n)) n++;
  return 'up' + n;
}
/* 启动自检：ID 重复立即报错拒启动（数据被外部灌坏时宁可拒服也不让 find 打错记录） */
{
  const seen = new Set();
  for (const t of EXTRA_TOOLS) {
    if (seen.has(t.id)) throw new Error(`[extraTools] 工具 ID 重复：${t.id}（${t.name}），拒绝启动——请先修复数据`);
    seen.add(t.id);
  }
}
/* 存量工具回填首次上架精确时间：从审核记录的 approvedAt 推导（仅内存，不重写文件） */
for (const t of EXTRA_TOOLS) {
  if (!t.approvedAt && t.uploadId) {
    const rec = UPLOADS.find((x) => x.id === t.uploadId);
    if (rec?.approvedAt) t.approvedAt = rec.approvedAt;
  }
}
/* 启动恢复：上次部署中途进程退出/重启的记录 → 转可重试的 deploy_failed，避免永远卡在 deploying */
{
  let n = 0;
  for (const r of UPLOADS) {
    if (r.status === 'deploying') { r.status = 'deploy_failed'; r.deployError = '部署中断（服务重启），可重试'; n++; }
  }
  if (n) { console.log(`[uploads] 启动恢复：${n} 条中断部署已标记为 deploy_failed（可重试）`); saveUploads(); }
}
/* 部署历史（P3）：每次激活/回滚记一条，审核中心可查；上限 500 条滚动 */
let DEPLOYS = readJSON('deployments.json', []);
if (!Array.isArray(DEPLOYS)) DEPLOYS = [];
const saveDeploys = () => writeJSON('deployments.json', DEPLOYS.slice(-500));

/* ============================== 服务型工具通道（P4） ==============================
 * 带后端的完整应用（Node/express 等）：审批通过后 docker build + run 为独立服务容器，
 * 端口段 18200-18399（services.json 登记；更新沿用原端口、数据卷保留、URL 稳定）。
 * 安全边界：业务容器无 privileged、不挂 docker.sock、不挂宿主目录（仅 named volume /data）、
 * 内存 512m / CPU 1 核限额；信任边界 = 管理员审批（内网）。
 * SERVICE_DOCKER=mock：跳过 docker 执行仅落盘登记（本地测试用）。 */
let SERVICES = readJSON('services.json', {});
if (!SERVICES || typeof SERVICES !== 'object' || Array.isArray(SERVICES)) SERVICES = {};
const saveServices = () => writeJSON('services.json', SERVICES);
const SVC_PORT_BEGIN = 18200;
const SVC_PORT_END = 18399;
const svcImage = (siteKey, v) => `skillharbor-svc-${siteKey}:v${v}`;
const svcContainer = (siteKey) => `skillharbor-svc-${siteKey}`;
/* 服务访问地址的主机名：取 FILES_BASE（与工具文件源同机）→ PORTAL_BASE；惰性求值（两者声明在本段之后） */
const svcHost = () => {
  try { return new URL(FILES_BASE || PORTAL_BASE).hostname; } catch { return '127.0.0.1'; }
};

// One lock covers the container action AND its portal state writes, including update aliases.
const serviceActions = new (require('node:async_hooks').AsyncLocalStorage)();
const busyServices = new Set();
function checkServiceAction() {
  const action = serviceActions.getStore();
  if (action?.active) action.check();
}
function failServiceAction() {
  const action = serviceActions.getStore();
  if (!action?.active) return;
  action.failed = true;
  action.reconcile();
}
async function docker(args, opts = {}) {
  const action = serviceActions.getStore();
  checkServiceAction();
  try {
    const result = await dockerCommand(args, opts);
    if (action?.active && args[0] === 'rm') action.removed = true;
    checkServiceAction();
    return result;
  } catch (error) {
    // Snapshot probes are best effort. A failed mutating command after removal is not.
    if (action?.active && ['rm', 'create', 'start'].includes(args[0])) action.failed = true;
    if (action?.active && args[0] === 'rm' && error.outcomeUnknown) action.removed = true;
    if (action?.active) action.reconcile();
    throw error;
  }
}
async function removeServiceContainer(cname) {
  try { await docker(['rm', '-f', cname]); }
  catch (error) {
    // Only explicit absence is success; daemon/permission/timeout errors remain failures.
    if (!/No such container:/i.test(error.message)) throw error;
    const action = serviceActions.getStore();
    if (action?.active) { action.removed = true; action.failed = false; }
    checkServiceAction();
  }
}

/** 执行 docker CLI（子进程，超时保护）；SERVICE_DOCKER=mock 时模拟成功 */
function dockerCommand(args, opts = {}) {
  if (process.env.SERVICE_DOCKER === 'mock') return Promise.resolve({ stdout: `[mock] docker ${args.join(' ')}`, mocked: true });
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: opts.timeout || 180000, maxBuffer: opts.maxBuffer || 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('服务器未安装 docker CLI（服务型工具部署能力未启用）'));
        /* stderr 首行常见为 legacy builder 的 DEPRECATED 警告（未装 buildx 时每次 build 都会打印），
         * 直接取第一行会把真实失败原因（npm 依赖错误 / 拉镜像失败 / socket 未挂载等）全掩盖；
         * 过滤噪音行后取末尾有效行 */
        const noise = /DEPRECATED:|^Install the buildx|^https?:\/\/|^Sending build context|^Step \d|^ ---> |^--->|^Running in|^Removing intermediate|^npm error A complete log/;
        const lines = String(stderr || '').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => l && !noise.test(l));
        const errs = lines.filter((l) => /error/i.test(l));
        let msg = (errs.length ? errs.slice(-2) : lines.slice(-2)).join('；') || String(err.message || err);
        if (/connect.*no such file|Cannot connect/i.test(msg)) msg += '（门户容器需挂载 /var/run/docker.sock 才能构建服务型工具）';
        const error = new Error(msg.slice(0, 300));
        error.outcomeUnknown = !!(err.killed || err.signal || err.code === 'ETIMEDOUT');
        reject(error);
      } else resolve({ stdout: String(stdout) });
    });
  });
}

/** 端口分配：已登记的沿用（更新场景），否则 18200-18399 逐个 bind 探测找空闲 */
async function allocServicePort(siteKey) {
  if (SERVICES[siteKey]?.port) return SERVICES[siteKey].port;
  const used = new Set(Object.values(SERVICES).map((s) => s && s.port).filter(Boolean));
  for (let p = SVC_PORT_BEGIN; p <= SVC_PORT_END; p++) {
    if (used.has(p)) continue;
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '0.0.0.0', () => s.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error(`服务端口段 ${SVC_PORT_BEGIN}-${SVC_PORT_END} 已用尽，请联系管理员清理已下线的服务容器`);
}

/* ====================== 服务容器业务数据持久化（deploy66） ======================
 * 根治「版本更新/回滚/重新上架丢生产数据」：报账系统这类工具把业务数据写在
 * 容器文件系统（如 /app/server/data.json），/data 卷它根本不写，rm -f 重建即全丢
 * （2026-09-10 防重复报账系统生产数据缺失事件的根因）。
 * 重建流程改为：docker cp 暂存旧容器业务数据 → rm → docker create → 回填 → start。
 * create 后未启动即回填，避免应用先启动、内存态在下次保存时覆盖回填文件的竞态。
 * 全程 best-effort：任何一步失败不阻断部署，仅留日志；暂存目录跨重建保留可作审计。 */

/** 业务数据文件（data.json）在容器内的候选目录：优先部署时登记的 dockerRoot，
 * 兼容历史登记缺失的场景（server 子目录 / 镜像根） */
function svcDataDirs(dockerRoot) {
  const list = [];
  if (dockerRoot && typeof dockerRoot === 'string') {
    const rel = dockerRoot.replace(/^\/+|\/+$/g, '');
    if (rel) list.push('/app/' + rel);
  }
  list.push('/app/server', '/app');
  return [...new Set(list)];
}

/** docker cp 拷贝，源不存在等失败返回 false（探测语义） */
async function dockerCpIfExists(args) {
  try { await docker(['cp', ...args], { timeout: 60000 }); return true; } catch { return false; }
}

/** 把容器内业务数据同步一份到 /data 卷的 sh 脚本（best-effort 灾备快照，
 * 也供下架前留底——重新上架/后续重建时可从卷恢复） */
function svcVolScript(dirs) {
  const list = dirs.map((d) => "'" + String(d).replace(/'/g, '') + "'").join(' ');
  return `for d in ${list}; do [ -f "$d/data.json" ] && cp "$d/data.json" /data/data.json && break; done`;
}

/** 下架/撤回前留底：业务数据快照进卷 + 主机暂存副本后再移除容器（镜像与卷保留，重新上架即恢复） */
async function svcRemoveWithSnapshot(siteKey) {
  const cname = svcContainer(siteKey);
  const dirs = svcDataDirs(SERVICES[siteKey]?.dockerRoot);
  await docker(['exec', cname, 'sh', '-c', svcVolScript(dirs)]).catch(() => {});
  /* 主机侧同步留一份最新拷贝：重新上架时旧容器已不可读，优先用这份（比卷快照新鲜——
   * 卷只在重建成功后刷新，若上次部署失败在 rm 之后，卷里还是上一轮的旧数据） */
  const stage = path.join(TMP_DIR, 'svc-data', siteKey);
  fs.mkdirSync(stage, { recursive: true });
  for (const dir of dirs) {
    if (await dockerCpIfExists([`${cname}:${dir}/data.json`, path.join(stage, 'data.json')])) break;
  }
  await removeServiceContainer(cname);
}

/* ============================== 共享 MySQL（一工具一库一账号，授权级硬隔离） ==============================
 *  容器 skillharbor-mysql（ops 部署，数据卷 skillharbor-mysql-data，仅挂内网网络 skillharbor-net）。
 *  约定：服务型包内 /data/*.sql = 数据迁移导出（mysqldump 等）→ 首次部署（空库）时平台自动建库建号并导入；
 *  连接信息经环境变量注入工具容器：DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD。
 *  root 口令存 DATA_DIR/secrets/mysql-root.password（数据卷内，不进仓库）；工具账号口令随机生成存 services.json。 */
const MYSQL_C = 'skillharbor-mysql';
const mysqlRootPw = () => {
  try { return fs.readFileSync(path.join(DATA_DIR, 'secrets', 'mysql-root.password'), 'utf8').trim(); } catch { return ''; }
};
const mysqlReady = () => !!mysqlRootPw();
/** 构建目录里的 SQL 导出（dockerRoot 内外的 data/ 都认） */
function findSqlDumps(buildCtx, dockerRoot) {
  const dirs = dockerRoot ? [path.join(buildCtx, dockerRoot, 'data'), path.join(buildCtx, 'data')] : [path.join(buildCtx, 'data')];
  const out = [];
  for (const d of dirs) {
    try { for (const f of fs.readdirSync(d)) if (/\.sql$/i.test(f)) out.push(path.join(d, f)); } catch { /* 无 data 目录 */ }
  }
  return [...new Set(out)];
}
/** 建库建号（幂等）：返回连接信息并存 SERVICES[siteKey].mysql；共享 MySQL 未配置时返回 null 不阻断 */
async function provisionMysql(siteKey) {
  const root = mysqlRootPw();
  if (!root) return null;
  const db = `skillharbor_${siteKey}`;
  const user = db.slice(0, 32);
  let info = SERVICES[siteKey]?.mysql;
  if (!info) info = { db, user, password: crypto.randomBytes(16).toString('hex') };
  const sql = `CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4;`
    + ` CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${info.password}';`
    + ` ALTER USER '${user}'@'%' IDENTIFIED BY '${info.password}';`
    + ` GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'%'; FLUSH PRIVILEGES;`;
  await docker(['exec', '-e', `MYSQL_PWD=${root}`, MYSQL_C, 'mysql', '-uroot', '-e', sql], { timeout: 60000 });
  return info;
}
/** SQL 导入（仅空库，幂等）：更新包带的导出一律跳过，线上数据以服务器为准 */
async function importSqlDumps(siteKey, dumps) {
  const root = mysqlRootPw();
  const db = `skillharbor_${siteKey}`;
  try {
    const r = await docker(['exec', '-e', `MYSQL_PWD=${root}`, MYSQL_C, 'mysql', '-uroot', '-N', '-B', '-e',
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${db}'`], { timeout: 30000 });
    if (String(r.stdout || '').trim() !== '0') {
      console.log(`[mysql] ${db} 非空，跳过 ${dumps.length} 个 SQL 导出（更新以线上数据为准）`);
      return false;
    }
  } catch (e) {
    console.log(`[mysql] ${db} 空库检查失败，跳过导入：${e.message}`);
    return false;
  }
  for (const f of dumps) {
    const inC = '/tmp/' + safeName(path.basename(f));
    await docker(['cp', f, `${MYSQL_C}:${inC}`], { timeout: 60000 });
    await docker(['exec', '-e', `MYSQL_PWD=${root}`, MYSQL_C, 'sh', '-c', `mysql -uroot ${db} < ${inC} && rm -f ${inC}`], { timeout: 5 * 60 * 1000 });
    console.log(`[mysql] ${db} 已导入 ${path.basename(f)}`);
  }
  return true;
}
/** 工具容器网络：与共享 MySQL 同网（skillharbor-net 不存在则创建，幂等） */
async function ensureSvcNetwork(useMysql) {
  if (!useMysql) return false;
  try { await docker(['network', 'inspect', 'skillharbor-net'], { timeout: 15000 }); }
  catch { await docker(['network', 'create', 'skillharbor-net'], { timeout: 15000 }); }
  return true;
}

/** 重建服务容器：暂存旧容器业务数据 → 移除旧容器 → create 新容器 → 回填数据 → start（端口不变，数据不丢） */
async function runServiceContainer(siteKey, tag, port, containerPort, dockerRoot, mysql) {
  const cname = svcContainer(siteKey);
  const dirs = svcDataDirs(dockerRoot ?? SERVICES[siteKey]?.dockerRoot);
  /* 1. 暂存旧容器业务数据（docker cp 对已停止的容器同样有效；成功即覆盖上次暂存）。
   *    不预先清空暂存目录：部署失败重试时旧容器已删，上次暂存的主机副本是最新数据 */
  const stage = path.join(TMP_DIR, 'svc-data', siteKey);
  fs.mkdirSync(stage, { recursive: true });
  let stagedDir = '';
  for (const dir of dirs) {
    if (await dockerCpIfExists([`${cname}:${dir}/data.json`, path.join(stage, 'data.json')])) { stagedDir = dir; break; }
  }
  /* 1a. 旧容器不可读（已被移除/部署失败后重试/下架后重新上架）：优先用主机上最近一次暂存
   *     （下架前留底或上次失败尝试的暂存，比卷快照新），其次才回落卷快照 */
  if (!stagedDir && fs.existsSync(path.join(stage, 'data.json'))) {
    stagedDir = '（最近暂存）';
    console.log(`[service] ${siteKey}：旧容器不可读，沿用最近一次暂存的业务数据`);
  }
  /* 1b. 主机也无暂存（首次部署等）：从 /data 卷快照恢复暂存
   *（只读挂卷 + cat 经 stdout 取回，不做目录 bind——平台跑在容器里，-v 的路径语义是宿主机视角） */
  if (!stagedDir) {
    try {
      const r = await docker(['run', '--rm', '-v', `skillharbor-svc-${siteKey}-data:/data:ro`, 'node:20-alpine', 'cat', '/data/data.json'],
        { timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
      const text = String(r.stdout || '').trim();
      if (text.startsWith('{')) {
        fs.writeFileSync(path.join(stage, 'data.json'), text);
        stagedDir = '/data（卷快照恢复）';
        console.log(`[service] ${siteKey}：旧容器不可读，已从 /data 卷快照恢复业务数据`);
      }
    } catch { /* 卷里也没有（首次部署等），正常路径 */ }
  }
  if (stagedDir) console.log(`[service] ${siteKey}：已暂存旧容器业务数据（${stagedDir}/data.json → ${stage}）`);
  /* 2. 移除旧容器（数据已暂存或本就没有） */
  await removeServiceContainer(cname);
  /* 3. create 新容器（不立即启动，数据回填后再 start）。
   *    资源上限默认 512m / 1cpu，可按工具在 services.json 的 limits 覆盖（Java 等大堆应用用）；
   *    services.json 的 env 表可注入自定义环境变量（如 SUPPLIES_WECHAT_DOMAIN——应用内部配置
   *    依赖部署地址的场景，改镜像不如给 env）；配了共享 MySQL 的工具挂 skillharbor-net 注入连接信息 */
  const limits = SERVICES[siteKey]?.limits || {};
  const createArgs = ['create', '--name', cname,
    '--restart', 'unless-stopped',
    '-p', `${port}:${containerPort}`,
    '-e', `PORT=${containerPort}`,
    '-v', `skillharbor-svc-${siteKey}-data:/data`,
    '--memory', limits.mem || '512m', '--cpus', limits.cpus || '1'];
  for (const [k, v] of Object.entries(SERVICES[siteKey]?.env || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k)) createArgs.push('-e', `${k}=${String(v).slice(0, 300)}`);
  }
  const mysqlInfo = mysql || SERVICES[siteKey]?.mysql;
  if (mysqlInfo && (await ensureSvcNetwork(true))) {
    createArgs.push('--network', 'skillharbor-net',
      '-e', 'DB_HOST=skillharbor-mysql', '-e', 'DB_PORT=3306',
      '-e', `DB_NAME=${mysqlInfo.db}`, '-e', `DB_USER=${mysqlInfo.user}`, '-e', `DB_PASSWORD=${mysqlInfo.password}`);
  }
  createArgs.push(tag);
  await docker(createArgs);
  /* 4. 回填业务数据：有暂存数据时以暂存为准（旧容器存活期间的数据永远是最新状态，
   *    覆盖镜像可能内置的旧 data.json）；候选目录按新版本 dockerRoot 优先，目录不存在顺延 */
  if (stagedDir) {
    let restoredDir = '';
    for (const dir of dirs) {
      if (await dockerCpIfExists([path.join(stage, 'data.json'), `${cname}:${dir}/data.json`])) { restoredDir = dir; break; }
    }
    if (restoredDir) console.log(`[service] ${siteKey}：业务数据已回填（${stagedDir} → ${restoredDir}/data.json）`);
    else console.error(`[service] ${siteKey}：警告——业务数据暂存于 ${stage} 但回填失败（候选目录 ${dirs.join('、')} 均不可写），请人工 docker cp 恢复`);
  }
  /* 5. 启动 */
  await docker(['start', cname]);
  /* 6. 卷快照刷新（best-effort）：把应用数据同步一份到 /data 卷，作为平台流程之外的灾备副本 */
  await docker(['exec', cname, 'sh', '-c', svcVolScript(dirs)]).catch(() => {});
  checkServiceAction();
}

/** 服务型工具部署：产物已落位 releases/<siteKey>/v<N>（build context）→ 构建镜像 → 重建容器 → 登记端口 */
async function deployService(siteKey, version, vDir, rec) {
  /* build context 支持包外层目录：解析时记录的 dockerRoot（Dockerfile/package.json 所在最浅目录） */
  const rootRel = rec.report?.dockerRoot || '';
  const ctx = rootRel ? path.join(vDir, rootRel) : vDir;
  if (!fs.existsSync(ctx)) throw new Error('构建目录缺失（解析信息与产物不一致），请重新上传');
  /* S2 自动修复（1417 式包：后端在 <root>/ 子目录、页面在包根、后端 PUBLIC_DIR=__dirname/.. 指向包根）：
   * 无原生 Dockerfile 时改用「包根为构建上下文 + 保持目录结构的生成 Dockerfile」——容器内
   * WORKDIR /app/<root>，COPY 后 server.js 位于 /app/<root>/，__dirname/.. 即包根，页面按原布局被服务，
   * 无需移动任何文件（与上传人在 Windows 下直接运行的布局完全一致）。
   * 有原生 Dockerfile 时尽力而为：把外部静态文件复制进构建目录（该 Dockerfile 的内部布局不可知）。 */
  const outsideFiles = rootRel
    ? fs.readdirSync(vDir).filter((f) =>
        f !== rootRel && f !== '_shots' && f !== '_docs' && fs.statSync(path.join(vDir, f)).isFile()
        && /\.(html?|css|js|png|jpe?g|gif|svg|ico|webp|json|txt|md)$/i.test(f))
    : [];
  const nativeDockerfile = fs.existsSync(path.join(ctx, 'Dockerfile'));
  let buildCtx = ctx;
  const autoFixed = [];
  if (!nativeDockerfile) {
    const tpl = (workdir, pkgPrefix) => [
      'FROM node:20-alpine',
      `WORKDIR ${workdir}`,
      `COPY ${pkgPrefix}package*.json ./`,
      'RUN npm install --omit=dev',
      'COPY . .',
      'CMD ["npm", "start"]',
      '',
    ].join('\n');
    if (rootRel && outsideFiles.length) {
      /* S2 修复：包根为上下文，目录结构原样进镜像（COPY . /app/ → /app/<root>/server.js + /app/页面，
       * __dirname/.. 即包根，页面按原布局被服务；npm install 在 WORKDIR=/app/<root> 内执行） */
      fs.writeFileSync(path.join(vDir, 'Dockerfile'), [
        'FROM node:20-alpine',
        'COPY . /app/',
        `WORKDIR /app/${rootRel}`,
        'RUN npm install --omit=dev',
        'CMD ["npm", "start"]',
        '',
      ].join('\n'));
      buildCtx = vDir;
      autoFixed.push(...outsideFiles);
      console.log(`[service] ${siteKey} v${version}：S2 自动修复（包根上下文 + 目录结构 Dockerfile），涉及 ${outsideFiles.length} 个外部文件（${outsideFiles.slice(0, 3).join('、')}${outsideFiles.length > 3 ? ' 等' : ''}）`);
    } else {
      fs.writeFileSync(path.join(ctx, 'Dockerfile'), tpl('/app', ''));
      buildCtx = ctx;
    }
  } else if (rootRel && outsideFiles.length) {
    for (const f of outsideFiles) {
      const to = path.join(ctx, f);
      if (!fs.existsSync(to)) {
        fs.copyFileSync(path.join(vDir, f), to);
        autoFixed.push(f);
      }
    }
    if (autoFixed.length) console.log(`[service] ${siteKey} v${version}：S2 尽力修复（复制 ${autoFixed.length} 个文件进原生 Dockerfile 的构建目录）`);
  }
  const tag = svcImage(siteKey, version);
  await docker(['build', '-t', tag, buildCtx], { timeout: 10 * 60 * 1000 });
  /* 共享 MySQL：包内 data/*.sql = 数据迁移导出 → 建库建号（幂等）+ 空库时导入。
   * 导入失败不阻断部署（容器仍起，工具按自身配置运行），错误进日志与部署记录 */
  let mysqlInfo = null;
  const dumps = findSqlDumps(buildCtx, rootRel);
  if (dumps.length && mysqlReady()) {
    try {
      mysqlInfo = await provisionMysql(siteKey);
      if (mysqlInfo) await importSqlDumps(siteKey, dumps);
    } catch (e) {
      console.error(`[mysql] ${siteKey} 共享库开通/导入失败（不阻断部署）：${e.message}`);
      mysqlInfo = mysqlInfo || SERVICES[siteKey]?.mysql || null;
    }
  } else if (dumps.length) {
    console.log(`[mysql] ${siteKey} 包内含 ${dumps.length} 个 SQL 导出，但共享 MySQL 未配置（DATA_DIR/secrets/mysql-root.password 缺失），未导入`);
  }
  const port = await allocServicePort(siteKey);
  const containerPort = +rec.report?.containerPort || SERVICES[siteKey]?.containerPort || 3000;
  await runServiceContainer(siteKey, tag, port, containerPort, rootRel, mysqlInfo);
  /* dockerRoot 一并登记：回滚/重新上架时 runServiceContainer 靠它定位容器内业务数据 */
  const prev = SERVICES[siteKey] || {};
  SERVICES[siteKey] = { port, containerPort, image: tag, at: Date.now(), dockerRoot: rootRel || '' };
  if (autoFixed.length) SERVICES[siteKey].autoFixed = autoFixed.slice(0, 5);
  if (mysqlInfo) SERVICES[siteKey].mysql = mysqlInfo;
  else if (prev.mysql) SERVICES[siteKey].mysql = prev.mysql; // 已配过库的工具：连接信息跨版本保留
  if (prev.limits) SERVICES[siteKey].limits = prev.limits;
  if (prev.env) SERVICES[siteKey].env = prev.env; // 自定义环境变量跨版本保留
  saveServices();
  return { port, containerPort, url: `http://${svcHost()}:${port}` };
}

/** 服务型工具版本激活：更新 meta 版本表（回滚依据）+ 保留策略清理目录与镜像 + 记部署历史 */
function activateServiceRelease(siteKey, version, info) {
  const base = path.join(UP_DIR, 'releases', siteKey);
  const meta = readReleaseMeta(base);
  meta.current = 'v' + version;
  meta.versions.push({ v: version, at: Date.now(), by: info.by || '', note: (info.note || '').slice(0, 120) });
  const tmp = path.join(base, 'meta.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, path.join(base, 'meta.json'));
  /* 保留策略：目录与镜像同步保留最近 3 版，更旧版本随新版本部署成功后自动清理。
   * 清理仅在 activate 时执行——此时新容器已接管运行，被清理版本不可能仍在运行。 */
  const all = fs.readdirSync(base).filter((x) => /^v\d+$/.test(x)).map((x) => +x.slice(1)).sort((a, b) => b - a);
  for (const v of all.slice(RELEASE_KEEP)) {
    fs.rmSync(path.join(base, 'v' + v), { recursive: true, force: true });
    serviceActions.exit(() => docker(['rmi', '-f', svcImage(siteKey, v)]).catch(() => {})); // 镜像清理失败不阻断（下次部署会覆盖 tag）
  }
  DEPLOYS.push({ id: nowId('d'), tool: siteKey, name: info.name || '', version: 'v' + version, type: info.type || 'deploy', by: info.by || '', at: Date.now() });
  saveDeploys();
  return meta;
}

/* ============================== 版本化部署（P3） ==============================
 * 新部署（新工具 / 任意更新，含旧 t<N> 工具的更新）一律落
 *   uploads/releases/u<uploadId>/v<N>/   完整产物（web=网页包，file=工具文件）
 *   uploads/sites/u<uploadId>  →  符号链接指向当前版本（原子切换，对外 URL 永不变）
 *   uploads/releases/u<uploadId>/meta.json  版本表（当前版本 + 历史）
 * 存量 t<N>/、files/ 目录永不改动，旧 URL 继续直读；保留最近 3 个版本目录。 */
const siteKeyOf = (uploadId) => 'u' + uploadId;
const RELEASE_KEEP = 3;
function readReleaseMeta(base) {
  try { return JSON.parse(fs.readFileSync(path.join(base, 'meta.json'), 'utf8')); } catch { return { current: '', versions: [] }; }
}
function nextVersion(base) {
  let max = 0;
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const v = /^v(\d+)$/.exec(d);
    if (v) max = Math.max(max, +v[1]);
  }
  return max + 1;
}
/** 激活版本：写 meta → 原子替换 sites 符号链接 → 记部署历史 → 按保留策略清理旧版本目录 */
function activateRelease(siteKey, version, info) {
  const base = path.join(UP_DIR, 'releases', siteKey);
  fs.mkdirSync(base, { recursive: true });
  const meta = readReleaseMeta(base);
  meta.current = 'v' + version;
  meta.versions.push({ v: version, at: Date.now(), by: info.by || '', note: (info.note || '').slice(0, 120) });
  {
    const t = path.join(base, 'meta.json.tmp');
    fs.writeFileSync(t, JSON.stringify(meta));
    fs.renameSync(t, path.join(base, 'meta.json'));
  }
  const sitesDir = path.join(UP_DIR, 'sites');
  fs.mkdirSync(sitesDir, { recursive: true });
  const link = path.join(sitesDir, siteKey);
  const tmpLink = path.join(sitesDir, '.tmp-' + siteKey);
  try { fs.rmSync(tmpLink, { force: true }); } catch { /* 不存在即可 */ }
  try {
    fs.symlinkSync(path.relative(sitesDir, path.join(base, 'v' + version)), tmpLink, 'dir');
  } catch {
    /* Windows 无目录符号链接权限时退回 junction（要求绝对路径目标）；Linux 不会走到这里 */
    fs.symlinkSync(path.join(base, 'v' + version), tmpLink, 'junction');
  }
  try {
    fs.renameSync(tmpLink, link); // 原子替换（覆盖指向旧版本的链接）
  } catch {
    /* Windows 上 rename 不能覆盖既有符号链接（生产 Linux 原子替换不走此分支）：
     * 先移除旧链接再就位，本地开发体验一致；间隙内 404 一次，可接受 */
    try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* 旧链接可能不存在 */ }
    fs.renameSync(tmpLink, link);
  }
  for (const d of fs.readdirSync(base).filter((x) => /^v\d+$/.test(x)).sort((a, b) => +b.slice(1) - +a.slice(1)).slice(RELEASE_KEEP)) {
    fs.rmSync(path.join(base, d), { recursive: true, force: true });
  }
  DEPLOYS.push({ id: nowId('d'), tool: siteKey, name: info.name || '', version: 'v' + version, type: info.type || 'deploy', by: info.by || '', at: Date.now() });
  saveDeploys();
  return meta;
}

/** 简单文本卡片告警（部署失败 / 探活失败 / 久未审核提醒），fire-and-forget */
async function alertText(title, md) {
  try {
    return await pushFeishuCard(
      { header: { title: { tag: 'plain_text', content: title }, template: 'red' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: md } }] },
      title,
    );
  } catch {
    return false;
  }
}

/* tmp 回收（启动时 + 每天一次）：draft 超 7 天整条回收；无主/已终态目录超 7 天清理；pending 超 30 天提醒审核 */
function gcUploads() {
  const now = Date.now();
  const before = UPLOADS.length;
  for (let i = UPLOADS.length - 1; i >= 0; i--) {
    const r = UPLOADS[i];
    if (r.status === 'draft' && now - (r.createdAt || 0) > 7 * DAY_MS) {
      fs.rmSync(path.join(TMP_DIR, r.id), { recursive: true, force: true });
      const original = path.join(ORIGINAL_UPLOADS_DIR, r.id + '.bin');
      if (fs.existsSync(original)) fs.unlinkSync(original);
      const analysisSource = path.join(ANALYSIS_SOURCES_DIR, r.id + '.zip');
      if (fs.existsSync(analysisSource)) fs.unlinkSync(analysisSource);
      UPLOADS.splice(i, 1);
    }
  }
  if (UPLOADS.length !== before) saveUploads();
  const active = new Set(UPLOADS.filter((x) => ['draft', 'rejected', 'pending', 'deploying', 'deploy_failed'].includes(x.status)).map((x) => x.id));
  for (const f of fs.readdirSync(TMP_DIR)) {
    // Service recovery snapshots outlive upload drafts; nested writes do not refresh this parent mtime.
    if (f === 'svc-data') continue;
    const p = path.join(TMP_DIR, f);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory() || active.has(f) || now - st.mtimeMs <= 7 * DAY_MS) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 目录被并发操作等异常忽略 */ }
  }
  const stale = UPLOADS.filter((x) => x.status === 'pending' && x.submittedAt && now - x.submittedAt > 30 * DAY_MS);
  if (stale.length) {
    alertText('提交久未审核', `${stale.length} 条提交超过 30 天未审核（最早 ${new Date(Math.min(...stale.map((x) => x.submittedAt))).toLocaleDateString('zh-CN')}），请处理：\n${stale.slice(0, 5).map((x) => `· ${x.name || x.filename || x.id}（${x.n || '?'}）`).join('\n')}`);
  }
}
/* 内置工具（前端静态名册）的下架状态与字段覆盖：工具管理页可编辑/上下架内置工具，需服务端持久化 */
let TOOL_STATUS = readJSON('tool-status.json', {});
const saveToolStatus = () => writeJSON('tool-status.json', TOOL_STATUS);
let TOOL_OVERRIDES = readJSON('tool-overrides.json', {});
const saveToolOverrides = () => writeJSON('tool-overrides.json', TOOL_OVERRIDES);
/* 技能「适用部门」门户本地配置（技能中心数据源无此字段）：slug → 部门短名数组（['全部'] = 全部门适用），
 * 管理端技能详情编辑；首页「适用部门」筛选行读取，未配置的技能按归属部门（上传人部门）参与筛选 */
let SKILL_DEPTS = readJSON('skill-departments.json', {});
const saveSkillDepts = () => writeJSON('skill-departments.json', SKILL_DEPTS);
/* 一次性回填：技能「适用部门」上线（2026-09-14）前，上传弹窗已采集该字段但审批上架时被丢弃——
 * 历史在线技能记录里的 departments 从未写入配置。启动时补写一次（标记文件防重复执行，
 * 避免覆盖管理员事后在技能详情里的删除/修改），只补缺失项，已配置的不动 */
const SKILL_DEPTS_BACKFILL_FLAG = 'skill-departments-backfilled.flag';
if (!fs.existsSync(path.join(DATA_DIR, SKILL_DEPTS_BACKFILL_FLAG))) {
  let filled = 0;
  for (const x of UPLOADS) {
    if (x.kind !== 'skill' || x.status !== 'online' || !x.publishSlug) continue;
    if (!Array.isArray(x.departments) || !x.departments.length || SKILL_DEPTS[x.publishSlug]) continue;
    SKILL_DEPTS[x.publishSlug] = x.departments.slice(0, 16);
    filled++;
  }
  if (filled) saveSkillDepts();
  writeJSON(SKILL_DEPTS_BACKFILL_FLAG, { at: Date.now(), filled });
  if (filled) console.log(`[skill-departments] 回填 ${filled} 条历史技能适用部门配置`);
}
/* 「使用次数清零」时间点（工具 id → 毫秒时间戳）：各端据此作废本地点击增量（见前端 useUsage.applyUsageResets） */
let USAGE_RESET = readJSON('usage-reset.json', {});
const saveUsageReset = () => writeJSON('usage-reset.json', USAGE_RESET);
const GW_BASE = () => process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800';
/* 技能网关服务令牌（SKILL_GATEWAY_TOKEN，须与网关 GATEWAY_ADMIN_TOKEN 一致）。
 * 网关独立化后 /api/* 全量 Bearer 鉴权，门户所有网关调用统一走本助手带令牌 */
const gwHeaders = () => {
  const h = { 'User-Agent': 'skillharbor' };
  const t = process.env.SKILL_GATEWAY_TOKEN || '';
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
};

async function lookupSmartTarget(binding, user, { allowMissing = false, allowForeign = false } = {}) {
  if (typeof binding !== 'string' || !/^(skill|tool):[a-z0-9][a-z0-9._-]*$/.test(binding)) throw Object.assign(new Error('请选择页面提供的发布对象'), { status: 400 });
  if (binding.startsWith('tool:')) {
    const tool = EXTRA_TOOLS.find(item => item.id === binding.slice(5) && item.status === 'online');
    const owner = tool && UPLOADS.find(item => item.id === tool.uploadId);
    if (!tool || owner?.u !== user.username) throw Object.assign(new Error('只能更新本人已发布的工具'), { status: 403 });
    const displayMetadata = Object.fromEntries(['icon', 'iconUrl', 'iconBg', 'url', 'tags', 'departments', 'category'].filter(key => Object.hasOwn(tool, key) || Object.hasOwn(owner, key)).map(key => [key, Object.hasOwn(tool, key) ? tool[key] : owner[key]]));
    if (!Array.isArray(displayMetadata.tags)) displayMetadata.tags = [];
    if (!Array.isArray(displayMetadata.departments)) displayMetadata.departments = ['全部'];
    return { name: tool.name, owned: true, displayMetadata, uploadKind: { local: 'web', service: 'service', download: 'file' }[tool.type] || 'link' };
  }
  const slug = binding.slice(6);
  const response = await fetch(GW_BASE() + '/api/skills/' + encodeURIComponent(slug), { headers: gwHeaders(), signal: AbortSignal.timeout(15000) });
  if (response.status === 404 && allowMissing) return null;
  if (!response.ok) throw Object.assign(new Error('无法确认发布对象，请稍后重试'), { status: 502 });
  const target = await response.json();
  if (!target || target.slug !== slug || typeof target.current_version !== 'string') throw Object.assign(new Error('发布对象信息不完整，请稍后重试'), { status: 502 });
  const owned = target.owner === user.name || UPLOADS.some(item => item.kind === 'skill' && item.status === 'online' && item.u === user.username && item.publishSlug === slug);
  if (!owned && !allowForeign) throw Object.assign(new Error('只能更新本人负责的智能体或技能'), { status: 403 });
  const prior = UPLOADS.filter(item => item.u === user.username && item.status === 'online' && item.publishSlug === slug).sort((a, b) => (b.updatedAt || b.approvedAt || b.createdAt) - (a.updatedAt || a.approvedAt || a.createdAt))[0] || {};
  const displayMetadata = Object.fromEntries(['icon', 'iconUrl', 'iconBg', 'tags', 'departments', 'category'].filter(key => Object.hasOwn(prior, key)).map(key => [key, prior[key]]));
  if (target.category) displayMetadata.category = target.category;
  if (Array.isArray(SKILL_DEPTS[slug])) displayMetadata.departments = SKILL_DEPTS[slug];
  if (!Array.isArray(displayMetadata.tags)) displayMetadata.tags = [];
  if (!Array.isArray(displayMetadata.departments)) displayMetadata.departments = ['全部'];
  return { slug, owned, displayMetadata, name: target.display_name || target.name || slug, nextVersion: owned ? nextSkillVersion(target.current_version) : undefined };
}
/* 用户内容独立源（生产：skillharbor-files/nginx 容器从 8180 提供，与门户跨源 → 上传工具的脚本碰不到门户令牌）。
 * 未配置时（本地开发）回落门户同源相对路径，行为与旧版一致。 */
const FILES_BASE = (process.env.FILES_BASE || '').replace(/\/$/, '');
const filesUrl = (p) => (FILES_BASE ? FILES_BASE + p : p);
const ymdOf = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/** 工具名册（统计报表用）：静态工具 + 已上线上传工具 */
let TOOL_NAMES = {};
try {
  for (const t of JSON.parse(fs.readFileSync(path.join(__dirname, 'server-seed-tools.json'), 'utf8'))) TOOL_NAMES[t.id] = t;
} catch { /* 无种子时仅统计上传工具 */ }
function toolName(id) {
  return TOOL_NAMES[id] || EXTRA_TOOLS.find((t) => t.id === id) || { name: id, owner: '—', department: '—' };
}

/** 零依赖 zip 读取：EOCD → 中央目录 → inflateRaw 解压
 *  防护（规则 R6/R7）：路径穿越 / 压缩炸弹在解压前拦截；上限可用 ZIP_TOTAL_MB / ZIP_MAX_FILES 环境变量调整（默认 500MB / 3000 个）
 *  开发环境垃圾（venv / node_modules / 缓存等）在解压前剔除（不计文件数与总量），剔除数量挂在返回数组 .junk 供报告展示 */
const ZIP_JUNK = /(^|\/)(venv|\.venv|node_modules|__pycache__|\.git|\.svn|\.hg|\.idea|\.vscode|\.pytest_cache|\.mypy_cache)(\/|$)|\.py[co]$|(^|\/)(\.DS_Store|Thumbs\.db)$/i;
function zipRead(buf) {
  const EOCD = 0x06054b50;
  const LIMIT_TOTAL = Number(process.env.ZIP_TOTAL_MB || 500) * 1024 * 1024;
  const LIMIT_FILES = Number(process.env.ZIP_MAX_FILES || 3000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: 未找到目录（文件可能损坏或不是 zip）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let totalOut = 0; // 解压总量上限（防 zip 炸弹：单条 256MB 之外再限总量 / 条数）
  let junk = 0; // 被剔除的开发环境文件数
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    /* 条目名解码：声明 UTF-8（EFS 位）按 UTF-8；否则强解 UTF-8 出 U+FFFD 时用 GBK 兜底——
     * Windows 中文压缩工具（WinRAR/好压等）按 GBK 写文件名，包内 Dockerfile/CODE 引用的却是
     * 正确中文名，乱码名会让 COPY 找不到文件（2026-09-17 结构洞工具部署失败根因）。
     * GBK 解码仍出 U+FFFD（包名上游已损坏或非 GBK 编码）则保留 UTF-8 强解结果，不引入锟斤拷。 */
    const rawName = buf.slice(p + 46, p + 46 + nameLen);
    let name = rawName.toString('utf8');
    if (!(flags & 0x800) && name.includes('\uFFFD')) {
      try {
        const gbk = new TextDecoder('gbk').decode(rawName);
        if (!gbk.includes('\uFFFD')) name = gbk;
      } catch { /* 环境无 GBK 解码器时保留 UTF-8 强解结果 */ }
    }
    p += 46 + nameLen + extraLen + cmtLen;
    if (flags & 1) throw new Error(`zip: ${name} 加密，不支持`);
    if (name.endsWith('/')) continue; // 目录项
    // Windows 自带压缩等工具会把分隔符写成反斜杠（assets\tailwind.js），统一归一为 / 再校验与分发
    name = name.replace(/\\/g, '/');
    if (ZIP_JUNK.test(name)) { junk++; continue; } // 开发垃圾剔除名单刻意保守：不含 dist / build / env 等可能是正常产物的名字
    if (/(^|\/)\.\.(\/|$)/.test(name) || name.startsWith('/')) {
      const err = new Error(`zip: 非法路径 ${name}`);
      err.code = 'ZIP_SLIP';
      throw err;
    }
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: 256 * 1024 * 1024 });
    totalOut += data.length;
    if (entries.length >= LIMIT_FILES || totalOut > LIMIT_TOTAL) {
      const err = new Error(`zip: 解压总量超限（已 ${entries.length + 1} 个文件 / ${(totalOut / 1024 / 1024).toFixed(0)}MB，上限 ${LIMIT_FILES} 个 / ${Math.round(LIMIT_TOTAL / 1024 / 1024)}MB）`);
      err.code = 'ZIP_BOMB';
      throw err;
    }
    entries.push({ name, data });
  }
  if (!entries.length) throw new Error('zip: 没有可用文件（开发垃圾剔除后包内为空，请确认打包的是工具本体目录）');
  entries.junk = junk;
  return entries;
}

const safeExt = (n) => (n || '').replace(/[^\w.-]/g, '_').slice(0, 60) || 'file';
/** 保留中文的存储文件名：仅去掉路径分隔符与 Windows 保留字符 */
const safeName = (n) => String(n || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80) || 'file';

/* ============================== 技能包发布 ============================== */

async function requireNewSkillIdentity(slug) {
  if (typeof slug !== 'string' || !slug) throw new Error('无法确认资源固定标识，请重新预览上传包');
  const response = await fetch(GW_BASE() + '/api/skills/' + encodeURIComponent(slug), { headers: gwHeaders(), signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return;
  if (response.ok) throw new Error(`固定标识「${slug}」已存在，请选择本人资源作为更新对象；新资源须使用不同标识`);
  throw new Error('无法确认固定标识是否已存在，请稍后重试');
}

/** 把已审核的技能发布到Skill Center（独立 skill-gateway 服务，/api/* 需服务令牌，上传接口要求 zip 包）。
 * rec.updateOf = 'skill:<slug>' 时为更新提交：定位该技能当前版本自动升补丁号，更新说明写入版本备注。
 * 上传响应显式返回 {slug, version}（网关契约），不再用前后清单 diff 猜测 slug */
async function publishSkillToGateway(rec) {
  const base = GW_BASE();
  const H = gwHeaders();
  const tmpDir = path.join(TMP_DIR, rec.id);
  if (!fs.existsSync(tmpDir)) throw new Error('原始技能包已过期，请让申请人重新上传');
  // Recheck dependencies before publishing; both old drafts and new uploads use the gateway's root selection.
  const updSlug = rec.updateOf && rec.updateOf.startsWith('skill:') ? rec.updateOf.slice(6) : '';
  const inspected = await inspectSkillArchive(base, H, makeZip(collectSkillPackage(tmpDir, '', null)), updSlug);
  if (inspected.errors?.length) throw new Error(inspected.errors.join('；'));
  if (!updSlug) await requireNewSkillIdentity(inspected.structure?.slug);
  if (rec.report?.packageRoot !== undefined && (rec.report.packageRoot !== inspected.root || rec.report.packageEntry !== inspected.entry)) {
    throw new Error('技能包入口与上传预览不一致，请重新上传检查');
  }
  const files = collectSkillPackage(tmpDir, inspected.root, inspected.entry);
  const zipBuf = makeZip(files);

  let firstVersion = '1.0.0';
  if (updSlug) {
    const det = await (await fetch(base + '/api/skills/' + encodeURIComponent(updSlug), { headers: H })).json().catch(() => null);
    if (!det || (!det.current_version && !det.version)) {
      throw new Error('绑定的技能在技能中心不存在（可能已被删除），请改用「全新提交」');
    }
    firstVersion = nextSkillVersion(det.current_version || det.version);
  }
  const note = rec.updateNote
    ? ('更新：' + rec.updateNote).slice(0, 120)
    : '门户上传自动上架 · 提交人 ' + rec.n;
  const uploadOnce = async (version) => {
    const fd = new FormData();
    fd.append('file', new Blob([zipBuf]), 'skill-package.zip');
    fd.append('version', version);
    fd.append('note', note);
    if (rec.name) fd.append('display_name', rec.name);
    if (rec.category) fd.append('category', rec.category);
    if (updSlug) fd.append('slug', updSlug);
    else fd.append('create_only', 'true');
    fd.append('owner', rec.n || ''); // 上传人 = 门户提交人，技能中心首次上传时记录归属
    const up = await fetch(base + '/api/skills/upload', { method: 'POST', body: fd, headers: H });
    return { ok: up.ok, status: up.status, json: await up.json().catch(() => ({})) };
  };
  const manifestVersion = inspected.structure.source === 'manifest' ? inspected.structure.version : '';
  let tryVersion = manifestVersion || String(rec.updateVersion || firstVersion).slice(0, 20);
  let up = await uploadOnce(tryVersion);
  let upJson = up.json;
  // 同名技能已存在该版本 → 查当前版本并自增补丁号重试（最多 20 次）
  for (let i = 0; updSlug && !manifestVersion && !up.ok && /version already exists/i.test(JSON.stringify(upJson)) && i < 20; i++) {
    let cur = tryVersion;
    try {
      const guessSlug = updSlug || (await (await fetch(base + '/api/skills', { headers: H })).json())
        .find((x) => (x.display_name || x.name) === (rec.name || ''))?.slug;
      if (guessSlug) {
        const detail = await (await fetch(base + '/api/skills/' + encodeURIComponent(guessSlug), { headers: H })).json();
        cur = String(detail.current_version || detail.version || cur);
      }
    } catch { /* 查不到就用本地递增 */ }
    tryVersion = nextSkillVersion(cur);
    up = await uploadOnce(tryVersion);
    upJson = up.json;
  }
  if (!up.ok) throw new Error('技能中心返回 ' + up.status + '：' + JSON.stringify(upJson).slice(0, 140));
  // 契约：上传响应显式携带 {slug, version}；更新提交以绑定 slug 为准（SKILL.md name 决定同一技能）
  const slug = upJson.slug || upJson.skill_slug || (updSlug || '');
  if (!slug) throw new Error('技能中心响应缺少技能标识（slug），请检查网关版本是否已升级至独立版');
  if (rec.name) {
    await fetch(`${base}/api/skills/${encodeURIComponent(slug)}/meta?display_name=${encodeURIComponent(rec.name)}`, { method: 'POST', headers: H }).catch(() => {});
  }
  await fetch(`${base}/api/skills/${encodeURIComponent(slug)}/status?status=enabled`, { method: 'POST', headers: H }).catch(() => {});
  return slug;
}

/* 技能上架成功后同步「适用部门」：上传弹窗对 AI 技能同样采集该字段（提交时校验落 rec.departments，
 * 空缺回退「全部」），上架后写入门户本地配置（skill-departments.json），首页「适用部门」筛选行据此生效。
 * 口径与工具一致——后续更新提交会随审批覆盖；管理端亦可在技能详情改（改后会被下一次更新审批覆盖） */
function syncSkillDeptsFromRecord(slug, rec) {
  if (!slug || !Array.isArray(rec?.departments) || !rec.departments.length) return;
  SKILL_DEPTS[slug] = rec.departments.slice(0, 16);
  saveSkillDepts();
  /* 新技能上架后归属部门映射立即失效重算（否则最长 5 分钟内首页归属部门筛不到该技能） */
  skillDeptCache = null;
}

/** #3 技能重名防线：WorkBuddy 壳技能以技能中文名作文件夹名，两个同名技能会在员工端互相覆盖。
 * 提交 / 改判 / 审批 / 重新上架前校验：门户在途记录（待审/部署中/在线/部署失败可重试）与
 * 技能中心现存技能（含停用——日后重新启用同样撞名）都不能同名。网关不可达时跳过在线比对，
 * 不阻断主流程（上架时 publishSkillToGateway 还有兜底报错）。返回 '' 表示无冲突 */async function findSkillNameConflict(name, excludeId, excludeSlug) {
  const n = String(name || '').trim();
  if (!n) return '';
  const dup = UPLOADS.find((x) =>
    x.kind === 'skill' && x.id !== excludeId
    && ['pending', 'deploying', 'online', 'deploy_failed'].includes(x.status)
    && String(x.name || '').trim() === n);
  if (dup) return `已有同名技能「${n}」${dup.status === 'online' ? '已上线' : '正在审核'}（提交人 ${dup.n || '—'}），请换个名称`;
  try {
    const list = await (await fetch(GW_BASE() + '/api/skills', { headers: gwHeaders(), signal: AbortSignal.timeout(4000) })).json();
    const hit = (Array.isArray(list) ? list : []).find((s) => s.slug !== excludeSlug && String(s.display_name || s.name || '').trim() === n);
    if (hit) return `技能中心已存在同名技能「${n}」${hit.status === 'enabled' ? '' : '（已停用）'}，请换个名称`;
  } catch { /* 网关不可达：跳过在线比对 */ }
  return '';
}
const MB = 1024 * 1024;

/* ============================== 飞书机器人推送（待审 + 告警卡片） ============================== */

/* 飞书 webhook：管理后台「系统设置」可配置（落数据卷 alert-webhook.json）；环境变量仅在首次初始化时作种子，源码不再内置地址 */
let ALERT_CFG = readJSON('alert-webhook.json', null);
if (!ALERT_CFG || typeof ALERT_CFG.url !== 'string') {
  ALERT_CFG = { url: process.env.FEISHU_WEBHOOK_URL || '' };
  writeJSON('alert-webhook.json', ALERT_CFG);
}
const saveAlertCfg = () => writeJSON('alert-webhook.json', ALERT_CFG);
/* 门户对外地址（卡片按钮链接）：固定 192 地址，不从请求 Host 推导（本机 curl 会得到 127.0.0.1） */
const PORTAL_BASE = (process.env.PORTAL_URL || 'http://127.0.0.1:8900').replace(/\/$/, '');
const KIND_LABEL_ZH = { web: '网页工具', skill: 'AI 技能', file: '文件下载', link: '外部链接', service: '服务型工具' };
const ALERT_LEVEL_ZH = { high: '高级', low: '提示' };
const ALERT_TYPE_ZH = { scrape: '疑似刷库', auth: '令牌异常', rollback: '版本回滚', stale: '久未更新' };

/** 飞书卡片推送：按业务 code 判定成功（卡片 schema 错误时飞书仍返回 HTTP 200） */
async function pushFeishuCard(card, tag) {
  if (!ALERT_CFG.url) {
    console.log(`[feishu] 未配置 webhook，跳过${tag}推送（管理后台 · 系统设置 可配置）`);
    return false;
  }
  const r = await fetch(ALERT_CFG.url, {
    signal: AbortSignal.timeout(8000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', card }),
  });
  const out = await r.json().catch(() => ({}));
  if (r.ok && (out.code === 0 || out.StatusCode === 0)) {
    console.log(`[feishu] ${tag}已推送`);
    return true;
  }
  console.log('[feishu] push failed:', r.status, JSON.stringify(out).slice(0, 160));
  return false;
}

/** 新增待审记录 → 飞书群机器人（交互卡片：字段两列 + 「去审核」按钮）；fire-and-forget，失败仅记日志 */
async function notifyPendingReview(rec) {
  try {
    const kind = KIND_LABEL_ZH[rec.kind] || rec.kind;
    const name = rec.name || rec.filename || '（未命名）';
    const isUpdate = !!rec.updateOf;
    const time = new Date(rec.submittedAt).toLocaleString('zh-CN', { hour12: false });
    const url = `${PORTAL_BASE}/#/admin?view=review`;
    const fields = [
      { is_short: true, text: { tag: 'lark_md', content: `**类型**\n${kind}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**申请人**\n${rec.n}（${rec.d}）` } },
      { is_short: false, text: { tag: 'lark_md', content: `**名称**\n${name}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**版本**\n${isUpdate ? (rec.updateOf.startsWith('skill:') ? '更新提交 · 通过后升版本' : '更新提交 · 通过后替换部署') : '全新提交'}` } },
      { is_short: true, text: { tag: 'lark_md', content: `**提交时间**\n${time}` } },
    ];
    const elements = [{ tag: 'div', fields }];
    if (isUpdate && rec.updateNote) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**更新说明**：${String(rec.updateNote).slice(0, 100)}` } });
    }
    elements.push(
      { tag: 'hr' },
      { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '去审核' }, type: 'primary', url }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '通过后自动部署 / 上架技能中心 · 驳回不影响线上版本 · 本消息由 SkillHarbor 门户自动发送' }] },
    );
    await pushFeishuCard(
      {
        config: { wide_markdown_mode: true },
        header: { template: isUpdate ? 'orange' : 'violet', title: { tag: 'plain_text', content: `SkillHarbor · 新待审核（${isUpdate ? '更新' : '新增'}）` } },
        elements,
      },
      `待审卡片：${name}（${rec.n}）`,
    );
  } catch (e) {
    console.log('[feishu] push error:', e.message);
  }
}

/* ---- 技能中心告警 → 飞书卡片：轮询网关待处理告警，仅推新增（seen 持久化，重启不重推） ---- */

let ALERTS_SEEN = readJSON('alerts-seen.json', null);
let lastAlertAttempt;
let alertPollRunning = false;

async function pushAlertCard(a) {
  const high = a.level === 'high';
  const fields = [
    { is_short: true, text: { tag: 'lark_md', content: `**级别**\n${ALERT_LEVEL_ZH[a.level] || a.level || '未知'}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**类型**\n${ALERT_TYPE_ZH[a.type] || a.type || '异常'}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**对象**\n${a.subject || '—'}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**详情**\n${a.description || '—'}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**触发时间**\n${a.ts || '—'}` } },
  ];
  return pushFeishuCard(
    {
      config: { wide_markdown_mode: true },
      header: { template: high ? 'red' : 'yellow', title: { tag: 'plain_text', content: `SkillHarbor · 技能中心告警${high ? '（高级）' : ''}` } },
      elements: [
        { tag: 'div', fields },
        { tag: 'hr' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '去处理' }, type: high ? 'danger' : 'primary', url: `${GW_BASE()}/#/alerts` }] },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '告警由技能网关规则自动生成 · 在网关控制台核实与归档 · 本消息由 SkillHarbor 门户自动转发' }] },
      ],
    },
    `告警卡片：${ALERT_TYPE_ZH[a.type] || a.type || '异常'}（${a.subject || ''}）`,
  );
}

async function pollGatewayAlerts() {
  if (alertPollRunning) return;
  alertPollRunning = true;
  try {
    const response = await fetch(GW_BASE() + '/api/alerts?status=open', { headers: gwHeaders(), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return;
    const list = await response.json();
    if (!Array.isArray(list)) return;
    const seen = new Set(Array.isArray(ALERTS_SEEN?.ids) ? ALERTS_SEEN.ids : []);
    const unique = new Map(list.filter(a => a && (typeof a.id === 'string' && a.id.trim() || typeof a.id === 'number' && Number.isFinite(a.id))).map(a => [a.id, a]));
    const ordered = [...unique.values()];
    const nextIndex = ordered.findIndex(a => a.id === lastAlertAttempt) + 1;
    const fresh = [...ordered.slice(nextIndex), ...ordered.slice(0, nextIndex)].filter(a => !seen.has(a.id));
    for (const alert of fresh.slice(0, 5)) {
      lastAlertAttempt = alert.id;
      try {
        if (await pushAlertCard(alert) !== true) continue;
        const next = { ids: [...seen, alert.id], at: Date.now() };
        writeJSON('alerts-seen.json', next);
        ALERTS_SEEN = next;
        seen.add(alert.id);
      } catch { /* 单条失败不消费，继续处理本轮其他告警 */ }
    }
  } catch { /* 网关不可达时下轮重试 */ }
  finally { alertPollRunning = false; }
}

if (process.env.DISABLE_ALERT_POLL !== '1') {
  const firstPoll = setTimeout(pollGatewayAlerts, 8000); // 启动稍等，避开网关瞬断
  const alertTimer = setInterval(pollGatewayAlerts, 60 * 1000);
  if (firstPoll.unref) firstPoll.unref();
  if (alertTimer.unref) alertTimer.unref();
}

/** 解析上传内容，产出报告并解包到 tmp/<id>/（供预览与部署） */
/* ============================== 上传校验规则引擎（P2） ==============================
 * parseUpload 产出 rep.rules = [{id, level: 'error'|'warn', msg, fix}]：
 *   error → verdict 'fail'（提交前端拦截 + submit 网关兜底，未清零不能进审核）
 *   warn  → 可提交，审核中心分级醒目展示
 * rep.lines 同步写兼容文案（✗/⚠ 前缀），旧版报告展示不受影响。
 * 规则清单见 docs/上传部署链路改造方案.md §3 */
const DB_EXT = /\.(db|sqlite|sqlite3|mdb|accdb|dbf)$/i;
const EXEC_EXT = /\.(exe|msi|scr|com|pif|bat|cmd|vbs|ps1|jar)$/i;
/* 桌面/安装程序扩展（zip 自动识别分流到下载类用）：不含 bat/ps1 等脚本——脚本常作为网页工具附属物出现，不能据此判型 */
const DESKTOP_APP_EXT = /\.(exe|msi|apk|dmg)$/i;
const DOUBLE_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|txt)\.(exe|scr|bat|cmd|js|vbs|jar)$/i;
const SECRET_FILE = /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|kdbx)$/i;
const TEXT_EXT_SECRET = /\.(env|json|js|py|txt|md|ya?ml|conf|ini|toml|cfg|html)$/i;
const SECRET_CONTENT = /(api[_-]?key|secret|token|passwd|password|access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{20,}/i;
const PHONE_RE = /\b1[3-9]\d{9}\b/g;
const IDCARD_RE = /\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g;
const SERVER_DEPS = new Set(['express', 'koa', 'fastify', '@nestjs/core', 'egg', 'hapi', 'socket.io', 'mongoose', 'sequelize', 'prisma', '@prisma/client', 'mysql2', 'pg', 'mongodb', 'sqlite3', 'better-sqlite3']);
const BACKEND_PY = /^\s*(?:from\s+(flask|fastapi|django|tornado|aiohttp|uvicorn|celery|sqlalchemy|pymysql|psycopg2)[.\s]|import\s+(flask|fastapi|django|tornado|aiohttp|uvicorn|celery|sqlalchemy)\b)/im;
const BACKEND_JS = /require\(\s*['"](express|koa|fastify|socket\.io|@nestjs\/core|egg)['"]\s*\)|import\s[^;\n]*from\s+['"](express|koa|fastify|socket\.io|@nestjs\/core|egg)['"]/;
const FIX_BACKEND = '本平台仅支持纯前端静态工具，请移除后端代码（服务端框架/依赖）后重新打包；如确需后端能力，请联系管理员评估服务型工具通道';

/** 扫描 HTML 内 src/href：外链计数 / 包内缺失 / 绝对路径三类结果。
 *  先剔除 icon/manifest/preload 等可缺失的 link 标签与模板占位符，控制误报 */
function scanHtmlRefs(html, basePath, nameSet) {
  const out = { missing: [], absolute: [], ext: 0 };
  const clean = html.replace(/<link[^>]+rel=["']?(shortcut\s+icon|icon|apple-touch-icon|manifest|preload|prefetch)["']?[^>]*>/gi, '');
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(clean))) {
    const raw = m[1].trim();
    if (!raw) continue;
    if (/^https?:/i.test(raw)) { out.ext++; continue; }
    if (/^(data:|mailto:|tel:|javascript:|#|\/\/)/i.test(raw)) continue;
    if (/\{\{|\$\{|<%/.test(raw)) continue; // 模板占位符（运行时才生成）
    if (/^\$/.test(raw)) continue; // JS replace 替换串令牌（$1/$2，内联脚本字符串），非真实路径
    const rel = raw.split(/[?#]/)[0];
    if (!rel) continue;
    if (/^file:/i.test(rel) || rel.startsWith('/')) { out.absolute.push(rel); continue; }
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(basePath), rel));
    if (p.startsWith('..') || p.startsWith('/')) { out.absolute.push(rel); continue; }
    if (!nameSet.has(p) && !nameSet.has(p + '/index.html')) out.missing.push(rel);
  }
  return out;
}

/** 扫描 CSS 内 url(...) 引用（相对该 css 文件路径解析） */
function scanCssRefs(css, basePath, nameSet) {
  const out = { missing: [], absolute: [] };
  const re = /url\(\s*['"]?([^)'"]+)['"]?\s*\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const raw = m[1].trim();
    if (!raw || /^(data:|#|\/\/)/i.test(raw)) continue;
    if (/^https?:/i.test(raw)) continue;
    if (/\{\{|\$\{|<%/.test(raw)) continue;
    if (/^\$/.test(raw)) continue; // JS replace 替换串令牌，非真实路径
    if (raw.startsWith('/') || /^file:/i.test(raw)) { out.absolute.push(raw); continue; }
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(basePath), raw.split(/[?#]/)[0]));
    if (p.startsWith('..') || p.startsWith('/')) { out.absolute.push(raw); continue; }
    if (!nameSet.has(p)) out.missing.push(raw);
  }
  return out;
}

/** 免选类型：按包内容自动判定通道。优先级：SKILL.md → 技能；后端证据（Dockerfile/package.json+start/
 * 后端依赖/工程）→ 服务型；桌面程序（exe/msi/apk/dmg）→ 文件下载；有 HTML → 网页；都没有 → 仍走网页分支
 * 产出规范的 R1 报错。exe 判型先于 HTML：桌面程序包（Electron 等未 asar 化时）常带 html 资源页，若按网页
 * 部署同事将无法运行；而网页工具包内带 exe/安装包的情形几乎不存在。 */
function detectKind(file) {
  const fname = String(file.filename || '').toLowerCase();
  if (!fname.endsWith('.zip')) {
    if (/\.html?$/.test(fname)) return { kind: 'web', reason: '单文件网页' };
    if (/\.md$/i.test(String(file.filename || ''))) return { kind: 'skill', reason: 'Markdown 技能文件' };
    return { kind: 'file', reason: '非压缩包文件' };
  }
  let entries;
  try { entries = zipRead(file.data); } catch { return { kind: 'web', reason: '' }; } // 坏 zip 交给网页分支给规范错误
  const shallow = (re) => entries.filter((e) => re.test(e.name)).sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  const skillMd = shallow(/(^|\/)skill\.md$/i);
  const manifest = shallow(/(^|\/)agent\.ya?ml$/i);
  if (manifest) return { kind: 'skill', reason: `包内含智能体清单（${manifest.name}）` };
  // A vibe-built project need not name its main instructions SKILL.md. Read
  // bounded frontmatter only; references or examples elsewhere are not intent.
  const markdown = entries.filter(entry => /\.md$/i.test(entry.name)).map(entry => {
    const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(entry.data.subarray(0, 128 * 1024).toString('utf8'))?.[1] || '';
    return { entry, header };
  });
  const declared = markdown.find(item => /^type:\s*["']?agent["']?\s*$/im.test(item.header));
  if (declared) return { kind: 'skill', reason: `项目说明明确声明智能体类型（${declared.entry.name}）` };
  /* 网页工具可把配套技能打进包内（如 .workbuddy/skills/…/SKILL.md）：入口 HTML 比 SKILL.md 更浅时判网页，
   * SKILL.md 更浅或平级仍判技能（纯技能包不受影响，旧行为保留） */
  const htmlEntry = entries
    .filter((e) => /\.html?$/i.test(e.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length)[0];
  const pathDepth = (n) => n.split('/').length;
  const declaredSkill = markdown.filter(item => /^type:\s*["']?skill["']?\s*$/im.test(item.header)).sort((a, b) => pathDepth(a.entry.name) - pathDepth(b.entry.name))[0];
  if (declaredSkill && !(htmlEntry && pathDepth(htmlEntry.name) < pathDepth(declaredSkill.entry.name))) return { kind: 'skill', reason: `项目主说明明确声明技能类型（${declaredSkill.entry.name}）` };
  if (skillMd && !(htmlEntry && pathDepth(htmlEntry.name) < pathDepth(skillMd.name))) {
    return { kind: 'skill', reason: `包内含 SKILL.md（${skillMd.name}）` };
  }
  if (skillMd && htmlEntry) console.log(`[detectKind] ${file.filename}：入口 HTML（${htmlEntry.name}）浅于 SKILL.md（${skillMd.name}），判网页（配套技能随包分发）`);
  const df = shallow(/(^|\/)Dockerfile$/i);
  let pkgStart = '';
  for (const p of entries.filter((e) => /(^|\/)package\.json$/i.test(e.name)).slice(0, 5)) {
    try {
      const j = JSON.parse(p.data.toString('utf8'));
      if (j.scripts && j.scripts.start) { pkgStart = p.name; break; }
    } catch { /* 损坏继续看下一个 */ }
  }
  let backendEvidence = '';
  if (df) backendEvidence = `包内含 Dockerfile（${df.name}）`;
  else if (pkgStart) backendEvidence = `package.json 带 start 启动脚本（${pkgStart}）`;
  else {
    for (const p of entries.filter((e) => /(^|\/)package\.json$/i.test(e.name)).slice(0, 5)) {
      try {
        const j = JSON.parse(p.data.toString('utf8'));
        const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
        const hit = deps.find((d) => SERVER_DEPS.has(d));
        if (hit) { backendEvidence = `检出后端依赖 ${hit}（${p.name}）`; break; }
      } catch { /* ignore */ }
    }
    if (!backendEvidence) {
      const req = entries.find((e) => /(^|\/)requirements\.txt$/i.test(e.name));
      const fw = req && (/^(flask|fastapi|django|uvicorn|tornado|gunicorn|sqlalchemy)\b/im.exec(req.data.toString('utf8')) || [])[1];
      if (fw) backendEvidence = `requirements.txt 含后端框架 ${fw}`;
      else if (entries.some((e) => /(^|\/)manage\.py$/i.test(e.name))) backendEvidence = '检出 Django 工程（manage.py）';
    }
  }
  if (backendEvidence) return { kind: 'service', reason: backendEvidence };
  const deskApp = entries.find((e) => DESKTOP_APP_EXT.test(e.name));
  if (deskApp) return { kind: 'file', reason: `包内含桌面程序 ${deskApp.name.split('/').pop()}（exe/安装包），将整包作为下载类工具分发` };
  if (entries.some((e) => /\.html?$/i.test(e.name))) return { kind: 'web', reason: '包内含 HTML 页面且无后端特征' };
  const namedInstructions = markdown.find(item => /^name:\s*\S/im.test(item.header) && /^description:\s*\S/im.test(item.header));
  if (namedInstructions) return { kind: 'skill', reason: `包内含有名称与用途的技能说明（${namedInstructions.entry.name}）` };
  return { kind: 'web', reason: '' };
}

function parseUpload(id, file, kind, inspection) {
  /* 免选类型（kind=auto）：检测分发到具体通道，解析日志首行注明判定依据；显式 kind 走原路径 */
  if (kind !== 'auto') return parseUploadKind(id, file, kind, inspection);
  const det = detectKind(file);
  const r = parseUploadKind(id, file, det.kind, inspection);
  if (det.reason) r.rep.lines.unshift(`✓ 自动识别：${KIND_LABEL_ZH[det.kind]}（依据：${det.reason}）`);
  r.detected = det.kind;
  return r;
}

function parseUploadKind(id, file, kind, inspection) {
  const dir = path.join(TMP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const rep = { verdict: 'fail', lines: [], entry: null, warns: 0, rules: [] };
  const push = (s) => rep.lines.push(s);
  /* 规则登记：error → 阻断提交（verdict fail）；warn → 审核可见。lines 同步写兼容文案 */
  const rule = (id, level, msg, fix) => {
    rep.rules.push({ id, level, msg: String(msg).slice(0, 200), fix: String(fix || '').slice(0, 160) });
    push((level === 'error' ? '✗ ' : '⚠ ') + msg);
  };
  const verdictOf = () => (rep.rules.some((r) => r.level === 'error') ? 'fail' : rep.rules.some((r) => r.level === 'warn') || rep.warns ? 'warn' : 'ok');
  const fname = file.filename.toLowerCase();
  /* 解析出的名称候选（供前端「更新已有」自动匹配：frontmatter name / 网页 title / 文件名去扩展名） */
  const names = [];
  const baseName = () => String(file.filename || '').replace(/\.(zip|html?|md)$/i, '').trim();
  const titleOf = (buf) => {
    if (!buf || buf.length > 2 * MB) return '';
    const m = /<title[^>]*>([^<]{1,60})<\/title>/i.exec(buf.toString('utf8'));
    return m ? m[1].trim() : '';
  };

  // ===== AI 技能：单个 SKILL.md 或含 SKILL.md 的 zip 压缩包 =====
  if (kind === 'skill' && fname.endsWith('.zip')) {
    let entries;
    try {
      entries = zipRead(file.data);
    } catch (e) {
      push('✗ ' + e.message);
      return { kind: 'skill', rep, names };
    }
    const totalMB = entries.reduce((s, e) => s + e.data.length, 0) / MB;
    push(`✓ 解压成功：${entries.length} 个文件，共 ${totalMB.toFixed(1)}MB`);
    if (entries.junk) push(`⚠ 已自动剔除 ${entries.junk} 个开发环境文件（venv / node_modules / 缓存等，不计入解析；若构建依赖它们请在 Dockerfile 加依赖安装步骤）`);
    // The gateway is authoritative. The fallback is retained only for legacy callers of the pure parser.
    const inspectedPath = inspection ? [inspection.root, inspection.entry].filter(Boolean).join('/') : null;
    const skillMd = inspectedPath ? entries.find(e => e.name === inspectedPath) : entries
      .filter((e) => /(^|\/)skill\.md$/i.test(e.name))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length)[0];
    if (!skillMd) {
      push('✗ 压缩包内未找到 SKILL.md（需包含 name / description 的技能文件）');
      return { kind: 'skill', rep, names };
    }
    push(`✓ SKILL.md 位置：${skillMd.name}（自动识别）`);
    const text = skillMd.data.toString('utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const fmName = fm && /^name:\s*(.+)$/m.exec(fm[1]);
    const fmDesc = fm && /^description:\s*(.+)/m.exec(fm[1]);
    if ((!fmName || !fmDesc) && !inspection) {
      push('✗ SKILL.md 缺少 frontmatter（name / description）');
      return { kind: 'skill', rep, names };
    }
    const skillName = fmName?.[1]?.trim() || inspection?.structure?.slug || baseName();
    push(`✓ 技能名称：${skillName}`);
    names.push(skillName, baseName());
    if (fmDesc) push(`✓ 触发描述：${fmDesc[1].trim().slice(0, 60)}`);
    // 参考文件（SKILL.md 之外的所有文件）
    const refs = entries.filter((e) => e !== skillMd);
    if (refs.length) {
      push(`✓ 参考文件 ${refs.length} 个：${refs.slice(0, 5).map((e) => e.name).join('、')}${refs.length > 5 ? ' 等' : ''}`);
    }
    for (const e of refs) {
      if (e.data.length > 30 * MB) {
        push(`注意：${e.name} 单文件 ${(e.data.length / MB).toFixed(0)}MB（偏大）`);
        rep.warns++;
      }
    }
    for (const e of entries) {
      const to = path.join(dir, e.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, e.data);
    }
    rep.verdict = rep.warns ? 'warn' : 'ok';
    return { kind: 'skill', rep, names };
  }

  if (kind === 'skill' || fname.endsWith('.md')) {
    const text = file.data.toString('utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const name = fm && /^name:\s*(.+)$/m.exec(fm[1]);
    const desc = fm && /^description:\s*(.+)/m.exec(fm[1]);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), file.data);
    if ((!name || !desc) && !inspection) {
      push('✗ SKILL.md 缺少 frontmatter（name / description）');
      return { kind: 'skill', rep, names };
    }
    const skillName = inspection?.names?.[0] || name?.[1]?.trim() || baseName();
    push(`✓ SKILL.md 解析成功：${skillName}`);
    names.push(skillName, baseName());
    if (desc) push(`✓ 触发描述：${desc[1].trim().slice(0, 60)}`);
    rep.verdict = 'ok';
    return { kind: 'skill', rep, names };
  }

  // ===== 服务型工具：带后端的完整应用 zip（Dockerfile / package.json） =====
  /* 该通道的用途就是运行后端代码：跳过 R2/R3 后端依赖、R10 可执行文件等静态托管规则；
   * 保留 zip 防护（R6/R7）与敏感信息警示（R9） */
  if (kind === 'service') {
    if (!fname.endsWith('.zip')) {
      rule('S1', 'error', '服务型工具需上传 zip 压缩包', '请把完整应用（含 Dockerfile 或 package.json）打成 zip 后上传');
      return { kind: 'service', rep, names };
    }
    let entries;
    try {
      entries = zipRead(file.data);
    } catch (e) {
      if (e.code === 'ZIP_SLIP') rule('R6', 'error', `检测到非法路径条目：${e.message.replace('zip: ', '')}`, '压缩包内含 .. 或绝对路径，已拒绝解压；请用标准压缩工具重新打包');
      else if (e.code === 'ZIP_BOMB') rule('R7', 'error', e.message.replace('zip: ', ''), '请精简包体（减少文件数量 / 总体积）后重新上传');
      else rule('S1', 'error', '压缩包解析失败：' + e.message, '请确认上传的是标准 zip 文件且未损坏，重新打包后再试');
      return { kind: 'service', rep, names };
    }
    const totalMB = entries.reduce((s, e) => s + e.data.length, 0) / MB;
    push(`✓ 解压成功：${entries.length} 个文件，共 ${totalMB.toFixed(1)}MB`);
    if (entries.junk) push(`⚠ 已自动剔除 ${entries.junk} 个开发环境文件（venv / node_modules / 缓存等，不计入解析；若构建依赖它们请在 Dockerfile 加依赖安装步骤）`);
    if (entries.some((e) => /(^|\/)data\/[^/]+\.sql$/i.test(e.name))) push('✓ 检测到 data/ 内 SQL 导出：首次部署将自动导入共享 MySQL（建库建号，连接信息经环境变量注入；更新包的导出不会覆盖线上数据）');
    const depth = (n) => n.split('/').length - 1;
    const shallowest = (re) => entries.filter((e) => re.test(e.name)).sort((a, b) => depth(a.name) - depth(b.name))[0];
    const dirOf = (n) => (n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '');
    const dockerfileEntry = shallowest(/(^|\/)Dockerfile$/i);
    const pkgEntry = shallowest(/(^|\/)package\.json$/i);
    if (!dockerfileEntry && !pkgEntry) {
      rule('S1', 'error', '包内未找到 Dockerfile 或 package.json', '服务型工具需含 Dockerfile（任意技术栈）或 package.json（Node 应用，须有 start 脚本）；请确认文件在包内后重新上传');
      rep.verdict = verdictOf();
      return { kind: 'service', rep, names };
    }
    let pkgJson = null;
    if (pkgEntry) {
      try { pkgJson = JSON.parse(pkgEntry.data.toString('utf8')); } catch { /* 损坏不阻断，start 校验兜底 */ }
    }
    if (!dockerfileEntry) {
      if (!pkgJson || !pkgJson.scripts || !pkgJson.scripts.start) {
        rule('S1', 'error', 'package.json 缺少 start 脚本（或 JSON 解析失败）', '请添加 "scripts": { "start": "node server.js" }（按实际入口修改），或把完整 Dockerfile 打进包内');
      } else {
        push('✓ package.json：将自动生成 Dockerfile（node:20-alpine + npm install + npm start）');
      }
    } else {
      push(`✓ Dockerfile 位置：${dockerfileEntry.name}`);
    }
    /* 构建根目录 = Dockerfile（优先）或 package.json 所在最浅目录（兼容包外层再套一层目录） */
    const rootDir = dirOf((dockerfileEntry || pkgEntry).name);
    if (rootDir) push(`✓ 构建根目录：${rootDir}/`);
    /* 1417 式隐患预警：HTML 在构建目录之外 → 不会打进镜像（部署时会自动把这些文件补进构建目录救活，日志留痕） */
    if (rootDir) {
      const outside = entries.filter((e) => /\.html?$/i.test(e.name) && !e.name.startsWith(rootDir + '/'));
      if (outside.length) {
        rule('S2', 'warn', `${outside.length} 个 HTML 位于构建目录 ${rootDir}/ 之外（如 ${outside.slice(0, 2).map((e) => e.name).join('、')}）`,
          `部署时会自动把这些文件补进构建目录，无需重新打包（部署日志留痕）；若页面仍 404 再让上传人调整`);
      }
    }
    /* S3 外置数据库/缓存依赖（error）：平台以单容器运行工具，提供不了独立 MySQL/PostgreSQL/Redis 等服务，
     * 这类包部署了也连不上库必然运行失败 → 前置硬拦截并指引改用 SQLite。
     * 扫 package.json 依赖 / requirements.txt / pom.xml / build.gradle / go.mod 的客户端库声明 */
    {
      const NODE_EXT = ['pg', 'mysql', 'mysql2', 'redis', 'ioredis', 'mongodb', 'mongoose', 'amqplib', 'kafkajs'];
      const PY_EXT = ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'pymysql', 'mysqlclient', 'redis', 'pymongo', 'motor'];
      const JVM_EXT = ['postgresql', 'mysql-connector', 'mongodb-driver', 'jedis', 'lettuce-core', 'kafka-clients'];
      const GO_EXT = ['lib/pq', 'go-sql-driver/mysql', 'go-redis'];
      const hits = [];
      if (pkgJson) {
        const deps = Object.keys(pkgJson.dependencies || {});
        hits.push(...deps.filter((d) => NODE_EXT.includes(d)));
      }
      const reqEntry = shallowest(/(^|\/)requirements\.txt$/i);
      if (reqEntry) {
        const names = reqEntry.data.toString('utf8').split(/\r?\n/)
          .map((l) => l.trim().replace(/^#.*/, '').split(/[=<>~;\s]/)[0].toLowerCase()).filter(Boolean);
        hits.push(...names.filter((d) => PY_EXT.includes(d)).map((d) => 'Python:' + d));
      }
      const jvmEntry = shallowest(/(^|\/)(pom\.xml|build\.gradle)$/i);
      if (jvmEntry) {
        const t = jvmEntry.data.toString('utf8');
        hits.push(...JVM_EXT.filter((a) => t.includes(a)).map((a) => a));
      }
      const goEntry = shallowest(/(^|\/)go\.mod$/i);
      if (goEntry) {
        const t = goEntry.data.toString('utf8');
        hits.push(...GO_EXT.filter((m) => t.includes(m)).map((m) => 'go.mod:' + m));
      }
      if (hits.length) {
        const uniq = [...new Set(hits)];
        rule('S3', 'error', `检测到外置数据库/缓存服务依赖（${uniq.slice(0, 4).join('、')}${uniq.length > 4 ? ' 等' : ''}）`,
          '平台以单容器运行工具，无法提供独立 MySQL/PostgreSQL/Redis 等服务，部署后必然连接失败；请改用 SQLite（数据库文件放 /data 目录）重新打包。确属正当需求：联系管理员，由管理员取得部署包在服务器上自行部署，再在管理后台「工具管理 → 手动添加工具」登记');
      }
    }
    /* S4 原生编译模块（warn）：无 Dockerfile 时自动生成的 node:20-alpine 镜像没有 build 工具链，原生模块可能编译失败 */
    if (!dockerfileEntry && pkgJson) {
      const NATIVE = ['better-sqlite3', 'sqlite3', 'canvas', 'sharp', 'bcrypt'];
      const nativeHit = Object.keys(pkgJson.dependencies || {}).filter((d) => NATIVE.includes(d));
      if (nativeHit.length) {
        rule('S4', 'warn', `依赖原生编译模块（${nativeHit.join('、')}），自动生成的 Dockerfile 在 node:20-alpine 上可能编译失败`,
          '建议在包内提供 Dockerfile 并装好构建工具链（如 RUN apk add --no-cache python3 make g++），或换用纯 JS 实现');
      }
    }
    /* 容器端口：Dockerfile EXPOSE 优先；未声明按约定 3000（部署时注入 PORT 环境变量，应用需监听 process.env.PORT） */
    let containerPort = 0;
    if (dockerfileEntry) {
      const expose = (/^EXPOSE\s+(\d+)/im.exec(dockerfileEntry.data.toString('utf8')) || [])[1];
      if (expose) { containerPort = +expose; push(`✓ 容器端口：EXPOSE ${expose}`); }
    }
    if (!containerPort) { containerPort = 3000; push(`• 未声明端口：按约定容器内监听 3000（部署时注入 PORT 环境变量，请确保应用监听 process.env.PORT）`); }
    rep.containerPort = containerPort;
    rep.dockerRoot = rootDir;
    if (entries.some((e) => /(^|\/)node_modules\//i.test(e.name))) {
      push('⚠ 包内含 node_modules：建议移除后重新打包（部署时自动安装依赖，可显著减小包体）');
      rep.warns++;
    }
    /* 敏感信息警示保留（服务通道不查后端依赖/可执行文件——这正是其用途） */
    const secretFiles = entries.filter((e) => SECRET_FILE.test(e.name));
    if (secretFiles.length) rule('R9', 'warn', `检测到密钥/凭据类文件：${secretFiles.slice(0, 3).map((e) => e.name).join('、')}`, '请确认包内不含真实密钥/口令；此类内容管理员将重点审核');
    let secretHits = 0;
    for (const e of entries.filter((x) => TEXT_EXT_SECRET.test(x.name)).slice(0, 50)) {
      if (e.data.length > 256 * 1024) continue;
      if (SECRET_CONTENT.test(e.data.toString('utf8'))) secretHits++;
    }
    if (secretHits) rule('R9', 'warn', `${secretHits} 个文件疑似含明文密钥/口令`, '请移除真实密钥或改用占位符（服务运行时可从 /data 卷读取）');
    names.push((pkgJson && pkgJson.name) || baseName());
    /* 包内 HTML 文件名：部署后入口路径自动发现的候选（服务型应用常见"首页 404、页面挂在具体路径"） */
    rep.htmlEntries = entries.filter((e) => /\.html?$/i.test(e.name)).map((e) => encodeURI(e.name.split('/').pop())).slice(0, 6);
    for (const e of entries) {
      if (e.data.length > 30 * MB) {
        push(`注意：${e.name} 单文件 ${(e.data.length / MB).toFixed(0)}MB（偏大）`);
        rep.warns++;
      }
    }
    for (const e of entries) {
      const to = path.join(dir, e.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, e.data);
    }
    rep.verdict = verdictOf();
    return { kind: 'service', rep, names };
  }

  /* 网页 zip 分支：仅 kind=web（auto 已由 detectKind 分流；file 类 zip 走下方下载分支，不再被 R1 误拦） */
  if (fname.endsWith('.zip') && kind !== 'file') {
    let entries;
    try {
      entries = zipRead(file.data);
    } catch (e) {
      if (e.code === 'ZIP_SLIP') rule('R6', 'error', `检测到非法路径条目：${e.message.replace('zip: ', '')}`, '压缩包内含 .. 或绝对路径，已拒绝解压；请用标准压缩工具重新打包');
      else if (e.code === 'ZIP_BOMB') rule('R7', 'error', e.message.replace('zip: ', ''), '请精简包体（减少文件数量 / 总体积）后重新上传');
      else rule('R1', 'error', '压缩包解析失败：' + e.message, '请确认上传的是标准 zip 文件且未损坏，重新打包后再试');
      return { kind: 'web', rep, names };
    }
    const totalMB = entries.reduce((s, e) => s + e.data.length, 0) / MB;
    push(`✓ 解压成功：${entries.length} 个文件，共 ${totalMB.toFixed(1)}MB`);
    if (entries.junk) push(`⚠ 已自动剔除 ${entries.junk} 个开发环境文件（venv / node_modules / 缓存等，不计入解析；若构建依赖它们请在 Dockerfile 加依赖安装步骤）`);
    const htmls = entries.filter((e) => /\.html?$/i.test(e.name));
    const pick =
      htmls.find((e) => e.name.toLowerCase() === 'index.html') ||
      htmls.sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length)[0];
    if (!pick) {
      rule('R1', 'error', '未找到入口 HTML（index.html）', '请把工具首页命名为 index.html 打进压缩包（可位于子目录，将自动识别）');
      return { kind: 'web', rep, names };
    }
    rep.entry = pick.name;
    push(`✓ 入口文件：${pick.name}（自动识别）`);
    names.push(titleOf(pick.data) || baseName());

    /* ---- 文件名级规则（全部条目扫描） ---- */
    const nameSet = new Set(entries.map((e) => e.name));
    const dbHits = entries.filter((e) => DB_EXT.test(e.name));
    if (dbHits.length) rule('R3', 'error', `检测到数据库文件：${dbHits.slice(0, 4).map((e) => e.name).join('、')}`, '静态托管无法运行数据库，请移除数据库文件（数据可导出为 json 随包分发）；确需数据库请联系管理员走服务型工具通道');
    const depHits = new Set();
    for (const p of entries.filter((e) => /(^|\/)package\.json$/i.test(e.name))) {
      try {
        const j = JSON.parse(p.data.toString('utf8'));
        for (const d of Object.keys({ ...j.dependencies, ...j.devDependencies })) if (SERVER_DEPS.has(d)) depHits.add(d);
      } catch { /* package.json 损坏不阻断，交给内容扫描 */ }
    }
    if (depHits.size) rule('R2', 'error', `检测到后端依赖：${[...depHits].slice(0, 4).join('、')}`, FIX_BACKEND);
    const req = entries.find((e) => /(^|\/)requirements\.txt$/i.test(e.name));
    if (req) {
      const hit = (/^(flask|fastapi|django|uvicorn|tornado|gunicorn|sqlalchemy)\b/im.exec(req.data.toString('utf8')) || [])[1];
      if (hit) rule('R2', 'error', `requirements.txt 含后端框架：${hit}`, FIX_BACKEND);
    }
    if (entries.some((e) => /(^|\/)manage\.py$/i.test(e.name))) rule('R2', 'error', '检测到 Django 工程（manage.py）', FIX_BACKEND);
    for (const e of entries) {
      if (e.data.length > 512 * 1024) continue;
      const t = e.data.toString('utf8');
      if (/\.py$/i.test(e.name) && BACKEND_PY.test(t)) { rule('R2', 'error', `检测到 Python 后端代码：${e.name}`, FIX_BACKEND); break; }
      if (/\.(js|cjs|mjs)$/i.test(e.name) && BACKEND_JS.test(t)) { rule('R2', 'error', `检测到 Node 后端代码：${e.name}`, FIX_BACKEND); break; }
    }

    /* ---- 内容级规则：死链 / 绝对路径 / 外链（前 20 个 HTML + 前 10 个 CSS） ---- */
    const missing = [];
    const absolute = [];
    let ext = 0;
    for (const e of htmls.slice(0, 20)) {
      if (e.data.length > 2 * MB) continue;
      const r = scanHtmlRefs(e.data.toString('utf8'), e.name, nameSet);
      ext += r.ext;
      missing.push(...r.missing.map((x) => `${e.name} → ${x}`));
      absolute.push(...r.absolute.map((x) => `${e.name}: ${x}`));
    }
    for (const e of entries.filter((x) => /\.css$/i.test(x.name)).slice(0, 10)) {
      if (e.data.length > MB) continue;
      const r = scanCssRefs(e.data.toString('utf8'), e.name, nameSet);
      missing.push(...r.missing.map((x) => `${e.name} → ${x}`));
      absolute.push(...r.absolute.map((x) => `${e.name}: ${x}`));
    }
    if (missing.length) rule('R4', 'error', `${missing.length} 处资源引用在包内不存在（如 ${missing.slice(0, 3).join('；')}）`, '页面引用的本地 js/css/图片必须打进压缩包，请补齐文件或改为包内真实存在的相对路径，否则部署后会白屏/缺资源');
    if (absolute.length) rule('R5', 'error', `${absolute.length} 处绝对路径 / file:// 引用（如 ${absolute.slice(0, 3).join('；')}）`, '以 / 或 file:// 开头的引用部署后无法访问，请改为相对路径（如 ./assets/app.js）');
    if (ext) rule('R8', 'warn', `检测到 ${ext} 处外网请求（http/https 链接）`, '内网用户可能无法访问外网资源（CDN/在线接口），建议把资源打进包内或改用内网地址');

    /* ---- 敏感信息（文件名 + 文本内容抽样） ---- */
    const secretFiles = entries.filter((e) => SECRET_FILE.test(e.name));
    if (secretFiles.length) rule('R9', 'warn', `检测到密钥/凭据类文件：${secretFiles.slice(0, 3).map((e) => e.name).join('、')}`, '请确认包内不含真实密钥/口令；此类内容管理员将重点审核');
    let secretHits = 0;
    let phones = 0;
    let idcards = 0;
    for (const e of entries.filter((x) => TEXT_EXT_SECRET.test(x.name)).slice(0, 50)) {
      if (e.data.length > 256 * 1024) continue;
      const t = e.data.toString('utf8');
      if (SECRET_CONTENT.test(t)) secretHits++;
      phones += (t.match(PHONE_RE) || []).length;
      idcards += (t.match(IDCARD_RE) || []).length;
    }
    if (secretHits) rule('R9', 'warn', `${secretHits} 个文件疑似含明文密钥/口令`, '请移除真实密钥或改用占位符，避免随工具包公开分发');
    if (idcards >= 10 || phones >= 20) rule('R9', 'warn', `疑似批量个人信息（身份证 ${idcards} 处 / 手机号 ${phones} 处）`, '请确认个人信息已获授权且必要，管理员将重点审核');

    /* ---- 可执行 / 双扩展名 / 文件名规范 / 多入口歧义 ---- */
    const exes = entries.filter((e) => EXEC_EXT.test(e.name));
    if (exes.length) rule('R10', 'warn', `包含可执行/脚本文件：${exes.slice(0, 4).map((e) => e.name).join('、')}`, '可执行文件需管理员重点核查安全性，请确认仅用于工具自身启动/分发');
    const dbl = entries.filter((e) => DOUBLE_EXT.test(e.name));
    if (dbl.length) rule('R10', 'warn', `疑似伪装可执行文件：${dbl.map((e) => e.name).join('、')}`, '双重扩展名（如 图片.jpg.exe）常见于伪装木马，请在更新说明中解释用途');
    const badNames = entries.filter((e) => e.name.length > 120 || /[<>:"|?*]/.test(e.name) || /[.\s]$/.test(e.name));
    if (badNames.length) rule('R13', 'warn', `${badNames.length} 个文件名超长或含特殊字符`, '特殊字符/超长文件名在部分系统与浏览器下会异常，建议规范命名');
    if (htmls.length > 1) {
      const idxCount = htmls.filter((e) => /(^|\/)index\.html?$/i.test(e.name)).length;
      if (idxCount > 1 || pick.name.toLowerCase() !== 'index.html') {
        rule('R14', 'warn', `检测到 ${htmls.length} 个 HTML（${idxCount} 个 index.html），入口自动识别为 ${pick.name}`, '入口为自动识别结果，请在提交前用「试运行预览」确认打开的是正确页面');
      }
    }
    for (const e of entries) {
      if (e.data.length > 30 * MB) {
        push(`注意：${e.name} 单文件 ${(e.data.length / MB).toFixed(0)}MB（偏大）`);
        rep.warns++;
      }
    }
    for (const e of entries) {
      const to = path.join(dir, e.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, e.data);
    }
    rep.verdict = verdictOf();
    return { kind: 'web', rep, names };
  }

  if (/\.html?$/.test(fname)) {
    fs.writeFileSync(path.join(dir, 'index.html'), file.data);
    rep.entry = 'index.html';
    push('✓ 单文件网页，入口 index.html');
    names.push(titleOf(file.data) || baseName());
    /* 单文件网页没有任何伴生资源：本地引用必然缺失（外链/内联不受影响） */
    const r = scanHtmlRefs(file.data.toString('utf8'), 'index.html', new Set(['index.html']));
    if (r.missing.length) rule('R4', 'error', `引用了本地文件但未随包上传：${[...new Set(r.missing)].slice(0, 3).join('、')}`, '单文件网页不能引用本地 js/css/图片，请把资源内联进 HTML，或改传完整 zip 压缩包');
    if (r.absolute.length) rule('R5', 'error', `${r.absolute.length} 处绝对路径 / file:// 引用`, '以 / 或 file:// 开头的引用部署后无法访问，请改为相对路径或内联');
    if (r.ext) rule('R8', 'warn', `检测到 ${r.ext} 处外网请求`, '内网用户可能无法访问外网资源，建议资源内联或改用内网地址');
    rep.verdict = verdictOf();
    return { kind: 'web', rep, names };
  }

  // 其他文件 → 下载类（只做文件名级规则；内容为任意格式不深度扫描）
  fs.writeFileSync(path.join(dir, safeExt(file.filename)), file.data);
  push(`✓ 文件接收成功：${file.filename}（${(file.data.length / MB).toFixed(1)}MB）`);
  names.push(baseName());
  /* zip 压缩包（含 exe 等桌面程序，detectKind 分流而来）：整包原样分发，包内可执行文件列入审核警示 */
  if (/\.zip$/i.test(fname)) {
    try {
      const entries = zipRead(file.data);
      const inExes = entries.filter((e) => EXEC_EXT.test(e.name));
      if (inExes.length) {
        rule('R10', 'warn', `压缩包含可执行/脚本文件：${inExes.slice(0, 4).map((e) => e.name.split('/').pop()).join('、')}${inExes.length > 4 ? ' 等' : ''}`,
          '整包将按「文件下载」类工具原样分发，同事下载 zip 解压后运行；可执行文件管理员将重点核查来源与安全性');
        push(`✓ 压缩包共 ${entries.length} 个文件，将作为下载产物原样分发（同事下载后解压运行）`);
      }
      const inDbl = entries.filter((e) => DOUBLE_EXT.test(e.name));
      if (inDbl.length) rule('R10', 'warn', `疑似伪装可执行文件：${inDbl.slice(0, 4).map((e) => e.name.split('/').pop()).join('、')}`, '双重扩展名（如 图片.jpg.exe）常见于伪装木马，请在更新说明中解释用途');
    } catch { /* 坏 zip：auto 路径到不了这（detectKind 已改判 web 给规范报错）；显式传 file 的坏 zip 原样分发不阻断 */ }
  }
  if (DOUBLE_EXT.test(file.filename)) rule('R10', 'warn', `疑似伪装可执行文件：${file.filename}`, '双重扩展名常见于伪装木马，请在说明中解释用途');
  else if (EXEC_EXT.test(file.filename)) rule('R10', 'warn', `可执行文件：${file.filename}`, '分发可执行文件需管理员重点核查来源与安全性');
  if (SECRET_FILE.test(file.filename)) rule('R9', 'warn', `密钥/凭据类文件：${file.filename}`, '请确认不含真实密钥/口令，管理员将重点审核');
  if (file.filename.length > 120 || /[<>:"|?*]/.test(file.filename)) rule('R13', 'warn', '文件名超长或含特殊字符', '部署时会自动安全化命名，建议规范命名便于检索');
  rep.verdict = verdictOf();
  return { kind: 'file', rep, names };
}

/* ============================== 使用统计 ============================== */

let STATS = readJSON('stats.json', { raw: [] });
if (!Array.isArray(STATS.raw)) STATS = { raw: [] };
const saveStats = () => writeJSON('stats.json', STATS);
let STATS_CFG = readJSON('stats-config.json', { dailyLimit: 5 });
const saveCfg = () => writeJSON('stats-config.json', STATS_CFG);

/* ============================== 工作台申请（开通 / 扩容 One-API 令牌） ============================== */

let REQUESTS = readJSON('requests.json', []);
const saveRequests = () => writeJSON('requests.json', REQUESTS);

function recordClick(u, toolId, req) {
  const t = Date.now();
  const day = ymd();
  const ip = clientIp(req);
  const mine = STATS.raw.filter((r) => r.u === u.username && r.tool === toolId && r.day === day);
  if (mine.length && t - mine[mine.length - 1].t < 10000) {
    return { merged: true, today: mine.filter((r) => r.c).length, limit: STATS_CFG.dailyLimit };
  }
  const counted = mine.filter((r) => r.c).length < STATS_CFG.dailyLimit;
  STATS.raw.push({ t, day, u: u.username, n: u.name, tool: toolId, ip, c: counted ? 1 : 0 });
  // 保留 90 天 / 上限 8 万条
  const cutoff = t - 90 * DAY_MS;
  if (STATS.raw.length > 80000 || STATS.raw[0].t < cutoff) {
    STATS.raw = STATS.raw.filter((r) => r.t >= cutoff).slice(-80000);
  }
  saveStats();
  return { merged: false, counted, today: mine.filter((r) => r.c).length + (counted ? 1 : 0), limit: STATS_CFG.dailyLimit };
}

/* ============================== WorkBuddy 壳技能缓存 ============================== */

let stubCache = null;
let skillDeptCache = null;

/* ===== 技能同步接入观测（方案A·零侵入）：每台已接入电脑的同步（安装/登录/15分钟/手动）都会请求
 * /api/skill-stubs/all，记录来源 IP 即为现成心跳；IP→姓名复用登录记录推导（与 /api/ip-name-map 同口径）。
 * 仅内存即时更新 + 落盘节流（60s），管理员侧 /api/admin/skill-sync 输出接入清单 ===== */
let SYNC_HB = readJSON('skill-sync-heartbeats.json', {}) || {};
let syncHbSavedAt = 0;
function recordSyncHeartbeat(ip) {
  if (!ip) return;
  const now = Date.now();
  const e = SYNC_HB[ip] || { first: now, count: 0 };
  e.last = now;
  e.count += 1;
  SYNC_HB[ip] = e;
  if (now - syncHbSavedAt > 60 * 1000) {
    syncHbSavedAt = now;
    for (const k of Object.keys(SYNC_HB)) if (now - SYNC_HB[k].last > 90 * 86400000) delete SYNC_HB[k];
    writeJSON('skill-sync-heartbeats.json', SYNC_HB);
  }
}
function buildStub(skill) {
  const slug = skill.slug;
  // 下发清洗（2026-10 C 盘 25GB 事故防线）：display_name 巨型/乱码/含路径非法字符时原样透传，
  // 客户端把技能名单写进 sync.log（每 15 分钟一行）→ 单条几 MB 撑爆各装机机器的 C 盘。
  // 名字在这里收口：剔控制符与路径非法字符、压缩空白、截 60 字符；desc 截 2000。
  const name = String(skill.display_name || skill.name || slug || '')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || String(slug || 'skill');
  const desc = String(skill.description || '').replace(/\s*\n+\s*/g, ' ').trim().slice(0, 2000);
  const content = [
    '---',
    `name: ${name}`,
    `description: ${desc}`,
    '---',
    '',
    `# ${name}（${slug} · 壳技能）`,
    '',
    '完整工作流存放于内网「Skill Center」，本文件不含任何方法论内容。',
    '',
    '执行规则：',
    `1. 第一步调用 MCP 工具 \`load_skill\`，参数 slug="${slug}"，获取完整 SKILL.md；`,
    '2. 严格按返回的完整流程执行任务；',
    '3. 流程中要求加载参考文件时，调用 `read_reference` / `read_asset` 按需拉取；',
    `4. 交付完成后调用 \`report_output\` 记录交付（参数 slug="${slug}", summary=交付物摘要）。`,
    '',
  ].join('\r\n');
  return { folder: name, slug, content };
}

/* ============================== 业务路由 ============================== */

// ApiHub mutations replace full JSON/frpc snapshots, so serialize their whole read-modify-write cycle.
let apiHubWriteQueue = Promise.resolve();
async function handleServiceAction(ctx) {
  const match = /^\/api\/admin\/(tools|uploads)\/([\w-]+)\/(status|delete|approve|offline|rollback)$/.exec(ctx.urlPath);
  if (ctx.req.method !== 'POST' || !match || !isAdmin(ctx)) return handleApiRequest(ctx);
  const rec = match[1] === 'uploads' ? UPLOADS.find(x => x.id === match[2]) : null;
  const tool = match[1] === 'tools' ? EXTRA_TOOLS.find(x => x.id === match[2])
    : (rec ? EXTRA_TOOLS.find(x => x.uploadId === rec.id) : null) || (rec?.updateOf?.startsWith('tool:') ? EXTRA_TOOLS.find(x => x.id === rec.updateOf.slice(5)) : null);
  if (tool?.type !== 'service' && rec?.kind !== 'service') return handleApiRequest(ctx);
  const key = tool?.uploadId ? siteKeyOf(tool.uploadId) : rec ? siteKeyOf(rec.id) : 'manual:' + tool.id;
  if (busyServices.has(key)) return fail(ctx.res, 409, '服务正在操作，请稍后刷新');
  const recordRevision = rec ? revisionOf(rec) : null;
  const recordTarget = rec?.updateOf, toolUpload = tool?.uploadId;
  const action = { active: true, removed: false, failed: false, check() {
    if (!this.active) return;
    ctx.user = auth(ctx.req, ctx.url); // Revalidate the original token, never a cached user.
    if (ctx.req.aborted || ctx.res.destroyed || ctx.user?.role !== 'admin' ||
        (tool && (!EXTRA_TOOLS.includes(tool) || tool.deleted || tool.uploadId !== toolUpload)) ||
        (rec && (!UPLOADS.includes(rec) || revisionOf(rec) !== recordRevision || rec.updateOf !== recordTarget))) {
      this.failed = true;
      throw new Error('操作已中止：连接、权限或工具记录已变化；请刷新后重试');
    }
  } };
  action.reconcile = () => {
    if (!action.active || !action.removed || !action.failed || action.compensated) return;
    const current = EXTRA_TOOLS.find(x => x.uploadId && siteKeyOf(x.uploadId) === key);
    if (current) {
      current.status = 'offline';
      current.serviceError = '容器操作未完成，运行状态待确认；镜像与恢复数据保留，可重新上架或重试部署';
    }
    for (const upload of UPLOADS) {
      if ((upload.id === current?.uploadId || upload === rec) && upload.status === 'online') upload.status = 'offline';
    }
    const errors = [];
    for (const save of [saveExtra, saveUploads]) {
      try { save(); } catch (error) { errors.push(error.message); }
    }
    if (errors.length) throw new Error('容器状态已变化，但下线状态持久化失败，重启前需核查恢复：' + errors.join('；'));
    action.compensated = true;
  };
  busyServices.add(key);
  try {
    return await serviceActions.run(action, async () => {
      action.check();
      return await handleApiRequest(ctx);
    });
  } catch (error) {
    action.failed = true;
    action.reconcile();
    if (!ctx.res.destroyed && !ctx.res.headersSent) return fail(ctx.res, 502, error.message);
  } finally {
    try {
      // Docker and JSON cannot commit atomically. After destructive failure hide the stale
      // online card, keep images/releases/snapshots, and leave an explicit recovery reason.
      action.reconcile();
    } finally { action.active = false; busyServices.delete(key); }
  }
}
async function handleApi(ctx) {
  // Read JSON before joining the queue so a disconnected waiting client cannot strand body readers.
  if (ctx.req.method === 'POST' && /^\/api\/kb\/(mkdir|rename|delete|move|priv-delete)$/.test(ctx.urlPath) && authed(ctx)) {
    ctx.kbBody = await readJson(ctx.req);
    const repoId = String(ctx.kbBody.reposId || '');
    if (KBPERMS.repos[repoId]?.tier === 'private') return withKbRepoLock(repoId, async () => {
      if (ctx.req.aborted || ctx.res.destroyed) return;
      ctx.user = auth(ctx.req, ctx.url);
      if (!ctx.user) return fail(ctx.res, 401, '登录已失效，请重新登录');
      if (kbPendingWrites[repoId] && kbRepoPerm(ctx.user, repoId).canWrite) return fail(ctx.res, 503, kbPendingMessage);
      return handleServiceAction(ctx);
    });
  }
  if (!ctx.urlPath.startsWith('/api/apihub/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.req.method)) {
    return handleServiceAction(ctx);
  }
  const previous = apiHubWriteQueue;
  let release;
  apiHubWriteQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (ctx.req.aborted || ctx.res.destroyed) return;
    return await handleServiceAction(ctx);
  } finally { release(); }
}

async function handleApiRequest(ctx) {
  const { req, res, url, urlPath } = ctx;
  let am;
  const POST = req.method === 'POST';
  const GET = req.method === 'GET';

  /* ---------- 鉴权 ---------- */
  if (urlPath === '/api/auth/login' && POST) {
    const b = await readJson(req);
    const uname = String(b.username || '').trim().toLowerCase();
    const u = USERS.find((x) => x.username === uname);
    if (!u) {
      LOGINS.push({ t: Date.now(), u: uname, n: uname, ip: clientIp(req), d: deviceOf(req.headers['user-agent']), ok: false, remote: false });
      saveLogins();
      return fail(res, 200, '账号不存在，请核对用户名（姓名全拼）');
    }
    if (u.disabled) {
      recordLogin(u, req, false);
      return fail(res, 200, '账号已被禁用，请联系管理员');
    }
    if (hashPwd(String(b.password || ''), u.salt) !== u.hash) {
      recordLogin(u, req, false);
      return fail(res, 200, '密码错误，默认密码为 123456');
    }
    recordLogin(u, req, true);
    return ok(res, { token: signToken(u), session: { ...publicUser(u), loginAt: Date.now() } });
  }

  if (urlPath === '/api/auth/me' && GET) {
    const u = authed(ctx);
    return u ? ok(res, { session: publicUser(u) }) : fail(res, 401, 'not logged in');
  }

  if (urlPath === '/api/auth/password' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const b = await readJson(req);
    if (hashPwd(String(b.oldPassword || ''), u.salt) !== u.hash) return fail(res, 200, '当前密码不正确');
    const np = String(b.newPassword || '');
    if (np.length < 6) return fail(res, 200, '新密码至少 6 位');
    if (np === defaultPwd(u)) return fail(res, 200, '新密码不能与默认密码相同');
    u.salt = crypto.randomBytes(8).toString('hex');
    u.hash = hashPwd(np, u.salt);
    u.ep = (u.ep || 1) + 1;
    saveUsers();
    return ok(res, { token: signToken(u), message: '密码已修改，下次登录请使用新密码' });
  }

  /* ============================== 接口中心（apihub） ==============================
   * 数据：data/apihub.json（readCriticalJSON/writeJSON；含 systems/interfaces/channels/dynamics/audit）
   * state：cloud=已接入云侧 / ready=可申请 / lan=内网直调（不过隧道）
   * 通道申请为真实操作：后端 TCP 自检目标 → 经 frpc 管理接口读取/追加/写回/热加载配置 → 记录通道与审计。
   * frpc webServer 仅监听内网宿主（frpc-prod.toml），容器经 FRPC_ADMIN_BASE 访问，Basic Auth 保护。 */
  const AH_FILE = 'apihub.json';
  const AH_FRPC_BASE = process.env.FRPC_ADMIN_BASE || '';
  const AH_FRPC_AUTH = 'Basic ' + Buffer.from(`${process.env.FRPC_ADMIN_USER || ''}:${process.env.FRPC_ADMIN_PASSWORD || ''}`).toString('base64');
  const AH_PORT_MIN = 18000, AH_PORT_MAX = 18998; /* 17999 留给冒烟 test-echo */

  function ahSeed() {
    const t = Date.now();
    const sys = (id, name, dept, owner, loc, avail) => ({ id, name, dept, owner, loc, avail, createdBy: 'seed', createdAt: t });
    const if_ = (id, sysId, method, path, title, desc, auth, state, up, extra) => ({
      id, sysId, method, path, title, desc, auth, state, up, port: extra && extra.port, owner: 'seed', ownerName: '系统预置',
      params: (extra && extra.params) || [], respOK: extra && extra.respOK, respMiss: extra && extra.respMiss,
      errs: (extra && extra.errs) || [], callers: (extra && extra.callers) || [],
      createdAt: t, updatedAt: t,
    });
    return {
      seq: 100,
      systems: {
        codeReg: sys('codeReg', '项目编码登记系统', '计划运营部', '（待补）', '部门电脑 10.0.0.30', '开机即用（计划任务自启）'),
        mxsdoc: sys('mxsdoc', 'MxsDoc 知识库', '技术部', '技术部', '内网服务器 127.0.0.1', '7×24'),
        aigw: sys('aigw', 'AI 能力网关', '技术部', '技术部', '内网服务器 127.0.0.1', '7×24'),
        sso: sys('sso', 'SSO 统一认证', '技术部', '技术部', '内网服务器 127.0.0.1', '7×24'),
        skillharbor: sys('skillharbor', 'SkillHarbor 统一工作站', '技术部', '技术部', '内网服务器 127.0.0.1', '7×24'),
      },
      interfaces: {
        lookup: if_('lookup', 'codeReg', 'GET', '/api/lookup', '按项目编码查项目名称',
          '输入完整项目编码，自动带出对应项目名称——用于报销、合同等录入场景，避免编码与名称错配。查不到时返回 found=false（HTTP 仍为 200），调用方应降级为手工填写。',
          'X-API-Key（向系统负责人索取）', 'cloud', '10.0.0.30:8081', {
            port: 18080,
            params: [['code', 'string', '必填', '完整项目编码，如 DTSJ20260977504QUP；大小写不敏感，空格自动忽略'], ['q', 'string', '可选', 'code 的兼容别名']],
            respOK: '{\n  "ok": true,\n  "found": true,\n  "count": 1,\n  "name": "华容县麻浣泗污水处理厂配套污水管网建设工程初步设计",\n  "names": ["…"],\n  "message": null\n}',
            respMiss: '{\n  "ok": true,\n  "found": false,\n  "count": 0,\n  "name": null,\n  "message": "未找到该编码，请确认是否完整正确"\n}',
            errs: [['400', '缺少 code 参数'], ['401', '密钥无效'], ['503', '接口停用'], ['500', '服务端异常']],
            callers: [['InvoiceFlow（云 · 阿里云）', '16:42 最近调用']],
          }),
        docSearch: if_('docSearch', 'mxsdoc', 'POST', '/api/doc/search', '文档语义检索',
          '用一句话在全公司 14 个知识库中语义检索文档，返回最相关文档的标题与相似度得分。适合"凭印象找资料"的场景，无需记住文档名或所在库。',
          'kb-svc 服务会话（向技术部申请）', 'ready', '127.0.0.1:8110', {
            params: [['q', 'string', '必填', '检索词（自然语言）'], ['topK', 'int', '可选', '返回条数，默认 5']],
            respOK: '{\n  "code": 200,\n  "data": [\n    { "docId": 123, "title": "…", "score": 0.92 }\n  ]\n}',
          }),
        docList: if_('docList', 'mxsdoc', 'GET', '/api/doc/list', '文档列表查询',
          '按库或文档 ID 查询文档目录与元数据（标题、更新时间、责任人），用于批量同步、目录展示等场景。',
          'kb-svc 服务会话（向技术部申请）', 'ready', '127.0.0.1:8110', {
            params: [['docId', 'string', '可选', '文档 ID，缺省返回目录']],
            respOK: '{ "code": 200, "data": [ … ] }',
          }),
        mcp: if_('mcp', 'aigw', 'POST', '/mcp', 'MCP 技能调用',
          '调用AI Gateway上架的 MCP 技能（工具、知识库、专家、数据），WorkBuddy 等智能体客户端的标准能力入口。',
          '网关白名单', 'lan', '127.0.0.1:8765', { params: [['tool', 'string', '必填', '技能名'], ['args', 'json', '可选', '技能参数']], callers: [['WorkBuddy / 智能体', '高频']] }),
        authv: if_('authv', 'sso', 'POST', '/api/verify', '登录凭证校验',
          '校验 SSO 会话令牌有效性并返回用户信息（姓名、部门、角色）。各内网系统接入统一登录时的标准校验入口。',
          '内部调用', 'lan', '127.0.0.1:8090', { params: [['token', 'string', '必填', '会话令牌']], callers: [['各内网系统', '内部调用']] }),
        search: if_('search', 'skillharbor', 'GET', '/api/search', '全局聚合搜索',
          '一次搜索同时返回门户工具、知识库文档与技能的聚合结果，是门户顶部全局搜索框的后端。',
          '登录态 Cookie', 'lan', '127.0.0.1', { params: [['q', 'string', '必填', '搜索词']], callers: [['门户用户', '高频']] }),
      },
      dynamics: [
        { t, text: '「按编码查项目名称」云侧通道切换至只读专用端口 8081', tag: '已完成' },
        { t: t - 60000, text: '云内网通道上线，接口广场首个云侧接入 18080 生效', tag: '已上线' },
        { t: t - 120000, text: '云侧 frps 部署完成（阿里云）', tag: '已完成' },
      ],
      channels: { lookup: { ifId: 'lookup', port: 18080, up: '10.0.0.30:8081', reason: 'InvoiceFlow 报销录入自动带出项目名称', createdBy: 'seed', createdAt: t, lastCheck: { t, ok: true, ms: 86 } } },
      audit: [],
    };
  }
  let AH = null;
  const ahDb = () => (AH = readCriticalJSON(AH_FILE, undefined) || (writeJSON(AH_FILE, (AH = ahSeed())), AH));
  const ahSave = () => writeJSON(AH_FILE, AH);
  const ahDyn = (text, tag) => { AH.dynamics.unshift({ t: Date.now(), text, tag: tag || '动态' }); AH.dynamics = AH.dynamics.slice(0, 50); };
  const ahAudit = (u, action, detail) => { AH.audit.unshift({ t: Date.now(), user: u.username, name: u.name, action, detail }); AH.audit = AH.audit.slice(0, 500); };

  /* TCP 探测（自检） */
  function ahProbe(host, port, timeout = 4000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const s = net.connect({ host, port }, () => { s.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); });
      s.setTimeout(timeout, () => { s.destroy(); resolve({ ok: false, ms: Date.now() - t0, err: 'timeout' }); });
      s.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, err: e.code || e.message }));
    });
  }

  /* frpc 管理接口：读全量配置 / 写回 / 热加载 */
  async function ahFrpc(method, apiPath, body) {
    if (!AH_FRPC_BASE) throw new Error('FRPC_ADMIN_BASE 未配置');
    const r = await fetch(AH_FRPC_BASE + apiPath, {
      method,
      headers: { Authorization: AH_FRPC_AUTH, ...(body !== undefined ? { 'Content-Type': 'text/plain' } : {}) },
      body: body === undefined ? undefined : body,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`frpc admin ${apiPath} HTTP ${r.status}`);
    return method === 'GET' ? await r.text() : undefined;
  }
  /* 在 frpc 配置末尾追加一个 [[proxies]] 块（幂等：同名旧块先剔除） */
  function ahAppendProxy(cfgText, name, ip, port, remotePort) {
    const re = new RegExp(`\\n\\[\\[proxies\\]\\]\\nname = "${name}"\\n(?:(?!\\[\\[proxies\\]\\]).)*`, 's');
    const block = `\n[[proxies]]\nname = "${name}"\ntype = "tcp"\nlocalIP = "${ip}"\nlocalPort = ${port}\nremotePort = ${remotePort}\n`;
    return cfgText.replace(re, '\n') + block;
  }
  function ahRemoveProxy(cfgText, name) {
    const re = new RegExp(`\\n\\[\\[proxies\\]\\]\\nname = "${name}"\\n(?:(?!\\[\\[proxies\\]\\]).)*`, 's');
    return cfgText.replace(re, '\n');
  }
  /* 分配云侧端口：避开现有配置 remotePort 与库内通道 */
  function ahAllocPort(cfgText) {
    const used = new Set();
    for (const m of cfgText.matchAll(/remotePort\s*=\s*(\d+)/g)) used.add(Number(m[1]));
    for (const c of Object.values(AH.channels)) used.add(c.port);
    for (let p = AH_PORT_MIN; p <= AH_PORT_MAX; p++) if (!used.has(p)) return p;
    throw new Error('端口池耗尽');
  }

  if (urlPath === '/api/apihub/state' && GET) {
    if (!authed(ctx)) return fail(res, 401, '请先登录');
    const db = ahDb();
    const ifs = Object.values(db.interfaces);
    return ok(res, {
      systems: db.systems,
      interfaces: ifs,
      dynamics: db.dynamics.slice(0, 12),
      channels: Object.values(db.channels),
      stats: {
        systems: Object.keys(db.systems).length,
        total: ifs.length,
        cloud: ifs.filter((x) => x.state === 'cloud').length,
        ready: ifs.filter((x) => x.state === 'ready').length,
        lan: ifs.filter((x) => x.state === 'lan').length,
        channels: Object.keys(db.channels).length,
      },
    });
  }

  if (urlPath === '/api/apihub/interfaces' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const db = ahDb();
    const b = await readJson(req);
    const sysName = String(b.sysName || '').trim();
    const ip = String(b.ip || '').trim();
    const port = Number(b.port) || 0;
    const p = String(b.path || '').trim();
    if (!sysName || !ip || !p) return fail(res, 200, '系统名称、内网地址、接口路径为必填');
    let sys = Object.values(db.systems).find((s) => s.name === sysName);
    if (!sys) {
      const sid = 'sys' + ++db.seq;
      sys = db.systems[sid] = { id: sid, name: sysName, dept: String(b.dept || '（待补）'), owner: String(b.contact || '（待补）'), loc: '部门电脑 ' + ip, avail: String(b.avail || '（待补）'), createdBy: u.username, createdAt: Date.now() };
    }
    const id = 'if' + ++db.seq;
    db.interfaces[id] = {
      id, sysId: sys.id, method: String(b.method || 'GET'), path: p,
      title: String(b.title || p), desc: String(b.desc || '（采集登记）'), auth: String(b.auth || '（待补）'),
      state: 'ready', up: `${ip}:${port}`, port: undefined,
      owner: u.username, ownerName: u.name,
      params: Array.isArray(b.params) ? b.params : [], respOK: b.respOK || null, respMiss: b.respMiss || null,
      errs: Array.isArray(b.errs) ? b.errs : [], callers: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    ahDyn(`「${db.interfaces[id].title}」登记进广场（${sys.name}）`, '新登记');
    ahAudit(u, 'register', `${sys.name} ${db.interfaces[id].method} ${p}`);
    ahSave();
    return ok(res, { id });
  }

  if ((am = /^\/api\/apihub\/interfaces\/([a-zA-Z0-9]+)$/.exec(urlPath)) && req.method === 'DELETE') {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const db = ahDb();
    const it = db.interfaces[am[1]];
    if (!it) return fail(res, 404, '接口不存在');
    if (u.role !== 'admin' && it.owner !== u.username) return fail(res, 403, '只有登记人或管理员可删除');
    if (it.state === 'cloud') return fail(res, 200, '该接口已接入云侧，请先在「我的接入」停用通道');
    delete db.interfaces[am[1]];
    ahDyn(`「${it.title}」已从广场下架`, '已下架');
    ahAudit(u, 'delete', `${it.method} ${it.path}`);
    ahSave();
    return ok(res, {});
  }

  if (urlPath === '/api/apihub/channels' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const db = ahDb();
    const b = await readJson(req);
    const it = db.interfaces[String(b.ifId || '')];
    if (!it) return fail(res, 404, '接口不存在');
    if (it.state === 'cloud') return fail(res, 200, '该接口已有云侧通道');
    /* ① 自检：从本服务（188 容器）直测目标 */
    const [ip, port] = it.up.split(':');
    const probe = await ahProbe(ip, Number(port));
    if (!probe.ok) {
      ahAudit(u, 'apply-failed', `${it.title} 自检失败 ${probe.err}`);
      ahSave();
      return fail(res, 200, `连通自检失败（${probe.err}）：请检查目标服务是否启动、是否绑定 0.0.0.0、防火墙是否放行 188 访问`);
    }
    /* ② 读 frpc 配置 → 分配端口 → 追加代理 → 写回 → 热加载 */
    let cfgText;
    try {
      cfgText = await ahFrpc('GET', '/api/config');
    } catch (e) {
      return fail(res, 200, '无法读取隧道配置（frpc 管理接口不可达）：' + e.message);
    }
    const rport = ahAllocPort(cfgText);
    const name = 'apihub-' + it.id;
    try {
      await ahFrpc('PUT', '/api/config', ahAppendProxy(cfgText, name, ip, port, rport));
      await ahFrpc('GET', '/api/reload');
    } catch (e) {
      ahAudit(u, 'apply-failed', `${it.title} 隧道配置失败 ${e.message}`);
      ahSave();
      return fail(res, 200, '隧道配置下发失败：' + e.message);
    }
    /* ③ 落库 */
    it.state = 'cloud'; it.port = rport; it.updatedAt = Date.now();
    db.channels[it.id] = { ifId: it.id, port: rport, up: it.up, reason: String(b.reason || ''), createdBy: u.username, createdName: u.name, createdAt: Date.now(), lastCheck: probe };
    ahDyn(`「${it.title}」云侧接入开通（127.0.0.1:${rport}，自检 ${probe.ms}ms）`, '已上线');
    ahAudit(u, 'apply', `${it.title} → ${it.up} 映射云侧 ${rport}`);
    ahSave();
    return ok(res, { port: rport, probe });
  }

  if ((am = /^\/api\/apihub\/channels\/([a-zA-Z0-9]+)$/.exec(urlPath)) && req.method === 'DELETE') {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const db = ahDb();
    const ch = db.channels[am[1]];
    const it = db.interfaces[am[1]];
    if (!ch || !it) return fail(res, 404, '通道不存在');
    if (u.role !== 'admin' && ch.createdBy !== u.username && it.owner !== u.username)
      return fail(res, 403, '仅管理员、通道开通人或接口登记人可停用通道');
    try {
      const cfgText = await ahFrpc('GET', '/api/config');
      await ahFrpc('PUT', '/api/config', ahRemoveProxy(cfgText, 'apihub-' + it.id));
      await ahFrpc('GET', '/api/reload');
    } catch (e) {
      return fail(res, 200, '隧道配置移除失败（通道已在本平台下架，但 frpc 配置可能残留）：' + e.message);
    }
    it.state = 'ready'; it.port = undefined; it.updatedAt = Date.now();
    delete db.channels[am[1]];
    ahDyn(`「${it.title}」云侧通道已停用`, '已停用');
    ahAudit(u, 'disable', `${it.title} 云侧 ${ch.port}`);
    ahSave();
    return ok(res, {});
  }

  /* ---------- 知识库 SSO 桥（单一账号源=SkillHarbor，2026-10-07） ----------
     原理：员工从工作台进入知识库时，本接口以其 SkillHarbor 身份自动登录 MxsDoc 并把
     MxsDoc 会话 cookie 透传给浏览器（8100 与 8110 同 host，cookie 跨端口共享）。
     MxsDoc 侧密码 = HMAC(用户名|SkillHarbor密码哈希, KB_BRIDGE_SECRET) 前 16 位（派生值，
     员工无需知晓）；SkillHarbor 改密后派生值变化，本接口检测到登录失败会用 admin 凭据
     自愈重置后重新登录——密码永远只有 SkillHarbor 一套。 */
  /* ---------- 知识库 BFF（API 融合 · 只读） ----------
     架构：浏览器 → 本服务 /api/kb/*（持每用户 MxsDoc 会话）→ MxsDoc HTTP API。
     会话与 /api/kb/sso 同一套派生密码规则（SkillHarbor 唯一密码体系），25 分钟复用、
     NOT_LOGIN 自动重登；预览走 getDocOfficeLink(preview=pdf) 的 x2t 转换管线。 */
  if (urlPath === '/api/gateway/install-wb' && req.method === 'GET') {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const tok = await ensureGatewayToken(u);
    const arg = tok ? " -GatewayToken '" + tok + "'" : '';
    const bat = [
      '@echo off',
      'title ' + (tok ? 'SkillHarbor AI Gateway setup for ' + u.name : 'SkillHarbor AI Gateway - one-click setup'),
      'echo Downloading installer from the portal...',
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$p=$env:TEMP+'\\skillharbor-skills-install.ps1'; (New-Object System.Net.WebClient).DownloadFile('http://127.0.0.1:8900/files/install-workbuddy-skills.ps1',$p); & $p" + arg + "\"",
      'echo.',
      'pause',
      '',
    ].join('\r\n');
    kbAudit(u, 'install-script', { src: 'web', tokenIssued: tok ? 1 : 0 });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="install-workbuddy-skills.bat"',
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.from(bat, 'utf8'));
    return;
  }


  if (urlPath === '/api/kb/repos' && GET) {
    const { u, src } = kbActor(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    try {
      const repos = await kbRepos(u);
      if (!KB_PERMS_ON()) return ok(res, { repos: repos.map(({ id, name }) => ({ id, name })), v2: false });
      const out = [];
      let myPrivate = null;
      for (const r of repos) {
        const p = kbRepoPerm(u, r.id, r.name);
        if (!p.visible) continue; // 无权库彻底隐藏（含 admin 对私有库）
        const isMine = p.tier === 'private' && p.owner === u.username;
        if (isMine) myPrivate = String(r.id);
        const cfg = KBPERMS.repos[String(r.id)] || {};
        const usage = isMine ? await withKbRepoLock(r.id, () => kbCurrentFiles(r.id)).catch(() => null) : null;
        out.push({
          id: r.id, name: r.name, tier: p.tier, invited: p.tier === 'private' && !isMine,
          readShared: p.readShared === true,
          canWrite: p.tier === 'private' ? isMine : (p.legacyWrite ? undefined : p.canWrite),
          canManage: p.canManage, canDownload: p.canDownload,
          quota: isMine ? { gb: cfg.quotaGB || 10, used: usage?.used ?? null, basis: 'current-files' } : undefined,
        });
      }
      const hasPrivate = !!myPrivate ||
        Object.values(KBPERMS.repos).some((c) => c && c.tier === 'private' && c.owner === u.username);
      return ok(res, { repos: out, v2: true, hasPrivate, myPrivate });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  if (urlPath === '/api/kb/list' && GET) {
    const { u, src } = kbActor(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const reposId = ctx.url.searchParams.get('reposId') || '';
    const docId = ctx.url.searchParams.get('docId') || '';
    const pPath = ctx.url.searchParams.get('path') || '';
    const pName = ctx.url.searchParams.get('name') || '';
    if (!reposId) return fail(res, 200, '参数缺失：reposId');
    if (KB_PERMS_ON()) {
      await kbRepos(u).catch(() => {});
      if (!kbRepoPerm(u, reposId).visible) { kbAudit(u, 'denied', { src, reposId, api: 'list' }); return fail(res, 200, '无权访问或不存在'); }
    }
    try {
      const j = await kbSvcForm('/Repos/getSubDocList.do', { vid: reposId, docId, path: pPath, name: pName, sort: '0', needLockState: '1' });
      if (j.status !== 'ok') return fail(res, 200, j.msgInfo || '获取目录失败');
      const entries = (j.data || [])
        .map((x) => ({
          name: x.name || '',
          type: Number(x.type) === 2 ? 'dir' : 'file',
          size: x.size ?? 0,
          docId: x.docId ?? '',
          pid: x.pid ?? 0,
          level: x.level ?? 0,
          path: x.path || '',
          latestEditTime: x.latestEditTime || 0,
        }))
        .sort((a, b) => (a.type === b.type ? String(a.name).localeCompare(String(b.name), 'zh') : a.type === 'dir' ? -1 : 1));
      return ok(res, { entries });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  if (urlPath === '/api/kb/search' && GET) {
    const { u, src } = kbActor(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 120);
    if (!q) return ok(res, { items: [] });
    try {
      /* 双路召回：MxsDoc 关键词 + skill-gateway 语义向量（失败降级纯关键词），
         语义路按 kb-svc 视角全库返回，必须按用户可见库过滤（权限不旁路） */
      const [kwJ, semJ] = await Promise.all([
        kbSvcForm('/Doc/searchDoc.do', { searchWord: q }),
        fetch(`${process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800'}/api/kb/semantic-search?q=${encodeURIComponent(q)}&top=40${KB_PERMS_ON() ? `&vids=${(await kbRepos(u)).filter((r) => kbRepoPerm(u, r.id, r.name).visible).map((r) => r.id).join(',')}` : ''}`, {
          headers: { Authorization: 'Bearer ' + (process.env.SKILL_GATEWAY_TOKEN || '') },
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (kwJ.status !== 'ok') { kbAudit(u, 'search', { src, q, err: String(kwJ.msgInfo || '').slice(0, 120) }); return fail(res, 200, kwJ.msgInfo || '搜索失败'); }
      const allowed = new Set((await kbRepos(u)).filter((r) => !KB_PERMS_ON() || kbRepoPerm(u, r.id, r.name).visible).map((r) => String(r.id)));
      const rrf = new Map();
      const add = (key, rank, item) => {
        const e = rrf.get(key) || { ...item, sources: [] };
        e.sources.push(item.source);
        e.rrf = (e.rrf || 0) + 1 / (60 + rank);
        rrf.set(key, e);
      };
      (kwJ.data || []).filter(x => x && allowed.has(String(x.vid ?? ''))).slice(0, 20).forEach((x, i) => {
        const vid = String(x.vid); // 先权限过滤再截断，缺少库标识的结果不能归属到可见库
        let preview = '';
        try { preview = Buffer.from((x.content || '') + '===', 'base64').toString('utf-8').slice(0, 160); } catch { /* 非法 base64 忽略 */ }
        add(JSON.stringify([vid, String(x.path || '').replace(/\/+$/, ''), String(x.name || '')]), i, {
          reposId: vid, repos: x.reposName || '', name: x.name || '', path: x.path || '',
          size: x.size ?? 0, preview, source: 'keyword',
        });
      });
      let mode = 'keyword';
      if (semJ && semJ.mode === 'semantic' && Array.isArray(semJ.items)) {
        mode = 'dual';
        semJ.items.filter(x => x && allowed.has(String(x.vid ?? ''))).forEach((x, i) => {
          const vid = String(x.vid);
          add(JSON.stringify([vid, String(x.path || '').replace(/\/+$/, ''), String(x.name || '')]), i, {
            reposId: vid, repos: (x.repos || '') + (x.repos && !x.repos.includes('库') ? '知识库' : ''),
            name: x.name || '', path: x.path || '', size: 0, preview: String(x.preview || '').slice(0, 160), source: 'semantic', semScore: x.score,
          });
        });
      }
      const items = [...rrf.values()]
        .sort((a, b) => b.rrf - a.rrf)
        .slice(0, 30)
        .map((e) => ({ ...e, sources: [...new Set(e.sources)] }));
      kbAudit(u, 'search', { src, q, n: items.length });
      return ok(res, { items, mode });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  /* 在线预览：md/txt 直读内联（MxsDoc 不支持 md→pdf）；Office/PDF 走 getDocOfficeLink(preview=pdf) 转发 */
  if (urlPath === '/api/kb/preview' && GET) {
    const { u, src } = kbActor(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const reposId = ctx.url.searchParams.get('reposId') || '';
    const dirPath = (ctx.url.searchParams.get('path') || '').replace(/^\/+/, '');
    const name = ctx.url.searchParams.get('name') || '';
    if (!reposId || !name) return fail(res, 200, '参数缺失');
    if (KB_PERMS_ON()) {
      await kbRepos(u).catch(() => {});
      if (!kbRepoPerm(u, reposId).visible) { kbAudit(u, 'denied', { src, reposId, api: 'preview' }); return fail(res, 200, '无权访问或不存在'); }
    }
    kbAudit(u, 'preview', { src, reposId, path: dirPath, name });
    try {
      const lower = name.toLowerCase();
      const imgExt = Object.keys(MD_IMG_TYPES).find((e) => lower.endsWith('.' + e));
      if (imgExt && ctx.url.searchParams.get('raw') === '1') {
        /* 图片原始流（img 标签引用） */
        const repo0 = (await kbRepos(u)).find((r) => String(r.id) === String(reposId));
        if (!repo0) return fail(res, 200, '仓库不存在或无权访问');
        const phys0 = `${(repo0.path || '').replace(/\/+$/, '')}/${reposId}/data/rdata/${dirPath ? dirPath + '/' : ''}`;
        const sid0 = await kbSvcSid();
        const r0 = await fetch(`${kbBase()}/Doc/downloadDoc.do?vid=${reposId}&targetPath=${kbB64(phys0)}&targetName=${kbB64(name)}`, { headers: { Cookie: `JSESSIONID=${sid0}` } });
        if (!r0.ok || !r0.body) return fail(res, 502, '图片获取失败');
        res.writeHead(200, { 'Content-Type': MD_IMG_TYPES[imgExt], 'Cache-Control': 'no-store', ...KB_PREVIEW_HEADERS });
        Readable.fromWeb(r0.body).pipe(res);
        return;
      }
      if (imgExt) {
        /* 图片预览：居中卡片包装，img 回指本接口 raw=1（token 已含在原 query） */
        const rawSrc = ctx.url.searchParams.get('token')
          ? `/api/kb/preview?reposId=${encodeURIComponent(reposId)}&path=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(name)}&raw=1&token=${encodeURIComponent(ctx.url.searchParams.get('token'))}`
          : `/api/kb/preview?reposId=${encodeURIComponent(reposId)}&path=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(name)}&raw=1`;
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#EDEEF4;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:28px;box-sizing:border-box}img{max-width:100%;max-height:calc(100vh - 56px);border-radius:10px;box-shadow:0 4px 18px rgba(16,18,35,.18);background:#fff}</style></head><body><img src="${escapeHtml(rawSrc)}" alt="${escapeHtml(name)}"></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...KB_PREVIEW_HEADERS });
        res.end(html);
        return;
      }
      if (lower.endsWith('.md')) {
        const repo = (await kbRepos(u)).find((r) => String(r.id) === String(reposId));
        if (!repo) return fail(res, 200, '仓库不存在或无权访问');
        const phys = `${(repo.path || '').replace(/\/+$/, '')}/${reposId}/data/rdata/${dirPath ? dirPath + '/' : ''}`;
        const sid = await kbSvcSid();
        const r = await fetch(`${kbBase()}/Doc/downloadDoc.do?vid=${reposId}&targetPath=${kbB64(phys)}&targetName=${kbB64(name)}`, { headers: { Cookie: `JSESSIONID=${sid}` } });
        if (!r.ok || !r.body) return fail(res, 502, '预览内容获取失败');
        const text = await r.text();
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${mdPageCss}</style></head><body><div class="card">${mdToHtml(text)}</div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...KB_PREVIEW_HEADERS,
          'Content-Security-Policy': KB_PREVIEW_HEADERS['Content-Security-Policy'].replace('sandbox;', 'sandbox allow-popups allow-popups-to-escape-sandbox;') });
        res.end(html);
        return;
      }
      if (lower.endsWith('.txt')) {
        const repo = (await kbRepos(u)).find((r) => String(r.id) === String(reposId));
        if (!repo) return fail(res, 200, '仓库不存在或无权访问');
        const phys = `${(repo.path || '').replace(/\/+$/, '')}/${reposId}/data/rdata/${dirPath ? dirPath + '/' : ''}`;
        const sid = await kbSvcSid();
        const r = await fetch(
          `${kbBase()}/Doc/downloadDoc.do?vid=${reposId}&targetPath=${kbB64(phys)}&targetName=${kbB64(name)}`,
          { headers: { Cookie: `JSESSIONID=${sid}` } }
        );
        if (!r.ok || !r.body) return fail(res, 502, '预览内容获取失败');
        const text = await r.text();
        const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#EDEEF4}
.card{max-width:860px;margin:24px auto;background:#fff;border-radius:10px;box-shadow:0 3px 14px rgba(16,18,35,.12);padding:36px 44px}
pre{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.9;color:#1F2333;font-family:"Cascadia Code",Consolas,"PingFang SC",monospace;margin:0}
h1{font-size:0}
</style></head><body><div class="card"><pre>${esc(text)}</pre></div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...KB_PREVIEW_HEADERS });
        res.end(html);
        return;
      }
      const j = await kbSvcForm('/Bussiness/getDocOfficeLink.do', {
        reposId, path: dirPath ? dirPath + '/' : '', name, preview: 'pdf',
      });
      if (j.status !== 'ok' || !j.data || typeof j.data !== 'string')
        return fail(res, 200, (j.msgInfo || '该文件类型暂不支持在线预览，请下载查看').slice(0, 140));
      const sid = await kbSvcSid();
      /* j.data 已含 context path（/DocSystem/...），只拼 origin，避免 /DocSystem/DocSystem/ 双前缀 404 */
      const pdfUrl = new URL(kbBase()).origin + j.data.replace(/^\/DocSystem/, '/DocSystem');
      const r = await fetch(pdfUrl, { headers: { Cookie: `JSESSIONID=${sid}` } });
      if (!r.ok || !r.body) return fail(res, 502, '预览内容获取失败');
      kbAudit(u, 'preview', { reposId, path: dirPath, name });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
      Readable.fromWeb(r.body).pipe(res);
      return;
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  /* 原文件下载：downloadDoc 需要 base64 targetPath（<repo物理路径>/<vid>/data/rdata/<目录>/）+ targetName */
  if (urlPath === '/api/kb/download' && GET) {
    const { u, src } = kbActor(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const vid = ctx.url.searchParams.get('reposId') || '';
    const dirPath = (ctx.url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    const name = ctx.url.searchParams.get('name') || '';
    if (!vid || !name) return fail(res, 200, '参数缺失');
    if (KB_PERMS_ON()) {
      await kbRepos(u).catch(() => {});
      const pDl = kbRepoPerm(u, vid);
      if (!pDl.visible) { kbAudit(u, 'denied', { src, reposId: vid, api: 'download' }); return fail(res, 200, '无权访问或不存在'); }
      if (!pDl.canDownload) { kbAudit(u, 'denied', { src, reposId: vid, api: 'download', why: 'no-download' }); return fail(res, 200, '该库仅支持在线预览，下载已关闭'); }
    }
    try {
      const repo = (await kbRepos(u)).find((r) => String(r.id) === String(vid));
      if (!repo) return fail(res, 200, '仓库不存在或无权访问');
      const phys = `${(repo.path || '').replace(/\/+$/, '')}/${vid}/data/rdata/${dirPath ? dirPath + '/' : ''}`;
      const sid = await kbSvcSid();
      const r = await fetch(
        `${kbBase()}/Doc/downloadDoc.do?vid=${vid}&targetPath=${kbB64(phys)}&targetName=${kbB64(name)}`,
        { headers: { Cookie: `JSESSIONID=${sid}` } }
      );
      if (!r.ok || !r.body) return fail(res, 502, '下载失败（可能无下载权限或文件已被移动）');
      kbAudit(u, 'download', { src, reposId: vid, path: dirPath, name });
      const ct = r.headers.get('content-type') || '';
      res.writeHead(200, {
        'Content-Type': /text\/html/i.test(ct) ? 'application/octet-stream' : ct || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
      });
      Readable.fromWeb(r.body).pipe(res);
      return;
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }

  /* ---------- 知识库 BFF · 写操作（第二步） ----------
     权限由 MxsDoc 按会话用户校验（本部门负责人可写，错误信息透传给前端）；
     rename 需节点级参数（docId/pid/level，getSubDocList 原样透传）；
     delete 先 unlock（清编辑锁）再删，删除成功后同名 2h 防误删锁由 MxsDoc 原生保留。 */
  if (urlPath === '/api/kb/mkdir' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const b = ctx.kbBody ?? await readJson(req);
    const reposId = String(b.reposId || '');
    const dirPath = String(b.path || '').replace(/^\/+|\/+$/g, '');
    const name = String(b.name || '').trim();
    if (!reposId || !name) return fail(res, 200, '参数缺失');
    if (/[\\/:*?"<>|]/.test(name)) return fail(res, 200, '目录名不能包含 \\ / : * ? " < > | 等字符');
    const gateMk = kbWriteGate(u, reposId);
    if (gateMk) { kbAudit(u, 'denied', { reposId, api: 'mkdir' }); return fail(res, 200, gateMk); }
    try {
      const j = await kbFormFor(u, reposId, '/Doc/addDoc.do', { reposId, path: dirPath ? dirPath + '/' : '', name, type: '2' });
      if (j.status !== 'ok') return fail(res, 200, j.msgInfo || '新建目录失败');
      kbAudit(u, 'mkdir', { reposId, path: dirPath, name });
      return ok(res, { ok: true });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  if (urlPath === '/api/kb/rename' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const b = ctx.kbBody ?? await readJson(req);
    const reposId = String(b.reposId || '');
    const docId = String(b.docId || '');
    const pid = String(b.pid ?? '0');
    const level = String(b.level ?? '0');
    const type = String(b.type === 'dir' ? 2 : 1);
    const dirPath = String(b.path || '').replace(/^\/+|\/+$/g, '');
    const name = String(b.name || '').trim();
    const dstName = String(b.dstName || '').trim();
    if (!reposId || !docId || !name || !dstName) return fail(res, 200, '参数缺失');
    if (/[\\/:*?"<>|]/.test(dstName)) return fail(res, 200, '名称不能包含 \\ / : * ? " < > | 等字符');
    const gateRn = kbWriteGate(u, reposId);
    if (gateRn) { kbAudit(u, 'denied', { reposId, api: 'rename' }); return fail(res, 200, gateRn); }
    try {
      /* MxsDoc 重命名走 move 语义，同名冲突报内部日志式 moveDoc_FSM 错——先查父目录给出可读文案
         （getSubDocList 根查询不能带 docId=0，与 /api/kb/list 根分支同型） */
      const parentPid = pid && pid !== '0' ? pid : '';
      const parentName = dirPath ? dirPath.split('/').pop() : '';
      const parent = await kbSvcForm('/Repos/getSubDocList.do', {
        vid: reposId, ...(parentPid ? { docId: parentPid, name: parentName } : {}), path: dirPath, sort: '0', needLockState: '0',
      }).catch(() => null);
      const dup = parent && parent.status === 'ok' && (parent.data || []).some((x) => x.name === dstName && String(x.docId) !== docId);
      if (dup) return fail(res, 200, `重命名失败：同级已有同名「${dstName}」`);
      const j = await kbFormFor(u, reposId, '/Doc/renameDoc.do', {
        reposId, docId, pid, type, level,
        path: dirPath ? dirPath + '/' : '/', name, dstName,
      });
      /* 其余裸错误统一前缀，原文附后便于排障 */
      if (j.status !== 'ok') {
        const raw = String(j.msgInfo || '');
        if (/不存在/.test(raw)) return fail(res, 200, '重命名失败：原目录/文件不存在（可能刚被他人改名或移动，请刷新后重试）');
        return fail(res, 200, raw ? `重命名失败：${raw.slice(0, 80)}` : '重命名失败');
      }
      kbAudit(u, 'rename', { reposId, path: dirPath, name, dstName });
      kbTouchVectors();
      return ok(res, { ok: true });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  if (urlPath === '/api/kb/delete' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const b = ctx.kbBody ?? await readJson(req);
    const reposId = String(b.reposId || '');
    const dirPath = String(b.path || '').replace(/^\/+|\/+$/g, '');
    const name = String(b.name || '').trim();
    const type = String(b.type === 'dir' ? 2 : 1);
    if (!reposId || !name) return fail(res, 200, '参数缺失');
    const gateDl = kbWriteGate(u, reposId);
    if (gateDl) { kbAudit(u, 'denied', { reposId, api: 'delete' }); return fail(res, 200, gateDl); }
    try {
      /* 编辑/预览残留锁先清（unlock 对无锁文件幂等）；删除后的 2h 同名防误删锁不绕过（原生特性） */
      await kbFormFor(u, reposId, '/Doc/unlockDoc.do', { reposId, path: dirPath ? dirPath + '/' : '/', name });
      const j = await kbFormFor(u, reposId, '/Doc/deleteDoc.do', { reposId, path: dirPath ? dirPath + '/' : '/', name, type });
      if (j.status !== 'ok') return fail(res, 200, j.msgInfo || '删除失败');
      kbAudit(u, 'delete', { reposId, path: dirPath, name, type });
      kbTouchVectors();
      return ok(res, { ok: true });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }

  /* 当前用户对库的写权限（getUserDocAuth 库级；前端按此显隐写操作按钮） */
  if (urlPath === '/api/kb/perm' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const reposId = ctx.url.searchParams.get('reposId') || '';
    if (!reposId) return fail(res, 200, '参数缺失');
    const p = kbRepoPerm(u, reposId);
    if (KB_PERMS_ON() && !p.visible) return ok(res, { canWrite: false, tier: p.tier, readShared: false, canManage: false, canDownload: false });
    let canWrite = p.canWrite;
    if (!canWrite && (p.legacyWrite || !KB_PERMS_ON())) {
      try {
        const j = await kbForm(u, '/Repos/getUserDocAuth.do', { docId: '0', reposId, path: '', name: '' });
        const d = j.data || {};
        canWrite = !!(Number(d.addEn) || Number(d.editEn) || Number(d.deleteEn));
      } catch { canWrite = false; }
    }
    return ok(res, { canWrite, tier: p.tier, readShared: p.readShared === true, canManage: p.canManage, canDownload: p.canDownload,
      isPrivateMine: p.tier === 'private' && p.owner === u.username });
  }
  /* 库况统计（阶段3）：文档数/库分布/最近构建（数据源=skill-gateway 向量库快照，含最新 edit 锚点） */
  if (urlPath === '/api/kb/stats' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    try {
      const r = await fetch(`${process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800'}/api/kb/vector-stats`, {
        headers: { Authorization: 'Bearer ' + (process.env.SKILL_GATEWAY_TOKEN || '') },
      });
      const j = await r.json().catch(() => null);
      if (!j || typeof j.total !== 'number') return fail(res, 200, '统计服务暂不可用');
      return ok(res, { total: j.total, byRepo: j.by_repo || [], lastBuiltAt: j.last_built_at || '' });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  /* 历史版本列表（覆盖上传自动生成版本；回滚/历史版下载请在经典视图操作——API 层参数语义异常已实测） */
  if (urlPath === '/api/kb/history' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const reposId = ctx.url.searchParams.get('reposId') || '';
    const dirPath = (ctx.url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    const name = ctx.url.searchParams.get('name') || '';
    if (!reposId || !name) return fail(res, 200, '参数缺失');
    if (KB_PERMS_ON()) {
      await kbRepos(u).catch(() => {});
      if (!kbRepoPerm(u, reposId).visible) return fail(res, 200, '无权访问或不存在');
    }
    try {
      const j = await kbFormFor(u, reposId, '/Doc/getDocHistory.do', { reposId, path: dirPath ? dirPath + '/' : '', name });
      if (j.status !== 'ok') return fail(res, 200, j.msgInfo || '获取历史失败');
      const items = (j.data || []).map((x) => ({
        commitId: x.commitId, commitMsg: x.commitMsg || '', commitTime: x.commitTime || 0, commitUser: x.commitUser || '',
      }));
      return ok(res, { items });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  /* 移动：源参数取自 getSubDocList 节点原样字段（pid/level/path=父路径），目标参数由前端目录选择器构造 */
  if (urlPath === '/api/kb/move' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const b = ctx.kbBody ?? await readJson(req);
    const reposId = String(b.reposId || '');
    const docId = String(b.docId || '');
    const type = String(b.type === 'dir' ? 2 : 1);
    const srcPid = String(b.srcPid ?? '0');
    const srcLevel = String(b.srcLevel ?? '0');
    const srcPath = String(b.srcPath || '');
    const srcName = String(b.srcName || '').trim();
    const dstPid = String(b.dstPid ?? '0');
    const dstLevel = String(b.dstLevel ?? '0');
    const dstPath = String(b.dstPath || '');
    const dstName = String(b.dstName || '').trim();
    if (!reposId || !docId || !srcName || !dstName) return fail(res, 200, '参数缺失');
    if (srcPid === dstPid) return fail(res, 200, '已在该目录下，无需移动');
    const gateMv = kbWriteGate(u, reposId);
    if (gateMv) { kbAudit(u, 'denied', { reposId, api: 'move' }); return fail(res, 200, gateMv); }
    try {
      const j = await kbFormFor(u, reposId, '/Doc/moveDoc.do', {
        reposId, docId, type, srcLevel, dstLevel, srcPid, dstPid,
        srcPath, srcName, dstPath, dstName,
      });
      if (j.status !== 'ok') return fail(res, 200, j.msgInfo || '移动失败');
      kbAudit(u, 'move', { reposId, docId, srcName, dstPath });
      kbTouchVectors();
      return ok(res, { ok: true });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
  }
  if (urlPath === '/api/kb/upload' && POST) {
    const { u, src } = kbActor(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const uploadEpoch = u.ep || 1;
    const ids = ctx.url.searchParams.getAll('reposId');
    if (ids.length !== 1 || !/^[1-9]\d{0,15}$/.test(ids[0])) {
      req.resume(); return fail(res, 400, '必须指定唯一有效的 reposId');
    }
    const upRepo = ids[0];
    const gateUp = kbWriteGate(u, upRepo);
    if (gateUp) { req.resume(); kbAudit(u, 'denied', { src, reposId: upRepo, api: 'upload' }); return fail(res, 403, gateUp); }
    let staged, body;
    try {
      staged = await stageKbUpload(req, ctx.url, TMP_DIR, Number(process.env.KB_UPLOAD_MAX_BYTES || 150 * 1024 * 1024));
      const upload = async () => {
        if (req.aborted || res.destroyed) return;
        // Staging and queueing may be long: revalidate before each upstream write.
        const current = USERS.find((x) => x.username === u.username && !x.disabled);
        if (!current || (current.ep || 1) !== uploadEpoch || kbWriteGate(current, upRepo)) return fail(res, 403, '上传期间权限已变更');
        const upCfg = KBPERMS.repos[upRepo];
        if (upCfg.tier === 'private') {
          kbAssertNoPending(upRepo);
          const target = kbPrivateUploadTarget(staged);
          const usage = await kbCurrentFiles(upRepo);
          const projected = usage.used - (usage.files.get(target) || 0) + staged.fileBytes;
          if (projected > (upCfg.quotaGB || 10) * 1024 ** 3 && projected > usage.used)
            return fail(res, 400, `私有库空间不足（配额 ${upCfg.quotaGB || 10}GB，仅计算当前文件），请清理后重试`);
        }
        const sid = await kbSvcWSid();
        if (req.aborted || res.destroyed) return;
        if (!USERS.includes(current) || current.disabled || (current.ep || 1) !== uploadEpoch || kbWriteGate(current, upRepo))
          return fail(res, 403, '上传期间权限已变更');
        body = fs.createReadStream(staged.path);
        const j = await kbPrivateWrite(upRepo, '/Doc/uploadDoc.do', async () => {
          const r = await fetch(kbBase() + '/Doc/uploadDoc.do', {
            method: 'POST', headers: { Cookie: 'JSESSIONID=' + sid, 'Content-Type': staged.contentType,
              'Content-Length': String(staged.bytes) }, body: Readable.toWeb(body), duplex: 'half', signal: AbortSignal.timeout(120000),
          });
          if (!r.ok) throw new Error('上传响应异常');
          return r.json();
        });
        if (j.status !== 'ok') {
          if (kbNotLogin(j)) KB_SVC_W_SESSION.sid = null;
          return fail(res, 200, j.msgInfo || '上传失败');
        }
        kbAudit(current, 'upload', { src, reposId: upRepo, bytes: staged.fileBytes });
        if (upCfg.tier !== 'private') kbTouchVectors();
        return ok(res, { ok: true, docId: j.data?.docId });
      };
      return await (KBPERMS.repos[upRepo]?.tier === 'private' ? withKbRepoLock(upRepo, upload) : upload());
    } catch (e) {
      req.resume();
      return fail(res, e.status || 500, String(e.message || e).slice(0, 120));
    } finally {
      if (body) { body.destroy(); if (!body.closed) await new Promise((resolve) => body.once('close', resolve)); }
      if (staged) staged.cleanup();
    }
  }

  /* ================= 知识库三类库 · 自助管理接口（2026-10-14） ================= */
  /* 人员目录（共享/维护员勾选器数据源；登录即可见） */
  if (urlPath === '/api/kb/people' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const groups = {};
    for (const x of USERS) {
      if (x.disabled || x.username === u.username) continue;
      const d = x.deptShort || x.dept || '其他';
      (groups[d] = groups[d] || []).push({ username: x.username, name: x.name });
    }
    return ok(res, { groups: Object.entries(groups).map(([dept, users]) => ({ dept, users })), depts: deptNames() });
  }

  /* 库配置读取（负责人/维护员/admin；私有库返回共享名单） */
  if (urlPath === '/api/kb/repo-config' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const reposId = ctx.url.searchParams.get('reposId') || '';
    if (!reposId) return fail(res, 200, '参数缺失');
    await kbRepos(u).catch(() => {});
    const p = kbRepoPerm(u, reposId);
    if (!p.canManage) return fail(res, 200, '仅库负责人/维护员/管理员可查看配置');
    const cfg = KBPERMS.repos[String(reposId)] || {};
    const nm = (arr) => (arr || [])
      .map((x) => USERS.find((y) => y.username === x && !y.disabled))
      .filter(Boolean)
      .map((y) => ({ username: y.username, name: y.name }));
    return ok(res, {
      tier: p.tier, dept: cfg.dept || String(kbRepoNameOf(reposId)).replace(/知识库$/, ''),
      owner: cfg.owner || '', maintainers: nm(cfg.maintainers), whitelist: nm(cfg.whitelist),
      allowDownload: cfg.allowDownload !== false, name: kbRepoNameOf(reposId),
      /* 部门库共享可见（只读）名单：页面只读展示给负责人/维护员，仅 admin 可修改 */
      readDepts: Array.isArray(cfg.readDepts) ? cfg.readDepts : [], isAdmin: u.role === 'admin',
    });
  }

  /* 库配置保存（部门库/公开库=维护员名单；负责人可自助增删，非 admin 限本部门） */
  if (urlPath === '/api/kb/repo-config' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    if (!KB_PERMS_ON()) return fail(res, 200, '权限模块未启用');
    const b = await readJson(req);
    const vid = String(b.reposId || '');
    await kbRepos(u).catch(() => {});
    const p = kbRepoPerm(u, vid);
    if (!p.canManage) return fail(res, 200, '仅库负责人/维护员/管理员可配置');
    if (p.tier === 'private') return fail(res, 200, '私有库请使用共享设置');
    const dept = p.dept || String(kbRepoNameOf(vid)).replace(/知识库$/, '');
    const old = KBPERMS.repos[String(vid)] || {};
    const wanted = [...new Set((b.maintainers || []).map(String).filter(Boolean))];
    const valid = wanted.filter((x) => {
      const t = USERS.find((y) => y.username === x && !y.disabled);
      return t && (u.role === 'admin' || (t.deptShort || t.dept) === dept);
    });
    const next = {
      ...old, tier: p.tier, dept: old.dept || dept,
      owner: u.role === 'admin' ? String(b.owner || old.owner || '') : (old.owner || ''),
      maintainers: valid, maintSet: true,
    };
    if (p.tier === 'dept') {
      /* 共享可见部门（只读，2026-11-03）：仅 admin 可改；非 admin 保存维护员时保留原名单并归一化一次 */
      if (b.readDepts !== undefined && u.role !== 'admin') return fail(res, 200, '仅管理员可设置共享部门');
      next.readDepts = (u.role === 'admin' && b.readDepts !== undefined)
        ? normalizeReadDepts(b.readDepts, next.dept, deptNames())
        : normalizeReadDepts(old.readDepts, next.dept, deptNames());
    }
    KBPERMS.repos[String(vid)] = next;
    saveKbPerms();
    /* T1.2 起物理写授权单点=kb-svc-w，维护员名单只存 BFF 策略表（不再建号/授权 MxsDoc 个人号） */
    kbAudit(u, 'repo-config', { reposId: vid, maintainers: valid, readDepts: next.readDepts || [] });
    return ok(res, { ok: true, maintainers: valid, readDepts: next.readDepts || [] });
  }

  /* 私有库：自助创建（每人限一个，10GB 配额） */
  if (urlPath === '/api/kb/priv-create' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    if (!KB_PERMS_ON()) return fail(res, 200, '权限模块未启用');
    if (Object.values(KBPERMS.repos).some((c) => c && c.tier === 'private' && c.owner === u.username))
      return fail(res, 200, '每人限一个私有库');
    try {
      const svcWId = await kbEnsureSvcW();
      const svcId = await kbMxUserId('kb-svc');
      let rname = `${u.name}的知识库`;
      const have = (await kbAdminForm('/Repos/getReposList.do', {})).data || [];
      if (have.some((r) => r.name === rname)) rname = `${u.name}(${u.username})的知识库`;
      const ROOT = process.env.MXSDOC_REPOS_ROOT || '/var/lib/mxsdoc/repos/';
      const add = await kbAdminForm('/Repos/addRepos.do', {
        name: rname, info: '私有知识库（SkillHarbor 自助创建，仅自己与共享名单可见）', type: 0, path: ROOT + rname,
        textSearch: '{enable:true}', recycleBin: '{enable:true}',
      });
      const list2 = (await kbAdminForm('/Repos/getReposList.do', {})).data || [];
      const nr = list2.find((r) => r.name === rname);
      if (!nr) return fail(res, 200, '建库失败：' + (add.msgInfo || '').slice(0, 80));
      const gRead = async (uid) => {
        await kbAdminForm('/Repos/configReposAuth.do', { userId: uid, reposId: nr.id, access: 1 });
        await kbAdminForm('/Repos/configDocAuth.do', { userId: uid, groupId: '', reposId: nr.id, docId: 0, path: '', name: '', isAdmin: 0, access: 1, editEn: 0, addEn: 0, deleteEn: 0, downloadEn: 1, uploadSize: '', heritable: 1 });
      };
      const gWrite = async (uid) => {
        await kbAdminForm('/Repos/configReposAuth.do', { userId: uid, reposId: nr.id, access: 1 });
        await kbAdminForm('/Repos/configDocAuth.do', { userId: uid, groupId: '', reposId: nr.id, docId: 0, path: '', name: '', isAdmin: 0, access: 1, editEn: 1, addEn: 1, deleteEn: 1, downloadEn: 1, uploadSize: '', heritable: 1 });
      };
      if (svcId) await gRead(svcId).catch(() => {});
      await gWrite(svcWId).catch(() => {});
      KBPERMS.repos[String(nr.id)] = { tier: 'private', owner: u.username, whitelist: [u.username],
        allowDownload: true, quotaGB: 10, name: rname, createdAt: Date.now() };
      saveKbPerms();
      KB_REPOS_CACHE = null;
      kbAudit(u, 'priv-create', { reposId: nr.id, name: rname });
      return ok(res, { ok: true, reposId: nr.id, name: rname });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 140));
    }
  }

  /* 私有库：共享名单 + 下载开关（仅库主人） */
  if (urlPath === '/api/kb/priv-share' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const b = await readJson(req);
    const vid = String(b.reposId || '');
    const cfg = KBPERMS.repos[String(vid)];
    if (!cfg || cfg.tier !== 'private' || cfg.owner !== u.username) return fail(res, 200, '仅库主人可管理共享');
    const wl = [...new Set([u.username, ...(b.whitelist || []).map(String).filter(Boolean)])]
      .filter((x) => USERS.some((y) => y.username === x && !y.disabled));
    cfg.whitelist = wl;
    if (typeof b.allowDownload === 'boolean') cfg.allowDownload = b.allowDownload;
    saveKbPerms();
    kbAudit(u, 'priv-share', { reposId: vid, whitelist: wl, allowDownload: cfg.allowDownload !== false });
    return ok(res, { ok: true, whitelist: wl, allowDownload: cfg.allowDownload !== false });
  }

  /* 私有库：自助删除（需输入库全名确认） */
  if (urlPath === '/api/kb/priv-delete' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    const b = ctx.kbBody ?? await readJson(req);
    const vid = String(b.reposId || '');
    const cfg = KBPERMS.repos[String(vid)];
    if (!cfg || cfg.tier !== 'private' || cfg.owner !== u.username) return fail(res, 200, '仅库主人可删除私有库');
    const rname = cfg.name || kbRepoNameOf(vid);
    if (String(b.confirm || '').trim() !== rname) return fail(res, 200, '请输入库全名「' + rname + '」确认删除');
    try {
      const adm = await kbMxLogin('admin', process.env.MXSDOC_ADMIN_PASSWORD || '');
      if (!adm.ok || !adm.sid) throw new Error('知识库管理员通道不可用');
      if (req.aborted || res.destroyed) return;
      const current = auth(req, url);
      if (!current) return fail(res, 401, '登录已失效，请重新登录');
      if (kbWriteGate(current, vid)) return fail(res, 403, '权限已变更');
      const j = await kbPrivateWrite(vid, '/Repos/deleteRepos.do', async () => {
        let result = await kbAdminForm('/Repos/deleteRepos.do', { vid }, { sid: adm.sid, strict: true });
        if (result.status !== 'ok') result = await kbAdminForm('/Repos/deleteRepos.do', { reposId: vid }, { sid: adm.sid, strict: true });
        return result;
      }, async (result) => {
        if (result.status !== 'ok') return kbCurrentFiles(vid);
        const remaining = await kbSvcForm('/Repos/getReposList.do', {});
        if (remaining.status !== 'ok' || !Array.isArray(remaining.data) || remaining.data.some(r => String(r.id) === vid))
          throw new Error('无法确认私有库已删除');
      });
      if (j.status !== 'ok') return fail(res, 200, '删除失败：' + (j.msgInfo || '').slice(0, 80));
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 120));
    }
    delete KBPERMS.repos[String(vid)];
    saveKbPerms();
    KB_REPOS_CACHE = null;
    kbAudit(u, 'priv-delete', { reposId: vid, name: rname });
    return ok(res, { ok: true });
  }

  /* 同步到公开库（部门库 → 全员发布通道；复制不移动，重复同步覆盖留版本） */
  if (urlPath === '/api/kb/sync-pub' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录门户');
    if (!KB_PERMS_ON()) return fail(res, 200, '权限模块未启用');
    const b = await readJson(req);
    const vid = String(b.reposId || '');
    const dirPath = String(b.path || '').replace(/^\/+|\/+$/g, '');
    const name = String(b.name || '').trim();
    const isDir = !!b.isDir;
    if (!vid || !name) return fail(res, 200, '参数缺失');
    try {
      const repos = await kbRepos(u);
      const src = repos.find((r) => String(r.id) === String(vid));
      if (!src) return fail(res, 200, '无权访问或不存在');
      const p = kbRepoPerm(u, vid, src.name);
      if (p.tier !== 'dept') return fail(res, 200, '仅部门库支持同步到公开库');
      let may = p.canWrite;
      if (!may && p.legacyWrite) {
        /* 迁移期：维护员名单未落库，按 MxsDoc 原生写权限探测 */
        try {
          const j = await kbForm(u, '/Repos/getUserDocAuth.do', { docId: '0', reposId: vid, path: '', name: '' });
          const d = j.data || {};
          may = !!(Number(d.addEn) || Number(d.editEn) || Number(d.deleteEn));
        } catch { may = false; }
      }
      if (!may) { kbAudit(u, 'denied', { reposId: vid, api: 'sync-pub' }); return fail(res, 200, '仅库维护人员可发布到公开库'); }
      const pubEnt = Object.entries(KBPERMS.repos).find(([, c]) => c && c.tier === 'public');
      if (!pubEnt) return fail(res, 200, '公司公开库未初始化（管理员先创建）');
      const pubId = pubEnt[0];
      const dept = p.dept || String(src.name).replace(/知识库$/, '');
      const sidW = await kbSvcWSid();
      const physOf = (rid, dp) => {
        const rp = repos.find((r) => String(r.id) === String(rid));
        return `${(rp.path || '').replace(/\/+$/, '')}/${rid}/data/rdata/${dp ? dp + '/' : ''}`;
      };
      const fetchFile = async (dp, nm) => {
        const sidR = await kbSvcSid();
        const r = await fetch(`${kbBase()}/Doc/downloadDoc.do?vid=${vid}&targetPath=${kbB64(physOf(vid, dp))}&targetName=${kbB64(nm)}`, { headers: { Cookie: `JSESSIONID=${sidR}` } });
        if (!r.ok) throw new Error('源文件读取失败：' + nm);
        return Buffer.from(await r.arrayBuffer());
      };
      const uploadOne = async (dp, nm, buf) => {
        const build = () => {
          const fd = new FormData();
          fd.append('reposId', String(pubId));
          fd.append('path', dp ? dp + '/' : '');
          fd.append('name', nm);
          fd.append('filePath', nm);
          fd.append('size', String(buf.length));
          fd.append('checkSum', '');
          fd.append('commitMsg', `同步发布（${u.name} · ${src.name}）`);
          fd.append('uploadFile', new Blob([buf]), nm);
          return fd;
        };
        for (let att = 0; att < 2; att++) {
          const r = await fetch(`${kbBase()}/Doc/uploadDoc.do`, { method: 'POST', headers: { Cookie: `JSESSIONID=${sidW}` }, body: build() });
          const j = await r.json().catch(() => ({}));
          if (j.status === 'ok') return;
          /* MxsDoc 对同名路径有短时"正在新增"仓储锁（重复同步场景易撞），等 900ms 重试一次 */
          if (att === 0 && /正在新增/.test(String(j.msgInfo || ''))) { await new Promise((r2) => setTimeout(r2, 900)); continue; }
          throw new Error('写入公开库失败：' + String(j.msgInfo || '').slice(0, 60));
        }
      };
      /* 逐层"先查后建"（docId 链，与门户列表同语义）：已存在则跳过——
         盲建会触发 MxsDoc 仓储锁（"用户正在新增文件"），重复同步即撞锁 */
      const pubList = async (node) => {
        const lj = await kbSvcForm('/Repos/getSubDocList.do', { vid: String(pubId), docId: node.docId || '', path: node.path || '', name: node.name || '', sort: '0', needLockState: '0' });
        return lj.status === 'ok' ? (lj.data || []) : [];
      };
      const ensureDir = async (dp) => {
        if (!dp) return;
        let node = { docId: '', path: '', name: '' };
        for (const sg of dp.split('/')) {
          const hit = (await pubList(node)).find((x) => x.name === sg && Number(x.type) === 2);
          if (hit) { node = { docId: String(hit.docId), path: hit.path, name: hit.name }; continue; }
          await kbSvcWForm('/Doc/addDoc.do', { reposId: String(pubId), path: node.path ? node.path + '/' : '', name: sg, type: '2' });
          await new Promise((r2) => setTimeout(r2, 300)); /* 等 MxsDoc 目录锁释放 */
          const hit2 = (await pubList(node)).find((x) => x.name === sg);
          node = hit2 ? { docId: String(hit2.docId), path: hit2.path, name: hit2.name }
                      : { docId: '', path: (node.path ? node.path + '/' : '') + sg, name: sg };
        }
      };
      const listDir = async (docId, dp, nm) => {
        const j = await kbSvcForm('/Repos/getSubDocList.do', { vid: String(vid), docId: docId || '', path: dp || '', name: nm || '', sort: '0', needLockState: '0' });
        if (j.status !== 'ok') throw new Error('目录读取失败：' + String(j.msgInfo || '').slice(0, 60));
        return (j.data || []).map((x) => ({ name: x.name, type: Number(x.type) === 2 ? 'dir' : 'file', docId: x.docId, path: x.path || '' }));
      };
      let n = 0, total = 0;
      const LIMIT_N = 500, LIMIT_B = 1024 ** 3;
      const dstBase = dept + (dirPath ? '/' + dirPath : '');
      if (!isDir) {
        const buf = await fetchFile(dirPath, name);
        await ensureDir(dstBase);
        await uploadOne(dstBase, name, buf);
        n = 1; total = buf.length;
      } else {
        /* 逐级下钻定位源目录（getSubDocList 需父级 docId，与前端 gotoPath 同法） */
        let cur = { docId: '', path: '', name: '' };
        for (const sg of [...(dirPath ? dirPath.split('/') : []), name]) {
          const kids = await listDir(cur.docId, cur.path, cur.name);
          const hit = kids.find((k) => k.name === sg && k.type === 'dir');
          if (!hit) throw new Error('目录不存在：' + sg);
          cur = { docId: String(hit.docId), path: hit.path, name: hit.name };
        }
        const copyTree = async (node, absSrc, absDst) => {
          const kids = await listDir(node.docId, node.path, node.name);
          await ensureDir(absDst);
          for (const k of kids) {
            if (n >= LIMIT_N || total >= LIMIT_B) throw new Error('超出同步上限（500 个文件 / 1GB）');
            if (k.type === 'dir') await copyTree(k, absSrc ? absSrc + '/' + k.name : k.name, absDst ? absDst + '/' + k.name : k.name);
            else { const buf = await fetchFile(absSrc, k.name); total += buf.length; await uploadOne(absDst, k.name, buf); n++; }
          }
        };
        await copyTree(cur, dirPath ? dirPath + '/' + name : name, dstBase ? dstBase + '/' + name : name);
      }
      kbTouchVectors();
      kbAudit(u, 'sync-pub', { reposId: vid, path: dirPath, name, isDir, files: n, bytes: total });
      return ok(res, { ok: true, files: n, bytes: total, dst: `公司公开库/${dstBase}${isDir ? '/' + name : ''}/${isDir ? '' : name}` });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 140));
    }
  }

  /* 公司公开库初始化（admin；幂等：建库 + kb-svc 读 + kb-svc-w 写 + 策略落库） */
  if (urlPath === '/api/admin/kb/ensure-pub' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    try {
      const svcWId = await kbEnsureSvcW();
      const svcId = await kbMxUserId('kb-svc');
      const have = (await kbAdminForm('/Repos/getReposList.do', {})).data || [];
      let pub = have.find((r) => r.name === '公司公开库');
      if (!pub) {
        const ROOT = process.env.MXSDOC_REPOS_ROOT || '/var/lib/mxsdoc/repos/';
        const add = await kbAdminForm('/Repos/addRepos.do', {
          name: '公司公开库', info: '公司公开资料（初始为空，由各部门负责人自行上传维护）', type: 0,
          path: ROOT + '公司公开库', textSearch: '{enable:true}', recycleBin: '{enable:true}',
        });
        const have2 = (await kbAdminForm('/Repos/getReposList.do', {})).data || [];
        pub = have2.find((r) => r.name === '公司公开库');
        if (!pub) return fail(res, 200, '创建失败：' + (add.msgInfo || '').slice(0, 80));
      }
      const gRead = async (uid) => {
        await kbAdminForm('/Repos/configReposAuth.do', { userId: uid, reposId: pub.id, access: 1 });
        await kbAdminForm('/Repos/configDocAuth.do', { userId: uid, groupId: '', reposId: pub.id, docId: 0, path: '', name: '', isAdmin: 0, access: 1, editEn: 0, addEn: 0, deleteEn: 0, downloadEn: 1, uploadSize: '', heritable: 1 });
      };
      const gWrite = async (uid) => {
        await kbAdminForm('/Repos/configReposAuth.do', { userId: uid, reposId: pub.id, access: 1 });
        await kbAdminForm('/Repos/configDocAuth.do', { userId: uid, groupId: '', reposId: pub.id, docId: 0, path: '', name: '', isAdmin: 0, access: 1, editEn: 1, addEn: 1, deleteEn: 1, downloadEn: 1, uploadSize: '', heritable: 1 });
      };
      if (svcId) await gRead(svcId).catch(() => {});
      await gWrite(svcWId).catch(() => {});
      const old = KBPERMS.repos[String(pub.id)] || {};
      KBPERMS.repos[String(pub.id)] = { ...old, tier: 'public', dept: '总经办', owner: old.owner || '', maintainers: old.maintainers || [], name: '公司公开库' };
      saveKbPerms();
      KB_REPOS_CACHE = null;
      kbAudit(authed(ctx), 'ensure-pub', { reposId: pub.id });
      return ok(res, { ok: true, reposId: pub.id });
    } catch (e) {
      return fail(res, 500, String(e.message || e).slice(0, 140));
    }
  }

  /* ---------- 组织管理（admin，2026-10-14）：部门字典 + 负责人 + 调岗 ---------- */
  if (urlPath === '/api/admin/org/depts' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const counts = {};
    for (const u of USERS) if (!u.disabled) counts[u.deptShort || u.dept] = (counts[u.deptShort || u.dept] || 0) + 1;
    const names = deptNames();
    const unassigned = USERS.filter((u) => !u.disabled && !names.includes(u.deptShort || u.dept)).length;
    /* 每部门的知识库信息（配置库或按命名约定） */
    const libOf = {};
    for (const [rid, c] of Object.entries(KBPERMS.repos)) {
      if (c && c.tier === 'dept' && c.dept) libOf[c.dept] = { libId: rid, maintainers: c.maintainers || [], owner: c.owner || '', libName: c.name || c.dept + '知识库' };
    }
    const depts = DEPTS.map((d) => ({
      ...d, count: counts[d.name] || 0,
      ...(libOf[d.name] || {}),
    }));
    return ok(res, { depts, unassigned });
  }
  if (urlPath === '/api/admin/org/depts' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name || /知识库$/.test(name)) return fail(res, 200, '部门名不合法（无需带"知识库"后缀）');
    if (DEPTS.some((d) => d.name === name)) return fail(res, 200, '部门已存在');
    let libNote = '';
    if (b.createLib) {
      /* 同步创建部门知识库（部门成员可见可下载）：建库 + kb-svc 读 + kb-svc-w 写 + 策略落库 */
      try {
        const svcWId = await kbEnsureSvcW();
        const svcId = await kbMxUserId('kb-svc');
        const rname = name + '知识库';
        const ROOT = process.env.MXSDOC_REPOS_ROOT || '/var/lib/mxsdoc/repos/';
        const add = await kbAdminForm('/Repos/addRepos.do', {
          name: rname, info: `${name} 部门知识库`, type: 0, path: ROOT + rname,
          textSearch: '{enable:true}', recycleBin: '{enable:true}',
        });
        const have2 = (await kbAdminForm('/Repos/getReposList.do', {})).data || [];
        const nr = have2.find((r) => r.name === rname);
        if (!nr) return fail(res, 200, '部门知识库创建失败：' + (add.msgInfo || '').slice(0, 80));
        const gR = async (uid, wr) => {
          await kbAdminForm('/Repos/configReposAuth.do', { userId: uid, reposId: nr.id, access: 1 });
          await kbAdminForm('/Repos/configDocAuth.do', { userId: uid, groupId: '', reposId: nr.id, docId: 0, path: '', name: '', isAdmin: 0, access: 1, editEn: wr, addEn: wr, deleteEn: wr, downloadEn: 1, uploadSize: '', heritable: 1 });
        };
        if (svcId) await gR(svcId, 0).catch(() => {});
        await gR(svcWId, 1).catch(() => {});
        KBPERMS.repos[String(nr.id)] = { tier: 'dept', dept: name, owner: '', maintainers: [], maintSet: false, name: rname };
        saveKbPerms();
        KB_REPOS_CACHE = null;
        libNote = `（已同步创建 ${rname}）`;
      } catch (e) {
        libNote = '（知识库创建失败：' + String(e.message || e).slice(0, 60) + '）';
      }
    }
    DEPTS.push({ name, head: '' });
    saveDepts();
    kbAudit(authed(ctx), 'org-dept-add', { name, createLib: !!b.createLib });
    return ok(res, { ok: true, note: libNote });
  }

  /* 部门重命名：字典 + 人员归属 + 策略表 + 知识库名（best-effort 联动） */
  if (urlPath === '/api/admin/org/dept-rename' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    const newName = String(b.newName || '').trim();
    if (!name || !newName || /知识库$/.test(newName)) return fail(res, 200, '参数不合法');
    const d = DEPTS.find((x) => x.name === name);
    if (!d) return fail(res, 200, '部门不存在');
    if (name === newName) return ok(res, { ok: true, changed: false });
    if (DEPTS.some((x) => x.name === newName)) return fail(res, 200, '目标部门名已存在');
    /* 知识库：MxsDoc 无 HTTP 改名 API（editRepos/updateRepos 等均 404，2026-10-14 实测）——
       库名保留原名，但策略表 dept 始终跟随新部门名（权限匹配不断链），界面如实显示实际库名 */
    let libNote = '';
    for (const cfg of Object.values(KBPERMS.repos)) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg.tier === 'dept' && cfg.dept === name) {
        cfg.dept = newName;
        libNote = '（知识库保留原名）';
      }
      if (Array.isArray(cfg.readDepts)) {
        cfg.readDepts = [...new Set(cfg.readDepts.map(dept => dept === name ? newName : dept))]
          .filter(dept => dept !== cfg.dept);
      }
    }
    /* 2) 人员归属 + 3) 字典 */
    let moved = 0;
    for (const u of USERS) {
      if ((u.deptShort || u.dept) === name) { u.dept = newName; u.deptShort = newName; moved++; }
    }
    d.name = newName;
    saveUsers(); saveDepts(); saveKbPerms();
    KB_REPOS_CACHE = null;
    kbAudit(authed(ctx), 'org-dept-rename', { name, newName, moved, libNote });
    return ok(res, { ok: true, moved, note: libNote });
  }

  /* 导出花名册（CSV，带 BOM，Excel 直接打开） */
  if (urlPath === '/api/admin/org/export' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const head = { username: '' };
    const maintains = kbMaintainsOf();
    const headOf = {};
    for (const d of DEPTS) if (d.head) headOf[d.head] = d.name;
    const rows = [['部门', '姓名', '账号', '岗位', '角色', '状态', '部门负责人', '库维护']];
    for (const d of DEPTS) {
      for (const u of USERS.filter((x) => (x.deptShort || x.dept) === d.name)) {
        rows.push([d.name, u.name, u.username, u.title || '', u.role === 'admin' ? '管理员' : '员工', u.disabled ? '已禁用' : '在职',
          d.head === u.username ? '是' : '', (maintains[u.username] || []).join('/')]);
      }
    }
    for (const u of USERS.filter((x) => !deptNames().includes(x.deptShort || x.dept))) {
      rows.push(['（未分配）', u.name, u.username, u.title || '', u.role === 'admin' ? '管理员' : '员工', u.disabled ? '已禁用' : '在职', '', (maintains[u.username] || []).join('/')]);
    }
    const NL = String.fromCharCode(13, 10); const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join(NL);
    kbAudit(authed(ctx), 'org-export', { rows: rows.length - 1 });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('花名册-' + new Date().toISOString().slice(0, 10) + '.csv')}`,
      'Cache-Control': 'no-store',
    });
    res.end('\ufeff' + csv);
    return;
  }
  if (urlPath === '/api/admin/org/dept-del' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (USERS.some((u) => !u.disabled && (u.deptShort || u.dept) === name)) return fail(res, 200, '部门下仍有在职人员，先调离再删除');
    DEPTS = DEPTS.filter((d) => d.name !== name);
    saveDepts();
    kbAudit(authed(ctx), 'org-dept-del', { name });
    return ok(res, { ok: true });
  }
  /* 设置部门负责人；syncKb=同时设为该部门知识库负责人（owner+维护员，BFF 策略表） */
  if (urlPath === '/api/admin/org/set-head' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const name = String(b.dept || '').trim();
    const head = String(b.head || '').trim();
    const d = DEPTS.find((x) => x.name === name);
    if (!d) return fail(res, 200, '部门不存在');
    const hu = USERS.find((x) => x.username === head && !x.disabled);
    if (!hu) return fail(res, 200, '负责人不存在或已禁用');
    if ((hu.deptShort || hu.dept) !== name) return fail(res, 200, `负责人须为本部门成员（${hu.name} 当前在${hu.deptShort || hu.dept}）`);
    d.head = head;
    saveDepts();
    let kbNote = '';
    if (b.syncKb) {
      /* 找到该部门的知识库（策略表或命名约定），设 owner 并加入维护员 */
      let vid = Object.entries(KBPERMS.repos).find(([, c]) => c && c.tier === 'dept' && c.dept === name)?.[0];
      if (!vid) {
        await kbRepos(hu).catch(() => {});
        const hit = ((KB_REPOS_CACHE && KB_REPOS_CACHE.list) || []).find((r) => r.name === name + '知识库');
        vid = hit ? String(hit.id) : null;
      }
      if (vid) {
        const cfg = KBPERMS.repos[String(vid)] || { tier: 'dept', dept: name, maintainers: [] };
        cfg.tier = 'dept'; cfg.dept = name;
        cfg.owner = head;
        if (!cfg.maintainers.includes(head)) cfg.maintainers.push(head);
        cfg.maintSet = true;
        KBPERMS.repos[String(vid)] = cfg;
        saveKbPerms();
        kbAudit(authed(ctx), 'org-set-head', { dept: name, head, syncKb: true, reposId: vid });
      } else {
        kbNote = '（未找到该部门知识库）';
      }
    } else {
      kbAudit(authed(ctx), 'org-set-head', { dept: name, head });
    }
    return ok(res, { ok: true, note: kbNote });
  }

  /* ---------- 用户管理（admin） ---------- */
  if (urlPath === '/api/admin/users' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    /* 最近一次成功登录的 IP / 时间（登录记录按时间追加，倒序找首个命中） */
    const lastLogin = {};
    for (let i = LOGINS.length - 1; i >= 0; i--) {
      const l = LOGINS[i];
      if (l && l.ok && l.ip && !lastLogin[l.u]) lastLogin[l.u] = { ip: l.ip, t: l.t };
    }
    const withLogin = (u) => ({ ...publicUser(u), lastLoginIp: lastLogin[u.username]?.ip || '', lastLoginAt: lastLogin[u.username]?.t || 0 });
    const maintains = kbMaintainsOf();
    const withKb = (u) => ({ ...withLogin(u), maintains: maintains[u.username] || [] });
    return ok(res, {
      users: USERS.filter((u) => !u.disabled).map(withKb),
      disabled: USERS.filter((u) => u.disabled).map(withKb),
    });
  }
  if (urlPath === '/api/admin/users' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const uname = String(b.username || '').trim().toLowerCase();
    if (!/^[a-z]+$/.test(uname)) return fail(res, 200, '用户名需为小写字母拼音');
    if (USERS.some((x) => x.username === uname)) return fail(res, 200, '用户名已存在');
    const dept = String(b.dept || '').trim();
    if (!deptNames().includes(dept)) return fail(res, 200, '部门不存在，请先在组织管理中新增部门');
    const salt = crypto.randomBytes(8).toString('hex');
    USERS.push({
      username: uname, name: String(b.name || uname), role: 'user', dept, deptShort: dept,
      title: b.title || '', phone: '', email: '', salt, hash: hashPwd('123456', salt), ep: 1, disabled: false,
    });
    saveUsers();
    kbAudit(authed(ctx), 'org-user-add', { target: uname, dept });
    return ok(res, { message: '已新增用户，初始密码 123456' });
  }
  let m;
  if ((m = /^\/api\/admin\/users\/([a-z]+)\/(disable|enable|reset)$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const u = USERS.find((x) => x.username === m[1]);
    if (!u) return fail(res, 200, '用户不存在');
    if (m[2] === 'disable' && u.role === 'admin') return fail(res, 200, '不能禁用管理员');
    if (m[2] === 'disable') u.disabled = true;
    if (m[2] === 'enable') u.disabled = false;
    if (m[2] === 'reset') {
      u.salt = crypto.randomBytes(8).toString('hex');
      u.hash = hashPwd(defaultPwd(u), u.salt);
      u.ep = (u.ep || 1) + 1; // 重置后旧令牌全部失效
    }
    if (m[2] === 'disable' || m[2] === 'reset') revokeGatewayToken(m[1]);
    saveUsers();
    return ok(res, { message: m[2] === 'reset' ? '密码已重置为默认' : '已更新' });
  }
  /* 人员编辑（姓名/岗位/部门——部门变更实时切换其部门库可见性并记审计） */
  if ((m = /^\/api\/admin\/users\/([a-z]+)\/edit$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const u = USERS.find((x) => x.username === m[1]);
    if (!u) return fail(res, 200, '用户不存在');
    const b = await readJson(req);
    const changes = {};
    if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== u.name) { changes.name = [u.name, b.name.trim()]; u.name = b.name.trim(); }
    if (typeof b.title === 'string') { changes.title = [u.title || '', b.title]; u.title = b.title; }
    if (typeof b.role === 'string' && ['user', 'admin'].includes(b.role) && b.role !== u.role) {
      if (u.username === (authed(ctx) || {}).username) return fail(res, 200, '不能修改自己的角色');
      if (u.role === 'admin' && USERS.filter((x) => x.role === 'admin' && !x.disabled).length <= 1)
        return fail(res, 200, '系统至少保留一名管理员');
      changes.role = [u.role, b.role];
      u.role = b.role;
    }
    if (typeof b.dept === 'string' && b.dept && b.dept !== (u.deptShort || u.dept)) {
      if (!deptNames().includes(b.dept)) return fail(res, 200, '部门不存在，请先在组织管理中添加');
      changes.dept = [u.deptShort || u.dept, b.dept];
      u.dept = b.dept;
      u.deptShort = b.dept;
    }
    if (!Object.keys(changes).length) return ok(res, { ok: true, changed: false });
    saveUsers();
    kbAudit(authed(ctx), 'org-user-edit', { target: u.username, changes });
    return ok(res, { ok: true, changed: true });
  }
  if ((m = /^\/api\/admin\/users\/([a-z]+)$/.exec(urlPath)) && req.method === 'DELETE') {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const u = USERS.find((x) => x.username === m[1]);
    if (!u) return fail(res, 200, '用户不存在');
    if (u.role === 'admin') return fail(res, 200, '不能删除管理员');
    const nextUsers = USERS.filter((x) => x.username !== m[1]);
    // 提交失败时不改变活动账号，也不撤销其网关令牌。
    writeJSON('users.json', nextUsers);
    USERS = nextUsers;
    revokeGatewayToken(m[1]);
    /* 同步清理知识库名单（维护员/共享白名单）；其名下私有库保留冻结（无人可访问） */
    let kbTouched = 0;
    for (const c of Object.values(KBPERMS.repos)) {
      if (!c) continue;
      const beforeM = (c.maintainers || []).length, beforeW = (c.whitelist || []).length;
      c.maintainers = (c.maintainers || []).filter((x) => x !== m[1]);
      c.whitelist = (c.whitelist || []).filter((x) => x !== m[1]);
      if ((c.maintainers || []).length !== beforeM || (c.whitelist || []).length !== beforeW) kbTouched++;
    }
    if (kbTouched) saveKbPerms();
    kbAudit(authed(ctx), 'org-user-del', { target: m[1], kbTouched });
    return ok(res, { message: '已删除' + (kbTouched ? `（已同步移出 ${kbTouched} 个库的名单）` : '') });
  }

  /* ---------- 登录记录（admin） ---------- */
  /* 清理指定 IP 的登录记录（测试机批量登录会污染"最近登录 IP"展示；audit 日志不受影响） */
  if (urlPath === '/api/admin/logins/purge' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const ip = String(b.ip || '').trim();
    const since = Number(b.since || 0);
    if (!ip) return fail(res, 200, '参数缺失：ip');
    const before = LOGINS.length;
    LOGINS = LOGINS.filter((l) => !(l.ip === ip && (!since || l.t >= since)));
    saveLogins();
    kbAudit(authed(ctx), 'logins-purge', { ip, since, removed: before - LOGINS.length });
    return ok(res, { ok: true, removed: before - LOGINS.length });
  }
  if (urlPath === '/api/admin/logins' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rows = LOGINS.slice(-300).reverse();
    return ok(res, { rows });
  }

  /* ---------- 评价 ---------- */
  if (urlPath === '/api/evals' && GET) {
    const target = url.searchParams.get('target') || '';
    const mineU = authed(ctx);
    // 脱敏：非管理员不暴露评价人 IP 与账号（仅显示姓名/部门）
    const strip = (e) => {
      const { ip, u, ...rest } = e;
      return rest;
    };
    const recent = EVALS.filter((e) => e.target === target && e.flag !== 'excluded')
      .sort((a, b) => b.t - a.t)
      .slice(0, 12)
      .map((e) => ({ ...(mineU?.role === 'admin' ? e : strip(e)), mine: mineU ? e.u === mineU.username : false }));
    const mine = mineU ? EVALS.find((e) => e.target === target && e.u === mineU.username) : null;
    return ok(res, { summary: evalSummary(target), recent, mine: mine ? { v: mine.v, s: mine.s, c: mine.c, t: mine.t } : null });
  }

  if (urlPath === '/api/evals/all' && GET) {
    const target = url.searchParams.get('target') || '';
    const viewer = authed(ctx);
    const items = EVALS.filter((e) => e.target === target && e.flag !== 'excluded').sort((a, b) => b.t - a.t).slice(0, 100)
      .map((e) => {
        const { ip, u, ...publicFields } = e;
        return { ...(viewer?.role === 'admin' ? e : publicFields), mine: viewer ? e.u === viewer.username : false };
      });
    return ok(res, { summary: evalSummary(target), items });
  }

  if (urlPath === '/api/evals' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录后再评价');
    const b = await readJson(req);
    const target = String(b.target || '');
    if (!target) return fail(res, 200, '缺少评价对象');
    const stars = b.stars === undefined ? 0 : Number(b.stars);
    if (b.stars !== undefined && (!Number.isInteger(stars) || stars < 1 || stars > 5)) return fail(res, 200, '星级必须是 1 到 5 的整数');
    const vote = stars ? (stars >= 4 ? 1 : -1) : b.vote === 1 ? 1 : b.vote === -1 ? -1 : 0;
    if (!vote) return fail(res, 200, '请先打星评分');
    const comment = String(b.comment || '').trim().slice(0, 300);
    const existing = EVALS.find((e) => e.target === target && e.u === u.username);
    if (existing) {
      existing.v = vote;
      existing.s = stars || (vote === 1 ? 5 : 1);
      existing.c = comment;
      existing.t = Date.now();
      existing.ip = clientIp(req);
      existing.reviewed = false;
    } else {
      EVALS.push({ id: nowId('e'), target, tn: String(b.targetName || '').slice(0, 40), u: u.username, n: u.name, d: u.deptShort || u.dept, v: vote, s: stars || (vote === 1 ? 5 : 1), c: comment, t: Date.now(), ip: clientIp(req), flag: 'ok', reviewed: false });
    }
    refreshSuspects();
    return ok(res, { summary: evalSummary(target) });
  }

  if (urlPath === '/api/admin/evals' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const target = url.searchParams.get('target') || '';
    const vote = url.searchParams.get('vote') || '';
    const flag = url.searchParams.get('flag') || '';
    const q = (url.searchParams.get('q') || '').trim();
    let rows = EVALS.slice().sort((a, b) => b.t - a.t);
    if (target) rows = rows.filter((e) => e.target === target);
    if (vote) rows = rows.filter((e) => e.v === Number(vote));
    if (flag) rows = rows.filter((e) => e.flag === flag);
    if (q) rows = rows.filter((e) => (e.n + e.u + e.c + e.tn).includes(q));
    return ok(res, { rows: rows.slice(0, 500), total: rows.length });
  }

  if ((m = /^\/api\/admin\/evals\/([a-z0-9]+)\/flag$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const e = EVALS.find((x) => x.id === m[1]);
    if (!e) return fail(res, 200, '记录不存在');
    const b = await readJson(req);
    e.flag = b.flag === 'excluded' ? 'excluded' : 'ok';
    e.reviewed = true;
    saveEvals();
    return ok(res, { message: e.flag === 'excluded' ? '已剔除（不计入好评率）' : '已恢复计入' });
  }

  if ((m = /^\/api\/admin\/evals\/([a-z0-9]+)$/.exec(urlPath)) && req.method === 'DELETE') {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    EVALS = EVALS.filter((x) => x.id !== m[1]);
    saveEvals();
    return ok(res, { message: '已删除' });
  }

  if (urlPath === '/api/admin/evals/export.csv' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = ['时间,对象,用户,部门,方向,评语,IP,状态'];
    for (const e of EVALS.slice().sort((a, b) => b.t - a.t)) {
      lines.push(
        [new Date(e.t).toLocaleString('zh-CN'), e.tn || e.target, e.n, e.d, e.v === 1 ? '推荐' : '不推荐', e.c, e.ip, e.flag === 'excluded' ? '已剔除' : e.flag === 'suspect' ? '疑似异常' : '正常']
          .map(esc).join(','));
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="evals-${ymd()}.csv"`, 'Cache-Control': 'no-store' });
    return res.end('\ufeff' + lines.join('\r\n'));
  }

  /* ---------- 上传 ---------- */
  /* 部门清单（上传弹窗「适用部门」多选选项）：取自员工名册去重短名，保持名册顺序 */
  if (urlPath === '/api/meta/departments' && GET) {
    const seen = new Set();
    const departments = [];
    for (const x of USERS) {
      const d = String(x.deptShort || x.dept || '').trim();
      if (d && !seen.has(d)) { seen.add(d); departments.push(d); }
    }
    return ok(res, { departments });
  }

  if ((m = /^\/api\/uploads\/([a-z0-9]+)\/draft$/.exec(urlPath)) && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const rec = UPLOADS.find(item => item.id === m[1] && item.u === u.username);
    if (!rec) return fail(res, 404, '未找到本人的上传草稿');
    const body = await readJson(req);
    if (!['draft', 'rejected'].includes(rec.status) || PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '草稿正在更新，请稍后重试');
    if (body.revision !== undefined && body.revision !== (rec.packageRevision || 0)) return fail(res, 409, '草稿已经变化，请刷新后保存');
    const before = { ...rec };
    try {
      Object.assign(rec, { name: String(body.name ?? rec.name ?? '').trim().slice(0, 30), desc: String(body.desc ?? rec.desc ?? '').trim().slice(0, 300), updateNote: String(body.updateNote ?? rec.updateNote ?? '').trim().slice(0, 200), updatedAt: Date.now() });
      if (Object.hasOwn(body, 'icon')) rec.icon = String(body.icon || '').trim().slice(0, 2);
      if (Object.hasOwn(body, 'iconUrl')) rec.iconUrl = /^\/files\/uploads\/icons\/[\w.-]+$/.test(String(body.iconUrl || '')) ? body.iconUrl : '';
      if (Object.hasOwn(body, 'iconBg')) rec.iconBg = /^#[a-fA-F0-9]{6}$/.test(String(body.iconBg || '')) ? body.iconBg : '';
      if (Object.hasOwn(body, 'url')) {
        const url = String(body.url || '').trim();
        if (url && !/^https?:\/\//.test(url)) throw Object.assign(new Error('请填写有效的网页地址'), { status: 400 });
        rec.url = url;
      }
      if (Object.hasOwn(body, 'category')) rec.category = String(body.category || '').trim().slice(0, 20);
      if (Object.hasOwn(body, 'tags')) {
        if (!Array.isArray(body.tags)) throw Object.assign(new Error('业务标签格式不正确'), { status: 400 });
        rec.tags = [...new Set(body.tags.map(value => String(value || '').trim().slice(0, 8)).filter(Boolean))].slice(0, 4);
      }
      if (Object.hasOwn(body, 'departments')) {
        if (!Array.isArray(body.departments)) throw Object.assign(new Error('适用部门格式不正确'), { status: 400 });
        const allowed = new Set(USERS.map(value => String(value.deptShort || value.dept || '').trim()).filter(Boolean));
        const departments = [...new Set(body.departments.map(value => String(value || '').trim()).filter(value => value === '全部' || allowed.has(value)))].slice(0, 16);
        rec.departments = departments.length ? departments : ['全部'];
      }
      saveUploads();
      return ok(res, { id: rec.id, revision: rec.packageRevision || 0 });
    } catch (error) {
      for (const key of Object.keys(rec)) if (!Object.hasOwn(before, key)) delete rec[key];
      Object.assign(rec, before);
      return fail(res, error.status === 400 ? 400 : 500, error.status === 400 ? error.message : '草稿未保存成功，请重试');
    }
  }

  if ((m = /^\/api\/uploads\/([a-z0-9]+)\/analyze$/.exec(urlPath)) && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const rec = UPLOADS.find(item => item.id === m[1] && item.u === u.username);
    if (!rec) return fail(res, 404, '未找到本人的上传草稿');
    const body = await readJson(req);
    if (!['draft', 'rejected'].includes(rec.status) || PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '草稿状态已变化，请稍后重试');
    const revision = rec.packageRevision || 0;
    PREPARING_UPLOADS.add(rec.id);
    try {
      let sourceBytes, sourceHash;
      if (rec.kind === 'skill') {
        const sourcePath = path.join(ANALYSIS_SOURCES_DIR, rec.id + '.zip');
        if (rec.smartAnalysisSourceHash && fs.existsSync(sourcePath)) {
          sourceBytes = fs.readFileSync(sourcePath);
          if (crypto.createHash('sha256').update(sourceBytes).digest('hex') !== rec.smartAnalysisSourceHash) throw Object.assign(new Error('分析材料校验失败，请重新上传项目包'), { status: 409 });
        } else {
          sourceBytes = makeZip(collectSkillPackage(path.join(TMP_DIR, rec.id), '', null));
          const temporary = sourcePath + '.' + crypto.randomUUID() + '.tmp';
          try { fs.writeFileSync(temporary, sourceBytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, sourcePath); }
          finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
        sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
      }
      const result = await analyzeDraft({
        rec, user: u, body, directory: path.join(TMP_DIR, rec.id), sourceBytes, sourceHash, gatewayBase: GW_BASE(), headers: gwHeaders(), collect: collectSkillPackage, makeZip,
        inspect: (bytes, slug) => inspectSkillArchive(GW_BASE(), gwHeaders(), bytes, slug), save: saveUploads, lookupTarget: lookupSmartTarget,
        findToolMatches: (name, user) => EXTRA_TOOLS.filter(tool => tool.status === 'online' && tool.name === name && UPLOADS.some(item => item.id === tool.uploadId && item.u === user.username)),
        findSkillMatches: async (name, user) => {
          const response = await fetch(GW_BASE() + '/api/skills', { headers: gwHeaders(), signal: AbortSignal.timeout(15000) });
          const list = await response.json();
          if (!response.ok || !Array.isArray(list)) throw Object.assign(new Error('无法确认现有项目，请稍后重试'), { status: 502 });
          return list.filter(item => (item.display_name || item.name) === name && (item.owner === user.name || UPLOADS.some(upload => upload.u === user.username && upload.status === 'online' && upload.publishSlug === item.slug))).slice(0, 12).map(item => ({ slug: item.slug, name: item.display_name || item.name }));
        },
        proposeAI: (context, user) => require('./server/lib/package-ai.cjs').proposePackage(context, user),
        assertEditable: () => { if (!['draft', 'rejected'].includes(rec.status) || (rec.packageRevision || 0) !== revision) throw Object.assign(new Error('草稿已在其他操作中变化，请刷新后重试'), { status: 409 }); },
      });
      return ok(res, result);
    } catch (error) { return fail(res, [400, 403, 409, 422, 502].includes(error.status) ? error.status : 400, error.status ? error.message : '自动整理暂未完成，草稿已保留，请稍后重试'); }
    finally { PREPARING_UPLOADS.delete(rec.id); }
  }

  if ((m = /^\/api\/uploads\/([a-z0-9]+)\/prepare$/.exec(urlPath)) && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const rec = UPLOADS.find(x => x.id === m[1]);
    if (!rec || rec.u !== u.username) return fail(res, 404, '未找到本人的上传草稿');
    if (rec.kind !== 'skill' || !['draft', 'rejected'].includes(rec.status)) return fail(res, 409, '只有待编辑的智能体或技能草稿可以修正结构');
    const b = await readJson(req);
    if (rec.kind !== 'skill' || !['draft', 'rejected'].includes(rec.status)) return fail(res, 409, '草稿状态已经变化，请刷新后重试');
    if (PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '结构正在更新，请稍后重新预览');
    const revision = rec.packageRevision || 0;
    if (b.apply && (!Number.isInteger(b.revision) || b.revision !== revision)) return fail(res, 409, '草稿已经变化，请重新预览结构后应用');
    if (b.apply && (!b.manifest || typeof b.manifest !== 'object' || Array.isArray(b.manifest))) return fail(res, 400, '请先预览并确认清单');
    PREPARING_UPLOADS.add(rec.id);
    try {
      const updateOf = String(Object.hasOwn(b, 'updateOf') ? b.updateOf || '' : rec.updateOf || '').trim();
      let slug;
      if (updateOf) {
        if (!updateOf.startsWith('skill:')) return fail(res, 400, '技能包只能绑定已有智能体或技能');
        slug = updateOf.slice(6);
        const owned = UPLOADS.some(x => x.u === u.username && x.publishSlug === slug && x.status === 'online');
        if (!owned) {
          const lookup = await fetch(GW_BASE() + '/api/skills/' + encodeURIComponent(slug), { headers: gwHeaders(), signal: AbortSignal.timeout(15000) });
          const target = await lookup.json().catch(() => ({}));
          if (!lookup.ok || String(target.owner || '') !== u.name) return fail(res, 403, '只能更新本人负责的智能体或技能');
        }
      }
      const directory = path.join(TMP_DIR, rec.id);
      const files = collectSkillPackage(directory, '', null);
      const assistance = await prepareSkillArchive(GW_BASE(), gwHeaders(), makeZip(files), { entry: b.entry, manifest: b.manifest, slug, regenerate: b.regenerate });
      assistance.revision = revision;
      if (!b.apply) return ok(res, { assistance });
      if (!assistance.manifestYaml || !assistance.inspection) return fail(res, 422, assistance.errors?.[0] || '清单结构无效，请修正后重新预览');
      const manifestName = preparedManifestPath(assistance);
      const preparedFiles = files.filter(f => f.name !== manifestName);
      preparedFiles.push({ name: manifestName, data: Buffer.from(assistance.manifestYaml, 'utf8') });
      // Validate the exact archive that this portal will publish, not just the proposed YAML.
      const inspection = await inspectSkillArchive(GW_BASE(), gwHeaders(), makeZip(preparedFiles), slug);
      assistance.inspection = inspection;
      assistance.errors = [...new Set([...(assistance.errors || []), ...(inspection.errors || [])])];
      assistance.revision = revision + 1;
      const report = preparationReport(assistance, true);
      const before = { ...rec };
      try {
        applyPreparedManifest(directory, assistance, () => {
          rec.report = report;
          rec.packageRevision = revision + 1;
          rec.updatedAt = Date.now();
          rec.updateOf = updateOf || undefined;
          delete rec.smartAnalysis;
          delete rec.smartChoices;
          delete rec.smartIdentityQuestion;
          delete rec.smartNewIdentity;
          delete rec.smartPublicationIntent;
          delete rec.smartAnalysisSourceHash;
          saveUploads();
        });
      } catch (error) {
        for (const key of Object.keys(rec)) if (!(key in before)) delete rec[key];
        Object.assign(rec, before);
        throw error;
      }
      return ok(res, { id: rec.id, report, assistance, parsedNames: inspection.names || [] });
    } catch (error) {
      return fail(res, error.status === 422 ? 422 : 400, '结构修正失败：' + error.message);
    } finally { PREPARING_UPLOADS.delete(rec.id); }
  }

  if (urlPath === '/api/uploads/parse' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) return fail(res, 200, '上传格式错误');
    let buf;
    try {
      buf = await readBody(req, 155);
    } catch (e) {
      /* 超限/断连时也要回明确文案：曾因裸断连让前端永远停在「解析中」 */
      return fail(res, 200, e.message === 'body too large' ? '文件超过 150MB 限制，请精简压缩包后重新上传' : '接收上传数据失败：' + e.message);
    }
    let form;
    try {
      form = parseMultipart(buf, ct);
    } catch (e) {
      return fail(res, 200, '解析上传失败：' + e.message);
    }
    const file = form.files.find((f) => f.name === 'file');
    if (!file) return fail(res, 200, '未收到文件');
    /* 免选类型（kind 缺省 auto）：免选类型，由包内容自动判定（显式传 web/skill/… 仍按原逻辑，兼容旧客户端与测试） */
    const resourceType = ['agent', 'skill', 'tool'].includes(form.fields.resourceType) ? form.fields.resourceType : '';
    const kind = ['agent', 'skill'].includes(resourceType) ? 'skill' : form.fields.kind || 'auto';
    if (file.data.length > 152 * MB) return fail(res, 200, '文件超过 150MB 限制，请精简压缩包后重新上传');
    const id = nowId('u');
    let parsed;
    try {
      const effectiveKind = kind === 'auto' ? detectKind(file).kind : kind;
      let inspection;
      if (effectiveKind === 'skill' || /\.md$/i.test(file.filename)) {
        const archive = /\.zip$/i.test(file.filename) ? file.data : makeZip([{ name: 'SKILL.md', data: file.data }]);
        try {
          inspection = await inspectSkillArchive(GW_BASE(), gwHeaders(), archive);
        } catch (error) {
          if (error.status !== 422) throw error;
          // A safe but ambiguous package may be retained for a user-confirmed repair.
          // prepare repeats all ZIP safety checks; dangerous archives never reach staging.
          const assistance = await prepareSkillArchive(GW_BASE(), gwHeaders(), archive);
          assistance.revision = 0;
          stageValidatedPackage(path.join(TMP_DIR, id), zipRead(archive));
          parsed = { kind: 'skill', rep: preparationReport(assistance, false), names: assistance.manifest?.id ? [assistance.manifest.id] : [] };
        }
      }
      if (!parsed) parsed = parseUpload(id, file, kind, inspection);
      if (inspection) {
        if (inspection.names?.length) parsed.names = inspection.names;
        parsed.rep.packageRoot = inspection.root;
        parsed.rep.packageEntry = inspection.entry;
        parsed.rep.structure = inspection.structure;
        for (const message of inspection.errors || []) parsed.rep.rules.push({ id: 'A1', level: 'error', msg: message, fix: '请修改包清单或补齐必需依赖后重新上传' });
        for (const message of inspection.warnings || []) parsed.rep.rules.push({ id: 'A2', level: 'warn', msg: message, fix: '请核对结构预览中的依赖状态' });
        parsed.rep.lines.push(`✓ ${inspection.structure.kind === 'agent' ? '智能体' : 'AI 技能'}：入口 ${inspection.entry}，包内组件 ${inspection.structure.components.length} 个，外部依赖 ${inspection.structure.dependencies.length} 个`);
        if (inspection.errors?.length) parsed.rep.verdict = 'fail';
        else if (inspection.warnings?.length && parsed.rep.verdict === 'ok') parsed.rep.verdict = 'warn';
        if (resourceType === 'agent' && inspection.structure.kind !== 'agent') {
          const assistance = await prepareSkillArchive(GW_BASE(), gwHeaders(), makeZip(collectSkillPackage(path.join(TMP_DIR, id), '', null)));
          assistance.revision = 0;
          parsed.rep = preparationReport(assistance, false);
        }
      }
    } catch (e) {
      const failedDirectory = path.resolve(TMP_DIR, id);
      if (path.dirname(failedDirectory) === path.resolve(TMP_DIR) && fs.existsSync(failedDirectory)) fs.rmSync(failedDirectory, { recursive: true, force: true });
      return fail(res, 200, '解析失败：' + e.message);
    }
    const originalPath = path.join(ORIGINAL_UPLOADS_DIR, id + '.bin');
    try { fs.writeFileSync(originalPath, file.data, { flag: 'wx', mode: 0o600 }); }
    catch { return fail(res, 500, '原始项目包未保存成功，请重试上传'); }
    UPLOADS.push({
      id, u: u.username, n: u.name, d: u.deptShort || u.dept,
      kind: parsed.kind, filename: file.filename, sizeMB: +(file.data.length / MB).toFixed(1),
      report: parsed.rep, resourceType, parsedNames: (parsed.names || []).filter(Boolean).slice(0, 4), originalSha256: crypto.createHash('sha256').update(file.data).digest('hex'), packageRevision: 0, createdAt: Date.now(), status: 'draft',
    });
    try { saveUploads(); }
    catch {
      const index = UPLOADS.findIndex(item => item.id === id);
      if (index >= 0) UPLOADS.splice(index, 1);
      fs.unlinkSync(originalPath);
      return fail(res, 500, '上传草稿未保存成功，请重试');
    }
    return ok(res, {
      id,
      kind: parsed.kind,
      detected: parsed.detected || parsed.kind,
      filename: file.filename,
      sizeMB: +(file.data.length / MB).toFixed(1),
      report: parsed.rep,
      parsedNames: (parsed.names || []).filter(Boolean).slice(0, 4),
      previewUrl: parsed.rep.entry ? `/files/uploads-preview/${id}/${parsed.rep.entry}` : null,
    });
  }

  /* ---------- 外部链接：抓取网页图标（favicon） ---------- */
  if (urlPath === '/api/uploads/icon' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const b = await readJson(req);
    let target;
    try {
      target = new URL(String(b.url || '').trim());
    } catch {
      return fail(res, 200, '地址格式不正确');
    }
    if (!/^https?:$/.test(target.protocol)) return fail(res, 200, '仅支持 http/https 地址');

    const iconDir = path.join(UP_DIR, 'icons');
    fs.mkdirSync(iconDir, { recursive: true });
    const tryFetch = async (urlStr) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(urlStr, { signal: ctl.signal, headers: { 'User-Agent': 'skillharbor' }, redirect: 'follow' });
        if (!r.ok) return null;
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const buf = Buffer.from(await r.arrayBuffer());
        clearTimeout(timer);
        if (buf.length < 16 || buf.length > 300 * 1024) return null;
        if (!ct.startsWith('image/') && !/\.(ico|png|jpe?g|svg|gif)(\?|$)/i.test(urlStr)) return null;
        return { buf, ct };
      } catch {
        clearTimeout(timer);
        return null;
      }
    };
    // ① /favicon.ico ② 页面 <link rel=icon> 指向的地址
    let got = await tryFetch(target.origin + '/favicon.ico');
    if (!got) {
      try {
        const page = await fetch(target.origin + '/', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'skillharbor' } });
        if (page.ok) {
          const html = (await page.text()).slice(0, 200 * 1024);
          const m = /<link[^>]+rel=["']?(?:shortcut\s+icon|icon|apple-touch-icon)["']?[^>]*>/i.exec(html) || /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']?(?:shortcut\s+icon|icon)["']?/i.exec(html);
          const href = m && (/href=["']([^"']+)["']/i.exec(m[0]) || [])[1];
          if (href) {
            const abs = new URL(href, target.origin + '/').href;
            got = await tryFetch(abs);
          }
        }
      } catch { /* 页面不可达则直接失败 */ }
    }
    if (!got) return fail(res, 200, '未能获取网页图标，可使用文字图标');
    const extByCt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
    const ext = extByCt[got.ct.split(';')[0]] || 'ico';
    const file = nowId('ic') + '.' + ext;
    fs.writeFileSync(path.join(iconDir, file), got.buf);
    return ok(res, { iconUrl: filesUrl(`/files/uploads/icons/${file}`) });
  }

  /* 会话材料：截图（jpg/png/webp ≤5MB，最多 2 张，首张为卡片封面）与产品说明书（pdf/docx/zip ≤20MB，1 份）。
   * 挂在 TMP_DIR/<id>/ 下（_shots/、_docs/），随提交一起进入审核；仅会话所有者可操作 */
  if ((m = /^\/api\/uploads\/([a-z0-9]+)\/material$/.exec(urlPath)) && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '上传会话已过期，请重新上传');
    if (rec.u !== u.username) return fail(res, 403, 'forbidden');
    if (rec.status !== 'draft') return fail(res, 200, '该记录已提交，材料不可修改');
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) return fail(res, 200, '请求格式不正确');
    let buf;
    try {
      buf = await readBody(req, 26);
    } catch (e) {
      return fail(res, 200, e.message === 'body too large' ? '文件超过大小限制（截图 5MB / 说明书 20MB）' : '接收上传数据失败：' + e.message);
    }
    let parsed;
    try { parsed = parseMultipart(buf, ct); } catch (e) { return fail(res, 200, e.message); }
    const type = String(parsed.fields.type || '');
    const file = parsed.files[0];
    if (!file) return fail(res, 200, '缺少文件');
    if (type === 'shot') {
      if (!/\.(jpe?g|png|webp)$/i.test(file.filename)) return fail(res, 200, '截图仅支持 jpg / png / webp');
      if (file.data.length > 5 * MB) return fail(res, 200, '截图单张不超过 5MB');
      const dir = path.join(TMP_DIR, rec.id, '_shots');
      fs.mkdirSync(dir, { recursive: true });
      const list = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
      if (list.length >= 2) return fail(res, 200, '截图最多 2 张，请先删除');
      const name = 'shot-' + (list.length + 1) + file.filename.toLowerCase().match(/\.(jpe?g|png|webp)$/)[0];
      fs.writeFileSync(path.join(dir, name), file.data);
      return ok(res, { shots: fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() });
    }
    if (type === 'doc') {
      if (!/\.(pdf|docx?|zip)$/i.test(file.filename)) return fail(res, 200, '说明书仅支持 pdf / docx / zip');
      if (file.data.length > 20 * MB) return fail(res, 200, '说明书不超过 20MB');
      const dir = path.join(TMP_DIR, rec.id, '_docs');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manual' + file.filename.toLowerCase().match(/\.(pdf|docx?|zip)$/)[0]), file.data);
      return ok(res, { doc: 'manual' + file.filename.toLowerCase().match(/\.(pdf|docx?|zip)$/)[0] });
    }
    return fail(res, 200, '材料类型不正确');
  }

  if ((m = /^\/api\/uploads\/([a-z0-9]+)\/material-del$/.exec(urlPath)) && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '上传会话已过期');
    if (rec.u !== u.username) return fail(res, 403, 'forbidden');
    if (rec.status !== 'draft') return fail(res, 200, '该记录已提交，材料不可修改');
    const b = await readJson(req);
    if (b.type === 'shot') {
      const dir = path.join(TMP_DIR, rec.id, '_shots');
      const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : [];
      const idx = Math.min(5, Math.max(1, Number(b.index) || 1)) - 1;
      if (list[idx]) fs.rmSync(path.join(dir, list[idx]), { force: true });
      // 重排为连续编号，保持“第一张=封面”
      const rest = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : [];
      rest.forEach((f, i) => {
        const want = 'shot-' + (i + 1) + f.slice(f.lastIndexOf('.'));
        if (f !== want) fs.renameSync(path.join(dir, f), path.join(dir, want));
      });
      return ok(res, { shots: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : [] });
    }
    if (b.type === 'doc') {
      fs.rmSync(path.join(TMP_DIR, rec.id, '_docs'), { recursive: true, force: true });
      return ok(res, { doc: '' });
    }
    return fail(res, 200, '材料类型不正确');
  }

  if (urlPath === '/api/uploads/submit' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const b = await readJson(req);
    const rec = UPLOADS.find((x) => x.id === b.id);
    if (!rec) return fail(res, 200, '上传会话已过期，请重新上传');
    /* 提交护栏：仅本人会话可提交；仅未提交（draft）/ 已驳回（rejected，修改后重交）可提交——防他入会话劫持与重复提交 */
    if (rec.u !== u.username) return fail(res, 200, '只能提交本人创建的上传记录');
    if (rec.status !== 'draft' && rec.status !== 'rejected') return fail(res, 200, '该记录已在审核流程中，无需重复提交');
    if (PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '结构正在更新，请完成后再提交审核');
    if ((rec.smartAnalysis || Object.hasOwn(b, 'revision')) && (!Number.isInteger(b.revision) || b.revision !== (rec.packageRevision || 0))) return fail(res, 409, '项目内容已更新，请重新查看并确认最新结果后提交');
    if (rec.smartAnalysis && (rec.smartAnalysis.status !== 'ready' || rec.smartAnalysis.revision !== (rec.packageRevision || 0))) return fail(res, 409, '请先完成自动整理和业务确认，再提交审核');
    const submittingRevision = rec.packageRevision || 0;
    /* P2 校验网关：error 未清零不允许进入审核（前端解析页已拦，此处服务端兜底） */
    const errs = (rec.report?.rules || []).filter((r) => r.level === 'error');
    if (errs.length) return fail(res, 200, `校验未通过（${errs.length} 项错误）：${errs[0].msg} —— ${errs[0].fix || '请修改后重新上传'}`);
    const name = String(b.name || '').trim().slice(0, 30);
    if (!name) return fail(res, 200, '请填写工具名称');
    if (rec.kind === 'link' && !/^https?:\/\//.test(String(b.url || ''))) return fail(res, 200, '外部链接格式不正确');
    // 版本类型：全新提交（无 updateOf）/ 更新已有（必须绑定本人名下已上线记录）
    const updateOf = String(b.updateOf === undefined ? rec.updateOf || '' : b.updateOf).trim();
    if (rec.packageRevision > 0 && rec.updateOf && updateOf !== rec.updateOf) {
      return fail(res, 409, '该草稿已确认更新对象，请重新预览并应用结构后再更换绑定');
    }
    if (rec.report?.structure?.source === 'manifest' && updateOf.startsWith('skill:') && rec.report.structure.slug !== updateOf.slice(6)) {
      return fail(res, 200, `包清单 id（${rec.report.structure.slug}）与要更新的技能标识不一致，请修改包清单或重新选择更新对象`);
    }
    const updateNote = String(b.updateNote || '').trim().slice(0, 200);
    const updateVersion = String(b.updateVersion || '').trim().slice(0, 20);
    let lockedName = '';
    if (updateOf) {
      if (!updateNote) return fail(res, 200, '更新提交必须填写更新说明');
      if (updateOf.startsWith('tool:')) {
        const tid = updateOf.slice(5);
        const t = EXTRA_TOOLS.find((x) => x.id === tid);
        if (!t || t.status !== 'online') return fail(res, 200, '绑定的工具不存在或未上线');
        const upRec = UPLOADS.find((x) => x.id === t.uploadId);
        if (!upRec || upRec.u !== u.username) return fail(res, 200, '只能更新自己提交且已上线的工具');
        lockedName = t.name;
        /* 免选类型后：更新提交沿用原工具通道，识别不一致时明确拒绝（防错误通道部署） */
        const wantKind = t.type === 'local' ? 'web' : t.type === 'service' ? 'service' : t.type === 'download' ? 'file' : '';
        if (wantKind && rec.kind !== wantKind) {
          return fail(res, 200, `该包自动识别为「${KIND_LABEL_ZH[rec.kind] || rec.kind}」，与原工具通道（${KIND_LABEL_ZH[wantKind]}）不符——请按原类型重新打包后上传，或联系管理员处理`);
        }
      } else if (updateOf.startsWith('skill:')) {
        const slug = updateOf.slice(6);
        const own = UPLOADS.find((x) => x.kind === 'skill' && x.status === 'online' && x.publishSlug === slug && x.u === u.username);
        if (own) {
          lockedName = own.name || name;
        } else {
          /* 直传网关上架的技能（无门户上传记录）：归属以技能中心为准——存在且归属本人即可更新（与 my-online 口径一致） */
          let gw = null;
          try { gw = await (await fetch(GW_BASE() + '/api/skills/' + encodeURIComponent(slug), { headers: gwHeaders() })).json(); } catch { gw = null; }
          if (!gw || !gw.slug || String(gw.owner || '') !== u.name) return fail(res, 200, '只能更新自己名下已上线的技能（以技能中心归属为准）');
          lockedName = gw.display_name || gw.name || name;
        }
        if (rec.kind !== 'skill') return fail(res, 200, `该包自动识别为「${KIND_LABEL_ZH[rec.kind] || rec.kind}」而不是 AI 技能（技能包需含 SKILL.md），无法更新技能`);
      } else {
        return fail(res, 200, '更新绑定格式不正确');
      }
    }
    /* #3 技能重名防线：壳技能按中文名落文件夹，同名技能会在员工端互相覆盖；
     * 更新提交名称已锁定为原技能名，无需校验 */
    if (rec.kind === 'skill' && !updateOf) {
      const conflict = await findSkillNameConflict(lockedName || name, rec.id);
      if (conflict) return fail(res, 200, conflict);
      try {
        let identity = rec.report?.structure?.slug;
        if (!identity) {
          const inspection = await inspectSkillArchive(GW_BASE(), gwHeaders(), makeZip(collectSkillPackage(path.join(TMP_DIR, rec.id), '', null)));
          identity = inspection.structure?.slug;
        }
        await requireNewSkillIdentity(identity);
      } catch (error) { return fail(res, 409, error.message); }
    }
    // Upstream ownership/name checks await network I/O. Recheck the draft at
    // the commit boundary so a concurrent repair or submission cannot bypass
    // the report and revision that this request validated.
    if (!['draft', 'rejected'].includes(rec.status) || PREPARING_UPLOADS.has(rec.id) || (rec.packageRevision || 0) !== submittingRevision) {
      return fail(res, 409, '草稿已在其他操作中变化，请重新检查后提交');
    }
    if ((rec.report?.rules || []).some(r => r.level === 'error')) return fail(res, 409, '当前结构尚未通过检查，请修正后再提交');
    /* 会话材料清单落进记录（文件仍在 tmp，审批通过时随包部署） */
    const shotsDir = path.join(TMP_DIR, rec.id, '_shots');
    const docsDir = path.join(TMP_DIR, rec.id, '_docs');
    rec.shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => !f.startsWith('.')).sort() : [];
    rec.doc = fs.existsSync(docsDir) ? fs.readdirSync(docsDir)[0] || '' : '';
    Object.assign(rec, {
      name: lockedName || name,
      desc: String(b.desc || '').trim().slice(0, 300) || '（待补充）',
      icon: (String(b.icon || '').trim().slice(0, 2) || name.slice(0, 2) || '工'),
      iconUrl: /^\/files\/uploads\/icons\/[\w.-]+$/.test(String(b.iconUrl || '')) ? b.iconUrl : '',
      iconBg: /^#[0-9a-fA-F]{6}$/.test(String(b.iconBg || '')) ? b.iconBg : '',
      url: String(b.url || '').trim(),
      category: String(b.category || '').trim().slice(0, 20), // 技能类上传的分类（上架技能中心时随包提交）
      tags: Array.isArray(b.tags)
        ? [...new Set(b.tags.map((t) => String(t || '').trim().slice(0, 8)).filter(Boolean))].slice(0, 4)
        : [],
      /* 适用部门（多选短名；['全部'] 表示全部门适用），不在名册内的值丢弃，空缺回退「全部」 */
      departments: (() => {
        const valid = new Set(USERS.map((x) => String(x.deptShort || x.dept || '').trim()).filter(Boolean));
        const arr = Array.isArray(b.departments)
          ? [...new Set(b.departments.map((d) => String(d || '').trim()).filter((d) => d === '全部' || valid.has(d)))]
          : [];
        return arr.length ? arr.slice(0, 16) : ['全部'];
      })(),
      updateOf: updateOf || undefined,
      updateNote: updateNote || undefined,
      updateVersion: updateVersion || undefined,
      status: 'pending',
      submittedAt: Date.now(),
    });
    saveUploads();
    notifyPendingReview(rec); // 飞书群推送（异步，不阻塞提交）
    return ok(res, { message: '已提交，等待管理员审核' });
  }

  if (urlPath === '/api/uploads/mine' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    return ok(res, { rows: UPLOADS.filter((x) => x.u === u.username).sort((a, b) => (b.submittedAt || b.createdAt) - (a.submittedAt || a.createdAt)).map(x => ({ ...x, sourceAvailable: x.kind === 'link' || fs.existsSync(path.join(TMP_DIR, x.id)) })) });
  }

  /* 我名下已上线记录（上传向导「更新已有」绑定列表）：工具取 extraTools（类型按卡片 type 归一——更新提交沿用
   * 首次 uploadId，记录 kind 会陈旧，卡片 type 才是当前真实形态），技能取已上架记录 + 已通过但未上架的置灰项，版本实时查网关 */
  if (urlPath === '/api/uploads/my-online' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const mine = UPLOADS.filter((x) => x.u === u.username);
    const kindOf = {};
    for (const x of mine) kindOf[x.id] = x.kind;
    const TYPE_KIND = { local: 'web', download: 'file', service: 'service', external: 'link' };
    const tools = EXTRA_TOOLS
      .filter((t) => t.status === 'online' && t.uploadId && mine.some((x) => x.id === t.uploadId && x.status === 'online'))
      .map((t) => ({ id: t.id, name: t.name, kind: TYPE_KIND[t.type] || kindOf[t.uploadId] || 'web', onlineAt: t.onlineAt || '', updatedAt: t.updatedAt || '', desc: t.desc || '', tags: Array.isArray(t.tags) ? t.tags : [], departments: Array.isArray(t.departments) ? t.departments : [] }));
    /* 技能：以技能中心（网关）为真相源按归属人（中文名）取全集——直传网关上架的技能（不经门户向导）
     * 同样出现在「更新已有」；门户上传记录仅补带入信息（描述/标签/适用部门/分类）与「已通过未上架」置灰项。
     * 网关不可达时回退上传记录口径（此时版本留空）。版本去 v 前端缀 v 展示，避免 vv 双头 */
    let gwSkills = null;
    try {
      const response = await fetch(GW_BASE() + '/api/skills', { headers: gwHeaders(), signal: AbortSignal.timeout(15000) });
      const list = await response.json();
      if (response.ok && Array.isArray(list)) gwSkills = list;
    } catch { /* 下方回退 */ }
    const recBySlug = new Map();
    for (const x of mine) if (x.kind === 'skill' && x.status === 'online' && x.publishSlug) recBySlug.set(x.publishSlug, x);
    const seen = new Set();
    const skills = [];
    if (gwSkills) {
      for (const g of gwSkills) {
        if (!g || !g.slug || seen.has(g.slug) || String(g.owner || '') !== u.name) continue;
        if (g.status && g.status !== 'enabled') continue;
        seen.add(g.slug);
        const x = recBySlug.get(g.slug) || {};
        skills.push({
          slug: g.slug,
          name: g.display_name || g.name || g.slug,
          version: String(g.current_version || '').replace(/^v/i, ''),
          kind: g.kind, status: g.status, updatedAt: g.updated_at || '',
          onlineAt: String(g.created_at || g.updated_at || '').slice(0, 10) || ymd(),
          desc: x.desc || g.description || '',
          category: x.category || g.category || '',
          tags: Array.isArray(x.tags) ? x.tags : [],
          departments: Array.isArray(x.departments) ? x.departments : [],
        });
      }
    } else {
      for (const [slug, x] of recBySlug) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        skills.push({ slug, name: x.name || slug, kind: x.report?.structure?.kind, status: 'enabled', updatedAt: x.updatedAt ? new Date(x.updatedAt).toISOString() : '', onlineAt: ymdOf(x.approvedAt || x.submittedAt || Date.now()), desc: x.desc || '', category: x.category || '', tags: Array.isArray(x.tags) ? x.tags : [], departments: Array.isArray(x.departments) ? x.departments : [] });
      }
    }
    for (const x of mine) {
      if (x.kind !== 'skill' || x.status !== 'online' || x.publishSlug || !x.name || seen.has('p:' + x.name)) continue;
      /* 已通过审核但未上架技能中心：列表可见但置灰（更新依赖线上 slug 升版本，须先由管理员上架） */
      seen.add('p:' + x.name);
      skills.push({ id: x.id, slug: '', pendingPublish: true, name: x.name, onlineAt: ymdOf(x.approvedAt || x.submittedAt || Date.now()), desc: x.desc || '', category: x.category || '', tags: Array.isArray(x.tags) ? x.tags : [], departments: Array.isArray(x.departments) ? x.departments : [] });
    }
    return ok(res, { tools, skills, gatewayAvailable: gwSkills !== null });
  }

  if (urlPath === '/api/uploads/parseonly' && POST) {
    // 外部链接类型：无文件，仅建会话
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const id = nowId('u');
    const report = { verdict: 'ok', lines: ['✓ 外部链接：无需解析，提交时填写地址即可'], entry: null, warns: 0 };
    UPLOADS.push({ id, u: u.username, n: u.name, d: u.deptShort || u.dept, kind: 'link', createdAt: Date.now(), status: 'draft', report });
    saveUploads();
    return ok(res, { id, kind: 'link', report });
  }

  if (urlPath === '/api/admin/uploads' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const status = url.searchParams.get('status') || '';
    let rows = UPLOADS.slice().sort((a, b) => (b.submittedAt || b.createdAt) - (a.submittedAt || a.createdAt));
    if (status) rows = rows.filter((x) => x.status === status);
    return ok(res, { rows, filesBase: FILES_BASE });
  }

  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/review$/.exec(urlPath)) && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find(item => item.id === m[1]);
    if (!rec) return fail(res, 404, '记录不存在');
    if (PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '项目正在更新，请稍后重新核查');
    const revision = revisionOf(rec), status = rec.status;
    // Clone the selected submission. Inspection must never mutate or persist it.
    const snapshot = JSON.stringify(rec);
    const selected = JSON.parse(snapshot);
    const review = await buildUploadReview({ rec: selected, directory: path.join(TMP_DIR, rec.id),
      inspect: (bytes, slug) => inspectSkillArchive(GW_BASE(), gwHeaders(), bytes, slug), tools: EXTRA_TOOLS, uploads: UPLOADS, skillDepartments: SKILL_DEPTS,
      fetchJson: async route => {
        const response = await fetch(GW_BASE() + route, { headers: gwHeaders(), signal: AbortSignal.timeout(15000) });
        const data = await response.json();
        if (!response.ok || !data || typeof data !== 'object') throw new Error('无法读取当前发布对象');
        return data;
      },
    });
    if (PREPARING_UPLOADS.has(rec.id) || revisionOf(rec) !== revision || rec.status !== status || JSON.stringify(rec) !== snapshot || UPLOADS.find(item => item.id === rec.id) !== rec) return fail(res, 409, '项目已变化，请重新核查');
    return ok(res, { ...review, reviewToken: reviewTokenOf(selected) });
  }

  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/approve$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '记录不存在');
    const revision = revisionOf(rec);
    let b;
    try { b = await readJson(req); } catch { return fail(res, 400, '审批请求格式错误'); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(res, 400, '审批请求格式错误');
    checkServiceAction();
    if (!matchesReviewToken(rec, b)) return fail(res, 409, '核查内容已变化，请重新核查后审批');
    if (Object.hasOwn(b, 'revision') && !Number.isInteger(b.revision)) return fail(res, 400, '核查版本必须为整数');
    if (revisionOf(rec) !== revision || Object.hasOwn(b, 'revision') && b.revision !== revision) return fail(res, 409, '项目已变化，请重新核查后审批');
    if (PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '项目正在处理，请稍后刷新');
    if (rec.status === 'online') return fail(res, 200, '该工具已上线');
    if (rec.status !== 'pending' && rec.status !== 'deploy_failed') return fail(res, 409, '当前状态不可审批，请刷新列表查看');
    const approvingStatus = rec.status;
    PREPARING_UPLOADS.add(rec.id);
    try {
    let url = rec.url || '';
    // 更新提交：绑定的原工具（保留 id 与历史统计 / 评价，替换内容后原卡位继续展示）
    const updTarget = rec.updateOf && rec.updateOf.startsWith('tool:')
      ? EXTRA_TOOLS.find((t) => t.id === rec.updateOf.slice(5))
      : null;
    /* 前置体检：不可恢复的输入问题（临时文件已被清理）在进入部署状态机前拦下，不产生 deploy_failed 噪音。
     * 材料目录精确匹配 _shots/_docs（不能按“下划线开头”泛化：文件类中文名经 safeExt 会变成 ____ 下划线开头） */
    const fromRoot = path.join(TMP_DIR, rec.id);
    const isMaterial = (x) => x === '_shots' || x === '_docs';
    if (rec.kind === 'web' || rec.kind === 'file' || rec.kind === 'service') {
      if (!fs.existsSync(fromRoot)) return fail(res, 200, '原始文件已过期，请让申请人重新上传');
      // 重复审批 / 曾被驳回后临时文件被清：拒绝而不是用空 URL 覆盖线上工具
      if (rec.kind === 'file' && !fs.readdirSync(fromRoot).some((x) => !isMaterial(x) && fs.statSync(path.join(fromRoot, x)).isFile())) {
        return fail(res, 200, '原始文件已过期，请让申请人重新上传');
      }
    }
    /* #3 重名防线（审批侧兜底）：拦住提交校验之后才冒出的同名（如管理员直接在技能中心控制台上传）；
     * 更新提交跳过——名称锁定为原技能名，网关比对会命中自身 */
    if (rec.kind === 'skill' && !rec.updateOf) {
      const conflict = await findSkillNameConflict(rec.name, rec.id);
      if (conflict) return fail(res, 200, '无法通过：' + conflict + '；请驳回本次提交，让上传人换名后重新提交');
    }
    if (rec.status !== approvingStatus || revisionOf(rec) !== revision || !matchesReviewToken(rec, b) || UPLOADS.find(item => item.id === rec.id) !== rec) return fail(res, 409, '项目已变化，请重新核查后审批');
    /* 部署状态机：pending / deploy_failed → deploying（先落盘，中途崩溃可见、重启后可重试）
     * → online；任何一步失败 → deploy_failed + 飞书告警，审核中心一键重试 */
    checkServiceAction();
    rec.status = 'deploying';
    rec.deployError = '';
    saveUploads();
    const opName = authed(ctx)?.name || '';
    let deploySite = null; // { siteKey, version }：产物就位后统一激活（见 saveExtra 之后）
    try {
      /* 站点键取上传记录 id（更新沿用原工具的首次 uploadId）→ URL 全生命周期稳定，且不依赖数组序号 */
      const siteKey = siteKeyOf(updTarget?.uploadId || rec.id);
      const rBase = path.join(UP_DIR, 'releases', siteKey);
      const version = nextVersion(rBase);
      const vDir = path.join(rBase, 'v' + version);
      if (rec.kind === 'web') {
        fs.mkdirSync(vDir, { recursive: true });
        /* 复制（而非移动）网页包本体 → 审批重试安全：tmp 在全部落位成功前保持原样。
         * _shots/_docs 是随审材料，落位 materials/（见下），不能混进发布目录 */
        for (const f of fs.readdirSync(fromRoot)) {
          if (f === '_shots' || f === '_docs') continue;
          fs.cpSync(path.join(fromRoot, f), path.join(vDir, f), { recursive: true });
        }
        url = filesUrl(`/files/uploads/sites/${siteKey}/${rec.report?.entry || 'index.html'}`);
        deploySite = { siteKey, version };
      } else if (rec.kind === 'file') {
        /* 找真正的用户文件：跳过 _shots/_docs 材料目录与一切子目录 */
        const f = fs.readdirSync(fromRoot).find((x) => !isMaterial(x) && fs.statSync(path.join(fromRoot, x)).isFile());
        // 保留原始文件名（含中文），仅去除路径/保留字符；URL 用 encodeURIComponent
        const dest = safeName(rec.filename || f);
        fs.mkdirSync(vDir, { recursive: true });
        fs.copyFileSync(path.join(fromRoot, f), path.join(vDir, dest));
        url = filesUrl(`/files/uploads/sites/${siteKey}/${encodeURIComponent(dest)}`);
        deploySite = { siteKey, version };
      } else if (rec.kind === 'service') {
        /* 产物复制到 releases/<siteKey>/v<N>（build context）→ 构建镜像 → 重建容器（端口沿用、数据卷保留） */
        fs.mkdirSync(vDir, { recursive: true });
        for (const f of fs.readdirSync(fromRoot)) {
          if (f === '_shots' || f === '_docs') continue;
          fs.cpSync(path.join(fromRoot, f), path.join(vDir, f), { recursive: true });
        }
        const svc = await deployService(siteKey, version, vDir, rec);
        url = svc.url;
        deploySite = { siteKey, version, service: true };
      }
      rec.approvedAt = rec.approvedAt || Date.now();
      if (rec.kind !== 'skill') {
        const existing = updTarget || EXTRA_TOOLS.find((t) => t.uploadId === rec.id);
        const entry = {
          id: existing?.id || nextUpId(),
          uploadId: existing?.uploadId || rec.id,
          name: rec.name,
          desc: rec.desc,
          department: rec.d || '—',
          owner: rec.n,
          url,
          type: rec.kind === 'web' ? 'local' : rec.kind === 'file' ? 'download' : rec.kind === 'service' ? 'service' : 'external',
          icon: rec.icon || (rec.name || '工').slice(0, 2),
          iconUrl: rec.iconUrl || '',
          iconBg: rec.iconBg || '',
          tags: Array.isArray(rec.tags) ? rec.tags : [],
          /* 适用部门：更新提交也会随审批覆盖（['全部'] = 全部门适用） */
          departments: Array.isArray(rec.departments) && rec.departments.length ? rec.departments : ['全部'],
          usage: existing?.usage ?? 0,
          likes: existing?.likes ?? 0,
          approvedAt: existing?.approvedAt || rec.approvedAt, // 首次上架精确时间（NEW 标记 / 最新上架排序用），版本更新不覆盖
          onlineAt: existing?.onlineAt || ymd(),
          status: 'online',
        };
        if (rec.updateOf && rec.updateNote) entry.updatedNote = rec.updateNote.slice(0, 120);
        /* 页面截图（≤2）与产品说明书落位：materials/<工具id>/，URL 指向独立源（FILES_BASE）。
         * 逐文件防御：个别材料缺失（异常中断残留）时跳过该张，不让整个审批 500 */
        const matDir = path.join(UP_DIR, 'materials', entry.id);
        {
          fs.rmSync(matDir, { recursive: true, force: true });
          fs.mkdirSync(matDir, { recursive: true });
          const fromShots = path.join(TMP_DIR, rec.id, '_shots');
          entry.shots = Array.isArray(rec.shots) && fs.existsSync(fromShots)
            ? rec.shots
                .filter((f) => fs.existsSync(path.join(fromShots, f)))
                .map((f, i) => {
                  const dest = 'shot-' + (i + 1) + f.slice(f.lastIndexOf('.'));
                  fs.copyFileSync(path.join(fromShots, f), path.join(matDir, dest));
                  return filesUrl(`/files/uploads/materials/${entry.id}/${dest}`);
                })
            : [];
          const fromDoc = rec.doc ? path.join(TMP_DIR, rec.id, '_docs', rec.doc) : '';
          if (fromDoc && fs.existsSync(fromDoc)) {
            fs.copyFileSync(fromDoc, path.join(matDir, rec.doc));
            entry.docUrl = filesUrl(`/files/uploads/materials/${entry.id}/${rec.doc}`);
          } else entry.docUrl = '';
        }
        if (rec.updateOf && rec.updateNote) entry.updatedNote = rec.updateNote.slice(0, 120);
        if (existing) {
          entry.updatedAt = ymd();
          Object.assign(existing, entry);
        } else {
          EXTRA_TOOLS.push(entry);
        }
        saveExtra();
        /* 产物与数据均已就位 → 激活新版本：静态走 sites 符号链接原子切换，服务型走 meta 版本表（容器已在 deployService 重建） */
        if (deploySite) {
          const info = {
            by: opName,
            name: rec.name,
            note: rec.updateOf ? `更新${rec.updateVersion ? '（' + rec.updateVersion + '）' : ''}：${rec.updateNote || ''}` : '首次部署',
          };
          if (deploySite.service) activateServiceRelease(deploySite.siteKey, deploySite.version, info);
          else activateRelease(deploySite.siteKey, deploySite.version, info);
        }
      }
      rec.status = 'online';
      rec.deployedUrl = url;
      saveUploads();
      /* 网页包与材料均已落位，才清理本次上传的临时目录（技能包由网关托管，不走这里） */
      if (rec.kind !== 'skill') fs.rmSync(fromRoot, { recursive: true, force: true });
    } catch (e) {
      rec.status = 'deploy_failed';
      rec.deployError = String(e.message || e).slice(0, 200);
      saveUploads();
      console.error(`[approve] 部署失败 ${rec.id}：${rec.deployError}`);
      alertText('工具部署失败', `**${rec.name || rec.id}** 审批通过但部署失败：${rec.deployError}\n审核中心可重试：${PORTAL_BASE}/#/admin?view=review`);
      return fail(res, rec.kind === 'service' ? 502 : 200, '部署失败：' + rec.deployError + '（已记录，审核中心可重试）');
    }
    // AI 技能：审核通过即自动上架到Skill Center（门户技能列表与 WorkBuddy 同步随之自动生效）
    if (rec.kind === 'skill') {
      try {
        rec.publishSlug = await publishSkillToGateway(rec);
        syncSkillDeptsFromRecord(rec.publishSlug, rec);
        saveUploads();
        const act = rec.updateOf ? `已通过：技能中心已升版本（${rec.publishSlug}），WorkBuddy 下次 load_skill 即用新版` : `已通过并上架技能中心（${rec.publishSlug}），门户技能库与 WorkBuddy 将自动同步`;
        return ok(res, { message: act, url });
      } catch (e) {
        return ok(res, { message: '已通过，但上架技能中心失败：' + e.message + '（可在列表点「上架技能中心」重试）', url });
      }
    }
    /* 部署后探活：静态 3 次×800ms；服务型 10 次×3s（启动慢）。
     * 语义分岔：静态文件 4xx = 坏（告警）；服务型只要应答了 HTTP 就算容器存活——
     * 404 通常是应用没提供首页路由（常见于前端文件没打进镜像），自动探测常见入口路径，
     * 命中则把访问地址指过去；找不到不告警，但提示按打包提示词重新打包。仅 unreachable / 5xx 告警。 */
    let probeNote = '';
    if ((rec.kind === 'web' || rec.kind === 'file' || rec.kind === 'service') && rec.deployedUrl) {
      const svcProbe = rec.kind === 'service';
      const abs = /^https?:\/\//.test(rec.deployedUrl) ? rec.deployedUrl : `http://${req.headers.host || '127.0.0.1:' + PORT}${rec.deployedUrl}`;
      let code = null;
      for (let i = 0; i < (svcProbe ? 10 : 3) && code === null; i++) {
        if (i) await new Promise((r2) => setTimeout(r2, svcProbe ? 3000 : 800));
        try {
          const r2 = await fetch(abs, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'skillharbor' } });
          code = r2.status;
        } catch { code = null; }
      }
      if (svcProbe && code === 404) {
        /* 入口路径自动发现：包内 HTML 文件名优先，再试常见路径；命中 2xx/3xx 即把 URL 指过去 */
        const cands = [...new Set([
          ...(Array.isArray(rec.report?.htmlEntries) ? rec.report.htmlEntries : []),
          'index.html', 'login', 'login.html', 'home', 'app', 'admin', 'ui',
          'api/index.html', 'api', 'api/login', // Spring Boot 等常配 context-path=/api（物资管理系统首例：前端在 /api/index.html）
        ])];
        let entry = '';
        for (const p of cands) {
          try {
            const r3 = await fetch(abs.replace(/\/+$/, '') + '/' + p, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'skillharbor' } });
            if (r3.status >= 200 && r3.status < 400) { entry = '/' + p; break; }
          } catch { /* 试下一个候选 */ }
        }
        if (entry) {
          rec.deployedUrl = abs.replace(/\/+$/, '') + entry;
          rec.healthCheck = { at: Date.now(), status: 404, entry };
          const t0 = updTarget || EXTRA_TOOLS.find((x) => x.uploadId === rec.id);
          if (t0) { t0.url = rec.deployedUrl; saveExtra(); }
          probeNote = `（服务已启动；首页 / 返回 404，已自动定位真实入口 ${entry}）`;
        } else {
          rec.healthCheck = { at: Date.now(), status: 404 };
          probeNote = `（服务已启动，但所有路径均 404——通常是前端页面文件没打进镜像或路由前缀不对，请让上传人按打包提示词重新打包并提交更新）`;
        }
        saveUploads();
      } else {
        rec.healthCheck = { at: Date.now(), status: code === null ? 'unreachable' : code };
        saveUploads();
        if (code === null || code >= 400) {
          probeNote = `（探活未通过：${rec.healthCheck.status}，已告警，请人工检查）`;
          alertText('部署探活未通过', `**${rec.name}** 已上线但入口探活未通过（${rec.healthCheck.status}）：\n${abs}`);
        }
      }
    }
    return ok(res, { message: (rec.updateOf ? '已通过：已替换部署原工具，历史统计与评价保留' : '已通过并自动部署上线') + probeNote, url });
    } finally { PREPARING_UPLOADS.delete(rec.id); }
  }

  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/publish$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '记录不存在');
    if (rec.kind !== 'skill') return fail(res, 200, '仅 AI 技能类型需要上架');
    /* #3 重新上架 / 失败重试前校验重名（excludeSlug 排除自身在技能中心的旧位；下线期间名字可能已被新技能占用） */
    const conflict = await findSkillNameConflict(rec.name, rec.id, rec.publishSlug);
    if (conflict) return fail(res, 200, '无法上架：' + conflict + '；请让上传人换名后重新提交');
    try {
      rec.publishSlug = await publishSkillToGateway(rec);
      syncSkillDeptsFromRecord(rec.publishSlug, rec);
      saveUploads();
      return ok(res, { message: `已上架技能中心（${rec.publishSlug}）`, slug: rec.publishSlug });
    } catch (e) {
      return fail(res, 200, e.message);
    }
  }

  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/reject$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '记录不存在');
    let b;
    try { b = await readJson(req); } catch { return fail(res, 400, '驳回请求格式错误'); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(res, 400, '驳回请求格式错误');
    if (!matchesReviewToken(rec, b)) return fail(res, 409, '核查内容已变化，请重新核查后驳回');
    if (Object.hasOwn(b, 'revision') && !Number.isInteger(b.revision)) return fail(res, 400, '核查版本必须为整数');
    if (Object.hasOwn(b, 'revision') && b.revision !== revisionOf(rec)) return fail(res, 409, '项目已变化，请重新核查后驳回');
    if (PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '项目正在处理，请稍后刷新');
    if (!['pending', 'deploy_failed'].includes(rec.status)) return fail(res, 409, '只有待审核或部署失败记录可以驳回');
    rec.status = 'rejected';
    rec.rejectReason = String(b.reason || '其他').slice(0, 120);
    rec.rejectedAt = Date.now();
    // A rejected submission remains editable; its package and attachments are
    // needed for exact draft restoration and a later resubmission.
    saveUploads();
    return ok(res, { message: '已驳回并通知申请人' });
  }

  /* 免选类型 · 管理员改判：待审记录在 网页/服务型/AI技能 间改判（更新提交类型已锁定，不可改） */
  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/rekind$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '记录不存在');
    if (rec.status !== 'pending' && rec.status !== 'deploy_failed') return fail(res, 200, '仅待审核记录可改判');
    if (rec.updateOf) return fail(res, 200, '更新提交的类型已锁定为原工具通道，不可改判');
    const b = await readJson(req);
    if (PREPARING_UPLOADS.has(rec.id)) return fail(res, 409, '项目正在处理，请稍后刷新');
    if (!['pending', 'deploy_failed'].includes(rec.status)) return fail(res, 409, '当前状态不可改判，请刷新列表查看');
    const revision = revisionOf(rec), status = rec.status;
    const to = String(b.kind || '');
    if (!['web', 'service', 'skill'].includes(to)) return fail(res, 200, '仅支持在 网页工具 / 服务型工具 / AI 技能 之间改判');
    if (rec.kind === to) return ok(res, { message: '类型未变化' });
    PREPARING_UPLOADS.add(rec.id);
    try {
    /* #3 改判为 AI 技能时校验重名（壳技能文件夹同名互相覆盖） */
    if (to === 'skill') {
      const conflict = await findSkillNameConflict(rec.name, rec.id);
      if (conflict) return fail(res, 200, '无法改判：' + conflict + '；请驳回后让上传人换名重新提交');
    }
    if (rec.status !== status || revisionOf(rec) !== revision || UPLOADS.find(item => item.id === rec.id) !== rec) return fail(res, 409, '项目已变化，请刷新列表查看');
    const from = rec.kind;
    rec.kind = to;
    rec.packageRevision = revision + 1;
    rec.rekindNote = `${KIND_LABEL_ZH[from] || from} → ${KIND_LABEL_ZH[to] || to}（${authed(ctx)?.name || '管理员'} ${ymd()}）`;
    saveUploads();
    let warn = '';
    if (to === 'web' && !rec.report?.entry) warn = '；注意：解析未识别到入口 HTML，按网页部署可能失败';
    if (to === 'service' && !rec.report?.containerPort) warn = '；注意：原解析按网页通道进行，服务部署可能失败，建议让上传人按打包提示词重新提交';
    return ok(res, { message: `已改判：${rec.rekindNote}${warn}` });
    } finally { PREPARING_UPLOADS.delete(rec.id); }
  }

  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/offline$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '记录不存在');
    let t = EXTRA_TOOLS.find((x) => x.uploadId === rec.id);
    if (!t && rec.updateOf && rec.updateOf.startsWith('tool:')) t = EXTRA_TOOLS.find((x) => x.id === rec.updateOf.slice(5));
    /* 服务型工具：业务数据快照进卷后停并移除容器（镜像与数据卷保留，重新上架从卷恢复数据） */
    let svcNote = '';
    if (t?.type === 'service' && t.uploadId) {
      await svcRemoveWithSnapshot(siteKeyOf(t.uploadId));
      svcNote = '；服务容器已停止，重新上架即恢复运行（业务数据已在卷中留底）';
    }
    checkServiceAction();
    rec.status = 'offline';
    if (t) {
      t.status = 'offline';
      saveExtra();
    }
    const original = UPLOADS.find(x => x.id === t?.uploadId);
    if (original) original.status = 'offline';
    saveUploads();
    return ok(res, { message: '已下线（卡片隐藏，文件保留）' + svcNote });
  }

  /* P3 一键回滚：切回当前版本的上一个保留版本，URL 不变（符号链接切换，用户无感） */
  if ((m = /^\/api\/admin\/uploads\/([a-z0-9]+)\/rollback$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rec = UPLOADS.find((x) => x.id === m[1]);
    if (!rec) return fail(res, 200, '记录不存在');
    /* 工具挂首次部署的 uploadId 名下：传更新记录 id 时沿 updateOf 解析到卡位 */
    let t = EXTRA_TOOLS.find((x) => x.uploadId === rec.id);
    if (!t && rec.updateOf && rec.updateOf.startsWith('tool:')) t = EXTRA_TOOLS.find((x) => x.id === rec.updateOf.slice(5));
    if (!t || t.status !== 'online') return fail(res, 200, '工具不存在或未在线');
    const base = path.join(UP_DIR, 'releases', siteKeyOf(t.uploadId));
    const meta = readReleaseMeta(base);
    const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^v\d+$/.test(d)).map((d) => +d.slice(1)) : [];
    const cur = meta.current ? +meta.current.slice(1) : Math.max(0, ...dirs);
    const prev = dirs.filter((v) => v < cur).sort((a, b) => b - a)[0];
    if (!prev) return fail(res, 200, '没有可回滚的历史版本（旧版目录部署，或更早版本已按保留策略清理）');
    if (t.type === 'service') {
      /* 服务型工具回滚：用保留的历史镜像重建容器（端口不变，数据卷保留） */
      const siteKey = siteKeyOf(t.uploadId);
      const svc = SERVICES[siteKey];
      if (!svc) return fail(res, 200, '服务端口登记缺失，无法回滚（请重新部署该工具）');
      try {
        await runServiceContainer(siteKey, svcImage(siteKey, prev), svc.port, svc.containerPort, svc.dockerRoot);
      } catch (e) {
        return fail(res, 502, '回滚失败（运行状态待确认，镜像与恢复数据保留）：' + e.message);
      }
      activateServiceRelease(siteKey, prev, { by: authed(ctx)?.name || '', name: t.name, type: 'rollback' });
      SERVICES[siteKey] = { ...svc, image: svcImage(siteKey, prev), at: Date.now() };
      saveServices();
    } else {
      activateRelease(siteKeyOf(t.uploadId), prev, { by: authed(ctx)?.name || '', name: t.name, type: 'rollback' });
    }
    t.updatedAt = ymd();
    t.updatedNote = `已回滚到 v${prev}（${ymd()}）`;
    saveExtra();
    return ok(res, { message: `已回滚到 v${prev}：URL 不变，用户无感；再次回滚可退到更早版本` });
  }

  /* P3 部署历史：?tool=u<uploadId> 过滤单工具，默认全量倒序 */
  if (urlPath === '/api/admin/deployments' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const tool = url.searchParams.get('tool') || '';
    let rows = DEPLOYS.slice().reverse();
    if (tool) rows = rows.filter((x) => x.tool === tool);
    return ok(res, { rows: rows.slice(0, 100) });
  }

  /* P4 服务运维看板：登记表（services.json）× 容器实时状态（docker ps/stats/system df，经 docker.sock；
   * SERVICE_DOCKER=mock 或 docker 不可用时降级为仅登记表） */
  if (urlPath === '/api/admin/services' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const rows = Object.entries(SERVICES).map(([siteKey, svc]) => {
      const tool = EXTRA_TOOLS.find((t) => t.uploadId && siteKeyOf(t.uploadId) === siteKey);
      const r0 = UPLOADS.find((x) => 'u' + x.id === siteKey);
      return {
        siteKey,
        toolId: tool?.id || '',
        name: tool?.name || r0?.name || siteKey,
        status: tool?.status || 'missing',
        port: svc.port,
        containerPort: svc.containerPort,
        image: svc.image,
        url: tool?.url || '',
        health: r0?.healthCheck || null,
        registeredAt: svc.at,
      };
    }).sort((a, b) => a.port - b.port);
    let live = { ok: false, containers: [], stats: {}, df: [], message: 'mock 模式：跳过实时状态' };
    if (process.env.SERVICE_DOCKER !== 'mock') {
      try {
        const ps = await docker(['ps', '-a', '--filter', 'name=skillharbor-svc-', '--format', '{{.Names}}\t{{.Status}}']);
        const containers = String(ps.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
          const [name, status] = l.split('\t');
          return { name: name || '', status: status || '', running: /^Up /i.test(status || '') };
        });
        const stats = {};
        const running = containers.filter((c) => c.running).map((c) => c.name);
        if (running.length) {
          const st = await docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', ...running], { timeout: 60000 });
          for (const l of String(st.stdout || '').trim().split('\n').filter(Boolean)) {
            const [name, cpu, mem] = l.split('\t');
            stats[name] = { cpu: (cpu || '').trim(), mem: (mem || '').trim() };
          }
        }
        let df = [];
        try {
          const d = await docker(['system', 'df', '--format', '{{json .}}'], { timeout: 60000 });
          df = String(d.stdout || '').trim().split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch { /* df 失败不影响列表 */ }
        live = { ok: true, containers, stats, df, message: '' };
      } catch (e) {
        live = { ok: false, containers: [], stats: {}, df: [], message: e.message };
      }
    }
    return ok(res, { rows, live, mock: process.env.SERVICE_DOCKER === 'mock', portBegin: SVC_PORT_BEGIN, portEnd: SVC_PORT_END });
  }

  /* ===== 技能 × 部门：复用「部门-员工-IP」基础数据推导 =====
   * 优先：技能的上传人（owner，技能中心首次上传时记录）→ 门户员工表 → 部门；
   * 回落：调用日志的 ip_name（由门户登录记录同步的 IP→姓名表）→ 部门，取调用量最高者。
   * 前端据此展示部门筛选行。 */
  if (urlPath === '/api/skills/dept-usage' && GET) {
    if (skillDeptCache && Date.now() - skillDeptCache.at < 5 * 60 * 1000) {
      return ok(res, { ...skillDeptCache.data, applicable: SKILL_DEPTS });
    }
    const base = process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800';
    const gwToken = process.env.SKILL_GATEWAY_TOKEN || '';
    try {
      const headers = { 'User-Agent': 'skillharbor' };
      if (gwToken) headers.Authorization = 'Bearer ' + gwToken;
      const name2dept = new Map(USERS.map((u) => [u.name, u.deptShort || u.dept || '']));
      const map = {};

      // 1) 上传人优先
      const skillsRes = await fetch(`${base}/api/skills`, { headers });
      if (skillsRes.ok) {
        const list = await skillsRes.json();
        for (const s of list || []) {
          const dept = name2dept.get(String(s.owner || '').trim());
          if (dept && s.slug) map[s.slug] = dept;
        }
      }

      // 2) 无上传人的技能回落：调用日志聚合
      const logsRes = await fetch(`${base}/api/logs?action=load_skill&size=2000`, { headers });
      if (logsRes.ok) {
        const d = await logsRes.json();
        const agg = new Map(); // slug -> dept -> count
        for (const it of d.items || []) {
          const dept = name2dept.get(it.ip_name || it.token_name || '');
          if (!dept || !it.skill_slug || map[it.skill_slug]) continue; // 已有归属的跳过
          if (!agg.has(it.skill_slug)) agg.set(it.skill_slug, new Map());
          const m = agg.get(it.skill_slug);
          m.set(dept, (m.get(dept) || 0) + 1);
        }
        for (const [slug, m] of agg) {
          const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
          if (top) map[slug] = top[0];
        }
      }

      const depts = [...new Set(Object.values(map))].sort();
      const data = { map, depts, applicable: SKILL_DEPTS };
      skillDeptCache = { at: Date.now(), data };
      return ok(res, data);
    } catch (e) {
      return ok(res, { map: {}, depts: [], applicable: {}, message: '技能中心不可达：' + e.message });
    }
  }

  /* ---------- 技能「适用部门」管理（admin）：技能中心数据源无此字段，门户本地持久化 ----------
   * 读全量（技能详情回显）+ 保存单个技能（['全部'] = 全部门适用；空数组 = 清除配置，回落归属部门） */
  if (urlPath === '/api/admin/skill-departments' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    return ok(res, { map: SKILL_DEPTS });
  }
  if (urlPath === '/api/admin/skill-departments' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const slug = String(b.slug || '').trim();
    if (!slug) return fail(res, 400, '缺少 slug');
    /* 校验同工具「适用部门」口径：只收名册短名与「全部」，最多 16 项 */
    const valid = new Set(USERS.map((x) => String(x.deptShort || x.dept || '').trim()).filter(Boolean));
    const arr = Array.isArray(b.departments)
      ? [...new Set(b.departments.map((d) => String(d || '').trim()).filter((d) => d === '全部' || valid.has(d)))]
      : [];
    if (arr.length) SKILL_DEPTS[slug] = arr.slice(0, 16);
    else delete SKILL_DEPTS[slug];
    saveSkillDepts();
    return ok(res, { slug, departments: SKILL_DEPTS[slug] || [] });
  }

  /* ---------- 工具管理：全量名册（内置 + 员工上传）/ 编辑 / 上下架 / 删除 ---------- */
  if (urlPath === '/api/admin/tools' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    return ok(res, {
      /* 软删除的工具（deleted 标记）不出现在管理名册；记录仍在 extraTools.json，可手工恢复 */
      extra: EXTRA_TOOLS.filter((t) => !t.deleted),
      builtinOffline: Object.keys(TOOL_STATUS).filter((k) => TOOL_STATUS[k] === 'offline'),
      builtinDeleted: Object.keys(TOOL_STATUS).filter((k) => TOOL_STATUS[k] === 'deleted'),
      builtinOverrides: TOOL_OVERRIDES,
      usageReset: USAGE_RESET,
    });
  }

  /* 手动添加工具（管理员）：S3 拦截外置数据库包后的正当出路——管理员取得部署包在服务器上自行部署，
   * 在此登记工具卡片（无 uploadId → 不参与平台部署/回滚/版本生命周期，上下架只切卡片状态） */
  if (urlPath === '/api/admin/tools/manual' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 30);
    const url = String(b.url || '').trim().slice(0, 300);
    const type = ['service', 'external', 'local', 'download'].includes(b.type) ? b.type : 'service';
    const desc = String(b.desc || '').trim().slice(0, 120);
    if (!name || !url) return fail(res, 200, '名称和访问地址必填');
    if (!/^https?:\/\/\S+$|^\/files\/\S+/.test(url)) return fail(res, 200, '访问地址需以 http(s):// 开头（内网地址如 http://10.0.0.x:端口）');
    if (EXTRA_TOOLS.some((t) => t.name === name)) return fail(res, 200, `已存在同名工具「${name}」，请换名或用「编辑」修改原工具`);
    const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map((t) => String(t || '').trim().slice(0, 8)).filter(Boolean))].slice(0, 4);
    const departments = Array.isArray(b.departments) && b.departments.length
      ? [...new Set(b.departments.map((d) => String(d || '').trim().slice(0, 20)).filter(Boolean))].slice(0, 16)
      : ['全部'];
    const id = nextUpId();
    const admin = authed(ctx);
    EXTRA_TOOLS.push({
      id, name, desc,
      department: admin?.dept || '—',
      owner: admin?.name || '管理员',
      url, type,
      icon: String(b.icon || '').trim().slice(0, 2) || name.slice(0, 2),
      iconUrl: '', iconBg: '',
      tags, departments,
      usage: 0, likes: 0,
      approvedAt: Date.now(), onlineAt: ymd(),
      status: 'online',
      manual: true, // 手动登记标记：管理端徽标 + 编辑可改 URL + 不触发容器生命周期
    });
    saveExtra();
    return ok(res, { message: `已添加「${name}」（手动登记，即时上线）`, id });
  }

  if ((m = /^\/api\/admin\/tools\/([\w-]+)\/edit$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const id = m[1];
    const b = await readJson(req);
    const patch = {};
    for (const k of ['name', 'desc', 'url', 'icon', 'iconUrl', 'iconBg']) {
      if (b[k] !== undefined) patch[k] = String(b[k]).slice(0, k === 'desc' ? 120 : k === 'name' ? 30 : 300);
    }
    if (Array.isArray(b.tags)) patch.tags = [...new Set(b.tags.map((t) => String(t || '').trim().slice(0, 8)).filter(Boolean))].slice(0, 4);
    /* 适用部门（多选短名，['全部'] = 全部门适用）：管理端补配 / 修正，内置工具走覆盖 */
    if (Array.isArray(b.departments)) {
      const arr = [...new Set(b.departments.map((d) => String(d || '').trim().slice(0, 20)).filter(Boolean))].slice(0, 16);
      patch.departments = arr.length ? arr : ['全部'];
    }
    const t = EXTRA_TOOLS.find((x) => x.id === id);
    if (t) {
      Object.assign(t, patch);
      saveExtra();
    } else {
      if (!TOOL_NAMES[id]) return fail(res, 200, '工具不存在');
      TOOL_OVERRIDES[id] = { ...TOOL_OVERRIDES[id], ...patch };
      saveToolOverrides();
    }
    return ok(res, { message: '已保存' });
  }

  if ((m = /^\/api\/admin\/tools\/([\w-]+)\/status$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const id = m[1];
    const b = await readJson(req);
    if (!['online', 'offline'].includes(b?.status)) return fail(res, 400, '状态仅支持 online/offline');
    checkServiceAction();
    const status = b.status;
    const t = EXTRA_TOOLS.find((x) => x.id === id);
    if (t) {
      if (t.deleted) return fail(res, 409, '已删除工具不可上架');
      if (t.status === status) return ok(res, { message: '状态未变化' });
      /* 服务型工具：上架用登记的当前镜像重启容器；下架停容器（镜像/数据卷保留）。
       * 手动登记（无 uploadId）的服务型工具没有平台容器生命周期，只切卡片状态 */
      if (t.type === 'service' && t.uploadId) {
        const siteKey = siteKeyOf(t.uploadId);
        const svc = SERVICES[siteKey];
        const meta = readReleaseMeta(path.join(UP_DIR, 'releases', siteKey));
        const tag = svc?.image || (meta.current ? svcImage(siteKey, +meta.current.slice(1)) : '');
        if (status === 'online') {
          try {
            if (!svc || !tag) throw new Error('缺少端口/镜像登记');
            await runServiceContainer(siteKey, tag, svc.port, svc.containerPort, svc.dockerRoot);
          } catch (e) {
            return fail(res, 502, '上架失败（运行状态待确认，卡片保持下线）：' + e.message + '；镜像与恢复数据保留，可重试');
          }
        } else {
          /* 下架：业务数据快照进卷后再移除容器，重新上架时 runServiceContainer 从卷恢复 */
          await svcRemoveWithSnapshot(siteKey);
        }
      }
      checkServiceAction();
      t.status = status;
      delete t.serviceError;
      saveExtra();
      const rec0 = UPLOADS.find((x) => x.id === t.uploadId);
      if (rec0) {
        rec0.status = status;
        saveUploads();
      }
    } else {
      if (!TOOL_NAMES[id]) return fail(res, 200, '工具不存在');
      if (TOOL_STATUS[id] === 'deleted') return fail(res, 409, '已删除工具不可上架');
      if (status === 'offline') TOOL_STATUS[id] = 'offline';
      else delete TOOL_STATUS[id];
      saveToolStatus();
    }
    return ok(res, { message: status === 'offline' ? '已下架：首页即时隐藏，统计与评价保留，可随时重新上架' : '已上架：首页即时可见' });
  }

  /* 删除工具（软删除）：卡片在首页 / 详情 / 管理名册即时消失，但记录不物理清除——
   * 上传与手动登记工具在 extraTools.json 打 deleted 标记（状态一并置 offline，服务型容器按下架口径先快照再移除）；
   * 内置工具在 tool-status.json 标记 deleted。统计看板原始记录与评价保留，需要恢复时手工清除标记即可。 */
  if ((m = /^\/api\/admin\/tools\/([\w-]+)\/delete$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const id = m[1];
    const t = EXTRA_TOOLS.find((x) => x.id === id);
    if (t) {
      if (t.deleted) return fail(res, 200, '该工具已被删除');
      /* 服务型工具：与下架同口径，业务数据快照进卷后移除容器（镜像/数据卷保留，恢复后可重启） */
      if (t.type === 'service' && t.uploadId) {
        await svcRemoveWithSnapshot(siteKeyOf(t.uploadId));
      }
      checkServiceAction();
      t.deleted = true;
      t.deletedAt = ymd();
      t.status = 'offline';
      saveExtra();
      const rec0 = UPLOADS.find((x) => x.id === t.uploadId);
      if (rec0) {
        rec0.status = 'offline';
        saveUploads();
      }
      return ok(res, { message: `已删除「${t.name}」：各页面即时隐藏；软删除，记录与统计评价保留，可恢复` });
    }
    if (!TOOL_NAMES[id]) return fail(res, 200, '工具不存在');
    TOOL_STATUS[id] = 'deleted';
    saveToolStatus();
    return ok(res, { message: `已删除「${TOOL_NAMES[id].name}」：各页面即时隐藏；软删除，记录与统计评价保留，可恢复` });
  }

  /* 使用次数清零（单个）：上传工具直接置 0；内置工具静态名册不可变 → 写 usage 覆盖；
   * 记录清零时间点，各浏览器据此作废该工具的本地点击增量。统计看板原始点击记录（stats.json）不受影响。 */
  if ((m = /^\/api\/admin\/tools\/([\w-]+)\/reset-usage$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const id = m[1];
    const t = EXTRA_TOOLS.find((x) => x.id === id);
    if (t) {
      t.usage = 0;
      saveExtra();
    } else {
      if (!TOOL_NAMES[id]) return fail(res, 200, '工具不存在');
      TOOL_OVERRIDES[id] = { ...TOOL_OVERRIDES[id], usage: 0 };
      saveToolOverrides();
    }
    USAGE_RESET[id] = Date.now();
    saveUsageReset();
    return ok(res, { message: `已清零「${(t || toolName(id)).name}」的累计使用显示` });
  }

  /* 使用次数清零（批量）：清零全部已上线工具 */
  if (urlPath === '/api/admin/tools/reset-usage' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const now = Date.now();
    let uploadsN = 0;
    for (const t of EXTRA_TOOLS) {
      if (t.status === 'offline') continue;
      t.usage = 0;
      USAGE_RESET[t.id] = now;
      uploadsN++;
    }
    let builtinsN = 0;
    for (const id of Object.keys(TOOL_NAMES)) {
      if (TOOL_STATUS[id]) continue; // 下架 / 已删除的内置工具不在清零范围
      TOOL_OVERRIDES[id] = { ...TOOL_OVERRIDES[id], usage: 0 };
      USAGE_RESET[id] = now;
      builtinsN++;
    }
    saveExtra();
    saveToolOverrides();
    saveUsageReset();
    return ok(res, { message: `已批量清零 ${builtinsN + uploadsN} 个已上线工具的累计使用显示`, count: builtinsN + uploadsN });
  }

  if (urlPath === '/api/tools/extra' && GET) {
    /* 近 7 天有效点击热度（stats.json 计入条目），首页「最近热门」排序用 */
    const cutoff7 = Date.now() - 7 * DAY_MS;
    const hot7d = {};
    for (const r of STATS.raw) {
      if (r.t < cutoff7 || !r.c) continue;
      hot7d[r.tool] = (hot7d[r.tool] || 0) + 1;
    }
    /* 全工具星级评价汇总（首页「评价最好」排序）：target=tool:<id>，已剔除评价不计 */
    const ratings = {};
    for (const e of EVALS) {
      if (e.flag === 'excluded') continue;
      const hit = /^tool:(.+)$/.exec(e.target);
      if (!hit) continue;
      const r = ratings[hit[1]] || (ratings[hit[1]] = { sum: 0, count: 0 });
      r.sum += Math.min(5, Math.max(1, e.s || (e.v === 1 ? 5 : 1)));
      r.count++;
    }
    for (const k of Object.keys(ratings)) {
      ratings[k] = { avg: Math.round((ratings[k].sum / ratings[k].count) * 10) / 10, count: ratings[k].count };
    }
    return ok(res, {
      tools: EXTRA_TOOLS.filter((t) => t.status === 'online'),
      /* 已删除（deleted）的内置工具对首页 / 详情与下架同待遇：一并隐藏 */
      builtinOffline: Object.keys(TOOL_STATUS).filter((k) => TOOL_STATUS[k] === 'offline' || TOOL_STATUS[k] === 'deleted'),
      builtinOverrides: TOOL_OVERRIDES,
      usageReset: USAGE_RESET,
      filesBase: FILES_BASE,
      hot7d,
      ratings,
    });
  }

  /* ---------- 工作台申请（开通 / 扩容 One-API 令牌）：员工提交 → 管理员待办处理 ---------- */
  if (urlPath === '/api/requests' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const b = await readJson(req);
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    const rec = {
      id: 'qr' + Date.now(),
      type: b.type === 'expand' ? 'expand' : 'open',
      username: u.username,
      name: u.name,
      dept: u.deptShort || u.dept || '',
      from: Number(b.from) || 0,
      to: Number(b.to) || 0,
      reason: String(b.reason || '').slice(0, 200),
      status: 'pending',
      createdAt: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      t: Date.now(),
    };
    REQUESTS.unshift(rec);
    if (REQUESTS.length > 2000) REQUESTS = REQUESTS.slice(0, 2000);
    saveRequests();
    return ok(res, { req: rec });
  }

  if (urlPath === '/api/requests/mine' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    return ok(res, { rows: REQUESTS.filter((r) => r.username === u.username).sort((a, b) => b.t - a.t) });
  }

  if (urlPath === '/api/admin/requests' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    return ok(res, { rows: REQUESTS.slice().sort((a, b) => b.t - a.t) });
  }

  if ((m = /^\/api\/admin\/requests\/([\w-]+)\/decide$/.exec(urlPath)) && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const r = REQUESTS.find((x) => x.id === m[1]);
    if (!r) return fail(res, 200, '申请不存在');
    if (r.status !== 'pending') return fail(res, 200, '该申请已处理');
    const b = await readJson(req);
    r.status = b.ok === false ? 'rejected' : 'approved';
    r.processedAt = Date.now();
    saveRequests();
    return ok(res, { message: r.status === 'approved' ? '已标记通过' : '已驳回' });
  }

  /* ---------- 系统设置：飞书告警 webhook（管理后台配置，落数据卷持久化，源码不内置地址） ---------- */
  if (urlPath === '/api/admin/alert-webhook' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    return ok(res, { url: ALERT_CFG.url });
  }

  if (urlPath === '/api/admin/alert-webhook' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const url = String(b.url || '').trim().slice(0, 300);
    if (url && !/^https:\/\//.test(url)) return fail(res, 200, '地址必须以 https:// 开头');
    ALERT_CFG.url = url;
    saveAlertCfg();
    return ok(res, { message: url ? '已保存，告警将推送到新地址' : '已清空，告警推送暂停' });
  }

  if (urlPath === '/api/admin/alert-webhook/test' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    if (!ALERT_CFG.url) return fail(res, 200, '尚未配置 webhook，请先保存地址');
    const sent = await pushFeishuCard(
      {
        config: { wide_markdown_mode: true },
        header: { template: 'green', title: { tag: 'plain_text', content: 'SkillHarbor · 告警通道测试' } },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: 'webhook 配置生效，这是一条测试卡片。' } },
          { tag: 'note', elements: [{ tag: 'plain_text', content: '由管理后台「系统设置」发起 · 本消息由 SkillHarbor 门户自动发送' }] },
        ],
      },
      '测试卡片',
    );
    return ok(res, { message: sent ? '测试卡片已推送，请在飞书群确认' : '推送失败，请核对 webhook 地址是否有效' });
  }

  /* ---------- 使用统计 ---------- */
  if (urlPath === '/api/stats/click' && POST) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, 'not logged in');
    const b = await readJson(req);
    const toolId = String(b.toolId || '');
    if (!toolId) return fail(res, 200, 'missing toolId');
    return ok(res, recordClick(u, toolId, req));
  }

  if (urlPath === '/api/stats/mine' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const month = url.searchParams.get('month') || ymd().slice(0, 7);
    const rows = STATS.raw.filter((r) => r.u === u.username && r.day.startsWith(month));
    const byTool = new Map();
    for (const r of rows) {
      if (!byTool.has(r.tool)) byTool.set(r.tool, { toolId: r.tool, counted: 0, overflow: 0, days: {} });
      const g = byTool.get(r.tool);
      if (r.c) g.counted++;
      else g.overflow++;
      g.days[r.day] = (g.days[r.day] || 0) + (r.c ? 1 : 0);
    }
    /* 最近使用（个人工作台卡片）：不按月过滤，取该用户最新 8 条点击（10 秒内连击已在上报时合并） */
    const recent = STATS.raw
      .filter((r) => r.u === u.username)
      .slice(-8)
      .reverse()
      .map((r) => ({ t: r.t, toolId: r.tool, name: toolName(r.tool).name }));
    return ok(res, { month, rows: [...byTool.values()].map((g) => ({ ...g, name: toolName(g.toolId).name })), limit: STATS_CFG.dailyLimit, recent });
  }

  /* 我名下工具的使用统计（工作台「我的工具」tab 看板）：内置名册（未下架）+ 已上线上传工具，按 owner 姓名；
     使用数据来自点击记录（10 秒连击已合并，c=1 为计入统计的有效点击） */
  if (urlPath === '/api/stats/my-tools' && GET) {
    const u = authed(ctx);
    if (!u) return fail(res, 401, '请先登录');
    const seen = new Set();
    const mine = [];
    const pushTool = (t) => {
      if (!t || seen.has(t.id)) return;
      seen.add(t.id);
      mine.push({ id: t.id, name: t.name, icon: t.icon || String(t.name || '工').slice(0, 2), type: t.type || 'external', onlineAt: t.onlineAt || '' });
    };
    for (const t of Object.values(TOOL_NAMES)) {
      if (t.owner === u.name && !TOOL_STATUS[t.id]) pushTool(t); // 下架 / 已删除不计
    }
    for (const t of EXTRA_TOOLS) {
      if (t.owner === u.name && t.status === 'online') pushTool(t);
    }
    const ids = new Set(mine.map((t) => t.id));
    const now = Date.now();
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    const start14 = d0.getTime() - 13 * DAY_MS;
    const byTool = new Map();
    mine.forEach((t) => byTool.set(t.id, { total: 0, last7: 0, prev7: 0, users: new Set(), lastAt: 0, dayMap: {} }));
    for (const r of STATS.raw) {
      if (!ids.has(r.tool)) continue;
      const g = byTool.get(r.tool);
      if (r.t > g.lastAt) g.lastAt = r.t;
      g.users.add(r.u);
      if (!r.c) continue;
      g.total++;
      g.dayMap[r.day] = (g.dayMap[r.day] || 0) + 1;
      const age = now - r.t;
      if (age < 7 * DAY_MS) g.last7++;
      else if (age < 14 * DAY_MS) g.prev7++;
    }
    const days14 = (g) => Array.from({ length: 14 }, (_, i) => g.dayMap[ymdOf(start14 + i * DAY_MS)] || 0);
    const tools = mine
      .map((t) => {
        const g = byTool.get(t.id);
        return { ...t, total: g.total, last7: g.last7, prev7: g.prev7, users: g.users.size, lastAt: g.lastAt, days: days14(g) };
      })
      .sort((a, b) => b.total - a.total);
    const allUsers = new Set();
    byTool.forEach((g) => g.users.forEach((x) => allUsers.add(x)));
    return ok(res, {
      tools,
      summary: {
        count: tools.length,
        total: tools.reduce((s, t) => s + t.total, 0),
        last7: tools.reduce((s, t) => s + t.last7, 0),
        prev7: tools.reduce((s, t) => s + t.prev7, 0),
        users: allUsers.size,
        days: Array.from({ length: 14 }, (_, i) => tools.reduce((s, t) => s + t.days[i], 0)),
      },
    });
  }

  if (urlPath === '/api/admin/stats' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const month = url.searchParams.get('month') || ymd().slice(0, 7);
    const rows = STATS.raw.filter((r) => r.day.startsWith(month));
    const days = new Set(rows.map((r) => r.day));
    const tools = new Map();
    for (const r of rows) {
      if (!tools.has(r.tool)) tools.set(r.tool, { id: r.tool, name: toolName(r.tool).name, owner: toolName(r.tool).owner, department: toolName(r.tool).department, days: {}, total: 0, users: new Set() });
      const g = tools.get(r.tool);
      if (r.c) {
        g.days[r.day] = (g.days[r.day] || 0) + 1;
        g.total++;
      }
      g.users.add(r.u);
    }
    // 负责人汇总（上传工具归提交人）
    const owners = new Map();
    for (const t of tools.values()) {
      const k = t.owner + '|' + t.department;
      if (!owners.has(k)) owners.set(k, { owner: t.owner, department: t.department, total: 0, tools: 0, users: new Set() });
      const o = owners.get(k);
      o.total += t.total;
      o.tools++;
      for (const u of t.users) o.users.add(u);
    }
    // 异常：同日同 IP ≥5 个账号
    const ipDay = new Map();
    for (const r of rows) {
      const k = r.day + '|' + r.ip;
      if (!ipDay.has(k)) ipDay.set(k, new Map());
      ipDay.get(k).set(r.u, r.n);
    }
    const anomalies = [...ipDay.entries()]
      .filter(([, us]) => us.size >= 5)
      .map(([k, us]) => {
        const [day, ip] = k.split('|');
        return { day, ip, users: [...us.entries()].map(([u, n]) => ({ u, n })) };
      });
    // 近 30 日有效使用趋势（跨自然月，供统计看板柱状图）
    const since = ymdOf(Date.now() - 29 * DAY_MS);
    const byDay = new Map();
    for (const r of STATS.raw) {
      if (r.day >= since && r.c) byDay.set(r.day, (byDay.get(r.day) || 0) + 1);
    }
    const trend30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = ymdOf(Date.now() - i * DAY_MS);
      trend30.push({ day: d, count: byDay.get(d) || 0 });
    }
    return ok(res, {
      month,
      config: STATS_CFG,
      days: [...days].sort(),
      tools: [...tools.values()].map((t) => ({ ...t, users: t.users.size })).sort((a, b) => b.total - a.total),
      owners: [...owners.values()].map((o) => ({ ...o, users: o.users.size })).sort((a, b) => b.total - a.total),
      totalClicks: rows.filter((r) => r.c).length,
      activeUsers: new Set(rows.map((r) => r.u)).size,
      anomalies,
      trend30,
    });
  }

  /* 技能调用漏斗（全技能 × 动作聚合）：网关日志无全量聚合接口，服务端分页拉取累计（上限 1 万条） */
  if (urlPath === '/api/admin/gw-funnel' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const base = GW_BASE();
    const counts = new Map();
    let total = 0;
    let fetched = 0;
    let page = 1;
    try {
      do {
        const d = await (await fetch(`${base}/api/logs?page=${page}&size=500`, { headers: gwHeaders() })).json();
        total = d.total || 0;
        for (const it of d.items || []) counts.set(it.action, (counts.get(it.action) || 0) + 1);
        fetched += (d.items || []).length;
        page++;
      } while (fetched < total && page <= 20);
    } catch (e) {
      return fail(res, 502, '技能中心不可达：' + e.message);
    }
    const order = ['load_skill', 'read_reference', 'read_asset', 'report_output'];
    const actions = order.map((a) => ({ action: a, count: counts.get(a) || 0 }));
    for (const [a, c] of counts) if (!order.includes(a)) actions.push({ action: a, count: c });
    return ok(res, { actions, sampled: fetched, total });
  }

  if (urlPath === '/api/admin/stats/detail' && GET) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const toolId = url.searchParams.get('toolId') || '';
    const day = url.searchParams.get('day') || '';
    const rows = STATS.raw.filter((r) => r.tool === toolId && r.day === day).sort((a, b) => a.t - b.t)
      .map((r) => ({ t: r.t, u: r.u, n: r.n, ip: r.ip, counted: !!r.c }));
    return ok(res, { rows });
  }

  if (urlPath === '/api/admin/stats/config' && POST) {
    if (!isAdmin(ctx)) return fail(res, 403, 'forbidden');
    const b = await readJson(req);
    const n = Number(b.dailyLimit);
    if (!(n >= 1 && n <= 100)) return fail(res, 200, '上限需在 1-100 之间');
    STATS_CFG.dailyLimit = Math.floor(n);
    saveCfg();
    return ok(res, { config: STATS_CFG, message: `已更新：每账号每工具每日计入上限 ${STATS_CFG.dailyLimit} 次` });
  }

  return fail(res, 404, 'api not found: ' + urlPath);
}

/* ============================== HTTP 服务器 ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.dxf': 'application/dxf',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/* 二次解码防护：urlPath 已解码一次，此处再解码可能抛 URIError 打挂进程，失败时退回原串 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* 统一带错误处理的文件流：读盘错误 500 而不是让 'error' 事件炸掉进程 */
function streamFile(res, file, headers) {
  const rs = fs.createReadStream(file);
  rs.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 read error');
  });
  res.writeHead(200, headers);
  rs.pipe(res);
}

function serveFile(res, baseDir, rel, opts = {}) {
  let file;
  try {
    file = path.normalize(path.join(baseDir, safeDecode(rel)));
  } catch {
    file = path.normalize(path.join(baseDir, rel));
  }
  if (!file.startsWith(baseDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  // 下载类工具：用磁盘上的原始文件名（含中文）作为下载名
  if (opts.download) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  }
  streamFile(res, file, headers);
}

/* One-API 可用模型缓存（员工自助 /api/one-api/models 用，5 分钟） */
let oneApiModelsCache = { at: 0, data: [] };

const server = http.createServer(async (req, res) => {
  let url, urlPath;
  try {
    url = new URL(req.url, 'http://x');
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    url = new URL('/', 'http://x');
    urlPath = '/';
  }

  /* ===== One-API 员工自助（登录即可；密钥与额度只返回本人 —— 按姓名关联的令牌，翻页聚合在服务端完成） ===== */
  const oneApiBase = () => process.env.ONE_API_BASE || 'http://127.0.0.1:3000';
  const oneApiToken = () => process.env.ONE_API_ADMIN_TOKEN || '';
  async function oneApiGet(path) {
    const r = await fetch(oneApiBase() + path, {
      headers: { Authorization: `Bearer ${oneApiToken()}`, 'User-Agent': 'skillharbor' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('one-api ' + r.status);
    const j = await r.json();
    if (j && j.success === false) throw new Error(j.message || 'one-api error');
    return j.data ?? j;
  }
  /* 定制版列表接口固定 10 条/页且无总条数：翻页读取（短页即末页）。注意 p 从 0 起（p=0 才是第一页） */
  async function oneApiPaged(pathBase, maxPages = 60) {
    const out = [];
    const sep = pathBase.includes('?') ? '&' : '?';
    for (let p = 0; p < maxPages; p++) {
      const d = await oneApiGet(pathBase + sep + 'p=' + p);
      const items = Array.isArray(d) ? d : d.items || [];
      if (!items.length) break;
      out.push(...items);
      if (items.length < 10) break;
    }
    return out;
  }
  if (urlPath === '/api/one-api/my-quota' && req.method === 'GET') {
    const u = authed({ req, res, url, urlPath });
    if (!u) return fail(res, 401, '请先登录');
    if (!oneApiToken()) return fail(res, 503, 'ONE_API_ADMIN_TOKEN not configured');
    try {
      const tokens = await oneApiPaged('/api/token/', 60);
      const mine = tokens.find((t) => t.name === u.name);
      if (!mine) return ok(res, { tokenState: 'none' });
      const used = mine.daily_used_tokens || 0;
      const unlimited = !!mine.unlimited_daily_tokens;
      const total = unlimited ? 0 : mine.daily_token_limit || 100000;
      /* 今日模型分布：按令牌名过滤日志（该定制版支持 token_name 查询参数） */
      let models = [];
      try {
        const now = Math.floor(Date.now() / 1000);
        const d0 = new Date();
        d0.setHours(0, 0, 0, 0);
        const dayStart = Math.floor(d0.getTime() / 1000);
        const logs = await oneApiPaged(
          `/api/log/?type=0&start_timestamp=${dayStart}&end_timestamp=${now}&token_name=${encodeURIComponent(u.name)}`,
          30,
        );
        const byModel = new Map();
        logs.forEach((l) => {
          const t = (l.prompt_tokens || 0) + (l.completion_tokens || 0);
          byModel.set(l.model_name, (byModel.get(l.model_name) || 0) + t);
        });
        models = [...byModel.entries()]
          .map(([model, mUsed]) => ({ model, used: mUsed }))
          .sort((a, b) => b.used - a.used)
          .slice(0, 4);
      } catch { /* 日志失败不影响主数据 */ }
      return ok(res, {
        tokenState: 'ok',
        used,
        total,
        unlimited,
        remainUsd: mine.unlimited_quota ? undefined : (mine.remain_quota || 0) / 500000,
        apiKey: mine.key ? 'sk-' + mine.key : '',
        models,
      });
    } catch (e) {
      return fail(res, 502, 'one-api unreachable: ' + e.message);
    }
  }
  if (urlPath === '/api/one-api/models' && req.method === 'GET') {
    const u = authed({ req, res, url, urlPath });
    if (!u) return fail(res, 401, '请先登录');
    if (!oneApiToken()) return fail(res, 503, 'ONE_API_ADMIN_TOKEN not configured');
    try {
      if (Date.now() - oneApiModelsCache.at > 5 * 60 * 1000) {
        const d = await oneApiGet('/api/channel/');
        const list = Array.isArray(d) ? d : d.items || [];
        const s = new Set();
        list
          .filter((c) => c.status === 1)
          .forEach((c) => String(c.models || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((m) => s.add(m)));
        /* ark-code-latest 为智能调度入口，固定置顶；其余按模型名 A-Z */
        const sorted = [...s].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const pinned = sorted.filter((m) => m === 'ark-code-latest');
        const rest = sorted.filter((m) => m !== 'ark-code-latest');
        oneApiModelsCache = { at: Date.now(), data: [...pinned, ...rest] };
      }
      return ok(res, { models: oneApiModelsCache.data });
    } catch (e) {
      return fail(res, 502, 'one-api unreachable: ' + e.message);
    }
  }

  /* ===== One-API 代理（管理令牌仅在服务端；仅管理员可用） ===== */
  if (urlPath.startsWith('/api/one-api/')) {
    if (!isAdmin({ req, res, url, urlPath })) return fail(res, 403, 'forbidden');
    const base = process.env.ONE_API_BASE || 'http://127.0.0.1:3000';
    const token = process.env.ONE_API_ADMIN_TOKEN || '';
    if (!token) return fail(res, 503, 'ONE_API_ADMIN_TOKEN not configured');
    const target = base + urlPath.replace('/api/one-api', '') + url.search;
    try {
      const upstream = await fetch(target, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'skillharbor' } });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await upstream.text());
    } catch (e) {
      fail(res, 502, 'one-api unreachable: ' + e.message);
    }
    return;
  }

  /* ===== 技能中心代理（透传方法/请求体/响应类型，支持启停、回滚、删除与 CSV 导出）
   * 鉴权：技能列表/详情与 KPI 概览为门户免登录展示面（GET 放行）；其余（写操作 / 日志 / 告警 / 导出）仅管理员 */
  if (urlPath.startsWith('/api/skill-gateway/')) {
    const GW_PUBLIC_GET = [
      /^\/api\/skill-gateway\/api\/skills$/,
      /^\/api\/skill-gateway\/api\/skills\/[\w.-]+$/,
      /^\/api\/skill-gateway\/api\/skills\/[\w.-]+\/content$/,
      /^\/api\/skill-gateway\/api\/skills\/[\w.-]+\/structure$/,
      /^\/api\/skill-gateway\/api\/skills\/[\w.-]+\/components\/[\w.-]+$/,
      /^\/api\/skill-gateway\/api\/stats\/overview$/,
      /^\/api\/skill-gateway\/api\/kb\/recent$/,
    ];
    const gwPublic = req.method === 'GET' && !/\/(?:migration-preview|dependency-issues)$/.test(urlPath) && GW_PUBLIC_GET.some((re) => re.test(urlPath));
    if (!gwPublic && !isAdmin({ req, res, url, urlPath })) return fail(res, 403, 'forbidden');
    const base = process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800';
    const gwToken = process.env.SKILL_GATEWAY_TOKEN || '';
    const target = base + urlPath.replace('/api/skill-gateway', '') + url.search;
    try {
      const headers = { 'User-Agent': 'skillharbor' };
      if (gwToken) headers.Authorization = 'Bearer ' + gwToken;
      const init = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const limitMB = /\/skills\/(?:upload|inspect|prepare)$/.test(urlPath) ? 155 : 80;
        if (Number(req.headers['content-length']) > limitMB * MB) return fail(res, 413, '请求超过大小限制（技能包最多 150MB）');
        let buf;
        try { buf = await readBody(req, limitMB); }
        catch (error) { return fail(res, error.message === 'body too large' ? 413 : 400, error.message === 'body too large' ? '请求超过大小限制（技能包最多 150MB）' : '接收请求失败，请重试'); }
        if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
        if (buf.length) init.body = buf;
      }
      const upstream = await fetch(target, init);
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      fail(res, 502, 'skill-gateway unreachable: ' + e.message);
    }
    return;
  }

  /* ===== WorkBuddy 一键安装数据 ===== */
  if (urlPath === '/api/skill-stubs/all') {
    recordSyncHeartbeat(clientIp(req)); // 覆盖率观测：到达门户即心跳（网关侧失败也算同步进程在跑）
    const base = process.env.SKILL_GATEWAY_BASE || 'http://127.0.0.1:8800';
    try {
      if (!stubCache || Date.now() - stubCache.at > 5 * 60 * 1000) {
        const r = await fetch(base + '/api/skills', { headers: gwHeaders() });
        if (!r.ok) throw new Error('gateway HTTP ' + r.status);
        const list = await r.json();
        // routable === false 的技能属智能体内部工具（规范自检/知识库验证/触发推演），
        // 只允许由智能体按 slug 分派调用：不下发本地壳技能，否则模型可直接命中、绕过智能体，
        // 网关 list_skills/search_skills 的隔离在装机侧就失效了。
        const enabled = (Array.isArray(list) ? list : []).filter((s) => s && s.status === 'enabled' && s.routable !== false);
        stubCache = { at: Date.now(), data: enabled.map(buildStub) };
      }
      return send(res, 200, {
        mcp: { name: process.env.MCP_SERVER_NAME || 'skillharbor-ai-gateway', url: process.env.MCP_SERVER_URL || 'http://127.0.0.1:8765/mcp' },
        stubs: stubCache.data,
      });
    } catch (e) {
      return fail(res, 502, 'skill-stubs unreachable: ' + e.message);
    }
  }

  /* ===== 技能同步接入清单（管理侧覆盖率观测）=====
   * rows：每台已接入设备（IP 维度）的首次/最后同步时间与次数；姓名取该 IP 最近一次成功登录
   * staffTotal/staffCovered：在职员工数与其中已接入人数（按姓名去重） */
  if (urlPath === '/api/admin/skill-sync' && req.method === 'GET') {
    if (!isAdmin({ req, res, url, urlPath })) return fail(res, 403, 'forbidden');
    const names = {};
    for (const l of LOGINS) if (l && l.ok && l.ip && l.n) names[l.ip] = l.n; // 顺序遍历后写覆盖 → 最近一次成功登录
    const now = Date.now();
    const rows = Object.entries(SYNC_HB)
      .map(([ip, e]) => ({ ip, name: names[ip] || '', lastAt: e.last, firstAt: e.first, count: e.count, stale: now - e.last > 24 * 3600 * 1000 }))
      .sort((a, b) => b.lastAt - a.lastAt);
    const covered = new Set(rows.map((r) => r.name).filter(Boolean));
    const staffTotal = USERS.filter((u) => !u.disabled).length;
    return ok(res, { rows, staffTotal, staffCovered: covered.size });
  }

  /* ===== 技能网关 · IP-姓名匹配表同步（从登录记录推导，只读；skillharbor 侧数据源）
   * 仅内网客户端（技能网关在 Docker 内网）或持有 SkillHarbor_SYNC_TOKEN 的调用方可访问 */
  if (urlPath === '/api/ip-name-map') {
    const token = process.env.SkillHarbor_SYNC_TOKEN || '';
    const isIntranet = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1)/.test(clientIp(req));
    if (!(token && url.searchParams.get('token') === token) && !isIntranet) return fail(res, 403, 'forbidden');
    const ips = {};
    for (const l of LOGINS) if (l && l.ok && l.ip && l.n) ips[l.ip] = l.n + '|' + l.u; // 顺序遍历，后写覆盖；deploy138 起「中文名|username」复合（网关 X-KB-User 头需 ASCII 的 username）
    return ok(res, { count: Object.keys(ips).length, ips });
  }

  /* ===== 业务 API ===== */
  if (urlPath.startsWith('/api/')) {
    try {
      return await handleApi({ req, res, url, urlPath });
    } catch (e) {
      console.error('[api]', urlPath, e);
      return fail(res, 500, 'server error: ' + e.message);
    }
  }

  /* ===== 静态文件 =====
   * /files/uploads/*      → DATA_DIR/uploads（用户上传已部署工具，持久卷）
   * /files/uploads-preview/* → DATA_DIR/tmp（审核沙箱预览）
   * /files/*              → ./files（随镜像分发的静态资源）
   */
  /* 用户内容走独立源（skillharbor-files:8180）：门户源不再直接服务，旧链接 301 兜底。
   * Location 必须用原始编码的 url.pathname——urlPath 已 decodeURIComponent 成原生中文，
   * 非 ASCII 头值令 writeHead 抛 ERR_INVALID_CHAR，请求挂死无响应（中文文件名 /files/uploads/* 8100 全挂的根因） */
  if (FILES_BASE && (urlPath.startsWith('/files/uploads/') || urlPath.startsWith('/files/uploads-preview/'))) {
    res.writeHead(301, { Location: FILES_BASE + url.pathname + url.search });
    return res.end();
  }
  if (urlPath.startsWith('/files/uploads-preview/')) {
    return serveFile(res, TMP_DIR, urlPath.replace('/files/uploads-preview/', ''));
  }
  if (urlPath.startsWith('/files/uploads/')) {
    if (urlPath.startsWith('/files/uploads/files/')) {
      return serveFile(res, UP_DIR, urlPath.replace('/files/uploads/', ''), { download: true });
    }
    return serveFile(res, UP_DIR, urlPath.replace('/files/uploads/', ''));
  }
  if (urlPath.startsWith('/files/')) {
    let ffile = path.normalize(path.join(FILES_DIR, safeDecode(urlPath.replace('/files/', ''))));
    if (!ffile.startsWith(FILES_DIR) || !fs.existsSync(ffile) || fs.statSync(ffile).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + urlPath);
    }
    const fext = path.extname(ffile).toLowerCase();
    return streamFile(res, ffile, { 'Content-Type': MIME[fext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  }

  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // 兼容旧版裸文件名链接
    const legacy = path.normalize(path.join(FILES_DIR, safeDecode(urlPath)));
    if (legacy.startsWith(FILES_DIR) && fs.existsSync(legacy) && fs.statSync(legacy).isFile()) {
      const lext = path.extname(legacy).toLowerCase();
      return streamFile(res, legacy, { 'Content-Type': MIME[lext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    }
    file = path.join(ROOT, 'index.html'); // SPA fallback
  }
  const ext = path.extname(file).toLowerCase();
  const cache = urlPath.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache';
  streamFile(res, file, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
});

/* ===== 一次性迁移：下载类工具的磁盘文件曾被下划线化（中文丢失），恢复为原始文件名 ===== */
try {
  let migrated = 0;
  for (const rec of UPLOADS) {
    if (rec.kind !== 'file' || rec.status !== 'online' || !rec.deployedUrl) continue;
    const oldName = decodeURIComponent(rec.deployedUrl.split('/').pop());
    const want = safeName(rec.filename || oldName);
    if (oldName === want) continue;
    const oldPath = path.join(UP_DIR, 'files', oldName);
    const newPath = path.join(UP_DIR, 'files', want);
    if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) continue;
    fs.renameSync(oldPath, newPath);
    rec.deployedUrl = '/files/uploads/files/' + encodeURIComponent(want);
    const t = EXTRA_TOOLS.find((x) => x.uploadId === rec.id);
    if (t) t.url = rec.deployedUrl;
    migrated++;
  }
  if (migrated) {
    saveUploads();
    saveExtra();
    console.log(`[migrate] renamed ${migrated} download file(s) to original names`);
  }
} catch (e) {
  console.error('[migrate] failed:', e.message);
}

/* 存量用户内容相对地址 → 独立源绝对地址（FILES_BASE 配置后自动执行，幂等） */
if (FILES_BASE) {
  let n = 0;
  for (const t of EXTRA_TOOLS) {
    if (typeof t.url === 'string' && t.url.startsWith('/files/uploads/')) { t.url = FILES_BASE + t.url; n++; }
    if (typeof t.iconUrl === 'string' && t.iconUrl.startsWith('/files/uploads/')) { t.iconUrl = FILES_BASE + t.iconUrl; n++; }
  }
  for (const x of UPLOADS) {
    if (typeof x.deployedUrl === 'string' && x.deployedUrl.startsWith('/files/uploads/')) { x.deployedUrl = FILES_BASE + x.deployedUrl; n++; }
  }
  if (n) {
    saveExtra();
    saveUploads();
    console.log(`[files-base] ${n} 个存量相对地址已指向独立源 ${FILES_BASE}`);
  }
}

server.listen(PORT, process.env.BIND_HOST || '0.0.0.0', () => {
  console.log(`[SkillHarbor] production server running at http://0.0.0.0:${PORT} (static:${ROOT}, data:${DATA_DIR})`);
  /* tmp 回收：启动即跑一次 + 每天一次（draft 超 7 天 / 无主目录 / 超 30 天未审提醒） */
  try { gcUploads(); } catch (e) { console.error('[gc] 启动回收失败（不影响服务）', e.message); }
  const gcTimer = setInterval(() => { try { gcUploads(); } catch { /* 忽略单次失败 */ } }, 24 * 3600 * 1000);
  if (gcTimer.unref) gcTimer.unref();
});

/* 进程级兜底：单请求异常不应打挂整个服务（Docker 内 crash-loop 比带伤运行更糟），记录后继续 */
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
