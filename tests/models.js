// v2.3 画面確認：車のモデリング（前後と車種の識別）。駐車場全景（ゲームの画面そのまま）と、確認用カメラでの斜め俯瞰・前後の寄りを撮る。
// 実行: node tests/models.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const URL = 'file://' + path.resolve(__dirname, '../dist/real-crane-game/index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__crane && window.__crane.phase === 'title');
  await page.evaluate(() => window.__crane.setup({ seed: 1, fixedPR: true }));
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__crane.phase === 'move');
  await page.waitForFunction(() => !document.getElementById("banner").classList.contains("vis"), null, { timeout: 20000 }); await sleep(600); // ラウンド開始の案内が消えるまで
  const shot = async name => { await page.evaluate(() => window.__crane.hiRes(true)); await sleep(300); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  shot', name); };
  await shot('30_lot_models');               // ゲームの画面そのまま（駐車場全景）
  const cars = (await page.evaluate(() => window.__crane.info().cars)).map(c => `${c.id}:${c.type}@(${c.x.toFixed(1)},${c.z.toFixed(1)})`);
  console.log('  cars', cars.join(' '));
  // 確認用カメラ：UI を隠して駐車場を斜めから俯瞰
  await page.addStyleTag({ content: '#ui{display:none!important}' });
  await page.evaluate(() => window.__crane.cam([9, 13, 6, 0, 0, -6.5])); await shot('31_lot_oblique');
  await page.evaluate(() => window.__crane.cam([-2, 4.2, 1.5, -2, 0.6, -5])); await shot('32_front_row_close');
  await page.evaluate(() => window.__crane.cam([4, 3.5, -16.5, 2, 0.6, -9])); await shot('33_back_row_close');
  // 1台ずつ寄る（前列は手前の通路から、奥の列は手前の車越しに斜め上から）
  const list = await page.evaluate(() => window.__crane.info().cars);
  const seen = new Set();
  for (const c of list) {
    if (seen.has(c.type)) continue; seen.add(c.type); // 車種ごとに1枚
    const back = c.row === 0;
    await page.evaluate(v => window.__crane.cam(v), [c.x + 3.2, back ? 5.2 : 3.4, c.z + (back ? 4.6 : 5.2), c.x, 0.7, c.z]);
    await shot(`34_car${c.id}_${c.type}`);
  }
  await page.evaluate(() => window.__crane.cam(null));
  console.log(errors.length ? 'JS errors: ' + errors.join(' | ') : 'JS errors: 0');
  await browser.close();
})();
