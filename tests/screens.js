// 画面確認（v2.1 駐車場版／v2.6 届いたら自動で掴んで上げる）：実際のボタン入力で5ラウンド遊び、各場面のスクリーンショットを撮る。
// v2.1：選択フェーズなし（爪の真下の車がライブで狙いになる）、揺れが強く収まりにくい。
// 実行: node tests/screens.js   （../tools の Playwright を使用）
// 十字パッドは本物のボタン要素へ PointerEvent を dispatch（ゲームの入力ハンドラを通る）、アクションは本物のマウスでクリック。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const FILE = path.resolve(__dirname, '../dist/real-crane-game/index.html'); // favicon などを同じフォルダに置いた公開用の出力（npm run build で作る）
const URL = 'file://' + FILE + '?seed=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [], external = [], checks = [];
const log = (...a) => console.log(...a);
const check = (name, ok, detail) => { checks.push({ name, ok }); log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

async function waitFor(page, fn, arg, timeout = 180000) {
  try { await page.waitForFunction(fn, arg, { timeout, polling: 30 }); }
  catch (e) { log('  state at timeout:', JSON.stringify(await page.evaluate(() => ({ phase: window.__crane.phase, ...window.__crane.info() })))); throw e; }
}
const info = page => page.evaluate(() => ({ phase: window.__crane.phase, ...window.__crane.info() }));

// ---- 文字レイアウト検査（お好み焼きと同じ流儀）
const layoutIssues = [];
async function checkLayout(page, name) {
  const res = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect();
    const out = [], texts = [];
    const visible = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false; } return true; };
    const label = el => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''));
    const walker = document.createTreeWalker(document.getElementById('ui'), NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (!n.textContent.trim() || !visible(n.parentElement)) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const rects = [...r.getClientRects()].filter(q => q.width > 0.5 && q.height > 0.5);
      const box = n.parentElement.closest('button, .sheet, .chip');
      const fs = parseFloat(getComputedStyle(n.parentElement).fontSize);
      for (const q0 of rects) {
        const cy = (q0.top + q0.bottom) / 2, hh = Math.min(q0.height, fs) / 2;
        const q = { left: q0.left, right: q0.right, top: cy - hh, bottom: cy + hh };
        const t = n.textContent.trim().slice(0, 14), who = label(n.parentElement) + ' "' + t + '"';
        texts.push({ q, who, node: n });
        const tol = 1;
        if (q.left < app.left - tol || q.right > app.right + tol || q.top < app.top - tol || q.bottom > app.bottom + tol) out.push('off-screen: ' + who);
        if (box) { const b = box.getBoundingClientRect(); if (q.left < b.left - tol || q.right > b.right + tol || q.top < b.top - tol || q.bottom > b.bottom + tol) out.push('outside ' + label(box) + ': ' + who); }
      }
    }
    for (let i = 0; i < texts.length; i++) for (let k = i + 1; k < texts.length; k++) {
      const a = texts[i].q, b = texts[k].q;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) out.push('overlap: ' + texts[i].who + ' × ' + texts[k].who);
    }
    const btns = [...document.querySelectorAll('#ui button')].filter(visible);
    for (const t of texts) for (const bt of btns) {
      if (bt.contains(t.node)) continue;
      const b = bt.getBoundingClientRect(), a = t.q;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) out.push('text over ' + label(bt) + ': ' + t.who);
    }
    for (let i = 0; i < btns.length; i++) for (let k = i + 1; k < btns.length; k++) {
      const a = btns[i].getBoundingClientRect(), b = btns[k].getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push('buttons overlap: ' + label(btns[i]) + ' × ' + label(btns[k]));
    }
    for (const el of document.querySelectorAll('#ui *')) {
      if (!visible(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && getComputedStyle(el).display !== 'inline') out.push('scroll-overflow: ' + label(el) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
    return { issues: out, nText: texts.length };
  });
  if (res.issues.length) { layoutIssues.push(...res.issues.map(s => name + ': ' + s)); log('  LAYOUT NG', name, res.issues); }
  else log('  layout ok', name, '(' + res.nText + ' text boxes)');
}
// スクリーンショット：その瞬間だけ最大解像度で描いて撮る（ヘッドレスは描画が遅く、普段は自動で解像度を落としているため）
const shots = [];
async function shot(page, name) {
  await page.evaluate(() => window.__crane.hiRes(true));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(250); // ヘッドレスでは CSS アニメーション（合成側）の反映が遅れるため
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  await page.evaluate(() => window.__crane.hiRes(false));
  const i = await info(page);
  shots.push(name);
  log(`  screenshot ${name}.png  [phase=${i.phase} crane=(${i.crane.x.toFixed(2)},${i.crane.z.toFixed(2)}) cable=${i.cable.toFixed(2)} swing=${i.swingDeg.toFixed(1)}°${i.load ? ` tilt=${i.load.tiltDeg.toFixed(1)}° cond=${(i.load.condition * 100).toFixed(0)}% bottom=${i.load.bottomY.toFixed(2)}` : ''} repairs=${i.repairs} contacts=${JSON.stringify(i.contacts.map(c => c.source + ':' + c.kind + '@' + c.carId))}]`);
  await checkLayout(page, name);
  return i;
}

// ---- 十字パッド：本物のボタン要素に pointerdown/up を送り、目標座標まで運転する
// loaded=true の時は軸ごとに「押す→制動距離で離す→揺れが収まるのを待つ」慎重な運転
async function driveTo(page, tx, tz, opt = {}) {
  return page.evaluate(async ({ tx, tz, opt }) => {
    const L = window.CraneLogic, C = window.__crane;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    const ev = (id, type) => document.getElementById(id).dispatchEvent(new PointerEvent(type, { pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true }));
    const tol = opt.tol || 0.08, loaded = !!opt.loaded;
    const acc = loaded ? L.CRANE.accelLoaded * L.CRANE.brake : L.CRANE.accelEmpty * L.CRANE.brake;
    const lag = loaded ? 0.9 : 0.05; // 加速度の立ち上がり遅れ分の余裕
    for (const ax of ['x', 'z']) {
      for (let iter = 0; iter < 60; iter++) {
        let i = C.info(); const pos = i.crane[ax], v = i.crane['v' + ax], d = (ax === 'x' ? tx : tz) - pos;
        if (Math.abs(d) <= tol) break;
        const id = ax === 'x' ? (d > 0 ? 'bR' : 'bL') : (d > 0 ? 'bD' : 'bU');
        ev(id, 'pointerdown');
        for (let k = 0; k < 2000; k++) {
          await frame(); i = C.info();
          const vv = i.crane['v' + ax], rem = ((ax === 'x' ? tx : tz) - i.crane[ax]) * Math.sign(d);
          if (rem <= vv * vv / (2 * acc) + Math.abs(vv) * lag * 0.5 + tol * 0.3 || C.phase !== opt.phase) break;
        }
        ev(id, 'pointerup');
        for (let k = 0; k < 2000; k++) { await frame(); i = C.info(); if (Math.abs(i.crane.vx) + Math.abs(i.crane.vz) < 1e-6) break; }
        if (loaded && opt.settle) for (let k = 0; k < 3000; k++) { await frame(); if (C.info().swingAmpDeg < opt.settle || C.phase !== opt.phase) break; }
        if (C.phase !== opt.phase) return C.phase;
      }
    }
    return C.phase;
  }, { tx, tz, opt: Object.assign({ phase: 'move' }, opt) });
}
// 方向ボタンを指定時間押し続ける（荒い運転用）
async function hold(page, ids, ms) {
  await page.evaluate(async ({ ids, ms }) => {
    const ev = (id, type) => document.getElementById(id).dispatchEvent(new PointerEvent(type, { pointerId: 12, pointerType: 'touch', isPrimary: true, bubbles: true }));
    ids.forEach(id => ev(id, 'pointerdown'));
    await new Promise(r => setTimeout(r, ms));
    ids.forEach(id => ev(id, 'pointerup'));
  }, { ids, ms });
}
// 本物のマウスでアクションボタンを押す
async function act(page) { const b = await page.locator('#act').boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }

// v2.1：選択フェーズは無い。ターン開始直後から爪を動かせることを確かめ、車の真上へ運ぶと狙いになる
async function roundStart(page) {
  await waitFor(page, () => window.__crane.phase === 'move');
  await sleep(2400); // バナーが消えるのを待つ
  const i = await info(page);
  check(`残り${i.left}台・失敗${i.fails}回：開始直後から操作できる（phase=move・十字パッド表示）・値札は全車に常時表示 (${i.tagsVisible.shown}/${i.tagsVisible.present})`,
    i.phase === 'move' && i.tagsVisible.shown === i.tagsVisible.present && i.tagsVisible.present > 0 && await page.locator('#ctl').isVisible());
}
async function aimAt(page, id) {
  const c = await page.evaluate(id => { const i = window.__crane.info(), L = window.CraneLogic, c = i.cars[id], lot = L.makeLot(i.seed); return [c.x, L.comWorld(lot.cars[id])[1]]; }, id);
  await driveTo(page, c[0], c[1], { tol: 0.05 });
  await waitFor(page, id => window.__crane.info().aimId === id, id, 8000);
  return info(page);
}
// 条件が成り立ってから ms 後（演出が出たところ）で進行を一時停止する
async function pauseWhen(page, fn, ms) {
  await page.evaluate(({ src, ms }) => new Promise(res => { const cond = eval(src); const f = () => { if (cond()) setTimeout(() => { window.__crane.pause(true); res(); }, ms); else requestAnimationFrame(f); }; f(); }), { src: '(' + fn.toString() + ')', ms });
}
// 揺れが収まるまで待つ
async function settle(page, deg = 0.12) { await waitFor(page, d => window.__crane.info().swingAmpDeg < d, deg, 30000); }
// 爪を目標位置へ（空の爪）→ 揺れが収まるのを待つ
async function moveClaw(page, x, z) {
  await driveTo(page, x, z, { tol: 0.02 });
  await settle(page);
  // 揺れの名残で爪の位置がずれていないか確認して微調整
  await driveTo(page, x, z, { tol: 0.02 });
  await settle(page);
}
// v2.6：「下ろす」を押したら、届いた（止まった）ところまで待つ。届いた後の掴む・上げる・戻すは自動
const reached = () => window.__crane.info().stopKind != null && window.__crane.phase !== 'lower';
async function lowerAndWait(page) {
  await act(page); // 下ろす（stopKind は押した瞬間に null に戻る）
  await waitFor(page, reached);
}
// 吊った車を運ぶ：logic の慎重な運転手（carefulDriver）の判断どおりに、本物の十字ボタンを押す／離す
async function carefulCarry(page, tx, tz, opt = {}) {
  return page.evaluate(async ({ tx, tz, opt }) => {
    const L = window.CraneLogic, C = window.__crane;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    const ev = (id, type) => document.getElementById(id).dispatchEvent(new PointerEvent(type, { pointerId: 31, pointerType: 'touch', isPrimary: true, bubbles: true }));
    const drv = L.carefulDriver(tx, tz, opt);
    const btn = { x: { '1': 'bR', '-1': 'bL' }, z: { '1': 'bD', '-1': 'bU' } }, cur = { x: 0, z: 0 };
    let maxSwing = 0; const t0 = performance.now();
    let last = performance.now();
    while (C.phase === 'carry' && performance.now() - t0 < (opt.timeout || 150000)) {
      const d = C.driveState(), p = L.typeById(d.type), now = performance.now();
      const cmd = drv(d.crane, d.swing, d.cable, p, Math.min(0.1, (now - last) / 1000)); last = now; // ゲームと同じく1フレーム最大0.1秒
      for (const k of ['x', 'z']) if (cmd[k] !== cur[k]) { if (cur[k]) ev(btn[k][cur[k]], 'pointerup'); if (cmd[k]) ev(btn[k][cmd[k]], 'pointerdown'); cur[k] = cmd[k]; }
      maxSwing = Math.max(maxSwing, C.info().swingDeg);
      if (drv.state.done) break;
      await frame();
    }
    for (const k of ['x', 'z']) if (cur[k]) ev(btn[k][cur[k]], 'pointerup');
    return { done: drv.state.done, maxSwing, secs: (performance.now() - t0) / 1000 };
  }, { tx, tz, opt });
}
async function carryToZone(page) {
  const Z = await page.evaluate(() => window.CraneLogic.ZONE);
  return carefulCarry(page, (Z.x0 + Z.x1) / 2, (Z.z0 + Z.z1) / 2);
}
async function placeAndGet(page, shotName) {
  await act(page); // 置く
  await waitFor(page, () => window.__crane.phase === 'place');
  await waitFor(page, () => window.__crane.phase === 'get', null, 60000);
  await sleep(200);
  if (shotName) await shot(page, shotName);
  await waitFor(page, () => window.__crane.phase === 'card');
}
// v2.2：結果カードの写真を調べて保存（中身のばらつき・大きさ・画面内）
async function photoCard(page, file) {
  const r = await page.evaluate(() => {
    const img = document.getElementById('pImg'), ph = document.getElementById('photo'), b = ph.getBoundingClientRect(), app = document.getElementById('app').getBoundingClientRect();
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data; let s = 0, s2 = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) { const v = (d[k] + d[k + 1] + d[k + 2]) / 3; s += v; s2 += v * v; n++; }
    const mean = s / n;
    return { cls: ph.className, nw: img.naturalWidth, sd: Math.sqrt(s2 / n - mean * mean), cap: document.getElementById('pCap').textContent, src: img.src.slice(0, 5), url: (() => { const k = document.createElement('canvas'); k.width = img.naturalWidth; k.height = img.naturalHeight; k.getContext('2d').drawImage(img, 0, 0); return k.toDataURL('image/jpeg', 0.92); })(),
      inside: b.left >= app.left - 2 && b.right <= app.right + 2 && b.top >= app.top && b.bottom <= app.bottom };
  });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.url.split(',')[1], 'base64'));
  delete r.url; return r;
}
// 重心の真上（幅方向は車の中心）
const overCom = i => [i.aim.x, i.aim.com[1]];
// 爪の指先が隣の車に深く入って乗り上げる（＝掴めない失敗になる）狙いの位置を logic の下降の模擬で探す
async function findBumpSpot(page) {
  return page.evaluate(() => {
    const L = window.CraneLogic, i = window.__crane.info(), lot = L.makeLot(i.seed);
    lot.cars.forEach(c => { const g = i.cars[c.id]; c.present = g.present; c.damage = g.damage; });
    for (const c of lot.cars) {
      if (!c.present) continue;
      const nb = L.neighbors(lot, c);
      for (const [side, sx] of [['left', -1], ['right', 1]]) {
        if (!nb[side]) continue;
        // 指先が隣の車に深く入る位置を探す（下降を logic で模擬）
        const cz = L.comWorld(c)[1];
        for (let off = 0.2; off < 1.6; off += 0.02) {
          if (L.carUnder(lot, c.x + sx * (off + 0.04), cz) !== c) break; // 爪の真下が隣の車に変わる手前まで
          const d = L.simulateDescent(lot, c, c.x + sx * off, cz);
          if (d.stop === 'neighbor') return { id: c.id, off: sx * off, nb: nb[side].id };
        }
      }
    }
    return null;
  });
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 693 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('request', r => { if (!r.url().startsWith('file://') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
  const t0 = Date.now();
  await page.goto(URL);
  await waitFor(page, () => window.__crane && window.__crane.phase === 'title');
  await sleep(800);
  log('[タイトル]');
  await shot(page, '00_title');
  await page.click('#startBtn');
  await roundStart(page);
  let i = await info(page);
  check('WebAudio：スタート操作で AudioContext が動作中', i.audio === 'running', 'state=' + i.audio);
  check('駐車場：10台・空き2区画', i.cars.length === 10 && i.cars.every(c => c.present));
  check('車種は5種類以上', new Set(i.cars.map(c => c.type)).size >= 5, [...new Set(i.cars.map(c => c.type))].join(','));
  check('開始位置（通路の上）では狙い無し・「下ろす」は押せない', i.aimId == null && i.actDisabled && /車の上へ/.test(i.actLabel), `aim=${i.aimId} act="${i.actLabel}"`);
  await shot(page, '01_lot');
  const cl = await page.evaluate(() => window.__crane.craneLayout());
  check('v2.4 クレーンの脚・梁・レールは駐車場の奥端より奥だけ（手前・前面に構造物なし、半透過の部材なし）', cl.meshes > 0 && cl.frontMeshes === 0 && cl.transparent === 0 && cl.maxZ < cl.lotBackZ, JSON.stringify(cl));
  await shot(page, '41_lot_no_front_crane');
  await page.evaluate(() => window.__crane.cam([14, 22, 16, 0, 0, -6]));
  await shot(page, '42_overview_oblique');
  await page.evaluate(() => window.__crane.cam(null));

  // ---------------- ROUND 1：スポーツカーを選び、真上から下ろして真っ直ぐ引き抜き、GET（無傷・接触なし）
  log('[R1 スポーツカー：きれいに]');
  const L1 = await page.evaluate(() => { const L = window.CraneLogic, i = window.__crane.info(); return i.cars.map(c => ({ id: c.id, type: c.type, value: c.value })); });
  const sports = L1.find(c => c.type === 'sports');
  // 自由移動中のハイライト切替：まず隣の車の上 → スポーツカーの上へ。爪の真下の車が切り替わる
  const lotInfo = await page.evaluate(() => { const L = window.CraneLogic, i = window.__crane.info(), lot = L.makeLot(i.seed); return lot.cars.map(c => ({ id: c.id, nb: L.neighbors(lot, c) })).map(o => ({ id: o.id, left: o.nb.left && o.nb.left.id, right: o.nb.right && o.nb.right.id })); });
  const nbOf = lotInfo[sports.id], firstId = nbOf.left != null ? nbOf.left : nbOf.right;
  i = await aimAt(page, firstId);
  const first = L1.find(c => c.id === firstId);
  check('自由移動：爪の真下の車がライブで狙いになる（値札ハイライト・HUD に価値・隙間。★と倍率は出さない）', i.aimId === firstId && i.hud.name.length > 0 && i.hud.val === '¥' + first.value + '万' && /隙間/.test(i.hud.aim) && !/[★☆×]/.test(i.hud.aim) && !i.actDisabled, JSON.stringify(i.hud));
  check('自由移動：狙いの車種に合わせて爪の大きさが変わる', i.clawType === first.type, `claw=${i.clawType} car=${first.type}`);
  check('v2.4 狙いを当てた車の値札だけ消える（他は表示）', !i.tagsVisible.aimShown && i.tagsVisible.shown === i.tagsVisible.present - 1 && JSON.stringify(i.tagsVisible.hiddenIds) === JSON.stringify([firstId]), JSON.stringify(i.tagsVisible));
  await shot(page, '02_aim_switch_a');
  i = await aimAt(page, sports.id);
  check('自由移動：隣の車へ動かすと狙いが切り替わる', i.aimId === sports.id && i.hud.val === '¥' + sports.value + '万' && i.clawType === 'sports', JSON.stringify(i.hud));
  check('v2.4 狙いが移ると前の車の値札は再表示・新しい狙いの値札だけ消える', !i.tagsVisible.aimShown && JSON.stringify(i.tagsVisible.hiddenIds) === JSON.stringify([sports.id]), JSON.stringify(i.tagsVisible));
  check('掴む前は対象未確定（target=null）', i.target == null);
  await shot(page, '02b_aim_switch_b');
  let [tx, tz] = overCom(i);
  await moveClaw(page, tx, tz);
  await shot(page, '03_aim');
  await shot(page, '40_aim_tag_hidden');
  await act(page);
  // 下降中：指先が隣の車の屋根の高さを通るところ
  await page.evaluate(() => new Promise(res => { const f = () => { const i = window.__crane.info(); if (window.__crane.phase !== 'lower' || i.claw.y - window.CraneLogic.CRANE.clawH(window.CraneLogic.typeById(i.clawType)) < 2.3) { window.__crane.pause(true); res(); } else requestAnimationFrame(f); }; f(); }));
  i = await info(page);
  check('R1 下降中を撮影できた', i.phase === 'lower', 'phase=' + i.phase);
  await shot(page, '04_lower');
  await page.evaluate(() => window.__crane.pause(false));
  await waitFor(page, reached);
  i = await info(page);
  check('R1 真上から下ろすと屋根に届き、隣に触れない', i.stopKind === 'target' && i.contacts.length === 0, `stop=${i.stopKind} contacts=${i.contacts.length}`);
  // v2.6：ボタンを押さずに自動で掴む
  await waitFor(page, () => ['closed', 'lift', 'carry'].includes(window.__crane.phase), null, 10000);
  i = await info(page);
  check('R1 掴んだ時点で対象が確定（target=スポーツカー、価値＝基本価格）', i.target && i.target.id === sports.id && i.target.value === sports.value && i.hud.aim === '', `target=${i.target && i.target.id} value=${i.target && i.target.value}`);
  // v2.6：引き抜きも自動
  await waitFor(page, () => { const i = window.__crane.info(); return window.__crane.phase === 'carry' || (window.__crane.phase === 'lift' && i.load && i.load.bottomY > 0.55); });
  await shot(page, '05_pull');
  await waitFor(page, () => window.__crane.phase === 'carry', null, 60000);
  i = await info(page);
  check('R1 真っ直ぐ引き抜けた（接触 0・状態 100%）', i.contacts.length === 0 && i.load.condition === 1, JSON.stringify(i.contacts));
  i = await info(page);
  check('運搬中の HUD に状態が出ている', /状態：無傷（100%）/.test(await page.evaluate(() => document.getElementById('hCond').textContent)));
  check('運搬中も値札は残りの車すべてに表示（掴んだ車だけ消える）', i.tagsVisible.shown === i.tagsVisible.present - 1, JSON.stringify(i.tagsVisible));
  let cr1 = await carryToZone(page);
  log(`  careful carry: ${cr1.secs.toFixed(0)}s, max swing ${cr1.maxSwing.toFixed(1)}°`);
  i = await info(page);
  check('R1 回収ゾーン到着・「置く」が押せる', i.inZone && !i.actDisabled, `crane=(${i.crane.x.toFixed(1)},${i.crane.z.toFixed(1)}) act="${i.actLabel}"`);
  await placeAndGet(page, '06_get');
  i = await info(page);
  check('R1 GET：価値×状態（無傷）', i.results[0].kind === 'get' && i.results[0].score === i.results[0].value && i.results[0].repairs === 0, JSON.stringify(i.results[0]));
  check('preserveDrawingBuffer は無効（写真は撮る瞬間に描き直して取得）', i.preserveDrawingBuffer === false, String(i.preserveDrawingBuffer));
  check('GET の瞬間に写真を1枚撮った（kind=get）', i.photo && i.photo.kind === 'get' && i.photoCount === 1, JSON.stringify(i.photo && { kind: i.photo.kind, ms: i.photo.ms, prof: i.photo.prof }));
  await sleep(1800); // 写真の「現像」アニメーション
  let pc = await photoCard(page, '06p_get_photo.jpg');
  check('GET カードにポラロイド写真（640px・中身あり・画面内・キャプション）', /show/.test(pc.cls) && !/fail/.test(pc.cls) && pc.nw === 640 && pc.sd > 15 && pc.inside && /GET!/.test(pc.cap) && pc.cap.includes('¥' + i.results[0].value + '万'), JSON.stringify(pc)); // 価値は囲まれ度の廃止（2026-11-24）で基本価格どおり
  await shot(page, '06b_get_card');
  check('GET カード：残りの台数と「続ける」ボタン（ラウンド制は無い）', await page.evaluate(() => /あと 9台/.test(document.getElementById('cScore').textContent) && document.getElementById('cBtn').textContent === '続ける'));
  await page.click('#cBtn');

  // ---------------- ROUND 2：右にずらして下ろす → 爪が隣の車を「こする」→ 引き抜き中に右へ動かす →「ぶつける」→ 減額して GET
  log('[R2 接触：こすった→ぶつけた]');
  await roundStart(page);
  i = await info(page);
  check('R1 で取った車は駐車場から消えた', !i.cars.find(c => c.id === sports.id).present);
  // 右隣に車がいて、こすりの幅（余裕〜余裕+0.12）が爪の開き内に収まる車
  const cand2 = await page.evaluate(() => {
    const L = window.CraneLogic, lot = { cars: [] }; // 画面の状態から再現する代わりに info を使う
    const i = window.__crane.info();
    return i.cars.filter(c => c.present).map(c => c.id);
  });
  const pick2 = await page.evaluate(ids => {
    // ゲーム内の lot を直接触らず、logic で同じ配置を作って判定（seed が同じ・取った車だけ除外）
    const L = window.CraneLogic, i = window.__crane.info(), lot = L.makeLot(i.seed);
    lot.cars.forEach(c => { const g = i.cars[c.id]; c.present = g.present; c.damage = g.damage; });
    let best = null;
    for (const c of lot.cars) {
      if (!c.present) continue;
      const nb = L.neighbors(lot, c), sl = L.clawSlack(lot, c);
      if (!nb.right || sl.right == null) continue;
      if (sl.right + 0.06 >= L.CLAW.openMargin - L.CLAW.tipR) continue;
      if (!best || L.carValue(lot, c) > L.carValue(lot, best.c)) best = { c, slack: sl.right, right: nb.right.id };
    }
    return best && { id: best.c.id, slack: best.slack, right: best.right };
  }, cand2);
  check('R2 こすり用の車が見つかった', !!pick2, JSON.stringify(pick2));
  i = await aimAt(page, pick2.id);
  [tx, tz] = overCom(i);
  await moveClaw(page, tx + pick2.slack + 0.05, tz);
  i = await info(page);
  check('R2 少しずらしても爪の真下は同じ車（狙いのまま）', i.aimId === pick2.id, 'aim=' + i.aimId);
  log(`  claw offset = ${(i.claw.x - tx).toFixed(3)} (slack ${pick2.slack.toFixed(3)})`);
  await act(page);
  await pauseWhen(page, () => window.__crane.info().contacts.length > 0 || window.__crane.phase !== 'lower', 420);
  const popInfo7 = await page.evaluate(() => [...document.querySelectorAll('.pop')].map(d => ({ t: d.textContent, op: getComputedStyle(d).opacity })));
  check('R2 「爪がこすった！」の表示が出ている', popInfo7.some(p => /こすった/.test(p.t)), JSON.stringify(popInfo7));
  await shot(page, '07_contact_claw_scrape');
  await page.evaluate(() => window.__crane.pause(false));
  await waitFor(page, reached);
  i = await info(page);
  check('R2 爪が右隣の車をこすった（軽）・それでも屋根に届く', i.contacts.length === 1 && i.contacts[0].source === 'claw' && i.contacts[0].kind === 'scrape' && i.contacts[0].carId === pick2.right && i.stopKind === 'target', JSON.stringify(i.contacts) + ' stop=' + i.stopKind);
  check('R2 こすった隣の車に弁償が発生・傷デカール', i.repairs > 0 && i.decals >= 1 && i.cars[pick2.right].damage > 0, `repairs=${i.repairs} decals=${i.decals}`);
  await waitFor(page, () => window.__crane.phase === 'lift', null, 10000); // v2.6：こすっても掴めれば自動で掴んで引き抜き開始
  // 引き抜き中（まだ区画の中）に右へ押す。0.8 m/s まで出たら離す（v2.1 は加速が強いので、押し続けると揺れが限界近くまで育つ）
  await page.evaluate(() => new Promise(res => {
    const b = document.getElementById('bR'); b.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 21, bubbles: true }));
    const f = () => { const i = window.__crane.info(); if (i.crane.vx >= 0.8 || i.contacts.some(c => c.source === 'load') || window.__crane.phase !== 'lift') { b.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, bubbles: true })); res(); } else requestAnimationFrame(f); }; f();
  }));
  await pauseWhen(page, () => window.__crane.info().contacts.some(c => c.source === 'load') || window.__crane.phase !== 'lift', 420);
  const popInfo = await page.evaluate(() => [...document.querySelectorAll('.pop')].map(d => ({ t: d.textContent, op: getComputedStyle(d).opacity, top: d.getBoundingClientRect().top })));
  check('R2 「ぶつけた！」の表示が出ている', popInfo.some(p => /ぶつけた/.test(p.t)), JSON.stringify(popInfo));
  await shot(page, '08_contact_bump');
  await page.evaluate(() => window.__crane.pause(false));
  i = await info(page);
  const loadEv = i.contacts.filter(c => c.source === 'load');
  check('R2 引き抜き中に動かすと、吊った車が隣に「ぶつかる」（重）', loadEv.some(c => c.kind === 'bump'), JSON.stringify(loadEv));
  check('R2 ぶつけて状態が下がる（重いほど減額大）', i.load.condition < 0.9, `cond=${i.load.condition.toFixed(2)}`);
  await waitFor(page, () => window.__crane.phase === 'carry', null, 60000);
  await carryToZone(page);
  await placeAndGet(page, '09_get_damaged');
  i = await info(page);
  const r2 = i.results[1];
  check('R2 GET：価値×状態−弁償', r2.kind === 'get' && r2.condition < 1 && r2.repairs > 0 && r2.score === Math.round(r2.value * r2.condition) - r2.repairs, JSON.stringify(r2));
  await sleep(1800);
  pc = await photoCard(page, '09p_get_damaged_photo.jpg');
  check('R2 GET カードにも写真', /show/.test(pc.cls) && pc.nw === 640 && pc.sd > 15, JSON.stringify(pc));
  await shot(page, '09b_damaged_card');
  await page.click('#cBtn');

  // ---------------- ROUND 3：1回目は大きくずらして爪が隣の車に乗り上げる（ぶつけた）→ 2回目は前後に大きくずらして傾き滑落
  log('[R3 爪が乗り上げ → 滑落]');
  await roundStart(page);
  const pick3 = await findBumpSpot(page);
  check('R3 乗り上げ用の位置が見つかった', !!pick3, JSON.stringify(pick3));
  i = await aimAt(page, pick3.id);
  [tx, tz] = overCom(i);
  await moveClaw(page, tx + pick3.off + Math.sign(pick3.off) * 0.04, tz);
  await act(page);
  await pauseWhen(page, () => window.__crane.info().contacts.length > 0 || window.__crane.phase !== 'lower', 420);
  await shot(page, '10_contact_claw_bump');
  await page.evaluate(() => window.__crane.pause(false));
  await waitFor(page, reached);
  i = await info(page);
  check('R3 爪が隣の車に乗り上げて止まる（ぶつけた・掴めない）', i.stopKind === 'neighbor' && !i.gripped && i.contacts.some(c => c.source === 'claw' && c.kind === 'bump'), `stop=${i.stopKind} ${JSON.stringify(i.contacts)}`);
  check('v2.6 R3 掴めなかった後はボタン不要（押せない・自動で戻す表示）', i.actDisabled && /自動/.test(i.actLabel), i.actLabel);
  await waitFor(page, () => window.__crane.phase === 'move', null, 30000); // ボタンを押さずに待つだけ
  i = await info(page);
  check('R3 掴めなかった＝失敗1回。カードは出さずにその場で続行（ラウンドは無い）', i.fails === 1 && i.phase === 'move' && i.results.length === 3 && i.results[2].kind === 'miss' && i.outcome == null, `fails=${i.fails} results=${i.results.map(r => r.kind)}`);
  check('R3 乗り上げた弁償は失敗の記録に入る（0 − 弁償）', i.results[2].repairs > 0 && i.results[2].score === -i.results[2].repairs && i.repairs === 0, JSON.stringify(i.results[2]));
  check('HUD に失敗の数（✕1つ・○2つ）', await page.evaluate(() => document.getElementById('hTries').textContent === '失敗 ✕○○'));
  // 2回目：重心から長手方向に大きくずらす → 傾いて滑り落ちる
  const so = await page.evaluate(() => { const L = window.CraneLogic, i = window.__crane.info(); return L.slipOffset(L.typeById(i.aim.type)); });
  const flip = i.aim.com[1] < i.aim.z ? -1 : 1; // 重心のある側（z）
  await moveClaw(page, tx, i.aim.com[1] + flip * so * 1.25);
  await lowerAndWait(page);
  i = await info(page);
  check('R3 2回目は屋根に届く', i.stopKind === 'target');
  await waitFor(page, () => window.__crane.phase === 'fall' || (window.__crane.info().load && window.__crane.info().load.tiltDeg > 14), null, 30000);
  if ((await info(page)).phase === 'lift') await shot(page, '11_tilt');
  await waitFor(page, () => window.__crane.phase === 'fall', null, 30000);
  i = await info(page);
  check('R3 傾きで滑落（cause=tilt）', i.load.cause === 'tilt', `maxTilt=${i.load.maxTiltDeg.toFixed(1)}°`);
  // v2.2：引き抜き中の低い落下でも大破する（ただし控えめ）
  await pauseWhen(page, () => { const w = window.__crane.info().wreck; return !!w && w.t >= 0.2; }, 0);
  i = await info(page);
  check('R3 低い落下でも大破・爆発（激しさは控えめ 0.2〜0.45）', i.wreck && i.wreck.power >= 0.2 && i.wreck.power < 0.45 && i.wreck.parts >= 2 && i.fire > 5, i.wreck && `h0=${i.wreck.h0.toFixed(2)}m impact=${i.wreck.impact.toFixed(2)} power=${i.wreck.power.toFixed(2)} parts=${i.wreck.parts} fire=${i.fire} smoke=${i.smoke} shake=${i.shake.toFixed(2)}`);
  check('R3 小さな爆発では屋根は飛ばない', i.wreck && !i.wreck.plan.roofOff);
  await shot(page, '12a_explode_small');
  await page.evaluate(() => window.__crane.pause(false));
  await waitFor(page, () => window.__crane.info().fallDone, null, 30000);
  await shot(page, '12_fallen');
  await waitFor(page, () => window.__crane.phase === 'card');
  i = await info(page);
  const r3 = i.results[3];
  check('R3 落下は 0 − 弁償・失敗2回目', r3.kind === 'fall' && r3.score === -r3.repairs && i.fails === 2 && i.outcome == null, JSON.stringify(r3) + ' fails=' + i.fails);
  check('R3 爆発直後に写真を撮った（kind=wreck）', i.photo && i.photo.kind === 'wreck', JSON.stringify(i.photo && { kind: i.photo.kind, len: i.photo.len }));
  await sleep(1800);
  pc = await photoCard(page, '12p_fail_photo.jpg');
  check('R3 失敗カードに写真（fail 額・中身あり・「大破」）', /show/.test(pc.cls) && /fail/.test(pc.cls) && pc.nw === 640 && pc.sd > 10 && pc.inside && /大破/.test(pc.cap), JSON.stringify(pc));
  await shot(page, '12b_fail_photo_card');
  check('失敗カードに失敗の数と「続ける」', await page.evaluate(() => /失敗 2\/3（あと1回でゲームオーバー）/.test(document.getElementById('cScore').textContent) && document.getElementById('cBtn').textContent === '続ける'), await page.evaluate(() => document.getElementById('cScore').textContent));
  await page.click('#cBtn');

  // ---------------- ROUND 4：雑に運ぶ（押しっぱなし→離す）と大きく揺れ、止まっても収まらない → 慎重な運転で揺れを殺して GET
  // ---------------- ROUND 5：残りで一番高い車をきれいに
  for (const rn of [4, 5]) {
    log(`[R${rn} ${rn === 4 ? '揺れが収まらない運搬' : 'きれいに'}]`);
    await roundStart(page);
    i = await info(page);
    const best = i.cars.filter(c => c.present).sort((a, b) => b.value - a.value)[0];
    i = await aimAt(page, best.id);
    if (rn === 4) { check('R4 前のラウンドの残骸（黒焦げ）が駐車場に残っている', i.wrecks === 1, 'wrecks=' + i.wrecks); await shot(page, '13_aim_after'); }
    [tx, tz] = overCom(i);
    await moveClaw(page, tx, tz);
    await lowerAndWait(page);
    await waitFor(page, () => window.__crane.phase === 'carry', null, 60000); // v2.6：掴む・上げるは自動
    if (rn === 4) {
      // 押す長さを logic で選ぶ：雑に押しっぱなしで手前へ運んで離すと、落ちはしないが大きく揺れが残る長さ
      const plan = await page.evaluate(() => {
        const L = window.CraneLogic, d = window.__crane.driveState(), p = L.typeById(d.type);
        let best = null;
        for (let h = 1.5; h <= 7; h += 0.1) {
          const c = { ...d.crane }, s = { ...d.swing }; let mx = 0, t = 0;
          for (; t < 30; t += 1 / 60) { L.stepCrane(c, { x: 0, z: t < h ? 1 : 0 }, 1 / 60, true); L.stepSwing(s, c.ax, c.az, d.cable, p, 1 / 60); mx = Math.max(mx, L.swingMag(s)); if (t > h && !c.vz) break; }
          const amp = L.swingAmp(s, p, d.cable);
          if (mx < 0.72 * p.swingLimit && c.z < L.ZONE.z1 - 0.5 && (!best || amp > best.amp)) best = { h, amp: amp / L.DEG, max: mx / L.DEG, lim: p.swingLimit / L.DEG };
        }
        return best;
      });
      log('  rough push plan', JSON.stringify(plan));
      await hold(page, ['bD'], plan.h * 1000);
      await waitFor(page, () => Math.abs(window.__crane.info().crane.vz) < 1e-6, null, 20000);
      await sleep(1500);
      const a1 = await info(page);
      await pauseWhen(page, () => true, 0);
      await shot(page, '15_swing_after_stop');
      await page.evaluate(() => window.__crane.pause(false));
      // ゲージは瞬間の振れ角を出すので、振り子が中央を通る瞬間を避けて 3 秒間の最大を見る（止めた直後の大きな揺れのうちに）
      const ga = await page.evaluate(async () => { let best = { w: '0%', v: '' }; const t0 = performance.now(); while (performance.now() - t0 < 3000) { const w = document.getElementById('gSwing').style.width; if (parseFloat(w) > parseFloat(best.w)) best = { w, v: document.getElementById('vSwing').textContent }; await new Promise(r => requestAnimationFrame(r)); } return best; });
      await sleep(5000);
      const a2 = await info(page);
      check('R4 雑に運ぶと止まった後も大きく揺れている', a1.swingAmpDeg > 6 && a1.phase === 'carry', `amp=${a1.swingAmpDeg.toFixed(1)}° (limit ${plan.lim}°)`);
      // v2.5：待てばちゃんと収まっていく（8秒で 25〜80% に減る。v2.1 は7割以上残った）
      check('R4 8秒待つと揺れがはっきり減っていく（25〜80%）', a2.swingAmpDeg < 0.8 * a1.swingAmpDeg && a2.swingAmpDeg > 0.25 * a1.swingAmpDeg && a2.phase === 'carry', `${a1.swingAmpDeg.toFixed(1)}° → ${a2.swingAmpDeg.toFixed(1)}°`);
      await shot(page, '15b_swing_8s_later');
      check('R4 揺れゲージに揺れが出ている', parseFloat(ga.w) > 20, JSON.stringify(ga));
    }
    const cc = await carryToZone(page);
    log(`  careful carry: ${cc.secs.toFixed(0)}s, max swing ${cc.maxSwing.toFixed(1)}°`);
    i = await info(page);
    check(`R${rn} 慎重な運転で揺れを殺してゾーンへ（落とさない）`, cc.done && i.phase === 'carry' && i.inZone && i.swingAmpDeg < 1.6, `amp=${i.swingAmpDeg.toFixed(2)}° ${cc.secs.toFixed(0)}s`);
    await placeAndGet(page, rn === 4 ? '16_get_after_swing' : null);
    i = await info(page);
    const r = i.results[i.results.length - 1];
    check(`R${rn} GET（接触なし・着地の衝撃なし）`, r.kind === 'get' && r.repairs === 0 && r.condition === 1, JSON.stringify(r));
    await page.click('#cBtn');
  }

  // ---------------- 3回目の失敗 → ゲームオーバー
  log('[3回目の失敗でゲームオーバー]');
  await roundStart(page);
  const pick6 = await findBumpSpot(page);
  check('3回目：乗り上げ用の位置が見つかった', !!pick6, JSON.stringify(pick6));
  i = await aimAt(page, pick6.id);
  [tx, tz] = overCom(i);
  await moveClaw(page, tx + pick6.off + Math.sign(pick6.off) * 0.04, tz);
  await act(page);
  await waitFor(page, () => window.__crane.phase === 'card', null, 60000);
  await sleep(400);
  i = await info(page);
  check('3回失敗した時点でゲームオーバー（カード「取れず」・「結果を見る」）', i.fails === 3 && i.outcome === 'over' && i.left === 5 && await page.evaluate(() => /取れず/.test(document.getElementById('cTitle').textContent) && /ゲームオーバー/.test(document.getElementById('cScore').textContent) && document.getElementById('cBtn').textContent === '結果を見る'), `fails=${i.fails} outcome=${i.outcome} left=${i.left}`);
  await shot(page, '13b_gameover_card');
  await page.click('#cBtn');

  // ---------------- 結果
  log('[結果]');
  await waitFor(page, () => window.__crane.phase === 'result');
  await sleep(400);
  i = await info(page);
  const sum = i.results.reduce((a, r) => a + r.score, 0);
  check('結果：全部の挑戦の合計（GET 4・掴めず 2・落下 1）', i.results.length === 7 && i.total === sum && i.results.filter(r => r.kind === 'get').length === 4, `total=${i.total} ${JSON.stringify(i.results.map(r => r.kind + ':' + r.score))}`);
  const shown = await page.evaluate(() => document.getElementById('rTotal').textContent);
  check('結果画面の合計表示が一致', shown.startsWith('¥' + sum), shown);
  const head = await page.evaluate(() => ({ h: document.getElementById('rHead').textContent, c: document.getElementById('rHead').className, s: document.getElementById('rSub').textContent }));
  check('結果画面の見出しは GAME OVER（GET 台数と失敗回数つき）', head.h === 'GAME OVER' && head.c === 'over' && /4台 GET・失敗 3回/.test(head.s), JSON.stringify(head));
  await shot(page, '14_result');
  await page.click('#againBtn');
  await waitFor(page, () => window.__crane.phase === 'move');
  i = await info(page);
  check('もう一度：失敗0回・10台・駐車場が元に戻る', i.fails === 0 && i.left === 10 && i.results.length === 0 && i.cars.every(c => c.present && c.damage === 0));

  // ---------------- パーフェクト／クリア（確認用 ?left=1：車1台だけの駐車場で、最後の1台を取りきる）
  for (const [q, want, fails] of [['&left=1', 'PERFECT!', 0], ['&left=1&fails=1', 'CLEAR!', 1]]) {
    log(`[${want}]`);
    await page.goto(URL + q);
    await waitFor(page, () => window.__crane && window.__crane.phase === 'title');
    await page.click('#startBtn');
    await roundStart(page);
    i = await info(page);
    const only = i.cars.find(c => c.present);
    check(`${want}：確認用の駐車場は1台・失敗${fails}回から`, i.left === 1 && i.fails === fails && !!only, `left=${i.left} fails=${i.fails}`);
    i = await aimAt(page, only.id);
    [tx, tz] = overCom(i);
    await moveClaw(page, tx, tz);
    await lowerAndWait(page);
    await waitFor(page, () => window.__crane.phase === 'carry', null, 60000);
    await carryToZone(page);
    await placeAndGet(page, null);
    await sleep(300);
    i = await info(page);
    check(`${want}：最後の1台を取ると決着（カードは「結果を見る」）`, i.left === 0 && i.outcome === (fails ? 'clear' : 'perfect') && await page.evaluate(() => document.getElementById('cBtn').textContent === '結果を見る' && /すべて回収/.test(document.getElementById('cScore').textContent)), `outcome=${i.outcome}`);
    await page.click('#cBtn');
    await waitFor(page, () => window.__crane.phase === 'result');
    await sleep(400);
    const h = await page.evaluate(() => ({ h: document.getElementById('rHead').textContent, s: document.getElementById('rSub').textContent }));
    check(`${want}：結果画面の見出し`, h.h === want && new RegExp('1台 GET・失敗 ' + fails + '回').test(h.s), JSON.stringify(h));
    await shot(page, fails ? '14c_clear' : '14b_perfect');
  }

  // ---------------- 静的チェック
  const html = fs.readFileSync(FILE, 'utf8');
  check('index.html にリンクタグ（a＋href）の文字列が無い', !/<a\s+href\s*=/i.test(html));
  check('外部リクエスト 0', external.length === 0, external.join(' '));
  check('JS エラー 0', errors.length === 0, errors.join(' | '));
  check('文字レイアウト崩れ 0', layoutIssues.length === 0, layoutIssues.join(' | '));
  await browser.close();
  const ng = checks.filter(c => !c.ok);
  log(`\n${checks.length - ng.length}/${checks.length} checks passed, ${shots.length} screenshots, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (ng.length) { log('FAILED:', ng.map(c => c.name).join(', ')); process.exit(1); }
})().catch(e => { console.error(e); console.error('errors:', errors); process.exit(1); });
