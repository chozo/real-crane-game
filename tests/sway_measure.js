// 揺れの収束時間の計測：押しっぱなしで dist 運んで離す（雑な運転）→ クレーンが止まった瞬間から、揺れ振幅が 2° 以下に収まるまでの秒数
// 実行: node tests/sway_measure.js [減衰の倍率=1] [車種id]   （倍率を変えると「今の減衰×倍率」で試算できる）
const L = require(process.env.LOGIC||'../src/logic.js'); const DEG = Math.PI / 180;
const K = +process.argv[2] || 1, ONLY = process.argv[3];
function run(p, z0, dist) {
  const cable = L.carryCable(p), cr = L.makeCrane(0, z0), s = L.makeSwing(); let mx = 0, t = 0;
  for (; t < 60; t += 1 / 60) {
    L.stepCrane(cr, { x: 0, z: cr.z < z0 + dist ? 1 : 0 }, 1 / 60, true); L.stepSwing(s, cr.ax, cr.az, cable, p, 1 / 60); mx = Math.max(mx, L.swingMag(s));
    if (cr.z >= z0 + dist - 1e-9 || cr.z >= 7.5 - 1e-9) { if (Math.abs(cr.vz) < 1e-9) break; }
  }
  const a0 = L.swingAmp(s, p, cable); let ts = 0;
  while (L.swingAmp(s, p, cable) > 2 * DEG && ts < 600) { L.stepSwing(s, 0, 0, cable, p, 1 / 60); ts += 1 / 60; }
  return { mx: mx / DEG, a0: a0 / DEG, ts };
}
const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };
const rows = [];
for (const p of L.CAR_TYPES) {
  if (ONLY && p.id !== ONLY) continue;
  const d0 = p.damp; p.damp = +(d0 * K).toFixed(3);
  const rs = []; for (let d = 3; d <= 16; d += 0.25) rs.push(run(p, -10, d));
  const wall = [8, 10, 12].map(d => run(p, 0, d)); // 既存テストと同じ：ゾーン側の端（フェンス）に当てて止まる
  const ts = rs.map(r => r.ts), a0 = rs.map(r => r.a0), mx = rs.map(r => r.mx);
  rows.push({ id: p.id, c: p.damp, half: 2 * Math.LN2 / p.damp, mxMed: pct(mx, .5), mxMax: Math.max(...mx), a0Max: Math.max(...a0), tsMed: pct(ts, .5), tsP90: pct(ts, .9), tsMax: Math.max(...ts), wallA0: wall[0].a0, wallTs: wall[0].ts, wallMx: wall[0].mx });
  p.damp = d0;
}
console.log('K=' + K);
for (const r of rows) console.log(`${r.id.padEnd(8)} c=${r.c.toFixed(3)} 半減${r.half.toFixed(1)}s | 運搬中の最大揺れ 中央${r.mxMed.toFixed(1)}° 最大${r.mxMax.toFixed(1)}° | 停止時振幅 最大${r.a0Max.toFixed(1)}° | 2°まで 中央${r.tsMed.toFixed(1)}s 90%${r.tsP90.toFixed(1)}s 最大${r.tsMax.toFixed(1)}s | 端で急停止: 停止時${r.wallA0.toFixed(1)}° →2° ${r.wallTs.toFixed(1)}s`);
