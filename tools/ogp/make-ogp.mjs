// OGP 画像（public/ogp.png、1200×630）と apple-touch-icon（public/apple-touch-icon.png、180×180）を作る。
// 1) 実際のゲーム（__crane.setup({ seed: N })）で一番高い車を吊り上げ、運搬の高さで止めて、UI を隠して 3D 画面だけ撮る
// 2) その写真を背景に、ポップなタイトル・一言・URL を重ねた 1200×630 の HTML を描いて撮る
// 使い方：npm run build && npm run ogp   （撮影カメラは CAM で調整。seed は SEED）
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEED = Number(process.env.SEED || 4); // seed=4 は奥の列に赤いスポーツカーがある
const OUT_DIR = path.join(ROOT, 'tools/ogp/out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

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

// ---------- 1) ゲーム画面を撮る
async function captureScene(browser) {
  // 9:16 固定の画面を高解像度で描き、あとで横長に切り抜く
  const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 3 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => window.__crane && window.__crane.phase === 'title', null, { timeout: 120000 });
  await page.evaluate(seed => window.__crane.setup({ seed, fixedPR: true }), SEED);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__crane.phase === 'move', null, { timeout: 60000 });
  await sleep(2000);
  const info = await page.evaluate(() => window.__crane.info());
  // 赤い車（スポーツ 0xe02818 → セダン 0xc8262c の順）を狙う。無ければ一番高い車
  const lot0 = await page.evaluate(() => { const L = window.CraneLogic; return L.makeLot(window.__crane.info().seed).cars.map(c => ({ id: c.id, color: c.color })); });
  const RED = [0xe02818, 0xc8262c], present = info.cars.filter(c => c.present);
  const red = RED.map(col => present.find(c => lot0[c.id].color === col)).find(Boolean);
  const best = red || present.sort((a, b) => b.value - a.value)[0];
  const tgt = await page.evaluate(id => { const L = window.CraneLogic, lot = L.makeLot(window.__crane.info().seed); return [lot.cars[id].x, L.comWorld(lot.cars[id])[1]]; }, best.id);
  for (let k = 0; k < 3; k++) {
    await driveTo(page, tgt[0], tgt[1], 0.02);
    await page.waitForFunction(() => window.__crane.info().swingAmpDeg < 0.12, null, { timeout: 30000, polling: 30 });
  }
  const b = await page.locator('#act').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // 下ろす → 自動で掴んで運搬の高さへ
  await page.waitForFunction(() => window.__crane.phase === 'carry', null, { timeout: 120000, polling: 30 });
  await sleep(1500);
  await page.evaluate(() => window.__crane.pause(true));
  const st = await page.evaluate(() => { const i = window.__crane.info(); return { claw: i.claw, target: i.target, bottomY: i.load.bottomY }; });
  // 吊った車を斜め前・やや下から見上げる（ケーブルとトロリーも入る）
  const c = st.target.com, cy = st.bottomY + 0.8;
  const CAM = process.env.CAM ? JSON.parse(process.env.CAM) : [c[0] - 11, cy + 3.5, c[1] + 15, c[0] + 0.5, cy + 0.6, c[1]];
  await page.addStyleTag({ content: '#ui{display:none!important}' });
  await page.evaluate(v => { window.__crane.hiRes(true); window.__crane.cam(v); window.__crane.tags(false); }, CAM);
  await sleep(400);
  const file = path.join(OUT_DIR, 'scene.png');
  await page.locator('#stage').screenshot({ path: file });
  console.log(`scene: seed=${SEED} car=${best.type}#${best.id} cam=${JSON.stringify(CAM.map(v => +v.toFixed(2)))} errors=${errors.length}`);
  await page.close();
  return file;
}

// ---------- 2) 重ねて 1200×630 に
const TITLE = '現実版クレーンゲーム';
function ogpHtml(sceneUrl, iconSvg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1200px;height:630px;overflow:hidden;font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans CJK JP",sans-serif;background:#000}
  .bg{position:absolute;left:520px;right:0;top:0;bottom:0;background:url(${sceneUrl}) center 36%/cover no-repeat}
  /* 左側：黄色の水玉の板（斜めに切る） */
  .panel{position:absolute;left:-40px;top:-20px;bottom:-20px;width:670px;background:#ffcc1a;
    background-image:radial-gradient(rgba(255,255,255,.55) 7px,transparent 8px);background-size:34px 34px;
    transform:skewX(-9deg);transform-origin:top left;border-right:14px solid #1d1a14;box-shadow:16px 0 0 #e8452c}
  .txt{position:absolute;left:52px;top:40px;width:620px}
  .badge{display:inline-flex;align-items:center;gap:12px;background:#1d1a14;color:#ffcc1a;font-weight:900;font-size:30px;letter-spacing:.18em;padding:8px 22px 8px 12px;border-radius:999px;transform:rotate(-3deg)}
  .badge img{width:46px;height:46px}
  h1{margin-top:22px;font-weight:900;line-height:1.02;color:#fff;letter-spacing:.01em;
    -webkit-text-stroke:14px #1d1a14;paint-order:stroke fill;text-shadow:0 9px 0 #1d1a14}
  h1 .a{display:block;font-size:80px;white-space:nowrap;margin-top:6px}
  h1 .b{display:block;font-size:120px;white-space:nowrap}
  .ribbon{display:inline-block;position:relative;z-index:2;margin-top:-14px;margin-left:300px;background:#e8452c;color:#fff;font-weight:900;font-size:50px;padding:4px 28px 8px;
    border:6px solid #1d1a14;border-radius:16px;transform:rotate(-4deg);box-shadow:6px 7px 0 #1d1a14}
  .catch{position:absolute;left:52px;bottom:94px;font-weight:900;font-size:27px;white-space:nowrap;color:#1d1a14;line-height:1.35}
  .catch em{font-style:normal;color:#e8452c}
  .url{position:absolute;left:52px;bottom:30px;background:#fff;color:#1d1a14;font-weight:800;font-size:26px;padding:6px 20px;border:4px solid #1d1a14;border-radius:999px}
  /* 右上：吹き出し */
  .pop{position:absolute;right:46px;top:40px;background:#fff;color:#1d1a14;font-weight:900;font-size:40px;padding:12px 26px;border:6px solid #1d1a14;border-radius:28px;transform:rotate(5deg);box-shadow:7px 8px 0 #1d1a14}
  .pop:after{content:"";position:absolute;left:46px;bottom:-30px;border:16px solid transparent;border-top:20px solid #1d1a14}
  .pop b{color:#e8452c}
  </style></head><body>
  <div class="bg"></div>
  <div class="panel"></div>
  <div class="txt">
    <div class="badge"><img src="${iconSvg}">REAL SIZE</div>
    <h1><span class="b">現実版</span><span class="a">クレーンゲーム</span></h1>
    <div class="ribbon">駐車場編</div>
  </div>
  <div class="catch">本物の車を、釣り上げろ！<br><em>高い車を狙え。</em>ぶつけたら弁償。</div>
  <div class="url">game.chozo.net/real-crane-game</div>
  <div class="pop">GET<b>!?</b></div>
  </body></html>`;
}

const browser = await chromium.launch({ channel: 'chrome', args: GL });
try {
  const scene = process.env.REUSE_SCENE ? path.join(OUT_DIR, 'scene.png') : await captureScene(browser);
  const iconPath = path.join(ROOT, 'public/favicon.svg');
  const toData = (f, mime) => `data:${mime};base64,` + fs.readFileSync(f).toString('base64');
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(ogpHtml(toData(scene, 'image/png'), toData(iconPath, 'image/svg+xml')));
  await page.evaluate(() => document.fonts.ready);
  await sleep(200);
  await page.screenshot({ path: path.join(ROOT, 'public/ogp.png') });
  console.log('wrote public/ogp.png (1200x630)');
  // apple-touch-icon（180×180、角丸なし＝iOS が丸める）
  const ic = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  const svg = fs.readFileSync(iconPath, 'utf8').replace('rx="14"', 'rx="0"');
  await ic.setContent(`<body style="margin:0"><img style="display:block;width:180px;height:180px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
  await ic.screenshot({ path: path.join(ROOT, 'public/apple-touch-icon.png') });
  console.log('wrote public/apple-touch-icon.png (180x180)');
} finally {
  await browser.close();
}
