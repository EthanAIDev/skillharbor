#!/usr/bin/env node
'use strict';
/**
 * Capture README demos clipped tightly to visible UI (no letterbox).
 * Usage: node scripts/capture-readme-shots.cjs
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8911';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const W = 1280;

async function goto(page, hash) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#root', { timeout: 15000 });
  await page.evaluate(() => {
    localStorage.setItem('skillharbor-theme', 'dark');
    document.documentElement.classList.add('dark');
  });
  await new Promise((r) => setTimeout(r, 700));
}

/** Clip to the painted UI: full width, top → footer (or last content) + padding */
async function clipBox(page) {
  return page.evaluate(() => {
    const pad = 16;
    const footer = document.querySelector('footer');
    const root = document.getElementById('root') || document.body;
    const bottomEl = footer || root;
    const bottom = Math.ceil(bottomEl.getBoundingClientRect().bottom) + pad;
    const width = Math.ceil(document.documentElement.clientWidth);
    const height = Math.min(Math.max(bottom, 600), 1600);
    return { x: 0, y: 0, width, height };
  });
}

async function shot(page, name) {
  // Ensure viewport is at least as tall as clip
  const clip = await clipBox(page);
  const vp = page.viewport();
  if (!vp || vp.height < clip.height || vp.width !== clip.width) {
    await page.setViewport({ width: clip.width, height: clip.height, deviceScaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 200));
  }
  const finalClip = await clipBox(page);
  finalClip.width = Math.min(finalClip.width, page.viewport().width);
  finalClip.height = Math.min(finalClip.height, page.viewport().height);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, type: 'png', clip: finalClip, captureBeyondViewport: false });
  console.log('wrote', name, `${finalClip.width}x${finalClip.height}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: W, height: 900, deviceScaleFactor: 1 },
    args: [`--window-size=${W},900`, '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  await goto(page, '#/');

  // Home
  await goto(page, '#/?tab=tools');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '✕');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await shot(page, '01-home.png');

  // Login — center card page: use fixed comfortable frame filled by page bg
  await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 1 });
  await goto(page, '#/login');
  await page.waitForSelector('input', { timeout: 10000 });
  await page.screenshot({
    path: path.join(OUT, '02-login.png'),
    type: 'png',
    clip: { x: 0, y: 0, width: 1100, height: 720 },
    captureBeyondViewport: false,
  });
  console.log('wrote 02-login.png 1100x720');

  // Workbench
  const inputs = await page.$$('input');
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type('admin', { delay: 8 });
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type('admin123', { delay: 8 });
  await Promise.all([
    page.waitForFunction(() => !location.hash.includes('login'), { timeout: 15000 }),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /登\s*录/.test(b.textContent || ''));
      btn && btn.click();
    }),
  ]);
  await page.setViewport({ width: W, height: 900, deviceScaleFactor: 1 });
  await goto(page, '#/workbench');
  await new Promise((r) => setTimeout(r, 500));
  await shot(page, '03-workbench.png');

  await browser.close();
  console.log('done');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
