// Built app + synthetic API only. No production server or external network.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

(async () => {
  const root = path.resolve(__dirname, '../dist');
  const output = path.resolve(__dirname, '../output/audit-ui-reliability');
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const relative = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try { res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file)); }
    catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: process.env.ZEB_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, timeout: 15000 });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1440, height: 1100 });
    const session = { username: 'owner', name: '评测用户', dept: '测试', role: 'admin', loginAt: 1 };
    await page.evaluateOnNewDocument(s => {
      localStorage.setItem('skillharbor-session', JSON.stringify(s)); localStorage.setItem('skillharbor-token', 'synthetic');
      window.open = () => null; // Tool opening is synthesized; counter and form interactions remain real.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined });
      window.__copies = [];
      window.__copyFailure = false;
      const exec = document.execCommand.bind(document);
      document.execCommand = command => {
        window.__copies.push({ inside: !!document.activeElement.closest('[role="dialog"]'), text: document.activeElement.value });
        return window.__copyFailure ? false : exec(command);
      };
    }, session);
    let hubFailure = true, evaluationFailure = true, holdHistory = true;
    const pendingMonths = [], evaluations = [], errors = [], pendingHistory = [];
    const history = { ok: true, recent: [
      { id: 'mine', n: session.name, s: 2, c: '本人旧历史', t: 2, mine: true },
      { id: 'other', n: '历史同事', s: 4, c: '同事非空历史', t: 1, mine: false },
    ], summary: { avg: 3, count: 2 }, mine: { s: 2, c: '本人旧历史' } };
    page.on('pageerror', error => errors.push(error.message));
    const tool = { id: 'audit-tool', name: '审计工具', desc: '用于本地验收', department: '测试', departments: ['全部'], owner: '工具管理员', url: base + '/local-tool', type: 'external', icon: '测', tags: [], usage: 0, likes: 0, approvedAt: Date.now(), onlineAt: new Date().toISOString() };
    const skill = { slug: 'example', name: '复制技能', status: 'enabled', category: '规划咨询', description: '本地合成说明', current_version: '1.0.0' };
    const stats = month => ({ ok: true, month, config: { dailyLimit: 5 }, days: [], tools: [{ id: 't', name: month === '2026-01' ? '旧月工具' : month === '2026-02' ? '最新月工具' : '当前月工具', owner: 'owner', department: '测试', days: {}, total: 7, users: 1 }], owners: [], totalClicks: 7, activeUsers: 1, anomalies: [], trend30: [] });
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const url = new URL(request.url());
        if (url.origin !== base) { await request.abort(); return; }
        const send = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
        const p = url.pathname;
        if (!p.startsWith('/api/') && p !== '/version.json') { await request.continue(); return; }
        if (p.endsWith('/auth/me')) { await send({ ok: true, session }); return; }
        if (p === '/api/apihub/state') { await send(hubFailure ? { ok: false, message: '合成读取失败' } : { ok: true, systems: {}, interfaces: [{ id: 'i', sysId: '', method: 'GET', path: '/example', title: '复制接口', desc: '合成接口', auth: '', state: 'cloud', up: '127.0.0.1:9000', port: 18000, owner: 'owner', ownerName: 'owner', params: [], errs: [], callers: [], createdAt: 1, updatedAt: 1 }], channels: [], dynamics: [], stats: { systems: 0, total: 1, cloud: 1, ready: 0, lan: 0, channels: 0 } }, hubFailure ? 500 : 200); return; }
        if (p === '/api/tools/extra') { await send({ ok: true, tools: [tool], builtinOffline: [], builtinOverrides: {} }); return; }
        if (p === '/api/admin/tools') { await send({ ok: true, extra: [], builtinOffline: [] }); return; }
        if (p === '/api/meta/departments') { await send({ ok: true, departments: ['测试'] }); return; }
        if (p === '/api/skills/dept-usage') { await send({ map: {}, depts: [], applicable: {} }); return; }
        if (p === '/api/admin/skill-departments') { await send({ ok: true, map: {} }); return; }
        if (p === '/api/evals' && request.method() === 'POST') {
          evaluations.push(JSON.parse(request.postData()));
          await send(evaluationFailure ? { ok: false, message: '合成评价失败' } : { ok: true, summary: { avg: 4.5, count: 2 } }); return;
        }
        if (p === '/api/evals') {
          if (holdHistory) pendingHistory.push(() => send(history));
          else await send(history);
          return;
        }
        if (p === '/api/admin/stats') {
          const month = url.searchParams.get('month');
          if (month === '2026-01') pendingMonths.push(() => send(stats(month)));
          else await send(stats(month));
          return;
        }
        if (p === '/api/skill-gateway/api/skills') { await send([skill]); return; }
        if (p === '/api/skill-gateway/api/skills/example') { await send(skill); return; }
        if (p === '/api/skill-gateway/api/health') { await send({ ok: true, mcp_alive: true }); return; }
        if (p.includes('/alerts') || p.includes('/trend') || p.endsWith('/recent')) { await send([]); return; }
        await send({ ok: true });
      })().catch(error => { if (!/Invalid InterceptionId|Target closed/.test(error.message)) errors.push(error.message); });
    });
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visible = text => page.waitForFunction(text => document.body.innerText.includes(text), {}, text);
    const click = async text => {
      await page.waitForFunction(text => [...(document.querySelector('[role="dialog"]') || document).querySelectorAll('button')].some(b => b.textContent.trim() === text), {}, text);
      const buttons = await page.$$(await page.$('[role="dialog"]') ? '[role="dialog"] button' : 'button');
      for (const button of buttons) if (await button.evaluate(b => b.textContent.trim()) === text) { await button.click(); break; }
      await frame();
    };
    const go = async route => { await page.goto(base + '/#' + route); await page.waitForSelector('.splash', { hidden: true }); };
    await go('/apihub'); await visible('合成读取失败'); hubFailure = false; await click('重试'); await visible('已登记系统');
    await page.screenshot({ path: path.join(output, 'apihub-retried.png') });
    const evaluateTool = async kind => {
      evaluationFailure = true; holdHistory = true;
      if (kind === 'modal') { await go('/?tab=tools'); await page.waitForSelector('[aria-label="查看审计工具详情"]'); await page.click('[aria-label="查看审计工具详情"]'); }
      else await go('/tool/audit-tool');
      await page.waitForSelector('[aria-label="5 星"]'); await page.click('[aria-label="5 星"]');
      await page.type('textarea', kind + '失败草稿'); await click('发送'); await visible('合成评价失败');
      assert.equal(await page.$eval('textarea', el => el.value), kind + '失败草稿');
      assert.equal(await page.evaluate(() => (document.querySelector('[role="dialog"]') || document.querySelector('main')).innerText.includes('评测用户')), false);
      holdHistory = false; for (const release of pendingHistory.splice(0)) await release();
      await visible('同事非空历史');
      assert.equal(await page.$eval('textarea', el => el.value), kind + '失败草稿');
      await visible('合成评价失败'); await visible('3.0');
      evaluationFailure = false; await click('发送');
      await page.waitForFunction(() => document.querySelector('textarea').value === '');
      assert.equal(await page.evaluate(() => (document.querySelector('[role="dialog"]') || document.querySelector('main')).innerText.includes('评测用户')), true);
      assert.equal(await page.evaluate(() => document.body.innerText.includes('本人旧历史')), false);
      await visible('同事非空历史'); await visible('4.5');
      if (kind === 'modal') {
        await click('打开工具'); await click('✕');
        assert.equal(await page.$eval('[aria-label="查看审计工具详情"]', el => el.textContent.includes('1 次使用')), true);
      }
    };
    await evaluateTool('modal'); await evaluateTool('detail');
    for (const kind of ['modal', 'detail']) {
      holdHistory = true; evaluationFailure = false;
      if (kind === 'modal') { await go('/?tab=tools'); await page.waitForSelector('[aria-label="查看审计工具详情"]'); await page.click('[aria-label="查看审计工具详情"]'); }
      else await go('/tool/audit-tool');
      await page.waitForSelector('[aria-label="5 星"]'); await page.click('[aria-label="5 星"]');
      await page.type('textarea', '先成功后历史'); await click('发送');
      await page.waitForFunction(() => document.querySelector('textarea').value === '');
      holdHistory = false; for (const release of pendingHistory.splice(0)) await release();
      await visible('同事非空历史'); await visible('4.5');
      const feed = await page.evaluate(() => {
        const scope = document.querySelector('[role="dialog"]') || document.querySelector('main');
        return { mine: [...scope.querySelectorAll('span')].filter(el => el.textContent === '评测用户').length, text: scope.innerText };
      });
      assert.equal(feed.mine, 1); assert.equal(feed.text.includes('本人旧历史'), false); assert.ok(feed.text.includes('先成功后历史'));
      await page.screenshot({ path: path.join(output, `${kind}-late-history.png`) });
    }
    assert.equal(evaluations.length, 6);
    await go('/admin?view=stats'); await visible('当前月工具');
    const month = async value => {
      await page.$eval('input[type="month"]', (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
      await frame();
    };
    await month('2026-01'); assert.equal(await page.evaluate(() => document.body.innerText.includes('当前月工具')), false);
    await month('2026-02'); await visible('最新月工具');
    for (const release of pendingMonths.splice(0)) await release(); await frame();
    assert.equal(await page.evaluate(() => document.body.innerText.includes('旧月工具')), false);
    await page.screenshot({ path: path.join(output, 'statistics-latest-month.png') });
    await go('/admin?view=skills'); await click('接入配置'); await page.waitForSelector('[role="dialog"] pre');
    for (let index = 0; index < 2; index++) {
      await page.evaluate(index => {
        const dialog = document.querySelector('[role="dialog"]');
        const button = [...dialog.querySelectorAll('button')].filter(b => b.textContent.trim() === '复制')[0];
        button.focus(); window.__copyButton = button;
        const text = dialog.querySelectorAll('pre')[index].firstChild;
        const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 8);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); window.__selected = selection.toString();
      }, index);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__copyButton.textContent === '已复制');
      assert.equal(await page.evaluate(() => document.activeElement === window.__copyButton && getSelection().toString() === window.__selected), true);
    }
    const copies = await page.evaluate(() => window.__copies);
    assert.equal(copies.length, 2); assert.ok(copies.every(c => c.inside && c.text.length > 0));
    await page.evaluate(async () => {
      const dialog = document.querySelector('[role="dialog"]');
      await Promise.all(dialog.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].filter(b => b.textContent === '已复制').every(b => getComputedStyle(b).whiteSpace === 'nowrap')), true);
    await page.screenshot({ path: path.join(output, 'http-copy-focus.png') });
    await go('/apihub'); await visible('复制接口');
    await page.evaluate(() => { window.__copies = []; });
    const card = await page.evaluateHandle(() => [...document.querySelectorAll('span')].find(el => el.textContent === '复制接口'));
    await card.asElement().click(); await click('📋 复制 curl 示例');
    await page.evaluate(() => { window.__copyFailure = true; });
    await click('📋 复制到剪贴板'); await visible('复制失败，请重试');
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').innerText.includes('✓ 已复制')), false);
    await page.screenshot({ path: path.join(output, 'apihub-copy-failed.png') });
    await page.evaluate(() => { window.__copyFailure = false; });
    await click('📋 复制到剪贴板'); await visible('✓ 已复制');
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').innerText.includes('复制失败')), false);
    const hubCopies = await page.evaluate(() => window.__copies);
    assert.equal(hubCopies.length, 2); assert.ok(hubCopies.every(item => item.inside && item.text.includes('curl')));
    await page.screenshot({ path: path.join(output, 'apihub-copy-retried.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: ['ApiHub error to retry', 'both evaluation entries retain late nonempty history after failure and success', 'home and modal usage synchronization', 'reverse month responses', 'both HTTP skill copy fallbacks preserve focus and selection with single-line success', 'ApiHub CopyModal fallback failure feedback and retry'], evaluations: evaluations.length, skillCopies: copies.length, hubCopies: hubCopies.length, externalNetwork: 'blocked', nativeClipboard: 'forced unavailable; real execCommand used for success' }));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
