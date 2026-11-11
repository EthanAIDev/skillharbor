// Opt in with ZEB_NGINX pointing to a local nginx executable. No Docker or production access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');

test('file origin downloads manuals while screenshots stay inline and releases stay private', { skip: !process.env.ZEB_NGINX }, async () => {
  const parent = path.resolve(__dirname, '../output/audit-20261110');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'nginx-test-'));
  const prefix = dir.replace(/\\/g, '/') + '/';
  let child;
  try {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const files = [
      ...['pdf', 'doc', 'docx', 'zip'].map(ext => `uploads/materials/tool-fixture/manual.${ext}`),
      'uploads/materials/tool-fixture/shot-1.png', 'uploads/files/tool-fixture/app.exe',
      'uploads/releases/private/index.html', 'uploads/sites/example/index.html', 'tmp/draft/index.html',
    ];
    for (const file of files) {
      const target = path.join(dir, 'data', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file);
    }
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.mkdirSync(path.join(dir, 'temp'));
    const server = fs.readFileSync(path.resolve(__dirname, '../files-nginx.conf'), 'utf8')
      .replace('listen 80;', `listen 127.0.0.1:${port};`)
      .replace(/alias\s+\/data\/([^;]+);/g, (_, tail) => `alias "${prefix}data/${tail}";`);
    fs.writeFileSync(path.join(dir, 'nginx.conf'), `pid logs/nginx.pid;\nerror_log logs/error.log;\nevents {}\nhttp { access_log off;\n${server}\n}`);
    const args = ['-p', prefix, '-c', 'nginx.conf'];
    execFileSync(process.env.ZEB_NGINX, [...args, '-t'], { windowsHide: true, stdio: 'pipe' });
    child = spawn(process.env.ZEB_NGINX, [...args, '-g', 'daemon off; master_process off;'], { windowsHide: true, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(base, { signal: AbortSignal.timeout(200) }); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    assert.ok(ready, 'temporary nginx must start');
    for (const file of files) {
      const uri = file.startsWith('tmp/') ? '/files/uploads-preview/' + file.slice(4) : '/files/' + file;
      const r = await fetch(base + uri + '?download=1', { signal: AbortSignal.timeout(2000) });
      if (file.includes('/releases/')) { assert.equal(r.status, 404); continue; }
      assert.equal(r.status, 200, uri);
      assert.equal(await r.text(), file, 'alias serves the exact requested file');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      const attachment = /\/manual\.(pdf|docx?|zip)$/.test(file) || file.startsWith('uploads/files/');
      assert.equal(r.headers.get('content-disposition'), attachment ? 'attachment' : null, uri);
    }
    assert.equal((await fetch(base + '/files/uploads/materials/tool-fixture/missing.pdf')).status, 404);
    assert.equal((await fetch(base + '/unrelated')).status, 404);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    // Only this test's generated directory can be removed; never traverse the binary or data volume.
    assert.equal(path.dirname(path.resolve(dir)), parent);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
