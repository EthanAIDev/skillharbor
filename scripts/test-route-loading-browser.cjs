// Built-app check: every API response is synthetic and all external requests are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

(async () => {
  const root = path.resolve(__dirname, '../dist');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: process.env.ZEB_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, timeout: 15000 });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1440, height: 1000 });
    const scripts = new Set();
    let rejectAdmin = false;
    let heldHub = null;
    let holdHub = true;
    const session = { username: 'fixture', name: '测试管理员', role: 'admin', dept: '测试', loginAt: 1 };
    await page.evaluateOnNewDocument(s => {
      if (new URLSearchParams(location.search).has('anonymous')) return;
      localStorage.setItem('skillharbor-session', JSON.stringify(s));
      localStorage.setItem('skillharbor-token', 'synthetic');
      localStorage.setItem('skillharbor-libtab', 'tools');
    }, session);
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const u = new URL(request.url());
        if (u.origin !== base) { await request.abort(); return; }
        if (u.pathname.endsWith('.js')) {
          scripts.add(u.pathname);
          if (rejectAdmin && /\/Admin-/.test(u.pathname)) { await request.abort(); return; }
          if (holdHub && /\/ApiHub-/.test(u.pathname)) { heldHub = request; return; }
        }
        if (!u.pathname.startsWith('/api/') && u.pathname !== '/version.json') { await request.continue(); return; }
        let body = { ok: true };
        if (u.pathname.endsWith('/auth/me')) body = { ok: true, session };
        else if (u.pathname === '/api/kb/repos') body = { ok: true, v2: true, repos: [], hasPrivate: false };
        else if (u.pathname === '/api/kb/stats') body = { ok: true, total: 0, byRepo: [] };
        else if (/\/skills$|\/alerts$/.test(u.pathname)) body = [];
        else if (u.pathname.endsWith('/admin/stats')) body = { ok: true, month: u.searchParams.get('month'), days: [], tools: [], owners: [], anomalies: [], trend30: [], config: { dailyLimit: 5 }, totalClicks: 0, activeUsers: 0 };
        else if (u.pathname.endsWith('/apihub/state')) body = { ok: true, systems: {}, interfaces: [], channels: [], dynamics: [], stats: { systems: 0, total: 0, cloud: 0, ready: 0, lan: 0, channels: 0 } };
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      })().catch(error => { if (!/Invalid InterceptionId|Target closed/.test(error.message)) console.error(error); });
    });
    await page.goto(base + '/#/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('main');
    const initial = [...scripts];
    const jsBytes = initial.reduce((n, url) => n + fs.statSync(path.join(root, url.slice(1))).size, 0);
    const baseline = process.argv.includes('--baseline');
    if (!baseline) {
      assert.equal(initial.some(url => /\/(Admin|ApiHub|KnowledgeBase|Workbench|ToolDetail|Login)-/.test(url)), false);
      for (const [route, text] of [['/apihub', '接口广场'], ['/kb', '公司的大脑'], ['/tool/1', 'openclaw：政策信息自动获取'], ['/workbench', '工作台'], ['/admin', 'SkillHarbor 管理后台']]) {
        await page.evaluate(route => { location.hash = '#' + route; }, route);
        if (route === '/apihub') {
          await page.waitForSelector('[role="status"]');
          assert.ok(heldHub, 'route module request is pending while loading feedback is visible');
          holdHub = false;
          await heldHub.continue();
        }
        try { await page.waitForFunction(text => document.body.innerText.includes(text), {}, text); }
        catch (error) { throw new Error(`${route}: ${await page.evaluate(() => document.body.innerText.slice(-1000))}`, { cause: error }); }
        await page.waitForNetworkIdle({ idleTime: 150 });
        assert.equal(await page.evaluate(() => !!document.querySelector('[data-reload-page]')), false, route);
      }
      assert.ok([...scripts].some(url => /\/Admin-/.test(url)), 'admin module loads on first visit');
      // A fresh document must show a recovery action if a deployed chunk is missing.
      await page.setCacheEnabled(false);
      rejectAdmin = true;
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.innerText.includes('页面加载失败'));
      rejectAdmin = false;
      const reload = await page.$('button[data-reload-page]');
      assert.ok(reload);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), reload.click()]);
      await page.waitForFunction(() => document.body.innerText.includes('SkillHarbor 管理后台'));
      await page.evaluate(() => { localStorage.removeItem('skillharbor-session'); localStorage.removeItem('skillharbor-token'); });
      await page.goto(base + '/?anonymous=1#/login', { waitUntil: 'networkidle0' });
      await page.waitForSelector('input[type="password"]');
    }
    const result = { baseline, initialJavaScriptBytes: jsBytes, initialScripts: initial, externalNetwork: 'blocked' };
    const out = path.resolve(__dirname, '../output/audit-20261110');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, baseline ? 'route-loading-before.json' : 'route-loading-after.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
