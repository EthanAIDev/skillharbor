/* Integration regression: real portal + temporary DATA_DIR + loopback-only upstream. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillharbor-kb-regression-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const users = ['admin', 'writer', 'reader'].map((username) => ({ username, name: username,
    role: username === 'admin' ? 'admin' : 'user', dept: 'test', deptShort: 'test', ep: 1,
    salt: 'test-salt', hash: 'test-hash', disabled: false }));
  const perms = { repos: { 1: { tier: 'dept', dept: 'test', owner: 'writer', maintainers: ['writer'], maintSet: true },
    2: { tier: 'private', owner: 'reader', whitelist: ['reader'], quotaGB: 10, usedBytes: 0 } } };
  for (const [name, value] of Object.entries({ 'users.json': users, 'secret.key.json': { k: secret },
    'kb-perms.json': perms, 'extraTools.json': [], 'uploads.json': [], 'alert-webhook.json': { url: '' } }))
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  if (options.corruptPolicy) fs.writeFileSync(path.join(dir, 'kb-perms.json'), '{broken');
  if (options.setup) options.setup(dir);
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, body: Buffer.concat(chunks) });
    if (options.handleUpstream && await options.handleUpstream(req, res, Buffer.concat(chunks))) return;
    if (req.url.includes('/Doc/downloadDoc.do') && options.previewContent !== undefined) {
      res.end(options.previewContent); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/User/login.do')) res.setHeader('Set-Cookie', 'JSESSIONID=test-only; Path=/');
    res.end(JSON.stringify({ status: 'ok', data: req.url.includes('getReposList')
      ? [{ id: 1, name: 'test知识库' }, { id: 2, name: 'private-test' }] : { docId: '100' } }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  if (options.afterListen) options.afterListen(dir, up);
  const preload = options.preload ? path.join(dir, 'preload.cjs') : '';
  if (preload) fs.writeFileSync(preload, options.preload);
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  let child, output = '';
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited;
  };
  t.after(async () => { await stop(); await new Promise((r) => upstream.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = async () => {
    output = '';
    child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), 'server.cjs', String(port)], { cwd: ROOT, windowsHide: true,
      env: { ...process.env, BIND_HOST: '127.0.0.1', DATA_DIR: dir, SERVICE_DOCKER: 'mock', SKILL_GATEWAY_BASE: up,
        ONE_API_BASE: up, ONE_API_ADMIN_TOKEN: 'test', MXSDOC_BASE_URL: up, FRPC_ADMIN_BASE: up, FEISHU_WEBHOOK_URL: '', SKILL_GATEWAY_TOKEN: 'test',
        MXSDOC_SVC_PASSWORD: 'test', MXSDOC_SVC_W_PASSWORD: 'test', MXSDOC_ADMIN_PASSWORD: 'test',
        KB_BRIDGE_SECRET: 'test', KB_PERMS_OFF: options.legacyOff ? '1' : '0', KB_UPLOAD_MAX_BYTES: String(options.maxBytes || 1024 * 1024), ...options.env },
      stdio: ['ignore', 'pipe', 'pipe', ...(preload ? ['ipc'] : [])] });
    child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('portal exited: ' + output);
      try { await fetch(`http://127.0.0.1:${port}/api/auth/me`); return; } catch {}
      await wait(30);
    }
    throw new Error('portal startup timeout: ' + output);
  };
  const token = (username) => {
    const b = Buffer.from(JSON.stringify({ u: username, ep: 1, exp: Date.now() + 60000 })).toString('base64url');
    return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url');
  };
  const request = async (url, { user = 'writer', raw = false, ...init } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}` + url, { ...init,
      headers: { Authorization: 'Bearer ' + token(user), ...init.headers } });
    return { status: r.status, headers: r.headers, body: raw ? await r.text() : await r.json() };
  };
  const invoke = (message) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('fixture IPC timeout')); }, 5000);
    const receive = (reply) => { if (reply.id !== id) return; clearTimeout(timer); child.off('message', receive); reply.error ? reject(new Error(reply.error)) : resolve(reply); };
    child.on('message', receive); child.send({ ...message, id });
  });
  await start();
  return { dir, calls, stop, start, request, invoke, base: `http://127.0.0.1:${port}`, token };
}

async function privateQuotaFixture(t, options = {}) {
  const files = new Map([['root.txt', 6], ['folder/nested.txt', 10]]);
  const f = await fixture(t, { setup(dir) {
    const policy = JSON.parse(fs.readFileSync(path.join(dir, 'kb-perms.json')));
    policy.repos[2].usedBytes = 999;
    policy.repos[2].quotaGB = 20 / 1024 ** 3;
    fs.writeFileSync(path.join(dir, 'kb-perms.json'), JSON.stringify(policy));
  }, async handleUpstream(req, res, body) {
    if (options.handleUpstream && await options.handleUpstream(req, res, body)) return true;
    const form = new URLSearchParams(body.toString());
    let data;
    if (req.url === '/Repos/getSubDocList.do') {
      assert.equal(form.get('vid'), '2');
      const nested = form.get('name') === 'folder';
      assert.equal(form.get('path') || '', '');
      if (nested) assert.equal(form.get('docId'), '200');
      else assert.ok(!form.get('docId'), 'root listing must not send docId=0');
      data = [...files].filter(([key]) => nested ? key.startsWith('folder/') : !key.includes('/'))
        .map(([key, size], index) => ({ docId: 300 + index + (nested ? 100 : 0), type: 1,
          path: nested ? 'folder/' : '', name: key.split('/').pop(), size }));
      if (!nested && [...files.keys()].some(key => key.startsWith('folder/')))
        data.push({ docId: 200, type: 2, path: '', name: 'folder', size: 9999 });
    } else if (req.url === '/Doc/deleteDoc.do') {
      const key = (form.get('path') || '').replace(/^\/+/, '') + form.get('name');
      for (const name of files.keys()) if (name === key || name.startsWith(key + '/')) files.delete(name);
      data = {};
    } else if (req.url === '/Doc/uploadDoc.do') {
      const multipart = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      files.set((multipart.get('path') || '') + multipart.get('name'), multipart.get('uploadFile').size);
      data = { docId: 999 };
    } else return false;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', data })); return true;
  } });
  return { ...f, files,
    quota: async () => (await f.request('/api/kb/repos', { user: 'reader' })).body.repos.find(r => String(r.id) === '2').quota,
    upload: (name, size, path = '') => {
      const body = new FormData(); body.append('reposId', '2'); body.append('path', path); body.append('name', name);
      body.append('filePath', name); body.append('size', String(size)); body.append('checkSum', '');
      body.append('uploadFile', new Blob(['x'.repeat(size)]), name);
      return f.request('/api/kb/upload?reposId=2', { user: 'reader', method: 'POST', body });
    },
  };
}

test('private quota measures only current nested files and ignores the legacy upload counter', async (t) => {
  const f = await privateQuotaFixture(t);
  assert.equal((await f.quota()).used, 16);
  assert.equal(f.calls.some(c => /getDocHistory|deleteHistory|recycle/i.test(c.url)), false);
  const calls = f.calls.length;
  const other = await f.request('/api/kb/repos', { user: 'admin' });
  assert.equal(other.body.repos.some(r => String(r.id) === '2'), false);
  assert.equal(f.calls.slice(calls).some(c => c.url === '/Repos/getSubDocList.do'), false);
});

test('private quota releases deleted folders and charges replacements by their current size', async (t) => {
  const f = await privateQuotaFixture(t);
  const removed = await f.request('/api/kb/delete', { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '2', path: '', name: 'folder', type: 'dir' }) });
  assert.equal(removed.body.ok, true);
  assert.equal((await f.quota()).used, 6);
  assert.equal((await f.upload('root.txt', 20)).body.ok, true, 'replacement at the exact quota must succeed');
  assert.equal((await f.quota()).used, 20);
  assert.equal((await f.upload('root.txt', 3)).body.ok, true, 'smaller replacement frees capacity');
  assert.equal((await f.quota()).used, 3);
  assert.equal((await f.upload('other.txt', 18)).status, 400);
  assert.equal(f.files.has('other.txt'), false, 'over-quota upload must not reach upstream');
  assert.equal((await f.upload('other.txt', 17)).body.ok, true);
  await f.stop(); await f.start();
  assert.equal((await f.quota()).used, 20, 'restarted portal recalculates current files');
  assert.equal((await f.upload('other.txt', 17)).body.ok, true, 'same-size replacement does not accumulate quota');
});

test('private repository mutations wait for an upload quota check and write to finish', async (t) => {
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await privateQuotaFixture(t, { async handleUpstream(req) {
    if (req.url === '/Doc/uploadDoc.do') { entered(); await barrier; }
    return false;
  } });
  const upload = f.upload('extra.txt', 4);
  await arrived;
  const deletion = f.request('/api/kb/delete', { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '2', path: '', name: 'root.txt', type: 'file' }) });
  await wait(75);
  const prematureDelete = f.calls.some(c => c.url === '/Doc/deleteDoc.do');
  release();
  assert.equal((await upload).body.ok, true);
  assert.equal((await deletion).body.ok, true);
  assert.equal(prematureDelete, false, 'delete cannot mutate the tree while quota upload is in flight');
  assert.equal((await f.quota()).used, 14);
});

test('concurrent private uploads cannot both spend the same remaining capacity', async (t) => {
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await privateQuotaFixture(t, { async handleUpstream(req) {
    if (req.url === '/Doc/uploadDoc.do') { entered(); await barrier; }
    return false;
  } });
  const first = f.upload('first.txt', 4); await arrived;
  const second = f.upload('second.txt', 4); await wait(75); release();
  assert.equal((await first).body.ok, true);
  assert.equal((await second).status, 400);
  assert.equal(f.calls.filter(c => c.url === '/Doc/uploadDoc.do').length, 1);
  assert.equal((await f.quota()).used, 20);
});

test('unverifiable private usage is unknown and blocks uploads without poisoning the queue', async (t) => {
  let broken = true;
  const f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
    if (broken && req.url === '/Repos/getSubDocList.do') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', data: [{ type: 1, path: '', name: 'broken.txt', size: -1 }] })); return true;
    }
    return false;
  } });
  assert.equal((await f.quota()).used, null);
  assert.equal((await f.upload('extra.txt', 4)).body.ok, false);
  assert.equal(f.calls.some(c => c.url === '/Doc/uploadDoc.do'), false);
  broken = false;
  assert.equal((await f.upload('extra.txt', 4)).body.ok, true);
  assert.equal((await f.quota()).used, 20);
});

test('ambiguous private upload targets and alternate upload modes cannot bypass quota checks', async (t) => {
  const f = await privateQuotaFixture(t);
  for (const [field, value] of [['path', 'folder'], ['name', 'other.txt'], ['docId', '1'], ['chunkNum', '2'], ['size', '0']]) {
    const body = new FormData(); body.append('reposId', '2'); body.append('name', 'root.txt'); body.append('path', '');
    body.append('uploadFile', new Blob(['xxxx']), 'root.txt');
    if (field === 'path' || field === 'size') body.set(field, value); else body.append(field, value);
    const response = await f.request('/api/kb/upload?reposId=2', { user: 'reader', method: 'POST', body });
    assert.equal(response.status, 400, field);
  }
  assert.equal(f.calls.some(c => c.url === '/Doc/uploadDoc.do'), false);
});

test('private quota counts Unicode targets exactly and failed upstream uploads consume no space', async (t) => {
  let rejectUpload = true;
  const f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
    if (rejectUpload && req.url === '/Doc/uploadDoc.do') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'fail', msgInfo: 'synthetic failure' })); return true;
    }
    return false;
  } });
  assert.equal((await f.upload('中文.txt', 2, 'folder/')).body.ok, false);
  assert.equal((await f.quota()).used, 16);
  rejectUpload = false;
  assert.equal((await f.upload('中文.txt', 2, 'folder/')).body.ok, true);
  assert.equal((await f.upload('中文.txt', 4, 'folder/')).body.ok, true);
  assert.equal((await f.quota()).used, 20);
});

test('an already over-quota private repository can shrink existing files to recover space', async (t) => {
  const f = await privateQuotaFixture(t);
  f.files.clear(); f.files.set('root.txt', 25);
  assert.equal((await f.upload('root.txt', 24)).body.ok, true);
  assert.equal((await f.quota()).used, 24);
  assert.equal((await f.upload('extra.txt', 1)).status, 400);
});

test('a disconnected private mutation in the queue is skipped and later requests finish', async (t) => {
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await privateQuotaFixture(t, { async handleUpstream(req) {
    if (req.url === '/Doc/uploadDoc.do') { entered(); await barrier; }
    return false;
  } });
  const upload = f.upload('extra.txt', 4); await arrived;
  const body = JSON.stringify({ reposId: '2', path: '', name: 'root.txt', type: 'file' });
  const queued = http.request(f.base + '/api/kb/delete', { method: 'POST', headers: {
    Authorization: 'Bearer ' + f.token('reader'), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
  } });
  queued.on('error', () => {}); queued.end(body); await wait(75); queued.destroy(); await wait(75); release();
  assert.equal((await upload).body.ok, true);
  const after = await f.request('/api/kb/repos', { user: 'reader', signal: AbortSignal.timeout(3000) });
  assert.equal(after.body.repos.find(r => r.id === 2).quota.used, 20);
  assert.equal(f.files.has('root.txt'), true);
  assert.equal(f.calls.some(c => c.url === '/Doc/deleteDoc.do'), false);
});

test('queued private mutations revalidate a disabled or reset account before writing', async (t) => {
  for (const change of ['disable', 'reset']) await t.test(change, async (t) => {
    let entered, release;
    const arrived = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const f = await privateQuotaFixture(t, { async handleUpstream(req) {
      if (req.url === '/Doc/uploadDoc.do') { entered(); await barrier; }
      return false;
    } });
    const upload = f.upload('extra.txt', 4); await arrived;
    const deletion = f.request('/api/kb/delete', { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reposId: '2', path: '', name: 'root.txt', type: 'file' }) });
    await wait(75);
    assert.equal((await f.request('/api/admin/users/reader/' + change, { user: 'admin', method: 'POST' })).body.ok, true);
    release(); await upload;
    assert.equal((await deletion).status, 401);
    assert.equal(f.calls.some(c => c.url === '/Doc/deleteDoc.do'), false);
  });
});

test('raw multipart decoding cannot substitute a different private upload target', async (t) => {
  const f = await privateQuotaFixture(t);
  for (const [label, name, contentType] of [
    ['BOM', '\uFEFFroot.txt', ''],
    ['UTF-16BE', 'root.txt', '\r\nContent-Type: text/plain; charset=UTF-16BE'],
  ]) {
    const raw = '--raw\r\nContent-Disposition: form-data; name="reposId"\r\n\r\n2\r\n'
      + '--raw\r\nContent-Disposition: form-data; name="name"' + contentType + '\r\n\r\n' + name + '\r\n'
      + '--raw\r\nContent-Disposition: form-data; name="path"\r\n\r\n\r\n'
      + '--raw\r\nContent-Disposition: form-data; name="uploadFile"; filename="root.txt"\r\n\r\nxxxxxxxxxx\r\n--raw--\r\n';
    const result = await f.request('/api/kb/upload?reposId=2', { user: 'reader', method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=raw' }, body: Buffer.from(raw) });
    assert.equal(result.status, 400, label);
  }
  assert.equal(f.calls.some(c => c.url === '/Doc/uploadDoc.do'), false);
});

test('an uncertain private write blocks later mutations across restart and permits reads and other repositories', async (t) => {
  let f, finishLate;
  const late = new Promise(resolve => { finishLate = resolve; });
  t.after(() => finishLate());
  f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
    if (req.url === '/Doc/uploadDoc.do') {
      res.destroy(); await late; f.files.set('late.txt', 4); return true;
    }
    return false;
  } });
  const first = await f.upload('late.txt', 4);
  assert.equal(first.body.ok, false);
  for (const restart of [false, true]) {
    if (restart) { await f.stop(); await f.start(); }
    assert.equal((await f.upload('next.txt', 4)).status, 503);
    for (const action of ['mkdir', 'rename', 'delete', 'move', 'priv-delete'])
      assert.equal((await f.request('/api/kb/' + action, { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reposId: '2', path: '', name: 'root.txt', type: 'file' }) })).status, 503, action);
    assert.equal((await f.request('/api/kb/repos', { user: 'reader' })).body.ok, true);
  }
  assert.equal(f.calls.filter(c => c.url === '/Doc/uploadDoc.do').length, 1);
  assert.equal((await f.request('/api/kb/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '1', path: '', name: 'unrelated' }) })).body.ok, true);
  finishLate(); await wait(30);
  assert.equal((await f.quota()).used, 20);
  assert.equal((await f.upload('next.txt', 4)).status, 503, 'a fresh scan alone does not settle the pending write');
});

test('private writes do not reach upstream when the durable pending record cannot be saved', async (t) => {
  const f = await privateQuotaFixture(t);
  fs.mkdirSync(path.join(f.dir, 'kb-pending-writes.json'));
  assert.equal((await f.upload('extra.txt', 4)).body.ok, false);
  assert.equal(f.calls.some(c => c.url === '/Doc/uploadDoc.do'), false);
});

test('a lost private move response also blocks later uploads', async (t) => {
  const f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
    if (req.url === '/Doc/moveDoc.do') { res.destroy(); return true; }
    return false;
  } });
  const moved = await f.request('/api/kb/move', { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '2', docId: '300', srcName: 'root.txt', dstName: 'root.txt', dstPath: 'folder/', srcPid: '0', dstPid: '200' }) });
  assert.equal(moved.body.ok, false);
  assert.match(moved.body.message, /结果待确认/);
  assert.equal((await f.upload('extra.txt', 4)).status, 503);
  assert.equal(f.calls.some(c => c.url === '/Doc/uploadDoc.do'), false);
});

test('a private write stays pending when its response or final usage cannot be verified', async (t) => {
  for (const failure of ['response', 'usage', 'clear-marker']) await t.test(failure, async (t) => {
    let wrote = false, f;
    f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
      if (req.url === '/Doc/uploadDoc.do') {
        wrote = true;
        if (failure === 'response') { res.end('{invalid'); return true; }
        if (failure === 'clear-marker') {
          fs.renameSync(path.join(f.dir, 'kb-pending-writes.json'), path.join(f.dir, 'pending-backup.json'));
          fs.mkdirSync(path.join(f.dir, 'kb-pending-writes.json'));
        }
      }
      if (wrote && failure === 'usage' && req.url === '/Repos/getSubDocList.do') { res.end('{}'); return true; }
      return false;
    } });
    assert.equal((await f.upload('extra.txt', 4)).status, 503);
    assert.equal((await f.upload('next.txt', 4)).status, 503);
    assert.equal(f.calls.filter(c => c.url === '/Doc/uploadDoc.do').length, 1);
  });
});

test('malformed persisted private write state refuses startup', async (t) => {
  for (const data of ['{broken', '[]', '{"2":null}']) await t.test(data, async (t) => {
    await assert.rejects(fixture(t, { setup(dir) { fs.writeFileSync(path.join(dir, 'kb-pending-writes.json'), data); } }), /kb-pending-writes.json/);
  });
});

test('private repository deletion authenticates upstream before recording a pending write', async (t) => {
  for (const failure of ['rejected', 'disconnected']) await t.test(failure, async (t) => {
    let rejectLogin = true, removed = false;
    const f = await privateQuotaFixture(t, { async handleUpstream(req, res, body) {
      const form = new URLSearchParams(body.toString());
      if (req.url === '/User/login.do' && form.get('userName') === 'admin' && rejectLogin) {
        if (failure === 'disconnected') res.destroy();
        else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'fail', msgInfo: 'synthetic login rejected' })); }
        return true;
      }
      if (req.url === '/Repos/deleteRepos.do') {
        removed = true; res.end(JSON.stringify({ status: 'ok' })); return true;
      }
      if (removed && req.url === '/Repos/getReposList.do') { res.end(JSON.stringify({ status: 'ok', data: [{ id: 1, name: 'test知识库' }] })); return true; }
      return false;
    } });
    await f.quota(); // Load the name used by the existing confirmation contract.
    const deletion = () => f.request('/api/kb/priv-delete', { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reposId: '2', confirm: 'private-test' }) });
    assert.equal((await deletion()).body.ok, false);
    assert.equal(f.calls.some(c => c.url === '/Repos/deleteRepos.do'), false);
    assert.equal((await f.upload('extra.txt', 4)).body.ok, true, 'a login failure must not strand the library');
    rejectLogin = false;
    assert.equal((await deletion()).body.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'kb-pending-writes.json'))), {});
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'kb-perms.json'))).repos[2], undefined);
  });
});

test('a completed partial upload failure is included in the next private quota calculation', async (t) => {
  let f, partial = true;
  f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
    if (partial && req.url === '/Doc/uploadDoc.do') {
      partial = false; f.files.set('root.txt', 10);
      res.end(JSON.stringify({ status: 'fail', msgInfo: 'synthetic post-write validation failure' })); return true;
    }
    return false;
  } });
  assert.equal((await f.upload('root.txt', 10)).body.ok, false);
  assert.equal((await f.quota()).used, 20);
  assert.equal((await f.upload('extra.txt', 1)).status, 400);
  assert.equal((await f.upload('root.txt', 6)).body.ok, true);
  assert.equal((await f.quota()).used, 16);
});

test('HTTP errors with plausible JSON leave private writes pending', async (t) => {
  for (const operation of ['upload', 'move', 'priv-delete']) await t.test(operation, async (t) => {
    const target = { upload: '/Doc/uploadDoc.do', move: '/Doc/moveDoc.do', 'priv-delete': '/Repos/deleteRepos.do' }[operation];
    const f = await privateQuotaFixture(t, { async handleUpstream(req, res) {
      if (req.url !== target) return false;
      res.statusCode = 502; res.end(JSON.stringify({ status: 'error' })); return true;
    } });
    await f.quota();
    const result = operation === 'upload' ? await f.upload('extra.txt', 4)
      : await f.request('/api/kb/' + operation, { user: 'reader', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reposId: '2', confirm: 'private-test', docId: '300', srcName: 'root.txt', dstName: 'root.txt', srcPid: '0', dstPid: '200' }) });
    assert.equal(result.body.ok, false);
    assert.match(result.body.message, /结果待确认/);
    assert.equal((await f.upload('extra.txt', 4)).status, 503);
  });
});

test('deleting a user persists before success and stays deleted after restart', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/users/reader', { user: 'admin', method: 'DELETE' })).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'users.json'))).some((u) => u.username === 'reader'), false);
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/auth/me', { user: 'reader' })).status, 401);
});

test('corrupt permission data refuses startup instead of silently granting fallback access', async (t) => {
  await assert.rejects(fixture(t, { corruptPolicy: true }), /kb-perms.json/);
});

test('a failed user save leaves the live user and permission state unchanged', async (t) => {
  const f = await fixture(t); const target = path.join(f.dir, 'users.json');
  fs.renameSync(target, target + '.original'); fs.mkdirSync(target);
  const result = await f.request('/api/admin/users/reader', { user: 'admin', method: 'DELETE' });
  assert.equal(result.body.ok, false);
  assert.equal((await f.request('/api/auth/me', { user: 'reader' })).body.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'kb-perms.json'))).repos[2].owner, 'reader');
  assert.equal(f.calls.some((c) => c.url.startsWith('/api/tokens')), false);
});

test('missing policy denies writes even before the repository list is cached', async (t) => {
  const f = await fixture(t);
  const denied = await f.request('/api/kb/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '999', path: '', name: 'test' }) });
  assert.equal(denied.body.ok, false);
  assert.equal(f.calls.some((c) => c.url.includes('/Doc/addDoc')), false);
  const allowed = await f.request('/api/kb/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '1', path: '', name: 'test' }) });
  assert.equal(allowed.body.ok, true);
});

test('legacy permission-off setting cannot expose another user private repository', async (t) => {
  const f = await fixture(t, { legacyOff: true });
  const result = await f.request('/api/kb/repos');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.repos.some((r) => String(r.id) === '2'), false);
});

test('upload binds a single body resource to a single query resource before any upstream write', async (t) => {
  const f = await fixture(t);
  const uploadCalls = () => f.calls.filter((c) => c.url.includes('/Doc/uploadDoc.do'));
  for (const [label, query, ids] of [['mismatch', '?reposId=1', ['2']], ['duplicate body', '?reposId=1', ['1', '2']],
    ['duplicate equal body', '?reposId=1', ['1', '1']], ['missing body', '?reposId=1', []],
    ['missing query', '', ['1']], ['duplicate query', '?reposId=1&reposId=1', ['1']],
    ['invalid ID', '?reposId=1', ['01']]]) {
    const fd = new FormData(); fd.append('uploadFile', new Blob(['test']), 'test.txt');
    for (const id of ids) fd.append('reposId', id);
    const r = await f.request('/api/kb/upload' + query, { method: 'POST', body: fd });
    assert.equal(r.body.ok, false, label);
    assert.equal(uploadCalls().length, 0, label + ' must not reach upstream');
  }
  const fd = new FormData(); fd.append('reposId', '1'); fd.append('path', '');
  fd.append('uploadFile', new Blob(['valid content']), 'test.txt');
  assert.equal((await f.request('/api/kb/upload?reposId=1', { method: 'POST', body: fd })).body.ok, true);
  assert.equal(uploadCalls().length, 1);
  assert.match(uploadCalls()[0].body.toString(), /valid content/);
});

test('oversized and malformed uploads are rejected without forwarding', async (t) => {
  const f = await fixture(t, { maxBytes: 2048 });
  const fd = new FormData(); fd.append('reposId', '1'); fd.append('uploadFile', new Blob(['x'.repeat(4096)]), 'big.txt');
  assert.equal((await f.request('/api/kb/upload?reposId=1', { method: 'POST', body: fd })).status, 413);
  const malformed = '--b\r\nContent-Disposition: form-data; name="reposId"\r\n\r\n1\r\n--b';
  assert.equal((await f.request('/api/kb/upload?reposId=1', { method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=b' }, body: malformed })).body.ok, false);
  assert.equal(f.calls.some((c) => c.url.includes('/Doc/uploadDoc.do')), false);
});

test('legacy recommendation votes and star ratings retain their intent; public lists redact identities', async (t) => {
  const f = await fixture(t);
  for (const [input, expected] of [[{ vote: 1 }, 1], [{ vote: -1 }, -1], [{ stars: 5 }, 1], [{ stars: 2 }, -1]]) {
    const saved = await f.request('/api/evals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'audit-fixture', ...input }) });
    assert.equal(saved.body.ok, true);
    const detail = await f.request('/api/evals?target=audit-fixture');
    assert.equal(detail.body.mine.v, expected);
  }
  const all = await f.request('/api/evals/all?target=audit-fixture', { headers: { Authorization: '' } });
  assert.equal(all.body.items.length, 1);
  assert.equal('ip' in all.body.items[0], false);
  assert.equal('u' in all.body.items[0], false);
  const admin = await f.request('/api/evals/all?target=audit-fixture', { user: 'admin' });
  assert.equal(admin.body.items[0].u, 'writer');
  assert.equal((await f.request('/api/evals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'audit-fixture' }) })).body.ok, false);
});

test('knowledge previews isolate active content and render Markdown as safe text and links', async (t) => {
  const f = await fixture(t, { previewContent: '# Heading\n**bold**\n<script>window.pwned=true</script>\n<img src=x onerror=alert(1)>\n[bad](javascript:alert)\n[encoded](jav&#x61;script:alert)\n[relative](guide.md)\n[good](https://example.com/a?q=1&b=2)\n[quote](https://example.com/"onclick="alert)' });
  const md = await f.request('/api/kb/preview?reposId=1&name=test.md', { raw: true });
  assert.equal(md.status, 200);
  assert.match(md.body, /<h2>Heading<\/h2>/);
  assert.match(md.body, /<b>bold<\/b>/);
  const { JSDOM } = require('jsdom');
  const document = new JSDOM(md.body).window.document;
  assert.equal(document.querySelectorAll('script, img, [onclick], [onerror]').length, 0);
  const links = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'));
  assert.ok(links.includes('guide.md'));
  assert.ok(links.includes('https://example.com/a?q=1&b=2'));
  assert.ok(links.includes('https://example.com/"onclick="alert'));
  for (const href of links) assert.ok(['http:', 'https:', 'mailto:'].includes(new URL(href, 'https://preview.invalid/').protocol));
  for (const name of ['test.md', 'test.txt', 'test.svg', 'test.svg&raw=1']) {
    const response = await f.request('/api/kb/preview?reposId=1&name=' + name, { raw: true });
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /(?:^|;\s*)sandbox(?: allow-popups allow-popups-to-escape-sandbox)?\s*;/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});

function seedChannelPermissions(dir) {
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json')));
  users.push({ ...users.find(u => u.username === 'reader'), username: 'observer', name: 'observer' });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  fs.writeFileSync(path.join(dir, 'apihub.json'), JSON.stringify({ systems: {}, interfaces: {
    owned: { id: 'owned', sysId: 'example', method: 'GET', path: '/example', title: '权限测试接口', desc: '', auth: '',
      state: 'cloud', up: '127.0.0.1:9000', owner: 'writer', ownerName: 'writer', params: [], errs: [], callers: [], createdAt: 1, updatedAt: 1 },
  }, channels: { owned: { ifId: 'owned', createdBy: 'reader', port: 18000, up: '127.0.0.1:9000', createdAt: 1 } }, dynamics: [], audit: [] }));
}

test('channel disable permissions protect tunnel configuration and persisted state', async (t) => {
  for (const [user, expected] of [['admin', 200], ['writer', 200], ['reader', 200], ['observer', 403], ['anonymous', 401]]) {
    await t.test(user, async (t) => {
      const f = await fixture(t, { setup: seedChannelPermissions });
      const before = fs.readFileSync(path.join(f.dir, 'apihub.json'), 'utf8');
      if (user !== 'anonymous') {
        const state = await f.request('/api/apihub/state', { user });
        assert.equal(state.body.channels.length, 1, 'all signed-in users can still view channels');
      }
      const result = await f.request('/api/apihub/channels/owned', { user, method: 'DELETE',
        headers: user === 'anonymous' ? { Authorization: '' } : {} });
      assert.equal(result.status, expected);
      if (expected !== 200) {
        assert.equal(result.body.ok, false);
        assert.equal(fs.readFileSync(path.join(f.dir, 'apihub.json'), 'utf8'), before);
        assert.equal(f.calls.some(c => c.url === '/api/config' || c.url === '/api/reload'), false);
      } else {
        assert.equal(result.body.ok, true);
        assert.equal(f.calls.filter(c => c.url === '/api/config').length, 2);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'apihub.json'))).channels, {});
      }
    });
  }
});

test('browser renders complete admin stats and recovers after a failed page', { skip: !process.env.ZEB_BROWSER, timeout: 30000 }, async (t) => {
  let failPage = true, empty = false, held = false, releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  t.after(() => releaseFirst());
  const f = await fixture(t, { async handleUpstream(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!['/api/token/', '/api/log/'].includes(url.pathname)) return false;
    const page = Number(url.searchParams.get('p'));
    const size = Number(url.searchParams.get('size')) || 10;
    if (!held) { held = true; await firstGate; }
    if (failPage && page === 1) { res.writeHead(503); res.end('test failure'); return true; }
    const rows = Array.from({ length: empty ? 0 : 621 }, (_, id) => url.pathname === '/api/token/'
      ? { id, name: id === 620 ? 'writer' : `fixture-${id}`, status: 1, daily_used_tokens: 2 }
      : { id, token_name: 'writer', model_name: 'fixture-model', prompt_tokens: 1, completion_tokens: 1, created_at: Math.floor(Date.now() / 1000) - 10 });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: rows.slice(page * size, (page + 1) * size), total: rows.length }));
    return true;
  } });
  const browser = await require('puppeteer-core').launch({ executablePath: process.env.ZEB_BROWSER, headless: true, timeout: 15000 });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setViewport({ width: 1440, height: 1100 });
  await page.setRequestInterception(true);
  page.on('request', req => req.url().startsWith(f.base + '/') || req.url().startsWith('data:') ? req.continue() : req.abort());
  await page.evaluateOnNewDocument(token => {
    localStorage.setItem('skillharbor-token', token);
    localStorage.setItem('skillharbor-session', JSON.stringify({ username: 'admin', name: 'admin', role: 'admin', dept: 'test', loginAt: Date.now() }));
  }, f.token('admin'));
  await page.goto(f.base + '/#/admin?view=ops');
  await page.waitForSelector('.splash', { hidden: true });
  await page.waitForSelector('[role="status"]');
  assert.match(await page.$eval('[role="status"]', node => node.textContent), /正在读取完整统计/);
  releaseFirst();
  await page.waitForFunction(() => /服务不可用|统计未完成/.test(document.body.textContent));
  await page.setViewport({ width: 1024, height: 1100 });
  if (process.env.ZEB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ZEB_SCREENSHOT_DIR, 'ops-error.png') });
  assert.match(await page.$eval('body', node => node.textContent), /统计未完成/);
  assert.equal(await page.$$eval('[title="0"]', nodes => nodes.length), 0, 'failed stats must not render a zero-valued chart');
  failPage = false;
  await page.setViewport({ width: 1440, height: 1100 });
  const retry = await page.waitForSelector('button::-p-text(重试统计)'); await retry.click();
  await page.waitForFunction(() => document.body.textContent.includes('今日 1,242 tokens'));
  assert.equal(await page.$eval('[title="1,242"]', node => !!node), true);
  assert.ok(await page.$('::-p-text(fixture-model)'));
  assert.doesNotMatch(await page.$eval('body', node => node.textContent), /统计未完成/);
  if (process.env.ZEB_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.ZEB_SCREENSHOT_DIR, 'ops-complete.png') });
  empty = true;
  await page.reload();
  await page.waitForFunction(() => document.body.textContent.includes('今日 0 tokens'));
  assert.equal(await page.$('[role="alert"]'), null);
  assert.ok(await page.$('::-p-text(今天还没有调用记录。)'));
});

test('browser shows channel actions only to authorized users and preserves confirmation', { skip: !process.env.ZEB_BROWSER, timeout: 30000 }, async (t) => {
  const f = await fixture(t, { setup: seedChannelPermissions });
  const browser = await require('puppeteer-core').launch({ executablePath: process.env.ZEB_BROWSER, headless: true, timeout: 15000 });
  t.after(() => browser.close());
  for (const username of ['observer', 'admin', 'reader', 'writer']) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    t.diagnostic(`checking channel view as ${username}`);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setRequestInterception(true);
    page.on('request', req => req.url().startsWith(f.base + '/') || req.url().startsWith('data:') ? req.continue() : req.abort());
    await page.evaluateOnNewDocument(({ username, token }) => {
      localStorage.setItem('skillharbor-token', token);
      localStorage.setItem('skillharbor-session', JSON.stringify({ username, name: username,
        role: username === 'admin' ? 'admin' : 'user', dept: 'test', loginAt: Date.now() }));
    }, { username, token: f.token(username) });
    await page.goto(f.base + '/#/apihub');
    await page.waitForSelector('.splash', { hidden: true });
    const nav = await page.waitForSelector('::-p-text(我的接入)');
    await nav.click();
    await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('127.0.0.1:18000'));
    await page.waitForFunction(() => [...document.querySelectorAll('.page-enter')].every(node => getComputedStyle(node).opacity === '1'));
    const buttons = await page.$$('tbody button');
    assert.equal(buttons.length, username === 'observer' ? 0 : 1, username);
    if (process.env.ZEB_SCREENSHOT_DIR && ['observer', 'writer'].includes(username)) {
      await page.screenshot({ path: path.join(process.env.ZEB_SCREENSHOT_DIR, `apihub-${username}.png`), fullPage: true });
    }
    if (username === 'writer') {
      const cancel = new Promise((resolve, reject) => page.once('dialog', async dialog => {
        try { assert.match(dialog.message(), /云侧调用将立即中断/); await dialog.dismiss(); resolve(); } catch (e) { reject(e); }
      }));
      await buttons[0].click(); await cancel;
      assert.equal(f.calls.some(c => c.url === '/api/config'), false);
      assert.equal(await page.$eval('tbody', node => node.textContent.includes('127.0.0.1:18000')), true);
      const response = page.waitForResponse(r => r.url() === f.base + '/api/apihub/channels/owned' && r.request().method() === 'DELETE');
      page.once('dialog', dialog => dialog.accept());
      await buttons[0].click();
      assert.equal((await (await response).json()).ok, true);
      await page.waitForFunction(() => !document.querySelector('tbody')?.textContent.includes('127.0.0.1:18000'));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'apihub.json'))).channels, {});
    }
    await page.close();
  }
});

test('channel deletion keeps its route identity while another request completes', async (t) => {
  let entered, release;
  const arrived = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  t.after(() => release());
  const f = await fixture(t, { setup(dir) {
    fs.writeFileSync(path.join(dir, 'apihub.json'), JSON.stringify({ systems: {}, interfaces: {
      owned: { id: 'owned', title: 'Fixture', state: 'cloud', owner: 'writer' },
    }, channels: { owned: { ifId: 'owned', createdBy: 'writer', port: 18000 } }, dynamics: [], audit: [] }));
  }, async handleUpstream(req, res) {
    if (req.url === '/api/config' && req.method === 'GET') {
      entered(); await barrier; res.end('\n[[proxies]]\nname = "apihub-owned"\n'); return true;
    }
  } });
  const deletion = f.request('/api/apihub/channels/owned', { method: 'DELETE' });
  await arrived;
  await f.request('/api/evals?target=unrelated');
  release();
  assert.equal((await deletion).body.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'apihub.json'))).channels, {});
});

test('department rename preserves shared read access and updates every owned repository', async (t) => {
  const f = await fixture(t, { setup(dir) {
    fs.writeFileSync(path.join(dir, 'depts.json'), JSON.stringify([{ name: 'test', head: '' }, { name: 'other', head: '' }]));
    fs.writeFileSync(path.join(dir, 'kb-perms.json'), JSON.stringify({ repos: {
      1: { tier: 'dept', dept: 'other', readDepts: ['test'], maintSet: true, maintainers: [] },
      2: { tier: 'dept', dept: 'test', maintSet: true, maintainers: [] },
      3: { tier: 'dept', dept: 'test', maintSet: true, maintainers: [] },
      orphan: null,
    } }));
  } });
  const renamed = await f.request('/api/admin/org/dept-rename', { user: 'admin', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test', newName: 'renamed' }) });
  assert.equal(renamed.body.ok, true);
  const repos = (await f.request('/api/kb/repos')).body.repos;
  assert.equal(repos.some(r => String(r.id) === '1'), true);
  assert.equal((await f.request('/api/kb/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reposId: '1', name: 'denied' }) })).body.ok, false);
  const cfg = JSON.parse(fs.readFileSync(path.join(f.dir, 'kb-perms.json'))).repos;
  assert.deepEqual(cfg[1].readDepts, ['renamed']);
  assert.equal(cfg[2].dept, 'renamed'); assert.equal(cfg[3].dept, 'renamed');
});

test('upload garbage collection preserves service recovery snapshots but removes stale orphan uploads', async (t) => {
  const f = await fixture(t, { setup(dir) {
    const stage = path.join(dir, 'tmp', 'svc-data');
    fs.mkdirSync(path.join(stage, 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'fixture', 'data.json'), '{"keep":true}');
    const orphan = path.join(dir, 'tmp', 'stale-orphan'); fs.mkdirSync(orphan);
    const old = new Date(Date.now() - 8 * 86400000);
    fs.utimesSync(stage, old, old); fs.utimesSync(orphan, old, old);
  } });
  for (let i = 0; i < 50 && fs.existsSync(path.join(f.dir, 'tmp', 'stale-orphan')); i++) await wait(50);
  assert.equal(fs.existsSync(path.join(f.dir, 'tmp', 'stale-orphan')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'tmp', 'svc-data', 'fixture', 'data.json'), 'utf8'), '{"keep":true}');
});

test('service rollback persists the selected image across restart and offline/online transitions', async (t) => {
  const f = await fixture(t, { setup(dir) {
    for (const [name, value] of Object.entries({
      'uploads.json': [{ id: 'fixture', kind: 'service', status: 'online' }],
      'extraTools.json': [{ id: 'fixturetool', uploadId: 'fixture', type: 'service', status: 'online', name: 'Fixture' }],
      'services.json': { ufixture: { image: 'skillharbor-svc-ufixture:v2', port: 18200, containerPort: 3000 } },
    })) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    const base = path.join(dir, 'uploads', 'releases', 'ufixture');
    for (const v of ['v1', 'v2']) fs.mkdirSync(path.join(base, v), { recursive: true });
    fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify({ current: 'v2', versions: [{ v: 1 }, { v: 2 }] }));
  } });
  assert.equal((await f.request('/api/admin/uploads/fixture/rollback', { user: 'admin', method: 'POST' })).body.ok, true);
  await f.stop(); await f.start();
  for (const status of ['offline', 'online']) {
    assert.equal((await f.request('/api/admin/tools/fixturetool/status', { user: 'admin', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })).body.ok, true);
  }
  const services = await f.request('/api/admin/services', { user: 'admin' });
  assert.equal(services.body.rows[0].image, 'skillharbor-svc-ufixture:v1');
});

test('concurrent channel mutations preserve both database and tunnel updates', async (t) => {
  let entered, release, config = '\n[[proxies]]\nname = "apihub-first"\n\n[[proxies]]\nname = "apihub-second"\n';
  const arrived = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  t.after(() => release());
  const f = await fixture(t, { setup(dir) {
    fs.writeFileSync(path.join(dir, 'apihub.json'), JSON.stringify({ systems: {}, interfaces: Object.fromEntries(
      ['first', 'second'].map(id => [id, { id, title: id, state: 'cloud', owner: 'writer' }])
    ), channels: { first: { port: 18000 }, second: { port: 18001 } }, dynamics: [], audit: [] }));
  }, async handleUpstream(req, res, body) {
    if (req.url !== '/api/config') return false;
    if (req.method === 'GET') { const snapshot = config; entered(); await barrier; res.end(snapshot); }
    else { config = body.toString(); res.end('ok'); }
    return true;
  } });
  const first = f.request('/api/apihub/channels/first', { method: 'DELETE' });
  await arrived;
  const second = f.request('/api/apihub/channels/second', { method: 'DELETE' });
  await wait(75); release();
  for (const result of await Promise.all([first, second])) assert.equal(result.body.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'apihub.json'))).channels, {});
  assert.doesNotMatch(config, /apihub-(first|second)/);
});

test('a queued disconnected client does not block later ApiHub mutations', async (t) => {
  let entered, release;
  const arrived = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  t.after(() => release());
  const f = await fixture(t, { setup(dir) {
    fs.writeFileSync(path.join(dir, 'apihub.json'), JSON.stringify({ systems: {}, interfaces: {
      owned: { id: 'owned', state: 'cloud', owner: 'writer' },
    }, channels: { owned: { port: 18000 } }, dynamics: [], audit: [] }));
  }, async handleUpstream(req, res) {
    if (req.url === '/api/config' && req.method === 'GET') { entered(); await barrier; res.end(''); return true; }
  } });
  const first = f.request('/api/apihub/channels/owned', { method: 'DELETE' }); await arrived;
  const abandoned = http.request(f.base + '/api/apihub/interfaces', { method: 'POST', headers: {
    Authorization: 'Bearer ' + f.token('writer'), 'Content-Type': 'application/json', 'Content-Length': '200',
  } });
  abandoned.on('error', () => {}); abandoned.write('{'); await wait(75);
  abandoned.destroy(); await wait(75); release();
  assert.equal((await first).body.ok, true);
  const last = await f.request('/api/apihub/interfaces/owned', { method: 'DELETE', signal: AbortSignal.timeout(3000) });
  assert.equal(last.body.ok, true);
});

test('browser enforces preview isolation while safe Markdown links and images work', { skip: !process.env.ZEB_BROWSER, timeout: 30000 }, async (t) => {
  const f = await fixture(t, { previewContent: '# Preview fixture\n**Readable content**\n<script>window.pwned=true</script>\n[Open safe link](/api/auth/me)',
    async handleUpstream(req, res) {
      if (!req.url.includes('/Doc/downloadDoc.do')) return false;
      const name = Buffer.from(new URL(req.url, 'http://localhost').searchParams.get('targetName'), 'base64').toString();
      if (name !== 'test.svg') return false;
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>window.pwned=true</script><rect width="100" height="100" fill="green"/></svg>');
      return true;
    } });
  const browser = await require('puppeteer-core').launch({ executablePath: process.env.ZEB_BROWSER, headless: true, timeout: 15000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const url = (name, raw = '') => f.base + '/api/kb/preview?reposId=1&name=' + name + raw + '&token=' + f.token('writer');
  await page.goto(url('test.md'));
  assert.equal(await page.$eval('h2', node => node.textContent), 'Preview fixture');
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.evaluate(() => { try { localStorage.setItem('unsafe', '1'); return true; } catch { return false; } }), false);
  // rel=noreferrer intentionally removes the opener, so observe browser targets rather than page popup events.
  const opened = browser.waitForTarget(target => target.url() === f.base + '/api/auth/me', { timeout: 5000 });
  await page.click('a'); const popup = await (await opened).page();
  assert.ok(popup.url().includes('/api/auth/me')); await popup.close();
  await page.setViewport({ width: 390, height: 844 });
  if (process.env.ZEB_SCREENSHOT) await page.screenshot({ path: process.env.ZEB_SCREENSHOT, fullPage: true });
  await page.goto(url('test.svg'));
  await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 100);
  await page.goto(url('test.svg', '&raw=1'));
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.evaluate(() => { try { localStorage.getItem('unsafe'); return true; } catch { return false; } }), false);
});


test('knowledge search keeps same-name documents in different repositories and fuses only their own sources', async (t) => {
  const f = await fixture(t, { async handleUpstream(req, res) {
    if (req.url === '/Doc/searchDoc.do') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', data: [1, 2].map(vid => ({ vid, name: 'shared.txt', path: 'folder/', content: Buffer.from('keyword-' + vid).toString('base64') })) })); return true;
    }
    if (req.url.startsWith('/api/kb/semantic-search')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mode: 'semantic', items: [{ vid: 2, name: 'shared.txt', path: 'folder', preview: 'semantic-two' }] })); return true;
    }
  } });
  const result = await f.request('/api/kb/search?q=shared', { user: 'reader' });
  assert.equal(result.body.ok, true);
  assert.equal(result.body.items.length, 2);
  const first = result.body.items.find(x => x.reposId === '1');
  const second = result.body.items.find(x => x.reposId === '2');
  assert.equal(first.preview, 'keyword-1');
  assert.deepEqual(first.sources, ['keyword']);
  assert.equal(second.preview, 'keyword-2');
  assert.deepEqual(second.sources, ['keyword', 'semantic']);
});


test('knowledge search filters inaccessible and unidentified hits before taking the keyword page', async (t) => {
  const f = await fixture(t, { async handleUpstream(req, res) {
    if (req.url === '/Doc/searchDoc.do') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', data: [
        { name: 'unknown.txt', path: '' },
        ...Array.from({ length: 20 }, (_, i) => ({ vid: 99, name: 'hidden-' + i, path: '' })),
        { vid: 1, name: 'visible.txt', path: '', content: Buffer.from('visible').toString('base64') },
      ] })); return true;
    }
    if (req.url.startsWith('/api/kb/semantic-search')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mode: 'semantic', items: [{ vid: 99, name: 'visible.txt', path: '' }, { name: 'unknown-semantic.txt' }] })); return true;
    }
  } });
  const result = await f.request('/api/kb/search?q=visible');
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.items.map(x => [x.reposId, x.name, x.sources]), [['1', 'visible.txt', ['keyword']]]);
});


test('knowledge search retains keyword results when semantic upstream is unavailable', async (t) => {
  const f = await fixture(t, { async handleUpstream(req, res) {
    if (req.url === '/Doc/searchDoc.do') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', data: [{ vid: 1, name: 'fallback.txt', path: '' }] })); return true;
    }
    if (req.url.startsWith('/api/kb/semantic-search')) { res.writeHead(503).end('unavailable'); return true; }
  } });
  const result = await f.request('/api/kb/search?q=fallback');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.mode, 'keyword');
  assert.equal(result.body.items[0].name, 'fallback.txt');
});


const alertTimerPreload = `
let poll;
for (const key of ['setTimeout', 'setInterval']) {
  const original = global[key];
  global[key] = (fn, ...args) => {
    if (fn.name === 'pollGatewayAlerts') { poll = fn; return { unref() {} }; }
    return original(fn, ...args);
  };
}
process.on('message', async message => {
  if (message.op !== 'poll') return;
  try { await poll(); process.send({ id: message.id }); }
  catch (error) { process.send({ id: message.id, error: error.message }); }
});
`;

test('scheduled alerts keep the sixth and seventh notification pending for the next poll', async (t) => {
  const delivered = [];
  const f = await fixture(t, { preload: alertTimerPreload, env: { DISABLE_ALERT_POLL: '0' },
    afterListen(dir, up) { fs.writeFileSync(path.join(dir, 'alert-webhook.json'), JSON.stringify({ url: up + '/webhook' })); },
    async handleUpstream(req, res, body) {
      if (req.url === '/api/alerts?status=open') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ id: 'a' + i, subject: 'subject-' + i })))); return true;
      }
      if (req.url === '/webhook') {
        delivered.push(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end('{"code":0}'); return true;
      }
    }
  });
  await f.invoke({ op: 'poll' });
  assert.equal(delivered.length, 5);
  await f.invoke({ op: 'poll' });
  assert.equal(delivered.length, 7);
  await f.stop(); await f.start(); await f.invoke({ op: 'poll' });
  assert.equal(delivered.length, 7, 'successful notifications remain seen after restart');
});


test('scheduled alerts rotate failed attempts so the sixth alert is not starved', async (t) => {
  const attempted = [];
  const f = await fixture(t, { preload: alertTimerPreload, env: { DISABLE_ALERT_POLL: '0' },
    afterListen(dir, up) { fs.writeFileSync(path.join(dir, 'alert-webhook.json'), JSON.stringify({ url: up + '/webhook' })); },
    async handleUpstream(req, res, body) {
      if (req.url === '/api/alerts?status=open') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: 'a' + i, subject: 'subject-' + i })))); return true;
      }
      if (req.url === '/webhook') {
        const id = JSON.parse(body).card.elements[0].fields[2].text.content.split('\n')[1]; attempted.push(id);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: id === 'subject-5' ? 0 : 1 })); return true;
      }
    }
  });
  await f.invoke({ op: 'poll' });
  assert.equal(attempted.length, 5);
  await f.invoke({ op: 'poll' });
  assert.equal(attempted.length, 10, 'five attempts maximum per poll');
  assert.ok(attempted.includes('subject-5'), 'failed prefix cannot permanently starve later alerts');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'alerts-seen.json'))).ids, ['a5']);
});


test('scheduled alerts serialize overlapping polls and deduplicate IDs within a response', async (t) => {
  let entered, release, polls = 0, sent = 0;
  const arrived = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  t.after(() => release());
  const f = await fixture(t, { preload: alertTimerPreload, env: { DISABLE_ALERT_POLL: '0' },
    afterListen(dir, up) { fs.writeFileSync(path.join(dir, 'alert-webhook.json'), JSON.stringify({ url: up + '/webhook' })); },
    async handleUpstream(req, res) {
      if (req.url === '/api/alerts?status=open') {
        polls++; entered(); await barrier;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{ id: 'one' }, { id: 'one' }, {}, null, { id: '' }])); return true;
      }
      if (req.url === '/webhook') { sent++; res.setHeader('Content-Type', 'application/json'); res.end('{"code":0}'); return true; }
    }
  });
  const first = f.invoke({ op: 'poll' }); await arrived;
  const second = f.invoke({ op: 'poll' });
  await wait(80); release(); await Promise.all([first, second]);
  assert.equal(polls, 1, 'overlapping timer ticks do not enter the poll twice');
  assert.equal(sent, 1);
});


for (const hangingTarget of ['gateway', 'webhook']) test(`scheduled alerts recover after a hanging ${hangingTarget} request`, async (t) => {
  let hang = true, sent = 0;
  const f = await fixture(t, { preload: alertTimerPreload + `
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = ms => timeout(ms === 8000 || ms === 10000 ? 80 : ms);
`, env: { DISABLE_ALERT_POLL: '0' },
    afterListen(dir, up) { fs.writeFileSync(path.join(dir, 'alert-webhook.json'), JSON.stringify({ url: up + '/webhook' })); },
    async handleUpstream(req, res) {
      if (req.url === '/api/alerts?status=open') {
        if (hang && hangingTarget === 'gateway') return true;
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ id: 'retry' }])); return true;
      }
      if (req.url === '/webhook') {
        if (hang && hangingTarget === 'webhook') return true;
        sent++; res.setHeader('Content-Type', 'application/json'); res.end('{"code":0}'); return true;
      }
    }
  });
  await f.invoke({ op: 'poll' });
  assert.equal(sent, 0);
  hang = false; await f.invoke({ op: 'poll' });
  assert.equal(sent, 1, 'timeout releases the poll lock and leaves the alert retryable');
});


for (const failure of ['http', 'business', 'disconnect']) test(`scheduled alerts retry ${failure} failures and retain seen IDs after archive and reopen`, async (t) => {
  let failing = true, listed = true, attempts = 0;
  const f = await fixture(t, { preload: alertTimerPreload, env: { DISABLE_ALERT_POLL: '0' },
    afterListen(dir, up) { fs.writeFileSync(path.join(dir, 'alert-webhook.json'), JSON.stringify({ url: up + '/webhook' })); },
    async handleUpstream(req, res) {
      if (req.url === '/api/alerts?status=open') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(listed ? [{ id: 'retry' }] : [])); return true;
      }
      if (req.url === '/webhook') {
        attempts++;
        if (failing && failure === 'disconnect') { req.socket.destroy(); return true; }
        res.writeHead(failing && failure === 'http' ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: failing && failure === 'business' ? 1 : 0 })); return true;
      }
    }
  });
  await f.invoke({ op: 'poll' });
  assert.equal(fs.existsSync(path.join(f.dir, 'alerts-seen.json')), false);
  failing = false; await f.invoke({ op: 'poll' });
  assert.equal(attempts, 2);
  listed = false; await f.invoke({ op: 'poll' });
  await f.stop(); await f.start(); listed = true; await f.invoke({ op: 'poll' });
  assert.equal(attempts, 2, 'a temporary absence cannot forget successful delivery');
});

test('scheduled alerts without a configured webhook stay pending until configuration is restored', async (t) => {
  let webhook, sent = 0;
  const f = await fixture(t, { preload: alertTimerPreload, env: { DISABLE_ALERT_POLL: '0' },
    afterListen(dir, up) { webhook = up + '/webhook'; },
    async handleUpstream(req, res) {
      if (req.url === '/api/alerts?status=open') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ id: 'pending' }])); return true;
      }
      if (req.url === '/webhook') { sent++; res.setHeader('Content-Type', 'application/json'); res.end('{"code":0}'); return true; }
    }
  });
  await f.invoke({ op: 'poll' });
  assert.equal(sent, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'alerts-seen.json')), false);
  await f.stop(); fs.writeFileSync(path.join(f.dir, 'alert-webhook.json'), JSON.stringify({ url: webhook }));
  await f.start(); await f.invoke({ op: 'poll' }); assert.equal(sent, 1);
});

// CLI boundary fake: never executes Docker or any other external command.
const lifecycleDockerPreload = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.DATA_DIR;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('Unexpected non-loopback fetch: ' + url.hostname);
  if (url.port === '18200' || url.port === '18201') {
    fs.appendFileSync(path.join(dir, 'probes.jsonl'), JSON.stringify(url.href) + '\\n');
    return realFetch(process.env.LIFECYCLE_PROBE_URL + url.pathname, options);
  }
  return realFetch(input, options);
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const controlFile = path.join(dir, 'docker-control.json');
  const control = JSON.parse(fs.readFileSync(controlFile));
  if (path.basename(to) === 'uploads.json' && control.failSaveUploads) {
    control.failSaveUploads = false; fs.writeFileSync(controlFile, JSON.stringify(control));
    throw new Error('injected upload state save failure');
  }
  return rename(from, to);
};
require('node:child_process').execFile = (file, args, opts, callback) => {
  if (file !== 'docker') throw new Error('Unexpected external command: ' + file);
  fs.appendFileSync(path.join(dir, 'commands.jsonl'), JSON.stringify(args) + '\\n');
  const finish = () => {
    const control = JSON.parse(fs.readFileSync(path.join(dir, 'docker-control.json')));
    const message = control[args[0] + 'Error'];
    const error = message ? Object.assign(new Error(message), { killed: !!control.killed }) : null;
    setImmediate(() => { callback(error, '', message || ''); fs.appendFileSync(path.join(dir, 'completed-commands.jsonl'), JSON.stringify(args) + '\\n'); });
  };
  const control = JSON.parse(fs.readFileSync(path.join(dir, 'docker-control.json')));
  if (control.hold === args[0]) {
    const timer = setInterval(() => {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'docker-control.json'))).hold === args[0]) return;
      clearInterval(timer); finish();
    }, 10);
  } else finish();
};
`;
async function lifecycleFixture(t, status = 'offline', setup) {
  const env = { SERVICE_DOCKER: '', DISABLE_ALERT_POLL: '1', PORTAL_URL: 'http://127.0.0.1', FILES_BASE: 'http://127.0.0.1' };
  const f = await fixture(t, { preload: lifecycleDockerPreload, env, afterListen(dir, up) { env.LIFECYCLE_PROBE_URL = up; }, setup(dir) {
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('docker-control.json', {});
    const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json')));
    users.push({ ...users[0], username: 'secondadmin' }); write('users.json', users);
    fs.mkdirSync(path.join(dir, 'tmp', 'update'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tmp/update/Dockerfile'), 'FROM scratch');
    write('uploads.json', [{ id: 'fixture', kind: 'service', status }, { id: 'update', kind: 'service', status: 'pending', updateOf: 'tool:fixturetool' }, { id: 'other', kind: 'service', status: 'offline' }]);
    write('extraTools.json', [{ id: 'fixturetool', uploadId: 'fixture', type: 'service', status, name: 'Fixture' },
      { id: 'othertool', uploadId: 'other', type: 'service', status: 'offline' }, { id: 'manual', type: 'service', status: 'offline', manual: true }, { id: 'ordinary', type: 'external', status: 'offline' }]);
    write('services.json', Object.fromEntries(['fixture', 'other'].map(id => ['u' + id, { image: 'skillharbor-svc-u' + id + ':v2', port: id === 'fixture' ? 18200 : 18201, containerPort: 3000 }])));
    for (const id of ['fixture', 'other']) {
      const base = path.join(dir, 'uploads', 'releases', 'u' + id);
      for (const v of ['v1', 'v2']) fs.mkdirSync(path.join(base, v), { recursive: true });
      fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify({ current: 'v2', versions: [{ v: 1 }, { v: 2 }] }));
      const stage = path.join(dir, 'tmp', 'svc-data', 'u' + id); fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'data.json'), '{"sentinel":"recovery"}');
    }
    if (setup) setup(dir);
  } });
  f.control = value => fs.writeFileSync(path.join(f.dir, 'docker-control.json'), JSON.stringify(value));
  f.commands = () => fs.existsSync(path.join(f.dir, 'commands.jsonl')) ? fs.readFileSync(path.join(f.dir, 'commands.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  f.post = (url, body) => f.request('/api/admin/' + url, { user: 'admin', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  f.state = () => ['extraTools.json', 'uploads.json'].map(name => JSON.parse(fs.readFileSync(path.join(f.dir, name)))[0]);
  return f;
}

test('service lifecycle start failure stays offline on HTTP, disk and restart; explicit retry recovers', async t => {
  const f = await lifecycleFixture(t);
  f.control({ startError: 'injected start failure' });
  const failed = await f.post('tools/fixturetool/status', { status: 'online' });
  assert.equal(failed.body.ok, false);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.ok(failed.status >= 400);
  assert.match(JSON.stringify(failed.body), /injected start failure/);
  const rows = await f.request('/api/admin/tools', { user: 'admin' });
  assert.equal(rows.body.extra.find(x => x.id === 'fixturetool').status, 'offline');
  assert.equal(fs.readFileSync(path.join(f.dir, 'tmp/svc-data/ufixture/data.json'), 'utf8'), '{"sentinel":"recovery"}');
  await f.stop(); await f.start();
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  f.control({});
  assert.equal((await f.post('tools/fixturetool/status', { status: 'online' })).body.ok, true);
  assert.deepEqual(f.state().map(x => x.status), ['online', 'online']);
});

async function waitForDocker(f, command) {
  for (let i = 0; i < 200; i++) { if (f.commands().some(args => args[0] === command)) return; await wait(10); }
  assert.fail('Docker fake did not reach ' + command);
}

test('service lifecycle same status is idempotent, manual services avoid Docker, invalid/deleted tools cannot revive', async t => {
  const f = await lifecycleFixture(t, 'online');
  assert.equal((await f.post('tools/fixturetool/status', { status: 'online' })).body.ok, true);
  assert.equal((await f.post('tools/fixturetool/status', { status: 'bogus' })).status, 400);
  for (const status of ['online', 'offline']) assert.equal((await f.post('tools/manual/status', { status })).body.ok, true);
  assert.equal((await f.post('tools/manual/delete')).body.ok, true);
  assert.equal((await f.post('tools/manual/status', { status: 'online' })).body.ok, false);
  const builtin = JSON.parse(fs.readFileSync(path.join(ROOT, 'server-seed-tools.json')))[0].id;
  assert.equal((await f.post('tools/' + builtin + '/delete')).body.ok, true);
  assert.equal((await f.post('tools/' + builtin + '/status', { status: 'online' })).body.ok, false);
  assert.equal((await f.post('tools/ordinary/status', { status: 'online' })).body.ok, true);
  assert.equal((await f.post('tools/ordinary/delete')).body.ok, true);
  assert.deepEqual(f.commands(), []);
});

test('service lifecycle rm failures preserve online state and deletion flags on all removal routes', async t => {
  const f = await lifecycleFixture(t, 'online');
  for (const message of ['Cannot connect to the Docker daemon', 'permission denied']) {
    f.control({ rmError: message });
    for (const [url, body] of [['tools/fixturetool/status', { status: 'offline' }], ['uploads/update/offline'], ['tools/fixturetool/delete']]) {
      const response = await f.post(url, body);
      assert.equal(response.status, 502);
      assert.equal(response.body.ok, false);
      assert.deepEqual(f.state().map(x => x.status), ['online', 'online']);
      assert.equal(f.state()[0].deleted, undefined);
    }
  }
  f.control({ rmError: 'Error response from daemon: No such container: skillharbor-svc-ufixture' });
  assert.equal((await f.post('uploads/update/offline')).body.ok, true);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
});

test('service lifecycle shared lock rejects update aliases and all conflicting actions while another service proceeds', async t => {
  const f = await lifecycleFixture(t);
  f.control({ hold: 'start' });
  const pending = f.post('tools/fixturetool/status', { status: 'online' });
  await waitForDocker(f, 'start');
  const before = f.commands().length;
  for (const [url, body] of [['tools/fixturetool/status', { status: 'offline' }], ['tools/fixturetool/delete'],
    ['uploads/fixture/rollback'], ['uploads/update/rollback'], ['uploads/update/offline'], ['uploads/update/approve']]) {
    assert.equal((await f.post(url, body)).status, 409, url);
  }
  assert.equal(f.commands().length, before);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.equal((await f.post('tools/othertool/status', { status: 'offline' })).body.ok, true);
  // Run a different service through actual commands while the first start is held.
  f.control({ hold: 'start' });
  assert.equal((await f.post('uploads/other/offline')).body.ok, true);
  assert.ok(f.commands().some(args => args[0] === 'rm' && args.includes('skillharbor-svc-uother')));
  f.control({});
  assert.equal((await pending).body.ok, true);
});

test('service lifecycle failed rollback hides stale online card and preserves image, releases and recovery data', async t => {
  const f = await lifecycleFixture(t, 'online');
  f.control({ startError: 'rollback start failed' });
  const failure = await f.post('uploads/update/rollback');
  assert.equal(failure.status, 502);
  assert.match(JSON.stringify(failure.body), /rollback start failed/, JSON.stringify(f.commands()));
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.match(f.state()[0].serviceError, /恢复/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'services.json'))).ufixture.image, 'skillharbor-svc-ufixture:v2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'uploads/releases/ufixture/meta.json'))).current, 'v2');
  assert.equal(fs.readFileSync(path.join(f.dir, 'tmp/svc-data/ufixture/data.json'), 'utf8'), '{"sentinel":"recovery"}');
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/admin/tools', { user: 'admin' })).body.extra.find(x => x.id === 'fixturetool').status, 'offline');
});

test('service lifecycle disconnect before removal prevents further Docker and state mutations', async t => {
  const f = await lifecycleFixture(t);
  f.control({ hold: 'cp' });
  const request = http.request(f.base + '/api/admin/tools/fixturetool/status', { method: 'POST', headers: {
    Authorization: 'Bearer ' + f.token('admin'), 'Content-Type': 'application/json' } });
  request.on('error', () => {}); request.end(JSON.stringify({ status: 'online' }));
  await waitForDocker(f, 'cp');
  request.destroy(); await wait(50);
  f.control({}); await wait(100);
  assert.equal(f.commands().some(args => ['rm', 'create', 'start'].includes(args[0])), false);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.equal((await f.post('tools/fixturetool/status', { status: 'online' })).body.ok, true, 'lock released');
});

test('service lifecycle revoked token while snapshot waits prevents removal and state writes', async t => {
  const f = await lifecycleFixture(t, 'online');
  f.control({ hold: 'cp' });
  const pending = f.post('tools/fixturetool/status', { status: 'offline' });
  await waitForDocker(f, 'cp');
  assert.equal((await f.request('/api/admin/users/admin/edit', { user: 'secondadmin', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }) })).body.ok, true);
  f.control({});
  assert.equal((await pending).body.ok, false);
  assert.equal(f.commands().some(args => args[0] === 'rm'), false);
  assert.deepEqual(f.state().map(x => x.status), ['online', 'online']);
});

test('service lifecycle update approval start failure hides old online card and keeps retry source', async t => {
  const f = await lifecycleFixture(t, 'online');
  f.control({ startError: 'update start failed' });
  const failure = await f.post('uploads/update/approve');
  assert.equal(failure.status, 502);
  assert.match(JSON.stringify(failure.body), /update start failed/);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  const update = JSON.parse(fs.readFileSync(path.join(f.dir, 'uploads.json'))).find(x => x.id === 'update');
  assert.equal(update.status, 'deploy_failed');
  assert.match(update.deployError, /update start failed/);
  assert.equal(fs.existsSync(path.join(f.dir, 'tmp/update/Dockerfile')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'services.json'))).ufixture.image, 'skillharbor-svc-ufixture:v2');
  assert.equal(fs.readFileSync(path.join(f.dir, 'tmp/svc-data/ufixture/data.json'), 'utf8'), '{"sentinel":"recovery"}');
});

test('service lifecycle timed out removal reports uncertain outcome and persists recovery state', async t => {
  const f = await lifecycleFixture(t, 'online');
  f.control({ rmError: 'docker rm timed out', killed: true });
  const failure = await f.post('tools/fixturetool/delete');
  assert.equal(failure.status, 502);
  assert.equal(f.state()[0].deleted, undefined);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.match(f.state()[0].serviceError, /待确认/);
});

test('service lifecycle state save failure after Docker success compensates before HTTP failure', async t => {
  const f = await lifecycleFixture(t);
  f.control({ failSaveUploads: true });
  const failure = await f.post('tools/fixturetool/status', { status: 'online' });
  assert.equal(failure.status, 502);
  assert.match(JSON.stringify(failure.body), /injected upload state save failure/);
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.match(f.state()[0].serviceError, /待确认/);
  assert.ok(f.commands().some(args => args[0] === 'start'));
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/admin/tools', { user: 'admin' })).body.extra.find(x => x.id === 'fixturetool').status, 'offline');
});

async function assertLifecycleRecoveryAfterRestart(f, image) {
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
  assert.match(f.state()[0].serviceError, /待确认/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'services.json'))).ufixture.image, image);
  assert.equal(fs.existsSync(path.join(f.dir, 'uploads/releases/ufixture/v2')), true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'tmp/svc-data/ufixture/data.json'), 'utf8'), '{"sentinel":"recovery"}');
  await f.stop(); await f.start();
  assert.equal((await f.request('/api/admin/tools', { user: 'admin' })).body.extra.find(x => x.id === 'fixturetool').status, 'offline');
  assert.deepEqual(f.state().map(x => x.status), ['offline', 'offline']);
}

test('service lifecycle update final upload save failure settles the old card offline before responding', async t => {
  const f = await lifecycleFixture(t, 'online');
  f.control({ hold: 'start' });
  const pending = f.post('uploads/update/approve');
  await waitForDocker(f, 'start');
  f.control({ failSaveUploads: true });
  const failure = await pending;
  assert.equal(failure.status, 502);
  assert.match(JSON.stringify(failure.body), /injected upload state save failure/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'uploads.json'))).find(x => x.id === 'update').status, 'deploy_failed');
  await assertLifecycleRecoveryAfterRestart(f, 'skillharbor-svc-ufixture:v3');
});

test('service lifecycle rollback network failure after removal settles the old card offline', async t => {
  const f = await lifecycleFixture(t, 'online', dir => {
    const filename = path.join(dir, 'services.json'), services = JSON.parse(fs.readFileSync(filename));
    services.ufixture.mysql = { db: 'fixture', user: 'fixture', password: 'test' };
    fs.writeFileSync(filename, JSON.stringify(services));
  });
  f.control({ networkError: 'injected network failure' });
  const failure = await f.post('uploads/update/rollback');
  assert.equal(failure.status, 502);
  assert.match(JSON.stringify(failure.body), /injected network failure/);
  assert.ok(f.commands().some(args => args[0] === 'rm'));
  assert.equal(f.commands().filter(args => args[0] === 'network').length, 2);
  await assertLifecycleRecoveryAfterRestart(f, 'skillharbor-svc-ufixture:v2');
});

test('service lifecycle delayed image cleanup cannot compensate a completed or newer successful action', async t => {
  for (const newerAction of [false, true]) await t.test(newerAction ? 'newer action' : 'completed action', async t => {
    const f = await lifecycleFixture(t, 'online', dir => {
      const base = path.join(dir, 'uploads/releases/ufixture');
      for (const version of [3, 4]) fs.mkdirSync(path.join(base, 'v' + version));
      fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify({ current: 'v4', versions: [1, 2, 3, 4].map(v => ({ v })) }));
    });
    f.control({ hold: 'rmi' });
    assert.equal((await f.post('uploads/update/approve')).body.ok, true);
    await waitForDocker(f, 'rmi');
    assert.ok(fs.readFileSync(path.join(f.dir, 'probes.jsonl'), 'utf8').includes('127.0.0.1:18200'));
    assert.equal((await f.request('/api/admin/users/admin/edit', { user: 'secondadmin', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'user' }) })).body.ok, true);
    if (newerAction) {
      for (const status of ['offline', 'online']) assert.equal((await f.request('/api/admin/tools/fixturetool/status', {
        user: 'secondadmin', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })).body.ok, true);
    }
    f.control({});
    for (let i = 0; i < 200; i++) {
      const filename = path.join(f.dir, 'completed-commands.jsonl');
      const done = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse) : [];
      if (done.filter(args => args[0] === 'rmi').length === 2) break;
      await wait(10);
      if (i === 199) assert.fail('delayed rmi did not complete');
    }
    const live = await f.request('/api/admin/tools', { user: 'secondadmin' });
    const tool = live.body.extra.find(x => x.id === 'fixturetool');
    assert.equal(tool.status, 'online');
    assert.equal(tool.serviceError, undefined);
    assert.deepEqual(f.state().map(x => x.status), ['online', 'online']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'services.json'))).ufixture.image, 'skillharbor-svc-ufixture:v5');
    await f.stop(); await f.start();
    assert.equal((await f.request('/api/admin/tools', { user: 'secondadmin' })).body.extra.find(x => x.id === 'fixturetool').status, 'online');
  });
});
