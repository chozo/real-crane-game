// 告知動画の台本（現実版クレーンゲーム 駐車場編）。
// 配置は seed=4（OGP 画像と同じ駐車場。奥の列に赤いスポーツカー ¥400万）。
// 流れ：つかみ＝青いオープンカーを揺らして落とし大破（スロー）→ タイトル →
//       隣の車に爪がガチン（失敗 2/3）→ 赤いスポーツカーを慎重に運んで GET（写真カード）→ エンドカード
// 使える操作はスキルの references/scenario-api.md。ゲーム側の入口は src/game.html の window.__game。

export const config = {
  slug: 'real-crane-game',
  url: 'https://game.chozo.net/real-crane-game/',
  orientation: 'portrait',
  game: { width: 432, height: 768 }, // 9:16
  serveDir: 'dist',
  gamePath: '/real-crane-game/',
  gameQuery: 'promo=1', // ゲームはこのクエリを見ない（配置は __game.setup で決める）
  music: { file: 'tools/promo/bgm.wav', volume: 0.14 }, // 効果音より約13.5 dB 小さい（真のピークも -1.2 dBTP に収まる）
  // 字幕はゲーム画面の上の帯に出す（ゲームの中のバナー・ポップと重ねない）ため、ゲーム画面は少し小さめ・下寄せ
  layout: { centerX: 0.5, centerY: 0.6, maxW: 0.9, maxH: 0.74 },
};

const ID = { open: 3, wagon: 6, sports: 2 };

export default async function scenario(p) {
  await p.seed(4);
  await p.call('setup', { seed: 4, fixedPR: true });
  await p.call('audio.capture', true);
  await p.call('start');

  // ---------------- 0〜3秒 つかみ：青いオープンカー（¥300万）を揺らして落とす → 大破
  await p.call('aimAt', ID.open);
  p.speed(10, { badge: false });
  await p.until((s) => !s.pilot, { max: 60, record: false });
  await p.call('act');
  await p.until((s) => s.phase === 'carry', { max: 60, record: false });
  await p.call('pump');
  // 外れる少し手前まで撮らずに進める
  await p.until((s) => s.phase !== 'carry', { max: 80, record: false });
  p.speed(1, { badge: false });
  // phase=fall になった瞬間から撮る
  p.zoom(1.12, 0.2, { x: 0.5, y: 0.5 });
  p.caption('揺らしすぎると…', { y: 0.09, size: 38, dur: 1.2 });
  let boomed = false;
  p.on('boom', () => {
    boomed = true;
    p.speed(0.35);
    p.fx('ドカーン！', { y: 0.5, size: 92, dur: 1.4, color: '#ffde3b' });
    p.shake(16, 0.6);
  });
  await p.until(() => boomed, { max: 4 });
  await p.wait(0.7);
  p.caption('¥300万が\n大破！', { y: 0.09, size: 38, dur: 1.4, color: '#ff5a3c' });
  await p.wait(0.6);
  p.speed(1); p.zoom(1, 0.4);
  p.off('boom');
  await p.wait(0.3);

  // ---------------- 3〜6秒 タイトル（燃える残骸を背景に）
  await p.eval((a, w) => { w.document.getElementById('big').className = ''; w.document.getElementById('pops').innerHTML = ''; }); // タイトルの下に「大破…」が透けないように（その場だけ）
  p.title({ title: '現実版\nクレーン\nゲーム', sub: '本物の車を、釣り上げろ！', dur: 2.8 });
  await p.wait(2.4);
  p.speed(2, { badge: false });
  await p.until((s) => s.phase === 'card', { max: 10 });
  p.speed(1);
  await p.wait(0.4);
  await p.call('next');

  // ---------------- 6〜11秒 惜しい失敗：爪が隣の車にガチン（失敗 2/3）
  const off = await p.call('bumpSpot', ID.wagon);
  await p.call('aimAt', ID.wagon, off);
  p.speed(10, { badge: false });
  await p.until((s) => !s.pilot, { max: 60, record: false });
  p.speed(1);
  p.caption('狙った車の真上で\n「取る」！', { y: 0.09, size: 38, dur: 1.6 });
  await p.wait(0.9);
  await p.call('act');
  p.on('bump', () => { p.fx('ガチン！', { y: 0.5, size: 84, color: '#fff' }); p.shake(10, 0.3); });
  p.speed(1.5, { badge: false });
  await p.until((s, ev) => ev.some((e) => e.type === 'bump'), { max: 8 });
  p.speed(1);
  p.caption('隣の車に当たったら\n弁償＆失敗', { y: 0.09, size: 38, dur: 1.8, color: '#ffe14d' });
  await p.wait(2);
  p.off('bump');
  p.caption('3回失敗で\nゲームオーバー', { y: 0.09, size: 38, dur: 1.4 });
  await p.wait(1.2);

  // ---------------- 11〜25秒 本命：赤いスポーツカー（¥400万）を慎重に運んで GET
  await p.until((s) => s.phase === 'move' && !s.pilot, { max: 20, record: false });
  await p.call('aimAt', ID.sports);
  p.speed(10, { badge: false });
  await p.until((s) => !s.pilot, { max: 60, record: false });
  p.speed(1);
  p.caption('本命は¥400万の\nスポーツカー', { y: 0.09, size: 38, dur: 1.6, color: '#ffe14d' });
  await p.wait(0.8);
  await p.call('act');
  p.speed(2);
  await p.until((s) => s.phase === 'closing', { max: 10 });
  p.speed(1);
  p.fx('ガシッ！', { y: 0.52, size: 72 });
  await p.wait(0.5);
  p.speed(2.5);
  await p.until((s) => s.phase === 'carry', { max: 10 });
  await p.call('carryToZone');
  p.caption('揺らさないように\nそーっと…', { y: 0.09, size: 38, dur: 2 });
  p.speed(8);
  await p.until((s) => !s.pilot, { max: 15 });
  p.speed(1);
  await p.call('act'); // 置く
  p.speed(3);
  await p.until((s) => s.phase === 'get', { max: 10 });
  p.speed(1);
  p.flash({ dur: 0.3, strength: 0.7 });
  p.fx('GET!', { y: 0.48, size: 110, dur: 1.4, color: '#ffde3b' });
  await p.wait(1.6);
  p.speed(1.5, { badge: false });
  await p.until((s) => s.phase === 'card', { max: 6 });
  p.speed(1);
  await p.wait(3); // 写真が現像される
  p.caption('全部取ればクリア！', { y: 0.09, size: 38, dur: 1.6 });
  await p.wait(1.6);

  // ---------------- エンドカード
  p.endCard({ title: '現実版\nクレーン\nゲーム', sub: '駐車場編', cta: '今すぐ遊べる！', dur: 3.4 });
  await p.wait(3.4);
}
