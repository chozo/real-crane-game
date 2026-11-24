// v2.2 画面確認：わざと落として爆発させる（運搬の高さから、揺れを育てて振り落とす）→ 爆発の瞬間・直後の煙・失敗の写真カード
// v2.5：失敗写真は爆発のピーク（火の玉が最大・部品が飛び散っている最中）。毎フレーム火の玉の大きさと宙の部品数を記録して、撮った瞬間がピークか確かめる
// 実行: node tests/explode.js   （../tools の Playwright を使用。?round=5 で1ラウンドだけ遊ぶ）
// 十字パッドは本物のボタン要素へ PointerEvent を dispatch、アクションは本物のマウスでクリック（screens.js と同じ流儀）。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const FILE = path.resolve(__dirname, '../dist/real-crane-game/index.html'); // favicon などを同じフォルダに置いた公開用の出力（npm run build で作る）
const URL = 'file://' + FILE + '?seed=1&round=5';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [], checks = [];
const log = (...a) => console.log(...a);
const check = (name, ok, detail) => { checks.push({ name, ok }); log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const info = page => page.evaluate(() => ({ phase: window.__crane.phase, ...window.__crane.info() }));
async function waitFor(page, fn, arg, timeout = 120000) {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 30 }); }
  catch (e) { log('  state at timeout:', JSON.stringify(await info(page)).slice(0, 1500)); throw e; }
}
async function shot(page, name) {
  await page.evaluate(() => window.__crane.hiRes(true));
  await sleep(250);
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  await page.evaluate(() => window.__crane.hiRes(false));
  log('  screenshot ' + name + '.png');
}
async function act(page) { const b = await page.locator('#act').boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
async function driveTo(page, tx, tz, tol) {
  return page.evaluate(async ({ tx, tz, tol }) => {
    const L = window.CraneLogic, C = window.__crane, frame = () => new Promise(r => requestAnimationFrame(r));
    const ev = (id, type) => document.getElementById(id).dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true }));
    const acc = L.CRANE.accelEmpty * L.CRANE.brake;
    for (const ax of ['x', 'z']) for (let it = 0; it < 60; it++) {
      let i = C.info(); const d = (ax === 'x' ? tx : tz) - i.crane[ax]; if (Math.abs(d) <= tol) break;
      const id = ax === 'x' ? (d > 0 ? 'bR' : 'bL') : (d > 0 ? 'bD' : 'bU'); ev(id, 'pointerdown');
      for (let k = 0; k < 2000; k++) { await frame(); i = C.info(); const vv = i.crane['v' + ax], rem = ((ax === 'x' ? tx : tz) - i.crane[ax]) * Math.sign(d); if (rem <= vv * vv / (2 * acc) + Math.abs(vv) * 0.025 + tol * 0.3) break; }
      ev(id, 'pointerup');
      for (let k = 0; k < 2000; k++) { await frame(); i = C.info(); if (Math.abs(i.crane.vx) + Math.abs(i.crane.vz) < 1e-6) break; }
    }
  }, { tx, tz, tol });
}
async function pauseWhen(page, fn) {
  await page.evaluate(src => new Promise(res => { const cond = eval(src); const f = () => { if (cond()) { window.__crane.pause(true); res(); } else requestAnimationFrame(f); }; f(); }), '(' + fn.toString() + ')');
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.goto(URL);
  await waitFor(page, () => window.__crane && window.__crane.phase === 'title');
  await page.click('#startBtn');
  await waitFor(page, () => window.__crane.phase === 'move');
  await sleep(2400);
  let i = await info(page);
  check('preserveDrawingBuffer は無効（常時保持しない）', i.preserveDrawingBuffer === false, String(i.preserveDrawingBuffer));
  // 一番高い車を掴んで、運搬の高さまで上げる
  const best = i.cars.filter(c => c.present).sort((a, b) => b.value - a.value)[0];
  const tgt = await page.evaluate(id => { const L = window.CraneLogic, i = window.__crane.info(), lot = L.makeLot(i.seed); return [lot.cars[id].x, L.comWorld(lot.cars[id])[1]]; }, best.id);
  for (let k = 0; k < 3; k++) { await driveTo(page, tgt[0], tgt[1], 0.02); await waitFor(page, () => window.__crane.info().swingAmpDeg < 0.12, null, 30000); }
  i = await info(page);
  check('狙い＝一番高い車', i.aimId === best.id, `aim=${i.aimId} best=${best.id} (${best.type})`);
  await act(page); // 下ろす（v2.6：届いたら自動で掴んで運搬の高さまで上がる）
  await waitFor(page, () => window.__crane.phase === 'carry', null, 60000);
  i = await info(page);
  log(`  carry height: bottom=${i.load.bottomY.toFixed(2)}m`);
  // わざと揺らす：吊り荷の振れと逆向きに押し続けて揺れを育て、振り落とす（本物の十字ボタン）
  const pump = await page.evaluate(async () => {
    const C = window.__crane, frame = () => new Promise(r => requestAnimationFrame(r));
    const ev = (id, type) => document.getElementById(id).dispatchEvent(new PointerEvent(type, { pointerId: 41, pointerType: 'touch', isPrimary: true, bubbles: true }));
    let cur = null, t0 = performance.now(), maxSw = 0;
    while (C.phase === 'carry' && performance.now() - t0 < 60000) {
      const d = C.driveState(); maxSw = Math.max(maxSw, C.info().swingDeg);
      const want = performance.now() - t0 < 900 ? 'bD' : (d.swing.wz > 0 ? 'bU' : 'bD');
      if (want !== cur) { if (cur) ev(cur, 'pointerup'); ev(want, 'pointerdown'); cur = want; }
      await frame();
    }
    if (cur) ev(cur, 'pointerup');
    return { phase: C.phase, secs: (performance.now() - t0) / 1000, maxSw };
  });
  log('  pump:', JSON.stringify(pump));
  // 爆発の派手さを毎フレーム記録（一時停止中は同じ t が続くので飛ばす）
  await page.evaluate(() => { window.__boomLog = []; const f = () => { const i = window.__crane.info(), w = i.wreck; if (w) { const L = window.__boomLog; if (!L.length || L[L.length - 1].t !== w.t) L.push({ t: w.t, ...i.boomFx }); if (w.t > 1.8) return; } requestAnimationFrame(f); }; f(); });
  i = await info(page);
  check('揺れを育てると振り落ちる（cause=swing）', pump.phase === 'fall' && i.load.cause === 'swing', `phase=${pump.phase} cause=${i.load && i.load.cause} maxSwing=${pump.maxSw.toFixed(1)}°`);
  // 激突の 0.25 秒後：火の玉・飛び散る部品・閃光
  await pauseWhen(page, () => { const w = window.__crane.info().wreck; return w && w.t >= 0.25; });
  i = await info(page);
  check('運搬の高さから落ちた（1.5m 以上）→ 激しさ 0.6 以上', i.wreck && i.wreck.h0 > 1.5 && i.wreck.power > 0.6, i.wreck && `h0=${i.wreck.h0.toFixed(2)}m impact=${i.wreck.impact.toFixed(2)}m/s power=${i.wreck.power.toFixed(2)}`);
  check('部品が飛び散っている（タイヤ・ドア・屋根など）', i.wreck.parts >= 6 && i.debrisFlying > 10, `parts=${i.wreck.parts} debris=${i.debris} flying=${i.debrisFlying} plan=${JSON.stringify({ t: i.wreck.plan.tyres, d: i.wreck.plan.doors, roof: i.wreck.plan.roofOff, hood: i.wreck.plan.hoodOff })}`);
  check('炎と煙のパーティクル・大きな画面シェイク', i.fire > 20 && i.smoke > 10 && i.shake > 1, `fire=${i.fire} smoke=${i.smoke} shake=${i.shake.toFixed(2)}`);
  const boom = await page.evaluate(() => parseFloat(document.getElementById('boom').style.opacity));
  check('閃光（画面の白橙フラッシュ＋照り返しの光）', i.wreck.boom0 > 0.3 && i.wreck.light0 > 50, `boom start=${i.wreck.boom0.toFixed(2)} light start=${i.wreck.light0.toFixed(0)} (now ${boom.toFixed(2)} at t=${i.wreck.t.toFixed(2)}s)`);
  await shot(page, '20_explode_big');
  await page.evaluate(() => window.__crane.pause(false));
  // 写真を撮る瞬間（v2.5：爆発のピーク）
  await pauseWhen(page, () => !!window.__crane.info().photo);
  i = await info(page);
  check('爆発のピークで写真を撮った（kind=wreck・激突の約0.3秒後）', i.photo && i.photo.kind === 'wreck' && i.photo.at >= i.photoAt - 1e-6 && i.photo.at < i.photoAt + 0.12, JSON.stringify(i.photo && { kind: i.photo.kind, at: +i.photo.at.toFixed(3), boom: i.photo.boom, ms: +i.photo.ms.toFixed(1) }));
  await shot(page, '21_photo_moment');
  await page.evaluate(() => window.__crane.pause(false));
  await waitFor(page, () => window.__boomLog.length && window.__boomLog[window.__boomLog.length - 1].t > 1.8, null, 30000);
  const blog = await page.evaluate(() => window.__boomLog), ph = (await info(page)).photo;
  const ballMax = Math.max(...blog.map(b => b.ball)), airMax = Math.max(...blog.map(b => b.air)), tBall = blog.find(b => b.ball === ballMax).t;
  const at13 = blog.reduce((a, b) => Math.abs(b.t - 1.3) < Math.abs(a.t - 1.3) ? b : a);
  log('  boom curve (t: ball / fire / air / spread):'); blog.filter((b, k) => k % 3 === 0 || Math.abs(b.t - ph.at) < 0.02).forEach(b => b.t < 1.5 && log(`    ${b.t.toFixed(2)}s  ${b.ball.toFixed(1)} / ${b.fire.toFixed(1)} / ${b.air} / ${b.spread.toFixed(2)}m`));
  check('写真の瞬間は火の玉が最大級（ピークの85%以上）', ph.boom.ball >= 0.85 * ballMax, `photo ball=${ph.boom.ball.toFixed(1)} max=${ballMax.toFixed(1)} @${tBall.toFixed(2)}s`);
  check('写真の瞬間は部品が宙を飛び散っている最中（宙の部品が最大の7割以上・中心から1m以上）', ph.boom.air >= 0.7 * airMax && ph.boom.spread > 1, `air=${ph.boom.air}/${airMax} spread=${ph.boom.spread.toFixed(2)}m`);
  check('旧タイミング（1.3秒後）は火の玉が引いた後だった', at13.ball < 0.2 * ballMax, `ball@1.3s=${at13.ball.toFixed(1)} air=${at13.air}`);
  await waitFor(page, () => window.__crane.info().fallDone, null, 30000);
  await sleep(1200);
  await shot(page, '21b_wreck_burning');
  await waitFor(page, () => window.__crane.phase === 'card');
  await sleep(1800); // 写真の「現像」アニメーション
  const card = await page.evaluate(() => {
    const img = document.getElementById('pImg'), ph = document.getElementById('photo'), r = ph.getBoundingClientRect(), app = document.getElementById('app').getBoundingClientRect();
    // 写真の中身が真っ黒・真っ白でないこと（画素のばらつき）
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data; let s = 0, s2 = 0, n = 0, dark = 0;
    for (let k = 0; k < d.length; k += 4) { const v = (d[k] + d[k + 1] + d[k + 2]) / 3; s += v; s2 += v * v; n++; if (v < 50) dark++; }
    const mean = s / n;
    return { cls: ph.className, nw: img.naturalWidth, nh: img.naturalHeight, mean, sd: Math.sqrt(s2 / n - mean * mean), darkFrac: dark / n, cap: document.getElementById('pCap').textContent, title: document.getElementById('cTitle').textContent, why: document.getElementById('cWhy').textContent,
      inside: r.left >= app.left - 2 && r.right <= app.right + 2 && r.top >= app.top && r.bottom <= app.bottom };
  });
  check('失敗カードにポラロイド写真（640px・中身あり・画面内）', /show/.test(card.cls) && /fail/.test(card.cls) && card.nw === 640 && card.sd > 15 && card.inside, JSON.stringify(card));
  check('キャプション・タイトルが「大破」', /大破/.test(card.cap) && /大破/.test(card.title) && /爆発/.test(card.why), `${card.title} / ${card.cap}`);
  i = await info(page);
  check('写真の JPEG 変換（非同期 toBlob）が済んでカードに入った', i.photo.ready && i.photo.len > 10000, `size=${i.photo.len}B capture=${i.photo.ms.toFixed(0)}ms`);
  await shot(page, '22_fail_photo_card');
  // 写真そのもの（640px）も保存して目視する
  const url = await page.evaluate(() => { const img = document.getElementById('pImg'), c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/jpeg', 0.92); });
  fs.writeFileSync(path.join(OUT, '22p_fail_photo.jpg'), Buffer.from(url.split(',')[1], 'base64'));
  // 次へ → 結果
  await page.click('#cBtn');
  await waitFor(page, () => window.__crane.phase === 'result');
  i = await info(page);
  check('残骸は黒焦げのまま残る（wrecks=1）', i.wrecks === 1, 'wrecks=' + i.wrecks);
  check('JS エラー 0', errors.length === 0, errors.join(' | '));
  await browser.close();
  const ng = checks.filter(c => !c.ok);
  log(`\n${checks.length - ng.length}/${checks.length} checks passed`);
  if (ng.length) { log('FAILED:', ng.map(c => c.name).join(', ')); process.exit(1); }
})().catch(e => { console.error(e); console.error('errors:', errors); process.exit(1); });
