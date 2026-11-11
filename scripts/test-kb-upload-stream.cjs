const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { stageKbUpload } = require('../server/lib/kb-upload.cjs');
const { repoPermission, normalizeReadDepts } = require('../server/lib/kb-permissions.cjs');
const { atomicWriteJSON } = require('../server/lib/atomic-json.cjs');
const boundary = 'test-boundary';
const multipart = (head, body, extra = '') => Buffer.concat([
  Buffer.from(`--${boundary}\r\n${head}\r\n\r\n`), body,
  Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="reposId"\r\n\r\n1\r\n--${boundary}--\r\n${extra}`),
]);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillharbor-stream-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function request(data, width = 7) {
  function* chunks() { for (let i = 0; i < data.length; i += width) yield data.subarray(i, i + width); }
  const stream = Readable.from(chunks());
  stream.headers = { 'content-type': 'multipart/form-data; boundary=' + boundary }; return stream;
}

test('chunked multipart preserves binary bytes and split boundary-like file content', async (t) => {
  const dir = temporary(t);
  const binary = Buffer.concat([Buffer.from([0, 255, 128, 13, 10]), Buffer.from('\r\n--test-boundaryXY'.repeat(20))]);
  const data = multipart('Content-Disposition: form-data; name="uploadFile"; filename="测试.bin"\r\nContent-Type: application/octet-stream', binary);
  const staged = await stageKbUpload(request(data, 1), new URL('http://test/?reposId=1'), dir, 10000);
  assert.equal(staged.fileBytes, binary.length);
  assert.notEqual(staged.contentType, 'multipart/form-data; boundary=' + boundary);
  assert.notEqual(fs.readFileSync(staged.path).indexOf(binary), -1);
  staged.cleanup(); assert.deepEqual(fs.readdirSync(dir), []);
});

test('ambiguous disposition, duplicate headers and extra epilogue never leave staged files', async (t) => {
  const dir = temporary(t);
  const invalid = [
    'Content-Disposition: form-data; name="reposId"; name="uploadFile"; filename="x"',
    'Content-Disposition: form-data; name="uploadFile"; filename="x"\r\nContent-Disposition: form-data; name="reposId"',
    'Content-Disposition: form-data; name="reposId"; filename="x"',
    'Content-Disposition: form-data; name*=UTF-8\'\'reposId; filename="x"',
    'Content-Disposition: form-data; name="uploadFile"; filename="x"\r\nContent-Transfer-Encoding: base64',
  ];
  for (const header of invalid) {
    await assert.rejects(stageKbUpload(request(multipart(header, Buffer.from('1'))), new URL('http://test/?reposId=1'), dir));
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  await assert.rejects(stageKbUpload(request(multipart('Content-Disposition: form-data; name="uploadFile"; filename="x"', Buffer.from('x'), 'unexpected')), new URL('http://test/?reposId=1'), dir));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('chunked oversize and disconnected streams clean up before a caller can forward', async (t) => {
  const dir = temporary(t);
  const data = multipart('Content-Disposition: form-data; name="uploadFile"; filename="x"', Buffer.alloc(8192));
  await assert.rejects(stageKbUpload(request(data), new URL('http://test/?reposId=1'), dir, 1024), { status: 413 });
  assert.deepEqual(fs.readdirSync(dir), []);
  const aborted = Readable.from((async function* () { yield data.subarray(0, 100); throw new Error('client disconnected'); })());
  aborted.headers = request(data).headers;
  await assert.rejects(stageKbUpload(aborted, new URL('http://test/?reposId=1'), dir), /disconnected/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('policy matrix preserves explicit public, department and private grants', () => {
  const policies = { repos: {
    1: { tier: 'dept', dept: 'A', owner: 'owner', maintainers: ['maintainer'], maintSet: true },
    2: { tier: 'public', maintainers: [] },
    3: { tier: 'private', owner: 'owner', whitelist: ['reader'], allowDownload: false },
    4: { tier: 'typo' },
  } };
  const user = (username, role = 'user', dept = 'A') => ({ username, role, dept });
  assert.equal(repoPermission(user('reader'), 1, policies).canWrite, false);
  assert.equal(repoPermission(user('maintainer', 'user', 'B'), 1, policies).canWrite, true);
  assert.equal(repoPermission(user('maintainer'), 2, policies).canWrite, true);
  assert.equal(repoPermission(user('owner'), 3, policies).canWrite, true);
  assert.equal(repoPermission(user('reader'), 3, policies).canWrite, false);
  assert.equal(repoPermission(user('reader'), 3, policies).canDownload, false);
  assert.equal(repoPermission(user('admin', 'admin'), 3, policies).visible, false);
  assert.equal(repoPermission(user('admin', 'admin'), 4, policies).canWrite, false);
  assert.equal(repoPermission(user('admin', 'admin'), 999, policies).visible, false);
});

test('department read sharing grants read-only visibility without write or management', () => {
  const policies = { repos: {
    14: { tier: 'dept', dept: '政技部', owner: '', maintainers: ['liuyang'], maintSet: true, readDepts: ['咨询所'] },
    15: { tier: 'dept', dept: '政技部', owner: '', maintainers: ['liuyang'], maintSet: true },
    17: { tier: 'private', owner: 'owner', whitelist: ['owner'], readDepts: ['咨询所'] },
  } };
  const user = (username, role = 'user', dept = '咨询所') => ({ username, role, deptShort: dept, dept });
  const shared = repoPermission(user('huangyating'), 14, policies);
  assert.deepEqual([shared.visible, shared.readShared, shared.canWrite, shared.canManage, shared.canDownload],
    [true, true, false, false, true]);
  /* 非共享部门不可见；共享只作用于可见性，不改变写/管理口径 */
  assert.equal(repoPermission(user('lidan', 'user', '研究院'), 14, policies).visible, false);
  assert.equal(repoPermission(user('liuyang', 'user', '政技部'), 14, policies).readShared, false);
  assert.equal(repoPermission(user('liuyang', 'user', '政技部'), 14, policies).canWrite, true);
  assert.equal(repoPermission(user('admin', 'admin', '总经办'), 14, policies).visible, true);
  assert.equal(repoPermission(user('admin', 'admin', '总经办'), 14, policies).readShared, false);
  /* 未配置 readDepts 的部门库不受影响 */
  assert.equal(repoPermission(user('huangyating'), 15, policies).visible, false);
  /* 私有库的 readDepts 不生效（可见性只由 whitelist 决定） */
  assert.equal(repoPermission(user('huangyating'), 17, policies).visible, false);
  /* 共享部门成员同时是本库维护员：以维护身份访问，不标记共享、可写 */
  const dual = { repos: { 14: { ...policies.repos[14], maintainers: ['huangyating'] } } };
  const dualPerm = repoPermission(user('huangyating'), 14, dual);
  assert.equal(dualPerm.readShared, false);
  assert.equal(dualPerm.canWrite, true);
});

test('read department list is normalized to known departments and excludes the owning department', () => {
  const allowed = ['总经办', '咨询所', '研究院', '政技部'];
  assert.deepEqual(normalizeReadDepts(['咨询所', ' 咨询所 ', '政技部', '不存在部门', 3, null, ''], '政技部', allowed), ['咨询所']);
  assert.deepEqual(normalizeReadDepts(['研究院', '咨询所'], '政技部', allowed), ['研究院', '咨询所']);
  assert.deepEqual(normalizeReadDepts(undefined, '政技部', allowed), []);
  assert.deepEqual(normalizeReadDepts('咨询所', '政技部', allowed), []);
});

test('atomic write failure retains the previous JSON and removes temporary files', (t) => {  const dir = temporary(t); atomicWriteJSON(dir, 'test.json', { before: true });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated disk error'); };
  try { assert.throws(() => atomicWriteJSON(dir, 'test.json', { after: true }), /simulated disk error/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'test.json'))), { before: true });
  assert.deepEqual(fs.readdirSync(dir), ['test.json']);
});
