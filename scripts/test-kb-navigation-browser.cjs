// Local built-app verification only. Every API request is fulfilled in Chrome;
// external requests are blocked and the static server binds loopback exclusively.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

(async () => {
  const root = path.resolve(__dirname, '../dist');
  const output = path.resolve(__dirname, '../output/audit-20261110');
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!target.startsWith(root + path.sep) && target !== root) { res.writeHead(403).end(); return; }
    const file = target === root + path.sep || target === root ? path.join(root, 'index.html') : target;
    try { res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: process.env.ZEB_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, timeout: 15000 });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1440, height: 1000 });
    const session = { username: 'test', name: '测试', dept: '测试', role: 'user', loginAt: 1 };
    await page.evaluateOnNewDocument(s => { localStorage.setItem('skillharbor-session', JSON.stringify(s)); localStorage.setItem('skillharbor-token', 'synthetic'); }, session);
    const held = [];
    const heldWrites = [], listReads = [], writes = [], heldTargets = [], moves = [];
    let holdMoveTarget = false;
    let batchScenario = false, holdBatchMove = false, privateScenario = false, privateDeleted = false;
    const heldBatchMoves = [];
    let holdA = true, failB = false, holdPreview = true;
    const file = name => ({ name, type: 'file', docId: name, path: '', size: 1, pid: 99, level: 0 });
    const dir = { name: '子目录', type: 'dir', docId: 9, path: '', level: 0 };
    const repos = [{ id: '1', name: '甲库', tier: 'dept', canWrite: true }, { id: '2', name: '乙库', tier: 'private', canWrite: false }];
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const url = new URL(request.url());
        if (url.origin !== base) { await request.abort(); return; }
        const send = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (!url.pathname.startsWith('/api/') && url.pathname !== '/version.json') { await request.continue(); return; }
        if (url.pathname.endsWith('/auth/me')) { await send({ ok: true, session }); return; }
        if (url.pathname.endsWith('/repos')) {
          const privateRepos = privateDeleted ? [repos[1]] : [{ ...repos[0], tier: 'private', canManage: true }, repos[1]];
          await send({ ok: true, v2: true, hasPrivate: privateScenario ? !privateDeleted : true, repos: privateScenario ? privateRepos : repos }); return;
        }
        if (url.pathname.endsWith('/people')) { await send({ groups: [], depts: [] }); return; }
        if (url.pathname.endsWith('/repo-config')) { await send({ whitelist: [] }); return; }
        if (url.pathname.endsWith('/priv-delete')) { privateDeleted = true; await send({ ok: true }); return; }
        if (url.pathname.endsWith('/stats')) { await send({ ok: true, total: 0, byRepo: [] }); return; }
        if (url.pathname.endsWith('/search')) { await send({ items: [{ reposId: '2', repos: '乙库', path: '', name: '根命中.txt', size: 1 }] }); return; }
        if (url.pathname.endsWith('/mkdir')) { writes.push(JSON.parse(request.postData())); heldWrites.push(() => send({ ok: true })); return; }
        if (url.pathname.endsWith('/move')) {
          moves.push(JSON.parse(request.postData()));
          if (holdBatchMove) { holdBatchMove = false; heldBatchMoves.push(() => send({ ok: true })); }
          else await send({ ok: true });
          return;
        }
        if (url.pathname.endsWith('/preview')) {
          if (holdPreview) held.push(() => request.respond({ contentType: 'text/html', body: '<p>合成预览</p>' }));
          else await request.respond({ contentType: 'text/html', body: '<p>合成预览</p>' });
          return;
        }
        const id = url.searchParams.get('reposId');
        if (url.pathname.endsWith('/perm')) {
          if (privateScenario && id === '1') { await send({ canWrite: true, tier: 'private', canManage: true, isPrivateMine: true, canDownload: true }); return; }
          if (id === '1' && holdA) held.push(() => send({ canWrite: true, tier: 'dept' }));
          else await send({ canWrite: id === '1', tier: id === '1' ? 'dept' : 'private', canDownload: true }, id === '2' && failB ? 503 : 200);
          return;
        }
        if (url.pathname.endsWith('/list')) {
          listReads.push(id);
          if (batchScenario) { await send({ entries: url.searchParams.has('docId') ? [{ name: 'Y', type: 'dir', docId: 22, level: 1, path: '子目录/' }] : [dir, file('批甲.txt'), file('批乙.txt')] }); return; }
          if (holdMoveTarget && url.searchParams.get('docId') === '9') { heldTargets.push(() => send({ entries: [{ name: '旧目标', type: 'dir', docId: 77, path: '子目录/', level: 1 }] })); return; }
          if (id === '1' && holdA) held.push(() => send({ entries: [file('旧库文件.txt')] }));
          else await send({ entries: url.searchParams.has('docId') ? [file('子文件.txt')] : [dir, file('当前文件.txt')] });
          return;
        }
        await send({ ok: true });
      })().catch(error => { if (!/Invalid InterceptionId|Target closed/.test(error.message)) console.error(error); });
    });
    const click = async text => {
      await page.waitForFunction(text => [...document.querySelectorAll('button')].some(e => e.textContent.trim() === text || (['甲库', '乙库'].includes(text) && e.textContent.includes(text) && e.textContent.includes('进入浏览'))), {}, text);
      await page.evaluate(text => {
        const scope = document.querySelector('[role="dialog"]') || document;
        const buttons = [...scope.querySelectorAll('button')].filter(e => e.textContent.trim() === text || (['甲库', '乙库'].includes(text) && e.textContent.includes(text) && e.textContent.includes('进入浏览')));
        (text === '知识库' ? buttons.at(-1) : buttons[0]).click();
      }, text);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    };
    const visible = text => page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
    const noUpload = async () => assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '上传文件')), false);
    await page.goto(base + '/#/kb'); await page.waitForSelector('.splash', { hidden: true }); await visible('甲库');
    await click('甲库'); await click('知识库'); await click('乙库'); await visible('当前文件.txt');
    for (const release of held.splice(0)) await release();
    await noUpload();
    assert.equal(await page.evaluate(() => document.body.innerText.includes('旧库文件.txt')), false);
    holdA = false; await click('知识库'); await click('甲库'); await visible('上传文件');
    failB = true; await click('知识库'); await click('乙库'); await visible('当前文件.txt'); await noUpload();
    failB = false; await click('知识库'); await click('甲库'); await visible('当前文件.txt');
    await page.click('[title="打开目录"]'); await visible('子文件.txt');
    await page.type('input[placeholder="搜索全部知识库…"]', '命中'); await page.keyboard.press('Enter'); await visible('根命中.txt');
    await click('定位'); await visible('当前文件.txt'); await noUpload();
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.card button')].filter(e => e.textContent.trim() === '子目录' && !e.title).length), 0);
    await page.click('[title="预览"]'); await page.waitForSelector('[role="dialog"]'); await click('✕');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    for (const release of held.splice(0)) await release().catch(() => {});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$('[role="dialog"]'), null);
    holdPreview = false; await page.click('[title="预览"]'); await page.waitForSelector('iframe');
    await click('✕'); await click('知识库'); await click('甲库'); await visible('上传文件');
    await click('新建目录'); await page.type('[role="dialog"] input', '旧写目录'); await click('创建'); await click('取消');
    await click('知识库'); await click('乙库'); await visible('当前文件.txt');
    const readsBefore = listReads.filter(id => id === '1').length;
    for (const release of heldWrites.splice(0)) await release();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(writes, [{ reposId: '1', path: '', name: '旧写目录' }]);
    assert.equal(listReads.filter(id => id === '1').length, readsBefore);
    await noUpload();
    // Exercise the real move dialog against a delayed target, then return root.
    await click('知识库'); await click('甲库'); await visible('上传文件');
    await page.evaluate(() => [...document.querySelectorAll('button[title="更多"]')].at(-1).click());
    await click('移动到…');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === '子目录'));
    holdMoveTarget = true; await click('子目录'); await click('甲库');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === '子目录'));
    for (const release of heldTargets.splice(0)) await release();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').textContent.includes('旧目标')), false);
    await click('移动到这里');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.equal(moves.length, 1); assert.equal(moves[0].dstPid, '0'); assert.equal(moves[0].dstPath, '');
    // R6: the first batch POST hangs while real clicks try to change its target.
    batchScenario = true; holdMoveTarget = false;
    await click('甲库'); await visible('批甲.txt'); await click('批量操作');
    await page.evaluate(() => {
      for (const name of ['批甲.txt', '批乙.txt']) document.querySelector(`span[title="${name}"]`).closest('tr').querySelector('input[type="checkbox"]').click();
    });
    await click('移动'); await click('子目录'); await visible('Y');
    holdBatchMove = true; await click('移动 2 项到这里'); await visible('移动中');
    const controls = await page.$$('[role="dialog"] button');
    for (const control of controls) {
      const label = await control.evaluate(el => el.textContent.trim());
      if (!['甲库', '子目录', 'Y'].includes(label)) continue;
      assert.equal(await control.evaluate(el => el.disabled), true);
      await control.click();
    }
    for (const release of heldBatchMoves.splice(0)) await release();
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.deepEqual(moves.slice(1).map(m => [m.dstPid, m.dstPath]), [['9', '子目录/'], ['9', '子目录/']]);
    assert.equal(await page.evaluate(() => document.body.innerText.includes('移动中')), false);
    await page.screenshot({ path: path.join(output, 'kb-navigation-desktop.png') });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'kb-navigation-390.png'), fullPage: true });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, directoryWidth: document.querySelector('.kb-dirpanel').getBoundingClientRect().width }));
    // R5: normal deletion of the current private library updates the home catalog.
    batchScenario = false; privateScenario = true;
    await page.setViewport({ width: 1440, height: 1000 }); await page.reload();
    await page.waitForSelector('.splash', { hidden: true }); await visible('甲库'); await click('甲库');
    await click('⚙ 共享设置'); await visible('删除私有库…');
    page.once('dialog', dialog => dialog.accept('甲库'));
    await click('删除私有库…'); await visible('＋ 新建我的私有库');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('甲库'))), false);
    assert.equal(privateDeleted, true);
    await page.screenshot({ path: path.join(output, 'kb-navigation-private-deleted.png') });
    console.log(JSON.stringify({ passed: ['rapid library switch', 'permission failure', 'root search location', 'close pending preview', 'reopen preview', 'old write keeps original payload without refreshing new library', 'late move target ignored and POST matches displayed root', 'pending batch freezes target controls and completes original destination', 'private deletion refreshes cards and restores create entry'], mobileLayout: layout, externalNetwork: 'blocked' }));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
