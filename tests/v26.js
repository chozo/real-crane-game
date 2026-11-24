// v2.6 の画面確認：node tests/v26.js（../tools の Playwright を使用）
//  A. 丸い印の追従：ラウンド開始直後（車の上ではない通路）からクレーンを動かし、描画した毎フレームの「印の位置」と「爪の位置」を比べる。
//     車の上・車の外で差が出ないこと、通路の上でも印が動くこと。v2.5 の成果物（tests/tmp/v25/index.html）と同じ操作で並べて撮る
//  B. 下ろすだけで自動で掴んで上がる：ボタンは「下ろす」の1回だけ。届く→掴む→引き抜く→運搬の高さ、を連続で撮る
//  C. 下降の中止：車に届く前に「上げる」を押すと巻き上げて戻る
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, 'screenshots', 'v26');
fs.mkdirSync(OUT, { recursive: true });
const NEW = 'file://' + path.resolve(__dirname, '../dist/real-crane-game/index.html') + '?seed=1';
const OLD = 'file://' + path.resolve(__dirname, 'tmp/v25/index.html') + '?seed=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [], checks = [];
const log = (...a) => console.log(...a);
const check = (name, ok, detail) => { checks.push({ name, ok }); log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
const info = page => page.evaluate(() => ({ phase: window.__crane.phase, ...window.__crane.info() }));
async function waitFor(page, fn, arg, timeout = 60000) {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 'raf' }); }
  catch (e) { log('  state at timeout:', JSON.stringify(await info(page)).slice(0, 600)); throw e; }
}
async function shot(page, name) {
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  return file;
}
async function act(page) { const b = await page.locator('#act').boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
const press = (page, id, on) => page.evaluate(({ id, on }) => document.getElementById(id).dispatchEvent(new PointerEvent(on ? 'pointerdown' : 'pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true })), { id, on });
async function start(page, url) {
  await page.goto(url);
  await waitFor(page, () => window.__crane && window.__crane.phase === 'title');
  await page.click('#startBtn');
  await waitFor(page, () => window.__crane.phase === 'move');
  await sleep(2400); // バナーが消えるまで
}
// 条件が成り立った瞬間に進行を止める（描画は止まる＝その瞬間の画面）
async function pauseWhen(page, src) {
  await page.evaluate(src => new Promise(res => { const cond = eval(src); const f = () => { if (cond()) { window.__crane.pause(true); res(); } else requestAnimationFrame(f); }; f(); }), '(' + src.toString() + ')');
}
const resume = page => page.evaluate(() => window.__crane.pause(false));
// 十字パッド（本物のボタン要素へ PointerEvent）で目標へ。screens.js の driveTo と同じ制動の考え方
async function driveTo(page, tx, tz, tol) {
  return page.evaluate(async ({ tx, tz, tol }) => {
    const L = window.CraneLogic, C = window.__crane, frame = () => new Promise(r => requestAnimationFrame(r));
    const ev = (id, type) => document.getElementById(id).dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true }));
    const acc = L.CRANE.accelEmpty * L.CRANE.brake;
    for (const ax of ['x', 'z']) for (let iter = 0; iter < 40; iter++) {
      let i = C.info(); const d = (ax === 'x' ? tx : tz) - i.crane[ax]; if (Math.abs(d) <= tol) break;
      const id = ax === 'x' ? (d > 0 ? 'bR' : 'bL') : (d > 0 ? 'bD' : 'bU'); ev(id, 'pointerdown');
      for (let k = 0; k < 2000; k++) { await frame(); i = C.info(); const vv = i.crane['v' + ax], rem = ((ax === 'x' ? tx : tz) - i.crane[ax]) * Math.sign(d); if (rem <= vv * vv / (2 * acc) + Math.abs(vv) * 0.025 + tol * 0.3) break; }
      ev(id, 'pointerup'); for (let k = 0; k < 2000; k++) { await frame(); i = C.info(); if (Math.abs(i.crane.vx) + Math.abs(i.crane.vz) < 1e-6) break; }
    }
  }, { tx, tz, tol });
}
// 複数の画像を1枚に並べる（見比べ用）
async function sheet(browser, files, labels, out, cols) {
  const p = await browser.newPage({ viewport: { width: 200 * cols, height: 100 } });
  const imgs = files.map(f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
  await p.setContent('<body style="margin:0;background:#111;font:bold 13px sans-serif;color:#fff"><div style="display:grid;grid-template-columns:repeat(' + cols + ',200px);gap:0">' +
    imgs.map((s, k) => '<div style="position:relative"><img src="' + s + '" style="width:200px;display:block"><div style="position:absolute;left:4px;top:4px;background:rgba(0,0,0,.7);padding:2px 5px;border-radius:4px">' + labels[k] + '</div></div>').join('') + '</div></body>');
  await p.waitForTimeout(200);
  await p.screenshot({ path: out, fullPage: true }); await p.close();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  // ---------------- A. 丸い印の追従
  log('[A 丸い印の追従]');
  // v2.5（修正前）：開始直後に通路の上を右へ動かす → 印が初期位置に置き去りになる様子
  // v2.5 の旧ビルド（tests/tmp/v25/index.html）は引き継ぎ時に持ち込まれていない。無ければ比較撮影を飛ばす
  const HAS_OLD = fs.existsSync(path.resolve(__dirname, 'tmp/v25/index.html'));
  let oldShot = null;
  if (HAS_OLD) {
  const old = await browser.newPage({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 1 });
  await start(old, OLD);
  await press(old, 'bR', true); await sleep(1500); await press(old, 'bR', false); await sleep(600);
  oldShot = await shot(old, 'A0_v25_bug_marker_left_behind');
  const oi = await old.evaluate(() => window.__crane.info());
  log(`  v2.5: claw=(${oi.claw.x.toFixed(2)},${oi.claw.z.toFixed(2)}) aim=${oi.aimId}`);
  await old.close();
  } else log('  （v2.5 の旧ビルドが無いので修正前との比較撮影は省略）');

  await start(page, NEW);
  let i = await info(page);
  check('開始位置は車の上ではない（狙い無し）', i.aimId == null, 'aim=' + i.aimId);
  await page.evaluate(() => window.__crane.trace(true));
  // 同じ操作（通路の上を右へ 1.5 秒）
  await press(page, 'bR', true); await sleep(1500); await press(page, 'bR', false); await sleep(600);
  const newShot = await shot(page, 'A1_v26_marker_follows_on_aisle');
  // 続けて駐車場の奥へ（車の上・隙間・車の上…）→ 左へ横断 → 手前へ戻る（通路）
  const route = [['bU', 1400], ['bL', 2600], ['bU', 700], ['bR', 2000], ['bD', 1800]];
  const film = [];
  for (const [id, ms] of route) {
    await press(page, id, true);
    const t0 = Date.now(); let k = 0;
    while (Date.now() - t0 < ms) {
      await sleep(Math.min(450, ms / 2));
      if (film.length < 12 && k++ < 2) { await page.evaluate(() => window.__crane.pause(true)); film.push({ f: await shot(page, 'A2_follow_' + String(film.length).padStart(2, '0')), i: await info(page) }); await resume(page); }
    }
    await press(page, id, false);
  }
  await sleep(800);
  const tr = await page.evaluate(() => window.__crane.trace(false));
  const mv = tr.filter(f => f.phase === 'move');
  const diff = f => Math.hypot(f.mx - f.cx, f.mz - f.cz);
  const on = mv.filter(f => f.onCar), off = mv.filter(f => !f.onCar);
  const maxOn = Math.max(...on.map(diff)), maxOff = Math.max(...off.map(diff));
  log(`  frames: ${mv.length}（車の上 ${on.length} / 車の外 ${off.length}）  |印−爪| 最大：車の上 ${maxOn.toExponential(1)} m / 車の外 ${maxOff.toExponential(1)} m`);
  check('毎フレーム印が表示されている', mv.every(f => f.vis));
  check('車の上・車の外の両方を十分なフレーム数通った', on.length > 20 && off.length > 20, `on=${on.length} off=${off.length}`);
  check('車の外（狙い無し）でも、毎フレーム印＝爪の真下（差 1mm 未満）', maxOff < 1e-3, maxOff.toExponential(2));
  check('車の上でも、毎フレーム印＝爪の真下（差 1mm 未満）。車の有無で差が変わらない', maxOn < 1e-3, maxOn.toExponential(2));
  // 最初に車の上に来るまでのフレーム：v2.5 ではここで印が初期位置に止まっていた
  const firstOn = mv.findIndex(f => f.onCar), pre = mv.slice(0, firstOn);
  const preMove = Math.hypot(pre[pre.length - 1].mx - pre[0].mx, pre[pre.length - 1].mz - pre[0].mz);
  const preClaw = Math.hypot(pre[pre.length - 1].cx - pre[0].cx, pre[pre.length - 1].cz - pre[0].cz);
  check('最初に車の上に来る前から印が動いている（爪と同じだけ）', preMove > 1 && Math.abs(preMove - preClaw) < 1e-3, `印 ${preMove.toFixed(2)} m / 爪 ${preClaw.toFixed(2)} m（${pre.length} フレーム）`);
  // 滑らかさ：フレーム間の印の移動量は爪の移動量と一致し、飛び（車に当たった瞬間のジャンプ）がない
  // ヘッドレスは描画が遅い（1フレーム最大 0.1 秒）ので、1フレームの移動量は「クレーンの最高速 × その間の時間」と比べる
  const vmax = await page.evaluate(() => window.CraneLogic.CRANE.vmaxEmpty);
  let maxStepDiff = 0, worstRatio = 0, enter = [];
  for (let k = 1; k < mv.length; k++) {
    const sm = Math.hypot(mv[k].mx - mv[k - 1].mx, mv[k].mz - mv[k - 1].mz), sc = Math.hypot(mv[k].cx - mv[k - 1].cx, mv[k].cz - mv[k - 1].cz);
    const dt = Math.min(0.1, (mv[k].t - mv[k - 1].t) / 1000) + 1 / 60;
    maxStepDiff = Math.max(maxStepDiff, Math.abs(sm - sc)); worstRatio = Math.max(worstRatio, sm / (vmax * 1.3 * dt));
    if (mv[k].onCar !== mv[k - 1].onCar) enter.push({ k, sm: +sm.toFixed(3), sc: +sc.toFixed(3) });
  }
  const fps = mv.length / ((mv[mv.length - 1].t - mv[0].t) / 1000);
  check('フレーム間の印の移動は爪の移動と一致し、飛びが無い（車に入る／出る瞬間も）', maxStepDiff < 1e-3 && enter.length >= 2 && enter.every(e => Math.abs(e.sm - e.sc) < 1e-3),
    `描画 ${fps.toFixed(0)} fps、（1フレームの移動は最大で最高速×時間の ${(worstRatio * 100).toFixed(0)}%＝振り子の分）、爪との差 ${maxStepDiff.toExponential(1)}、車の境目 ${enter.length} 回 ${JSON.stringify(enter.slice(0, 4))}`);
  if (oldShot) await sheet(browser, [oldShot, newShot], ['v2.5 修正前', 'v2.6 修正後'], path.join(OUT, 'A0_compare_before_after.png'), 2);
  await sheet(browser, film.map(o => o.f), film.map((o, k) => `${k} ${o.i.aimId == null ? '車の外' : '車#' + o.i.aimId}`), path.join(OUT, 'A2_follow_sheet.png'), 4);
  fs.writeFileSync(path.join(OUT, 'A_trace.json'), JSON.stringify(mv.map(f => ({ mx: +f.mx.toFixed(4), mz: +f.mz.toFixed(4), cx: +f.cx.toFixed(4), cz: +f.cz.toFixed(4), onCar: f.onCar }))));

  // ---------------- B. 下ろすだけで自動で掴んで上がる
  log('[B 下ろすだけで自動で掴んで上がる]');
  const L1 = await page.evaluate(() => { const L = window.CraneLogic, i = window.__crane.info(), lot = L.makeLot(i.seed), c = lot.cars.find(c => c.type.id === 'sedan') || lot.cars[6]; return { id: c.id, x: c.x, z: L.comWorld(c)[1] }; });
  for (let rep = 0; rep < 2; rep++) { await driveTo(page, L1.x, L1.z, 0.03); await waitFor(page, () => window.__crane.info().swingAmpDeg < 0.3, null, 60000); }
  i = await info(page);
  check('狙いの車の真上', i.aimId === L1.id && !i.actDisabled, `aim=${i.aimId} want=${L1.id} act=${i.actLabel}`);
  // ボタンのクリック数と、フレームごとのフェーズ・ボタン状態を記録
  await page.evaluate(() => {
    window.__clicks = 0; document.getElementById('act').addEventListener('pointerdown', () => window.__clicks++);
    window.__ph = []; const f = () => { const p = window.__crane.phase, b = document.getElementById('act'); window.__ph.push([p, b.disabled, b.textContent]); if (p !== 'carry' && p !== 'fall') requestAnimationFrame(f); }; requestAnimationFrame(f);
  });
  const triesB = i.tries;
  await act(page); // ← この1回だけ
  const steps = [
    ['B1_lower', () => window.__crane.phase === 'lower' && window.__crane.info().cable > 9.5, '下降中'],
    ['B2_reached', () => window.__crane.phase === 'down', '届いた'],
    ['B3_closing', () => window.__crane.phase === 'closing' && window.__crane.info().cable > 0, '自動で掴む'],
    ['B4_closed', () => window.__crane.phase === 'closed' || window.__crane.phase === 'lift', '掴んだ'],
    ['B5_lift', () => window.__crane.phase === 'lift' && window.__crane.info().load.bottomY > 0.9, '自動で引き抜き'],
    ['B6_carry', () => window.__crane.phase === 'carry', '運搬の高さ'],
  ];
  const bFiles = [], bLabels = [];
  for (const [name, cond, label] of steps) {
    await pauseWhen(page, cond);
    const si = await info(page);
    bFiles.push(await shot(page, name)); bLabels.push(label + ' ' + si.phase);
    log(`  ${name}: phase=${si.phase} cable=${si.cable.toFixed(2)} act="${si.actLabel}" disabled=${si.actDisabled}${si.load ? ' bottom=' + si.load.bottomY.toFixed(2) : ''}`);
    await resume(page);
  }
  await sleep(300);
  const ph = await page.evaluate(() => window.__ph), clicks = await page.evaluate(() => window.__clicks);
  const seq = ph.map(x => x[0]).filter((p, k, a) => k === 0 || p !== a[k - 1]);
  i = await info(page);
  check('アクションボタンを押したのは「下ろす」の1回だけ', clicks === 1, 'clicks=' + clicks);
  check('フェーズ：下降→届く→掴む→掴んだ→引き抜き→運搬（ボタン無しで進む）', JSON.stringify(seq.slice(seq.indexOf('lower'))) === JSON.stringify(['lower', 'down', 'closing', 'closed', 'lift', 'carry']), seq.join('→'));
  check('届いた後〜引き抜き中はボタンが押せない（自動）', ph.filter(x => ['down', 'closing', 'closed', 'lift'].includes(x[0])).every(x => x[1]), [...new Set(ph.filter(x => ['down', 'closing', 'closed', 'lift'].includes(x[0])).map(x => x[0] + ':' + x[2]))].join(' '));
  check('下降中は「上げる（中止）」が押せる', ph.filter(x => x[0] === 'lower').every(x => !x[1] && /上げる/.test(x[2])));
  check('運搬の高さで掴んだまま（対象確定・試行回数はそのまま）', i.phase === 'carry' && i.target && i.target.id === L1.id && !i.load.detached && i.tries === triesB, `target=${i.target && i.target.id} tries=${i.tries}`);
  check('運搬中の「置く」は従来どおりボタン（ゾーン外では押せない）', i.actDisabled && /運ぶ/.test(i.actLabel), i.actLabel);
  await sheet(browser, bFiles, bLabels, path.join(OUT, 'B_auto_grip_sheet.png'), 3);

  // ---------------- C. 下降の中止（車に届く前）
  log('[C 下降の中止]');
  await page.goto(NEW); await waitFor(page, () => window.__crane && window.__crane.phase === 'title'); await page.click('#startBtn'); await waitFor(page, () => window.__crane.phase === 'move'); await sleep(2400);
  await press(page, 'bU', true); await waitFor(page, () => window.__crane.info().aimId != null, null, 10000); await press(page, 'bU', false);
  await waitFor(page, () => { const c = window.__crane.info().crane; return !c.vx && !c.vz; });
  await waitFor(page, () => window.__crane.info().aimId != null);
  i = await info(page); const triesC = i.tries;
  await act(page);
  // ヘッドレスは描画が遅く、クリックが届く前に車に届いてしまうので、下降中に止めてから押す（ボタンの処理は止めていても動く）
  await pauseWhen(page, () => window.__crane.phase === 'lower' && window.__crane.info().cable > 9.0);
  i = await info(page);
  check('下降中のボタンは「上げる」', i.phase === 'lower' && !i.actDisabled && /上げる/.test(i.actLabel), i.phase + ' ' + i.actLabel);
  await act(page);
  await resume(page);
  await pauseWhen(page, () => window.__crane.phase === 'liftEmpty' && window.__crane.info().cable < 8.6);
  i = await info(page);
  const cFile = await shot(page, 'C1_abort_rising');
  check('押すと下降を中止して巻き上げる（車に触れずに）', i.phase === 'liftEmpty' && i.stopKind === 'abort' && i.contacts.length === 0, `phase=${i.phase} stop=${i.stopKind}`);
  await resume(page);
  await waitFor(page, () => window.__crane.phase === 'move', null, 20000);
  i = await info(page);
  check('戻ったら再び移動できる（試行回数は従来の「やり直す」と同じく1減る）', i.phase === 'move' && i.tries === triesC - 1, `tries ${triesC}→${i.tries}`);

  await browser.close();
  check('JS エラー 0', errors.length === 0, errors.join(' | '));
  const ng = checks.filter(c => !c.ok);
  log(`\n${checks.length - ng.length}/${checks.length} checks passed`);
  if (ng.length) { log('FAILED:', ng.map(c => c.name).join(', ')); process.exit(1); }
})().catch(e => { console.error(e); console.error('errors:', errors); process.exit(1); });
