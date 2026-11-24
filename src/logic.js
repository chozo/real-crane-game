/* 現実版クレーンゲーム v2（駐車場版）— 純ロジック（描画非依存）
 * ブラウザでは window.CraneLogic、Node では module.exports として使う。
 * 単位：長さ m、時間 s、角度 rad、質量 kg、価値 万円。
 * 座標：x＝レール方向（画面の左右）、z＝トロリー方向（画面の前後、+z が手前）、y＝上。
 * 車の向き yaw は three.js の rotation.y と同じ（ローカル +x＝長手方向）。駐車場の車は yaw=π/2（長手が z 方向）。
 * v1 から継続：クレーン移動、振り子、重心ずれ→傾き→滑落、着地の衝撃、スコア。
 * v2 で追加：駐車場の生成、囲まれ度と価値、爪の下降時の接触、吊った車と隣の車の接触（こすった／ぶつけた）。
 */
(function (root) {
  'use strict';

  var G = 9.8;
  var DEG = Math.PI / 180;

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sign(x) { return x < 0 ? -1 : 1; }
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // ---------------------------------------------------------------- 車種
  // L＝長さ, W＝幅, H＝高さ（屋根）, lowTop＝ボンネット・ドア上端の高さ, cabL/cabX＝キャビン（屋根）の長さと中心（L 比、+ が前）
  // base＝基本価格（万円）, com＝重心のずれ（長手, 幅）, comH＝重心の高さ（H 比）, grip＝爪が傾きに抵抗する割合
  // tiltLimit/swingLimit＝滑り始める傾き／落ちる揺れ, damp＝揺れの減衰
  // scratchK＝傷の付きやすさ（高級車ほど減額が大きい）
  var CAR_TYPES = [
    { id: 'kei', name: '軽自動車', base: 90, mass: 850, L: 3.4, W: 1.48, H: 1.64, lowTop: 0.84, cabL: 0.70, cabX: -0.10,
      com: [0.22, 0], comH: 0.42, grip: 0.62, tiltLimit: 22 * DEG, swingLimit: 25 * DEG, damp: 0.21, scratchK: 1.0,
      colors: [0x86d8c8, 0xf4e27a, 0xf7f3ea, 0xf3a6b8] },
    { id: 'compact', name: 'コンパクト', base: 130, mass: 1100, L: 3.95, W: 1.70, H: 1.52, lowTop: 0.82, cabL: 0.58, cabX: -0.09,
      com: [0.30, 0], comH: 0.42, grip: 0.62, tiltLimit: 21 * DEG, swingLimit: 24 * DEG, damp: 0.195, scratchK: 1.0,
      colors: [0x3f7fd0, 0xe9893a, 0xc9ced4, 0x5aa65a] },
    { id: 'sedan', name: 'セダン', base: 200, mass: 1450, L: 4.70, W: 1.80, H: 1.45, lowTop: 0.82, cabL: 0.46, cabX: -0.05,
      com: [0.38, 0], comH: 0.40, grip: 0.62, tiltLimit: 20 * DEG, swingLimit: 23 * DEG, damp: 0.165, scratchK: 1.1,
      colors: [0xc8262c, 0x2b2f38, 0xe8e8ea, 0x6a7280] },
    { id: 'wagon', name: 'ワゴン', base: 240, mass: 1550, L: 4.75, W: 1.80, H: 1.56, lowTop: 0.84, cabL: 0.64, cabX: -0.15,
      com: [0.30, 0], comH: 0.42, grip: 0.62, tiltLimit: 19 * DEG, swingLimit: 22 * DEG, damp: 0.15, scratchK: 1.1,
      colors: [0x2f5a3c, 0x8a6a4a, 0xdcdcd6, 0x1f3f6e] },
    { id: 'open', name: 'オープンカー', base: 300, mass: 1150, L: 3.95, W: 1.74, H: 1.22, lowTop: 0.86, cabL: 0, cabX: 0,
      com: [0.18, 0], comH: 0.40, grip: 0.62, tiltLimit: 20 * DEG, swingLimit: 22 * DEG, damp: 0.165, scratchK: 1.3,
      colors: [0xd8b02a, 0x22a0c8, 0xb02a4a] },
    { id: 'sports', name: 'スポーツカー', base: 400, mass: 1400, L: 4.45, W: 1.90, H: 1.18, lowTop: 0.72, cabL: 0.36, cabX: -0.04,
      com: [-0.30, 0], comH: 0.38, grip: 0.62, tiltLimit: 18 * DEG, swingLimit: 21 * DEG, damp: 0.18, scratchK: 1.5,
      colors: [0xe02818, 0xf2c200, 0x111316] }
  ];
  function typeById(id) { for (var i = 0; i < CAR_TYPES.length; i++) if (CAR_TYPES[i].id === id) return CAR_TYPES[i]; return null; }
  /** 屋根（掴む面）の高さ。l は車の前（ノーズ）向きを + とした長手位置 */
  function topAt(p, l) {
    if (p.cabL > 0 && Math.abs(l - p.cabX * p.L) <= p.cabL * p.L / 2 + 0.1) return p.H;
    return p.lowTop;
  }

  // ---------------------------------------------------------------- 駐車場・ジオラマ・クレーン
  // 2列×6区画（背中合わせ）。row 0 が奥（フェンス側）、row 1 が手前（通路側）
  var LOT = { cols: 6, rows: 2, SW: 2.5, SD: 5.2, rowZ: [-9.8, -4.6], empty: 2, jitterX: 0.08, jitterZ: 0.18 };
  LOT.x0 = -LOT.cols / 2 * LOT.SW; LOT.x1 = -LOT.x0;
  LOT.z0 = LOT.rowZ[0] - LOT.SD / 2; LOT.z1 = LOT.rowZ[1] + LOT.SD / 2;
  var YARD = { xMin: -9, xMax: 9, zMin: -12.5, zMax: 7.5 };
  var ZONE = { x0: -4, x1: 4, z0: 1.8, z1: 7.6 };           // 回収ゾーン（手前中央、通路の先）
  var ROUNDS = 5;
  var CRANE = {
    topY: 14, cableMin: 3, clear: 2.6,
    accelEmpty: 5, vmaxEmpty: 4,
    accelLoaded: 1.15, vmaxLoaded: 2.6, jerkLoaded: 2.5,     // v2.1：加減速を強めて揺れが育ちやすく（v2 は 0.8 / 1.5）
    brake: 1.0,
    lowerSpeed: 4,
    slotSpeed: 0.42,          // 区画から引き抜く間の巻き上げ速度（ゆっくり）
    liftRamp: 0.6,           // この長さ巻き上げると車の重さが全部爪に乗る
    clawH: function (p) { return 1.1 * (p ? clawScale(p) : 1); }
  };
  function clawScale(p) { return clamp((0.55 * Math.min(p.L, p.W) + 0.12 * Math.max(p.L, p.W)) / 1.25, 1, 3.2); }
  function carryCable(p) { return Math.max(CRANE.cableMin, CRANE.topY - CRANE.clawH(p) - p.H - CRANE.clear); }
  /** 爪：横（車の幅方向＝x）に2本ずつ、計4本。開くと車の側面から openMargin 外側まで広がる */
  var CLAW = { openMargin: 0.45, tipR: 0.07, closeMargin: 0.04, scrapeDepth: 0.12 };
  function clawReach(p) { return p.W / 2 + CLAW.openMargin; }  // 爪の中心〜開いた指先の中心（指先の太さ tipR はこの外側）
  function fingerZ(p) { return 0.42 * clawScale(p); }                       // 指の前後位置（±）
  function fingerDepth(p) { return clamp(p.lowTop * 0.75 + 0.15, 0.6, 0.9); } // 開いた指先がハブ下面より下に出る長さ
  var TRIES = 2;

  // ---------------------------------------------------------------- 駐車場の生成
  function stallPos(row, col) { return { x: LOT.x0 + (col + 0.5) * LOT.SW, z: LOT.rowZ[row] }; }
  function makeLot(seed) {
    var r = rng((seed || 1) * 7919 + 13);
    var n = LOT.rows * LOT.cols, idx = [], i;
    for (i = 0; i < n; i++) idx.push(i);
    for (i = n - 1; i > 0; i--) { var k = Math.floor(r() * (i + 1)), t = idx[i]; idx[i] = idx[k]; idx[k] = t; }
    var empty = idx.slice(0, LOT.empty);
    // 車種のデッキ（毎回いろいろな車が並ぶ）
    var deck = ['kei', 'kei', 'compact', 'compact', 'sedan', 'sedan', 'wagon', 'wagon', 'open', 'sports'];
    for (i = deck.length - 1; i > 0; i--) { var k2 = Math.floor(r() * (i + 1)), t2 = deck[i]; deck[i] = deck[k2]; deck[k2] = t2; }
    var cars = [], d = 0;
    for (var row = 0; row < LOT.rows; row++) for (var col = 0; col < LOT.cols; col++) {
      var s = row * LOT.cols + col;
      var jx = (r() - 0.5) * 2 * LOT.jitterX, jz = (r() - 0.5) * 2 * LOT.jitterZ, fl = r() < 0.5 ? -1 : 1, cr = r();
      if (empty.indexOf(s) >= 0) continue;
      var p = typeById(deck[d++ % deck.length]), sp = stallPos(row, col);
      cars.push({ id: cars.length, type: p, row: row, col: col, x: sp.x + jx, z: sp.z + jz, yaw: Math.PI / 2, flip: fl,
        com: [p.com[0] * fl, p.com[1]], color: p.colors[Math.floor(cr * p.colors.length)], damage: 0, present: true });
    }
    return { seed: seed, cars: cars, empty: empty };
  }
  function carAt(lot, row, col) {
    for (var i = 0; i < lot.cars.length; i++) { var c = lot.cars[i]; if (c.present && c.row === row && c.col === col) return c; }
    return null;
  }
  function neighbors(lot, car) {
    return { left: carAt(lot, car.row, car.col - 1), right: carAt(lot, car.row, car.col + 1), across: carAt(lot, 1 - car.row, car.col) };
  }
  /** 囲まれ度：左右の車（各 +0.3）、背中合わせの車（+0.2）、奥の列（+0.15） */
  function surround(lot, car) {
    var nb = neighbors(lot, car);
    var side = (nb.left ? 1 : 0) + (nb.right ? 1 : 0), across = nb.across ? 1 : 0, back = car.row === 0 ? 1 : 0;
    var mult = 1 + 0.3 * side + 0.2 * across + 0.15 * back;
    return { side: side, across: across, back: back, stars: side + across + back, mult: Math.round(mult * 100) / 100 };
  }
  function carValue(lot, car) { return Math.round(car.type.base * surround(lot, car).mult * (1 - clamp(car.damage, 0, 0.9))); }
  /** 左右の隙間（m）。隣が空なら null（＝広い） */
  function gaps(lot, car) {
    var nb = neighbors(lot, car), W = car.type.W;
    return {
      left: nb.left ? (car.x - W / 2) - (nb.left.x + nb.left.type.W / 2) : null,
      right: nb.right ? (nb.right.x - nb.right.type.W / 2) - (car.x + W / 2) : null
    };
  }
  /** 隙間の余裕：真上から左右にどこまでずれても爪が隣に当たらないか（m）。null＝広い */
  function clawSlack(lot, car) {
    var g = gaps(lot, car), m = CLAW.openMargin + CLAW.tipR;
    var f = function (v) { return v == null ? null : v - m; };
    return { left: f(g.left), right: f(g.right) };
  }
  function presentCars(lot) { return lot.cars.filter(function (c) { return c.present; }); }
  /** v2.1：いま爪の真下にある車＝狙いの車（選択フェーズなし）。
   *  区画で割り当てる：前後は車の長さ＋少し、左右は区画の幅の半分＋少しまで（隣との隙間の上なら近い方の車）。
   *  空き区画・通路・ゾーンの上なら null */
  function carUnder(lot, x, z) {
    var best = null, bd = 1e9;
    for (var i = 0; i < lot.cars.length; i++) {
      var c = lot.cars[i]; if (!c.present) continue;
      var dx = Math.abs(x - c.x), dz = Math.abs(z - c.z);
      if (dz > c.type.L / 2 + 0.25 || dx > LOT.SW / 2 + 0.3) continue;  // 駐車のずれで隙間の真ん中が区画線を越えても途切れない
      if (dx < bd) { bd = dx; best = c; }
    }
    return best;
  }

  // ---------------------------------------------------------------- 座標
  function toLocal(dx, dz, yaw) { var c = Math.cos(yaw), s = Math.sin(yaw); return [dx * c - dz * s, dx * s + dz * c]; }
  function toWorld(l, w, yaw) { var c = Math.cos(yaw), s = Math.sin(yaw); return [l * c + w * s, -l * s + w * c]; }
  function comWorld(car) { var d = toWorld(car.com[0], car.com[1], car.yaw); return [car.x + d[0], car.z + d[1]]; }
  /** 点 (x,z) が車の足跡（＋余白 m）の中か。中なら車ローカル座標を返す */
  function inFootprint(car, x, z, m) {
    var loc = toLocal(x - car.x, z - car.z, car.yaw), p = car.type;
    m = m || 0;
    return Math.abs(loc[0]) <= p.L / 2 + m && Math.abs(loc[1]) <= p.W / 2 + m ? loc : null;
  }
  function topAtWorld(car, x, z) { var loc = toLocal(x - car.x, z - car.z, car.yaw); return topAt(car.type, loc[0] * car.flip); }

  // ---------------------------------------------------------------- 爪の下降と接触
  /** 爪のハブ下面が高さ hubY にあるときの状況（毎フレーム呼ぶ）。
   *  stop：'target'（ねらった車の屋根に届いた）/'ownRoof'（ずれすぎて指が自分の車の屋根に乗った）/
   *        'neighbor'（指かハブが隣の車に乗り上げた＝ぶつけた）/'ground'/null（まだ下降中）
   *  hits：指先が隣の車に触れている（depth＝食い込み m, kind＝scrape/bump） */
  function clawProbe(lot, target, cx, cz, hubY) {
    var p = target.type, reach = clawReach(p), fz = fingerZ(p), tipY = hubY - fingerDepth(p);
    var cars = presentCars(lot), res = { stop: null, stopY: null, hits: [], tipY: tipY, hubCar: null };
    var setStop = function (kind, y, car) { if (res.stopY == null || y > res.stopY) { res.stop = kind; res.stopY = y; res.hubCar = car || null; } };
    // ハブの真下
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (!inFootprint(c, cx, cz, 0)) continue;
      var top = topAtWorld(c, cx, cz);
      if (hubY <= top) setStop(c === target ? 'target' : 'neighbor', top, c);
    }
    // 指先（左右2本ずつ）
    for (var sx = -1; sx <= 1; sx += 2) for (var sz = -1; sz <= 1; sz += 2) {
      var tx = cx + sx * reach, tz = cz + sz * fz;
      for (var k = 0; k < cars.length; k++) {
        var n = cars[k], loc = inFootprint(n, tx, tz, CLAW.tipR);
        if (!loc) continue;
        var ntop = topAtWorld(n, tx, tz);
        if (tipY > ntop) continue;
        var depth = Math.min(n.type.L / 2 + CLAW.tipR - Math.abs(loc[0]), n.type.W / 2 + CLAW.tipR - Math.abs(loc[1]));
        if (n === target) { setStop('ownRoof', ntop + fingerDepth(p), n); continue; }
        var kind = depth > CLAW.scrapeDepth ? 'bump' : 'scrape';
        res.hits.push({ car: n, depth: depth, kind: kind, x: tx, y: Math.max(tipY, 0.3), z: tz, side: sx });
        if (kind === 'bump') setStop('neighbor', ntop + fingerDepth(p), n);
      }
    }
    if (res.stop == null && tipY <= 0.05) setStop('ground', 0.05 + fingerDepth(p));
    // 自分の屋根と隣の車の両方に指が乗ったら、隣の車にぶつけた方を優先して知らせる
    if (res.stop === 'ownRoof') res.hits.forEach(function (h) { if (h.kind === 'bump') { res.stop = 'neighbor'; res.hubCar = h.car; } });
    return res;
  }
  /** 上から下ろしきるまでの下降をまとめて計算（テスト・確認用。描画側は毎フレーム clawProbe を呼ぶ） */
  function simulateDescent(lot, target, cx, cz, step) {
    step = step || 0.02;
    var hits = {}, order = [];
    for (var y = 6; y > -1; y -= step) {
      var r = clawProbe(lot, target, cx, cz, y);
      r.hits.forEach(function (h) {
        var o = hits[h.car.id];
        if (!o) { hits[h.car.id] = o = { car: h.car, depth: 0, kind: 'scrape' }; order.push(o); }
        o.depth = Math.max(o.depth, h.depth); if (h.kind === 'bump') o.kind = 'bump';
      });
      if (r.stop) return { stop: r.stop, hubY: r.stopY, hits: order, hubCar: r.hubCar };
    }
    return { stop: 'ground', hubY: 0, hits: order };
  }
  /** 爪を閉じたときの掴み：爪は車の幅方向の中心へ寄る（吊り元からのずれ＝振り子の初期振れ）。長手方向のずれは重心ずれになる */
  function gripInfo(car, cx, cz) {
    var p = car.type, loc = toLocal(cx - car.x, cz - car.z, car.yaw);
    var onTarget = Math.abs(loc[0]) <= p.L / 2 - 0.2 && Math.abs(loc[1]) <= CLAW.openMargin - CLAW.tipR;
    var e = [loc[0] - car.com[0], 0];
    var cw = toWorld(loc[0], 0, car.yaw); // 寄せた後の爪の位置
    return { local: loc, onTarget: onTarget, e: e, dist: Math.abs(e[0]), lateral: loc[1], clawX: car.x + cw[0], clawZ: car.z + cw[1] };
  }

  // ---------------------------------------------------------------- 傾き（v1 から継続）
  function tiltTarget(p, e) { var hc = p.H * (1 - p.comH); return Math.atan(e / hc) * p.grip; }
  function slipOffset(p) { var hc = p.H * (1 - p.comH); return Math.tan(p.tiltLimit / p.grip) * hc; }
  function liftSpeed(p) { return p ? 1.6 / (1 + p.mass / 1500) + 0.35 : 3.2; }
  function swingLeff(p, cable) {
    cable = Math.max(cable, 1);
    if (!p) return cable * 0.3;
    return cable;   // v2：吊った車は実際のケーブル長の振り子（v1 の「周期合わせ」は吊り荷が逆向きに動いて見えたため廃止）
  }
  function swingOmega(p, cable) { return Math.sqrt(G / swingLeff(p, cable)); }

  // ---------------------------------------------------------------- クレーン移動（v1 から継続）
  function makeCrane(x, z) { return { x: x, z: z, vx: 0, vz: 0, ax: 0, az: 0 }; }
  /** 1軸ぶんの速度変化（ボタン inp＝-1/0/+1）。a＝前のステップの加速度（加加速度の制限に使う） */
  function craneAxis(v, a, inp, dt, loaded) {
    var acc = loaded ? CRANE.accelLoaded : CRANE.accelEmpty;
    var vmax = loaded ? CRANE.vmaxLoaded : CRANE.vmaxEmpty;
    var jerk = loaded ? CRANE.jerkLoaded : 1e9;
    var target = inp * vmax;
    var lim = (inp === 0 || sign(target) !== sign(v)) && Math.abs(v) > 1e-6 ? acc * CRANE.brake : acc;
    var ades = inp === 0 ? (Math.abs(v) > 1e-9 ? -sign(v) * lim : 0) : clamp((target - v) * (loaded ? 3 : 12), -lim, lim);
    var na = a + clamp(ades - a, -jerk * dt, jerk * dt);
    var dv = na * dt;
    if ((target - v) * (target - v - dv) < 0) { dv = target - v; }
    if (inp === 0 && (v + dv) * v <= 0) dv = -v;
    return dv;
  }
  function stepCrane(c, input, dt, loaded) {
    var dvx = craneAxis(c.vx, c.cax || 0, input.x || 0, dt, loaded), dvz = craneAxis(c.vz, c.caz || 0, input.z || 0, dt, loaded);
    c.cax = dvx / dt; c.caz = dvz / dt;
    var nvx = c.vx + dvx, nvz = c.vz + dvz;
    var nx = c.x + (c.vx + nvx) / 2 * dt, nz = c.z + (c.vz + nvz) / 2 * dt;
    if (nx < YARD.xMin) { nx = YARD.xMin; nvx = 0; } if (nx > YARD.xMax) { nx = YARD.xMax; nvx = 0; }
    if (nz < YARD.zMin) { nz = YARD.zMin; nvz = 0; } if (nz > YARD.zMax) { nz = YARD.zMax; nvz = 0; }
    c.ax = (nvx - c.vx) / dt; c.az = (nvz - c.vz) / dt;
    c.vx = nvx; c.vz = nvz; c.x = nx; c.z = nz;
    return c;
  }

  // ---------------------------------------------------------------- 振り子（v1 から継続）
  // v2.1：減衰を大きく下げた（吊った車 c≈0.05〜0.07/s → 振幅が半分になるまで約20〜28秒）。
  // v2.5：少し戻した（c≈0.15〜0.21/s → 半減に約7〜9秒。v2.1 の3倍、v2 の約1/3）。運搬中に育つ揺れはほぼそのまま、
  // 止めて待てば 20〜30 秒ほどで収まる。急ぐなら従来どおり、吊り荷が動く向きへクレーンを寄せて（逆位相で）揺れを殺す。
  var EMPTY_SWING = { damp: 0.8, accK: 0.2 };
  function makeSwing() { return { tx: 0, tz: 0, wx: 0, wz: 0 }; }
  function swingDamp(p) { return p ? p.damp : EMPTY_SWING.damp; }
  function stepSwing(s, ax, az, cable, p, dt) {
    var Leff = swingLeff(p, cable);
    var c = swingDamp(p);
    if (!p) { ax *= EMPTY_SWING.accK; az *= EMPTY_SWING.accK; }
    var n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (var i = 0; i < n; i++) {
      var axx = -G / Leff * Math.sin(s.tx) - ax / Leff * Math.cos(s.tx) - c * s.wx;
      var azz = -G / Leff * Math.sin(s.tz) - az / Leff * Math.cos(s.tz) - c * s.wz;
      s.wx += axx * h; s.wz += azz * h;
      s.tx += s.wx * h; s.tz += s.wz * h;
    }
    return s;
  }
  function swingMag(s) { return Math.hypot(s.tx, s.tz); }
  /** 爪の先端（ケーブル下端）の位置 */
  function clawEnd(cr, cable, s) {
    var sx = Math.sin(s.tx), sz = Math.sin(s.tz);
    return { x: cr.x + cable * sx, y: CRANE.topY - cable * Math.sqrt(Math.max(0, 1 - sx * sx - sz * sz)), z: cr.z + cable * sz };
  }

  // ---------------------------------------------------------------- 掴んだ車（傾き・滑落・状態）
  function makeLoad(car, cx, cz) {
    var g = gripInfo(car, cx, cz);
    return {
      e: g.e.slice(), phi: [0, 0], dphi: [0, 0],
      slipping: false, slipV: 0, slipped: 0, detached: false,
      damage: 0, condition: 1, maxTilt: 0, maxSwing: 0
    };
  }
  function stepLoad(ld, p, dt, liftFrac, swing) {
    if (ld.detached) return ld;
    var n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (var it = 0; it < n; it++) {
      for (var k = 0; k < 2; k++) {
        var target = tiltTarget(p, ld.e[k]) * liftFrac;
        var acc = -18 * (ld.phi[k] - target) - 5.5 * ld.dphi[k];
        ld.dphi[k] += acc * h; ld.phi[k] += ld.dphi[k] * h;
      }
      var tilt = Math.hypot(ld.phi[0], ld.phi[1]);
      if (!ld.slipping && liftFrac > 0.5 && tilt > p.tiltLimit) ld.slipping = true;
      if (ld.slipping) {
        ld.slipV += G * Math.sin(tilt) * 0.55 * h;
        var ds = ld.slipV * h, d = Math.hypot(ld.e[0], ld.e[1]) || 1;
        ld.e[0] += ld.e[0] / d * ds; ld.e[1] += ld.e[1] / d * ds;
        ld.slipped += ds;
        if (ld.slipped > 0.35 + 0.08 * Math.max(p.L, p.W) || tilt > p.tiltLimit + 22 * DEG) { ld.detached = true; ld.cause = 'tilt'; break; }
      }
    }
    var tiltNow = Math.hypot(ld.phi[0], ld.phi[1]);
    var sw = swing ? swingMag(swing) : 0;
    ld.maxTilt = Math.max(ld.maxTilt, tiltNow); ld.maxSwing = Math.max(ld.maxSwing, sw);
    if (!ld.detached && liftFrac > 0.5 && sw > p.swingLimit) { ld.detached = true; ld.cause = 'swing'; }
    return ld;
  }
  function recalcCondition(ld) { ld.condition = clamp(1 - ld.damage, 0, 1); }
  function landingDamage(p, sw, tilt) {
    var d = Math.max(0, sw - 5 * DEG) / DEG * 0.02 + Math.max(0, tilt - 7 * DEG) / DEG * 0.015;
    return clamp(d, 0, 0.6);
  }
  function applyLanding(ld, p, sw, tilt) { var d = landingDamage(p, sw, tilt); ld.damage += d; recalcCondition(ld); return d; }

  // ---------------------------------------------------------------- 吊った車の姿勢と隣の車との接触
  // three.js の Euler 'XYZ'（R = Rx·Ry·Rz）と同じ計算で、描画と同じ姿勢を求める
  function rotX(a, v) { var c = Math.cos(a), s = Math.sin(a); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; }
  function rotY(a, v) { var c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }
  function rotZ(a, v) { var c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]; }
  /** 吊った車の表面のサンプル点（ワールド座標）。lift＝吊り上げの状態（crane, cable, swing, load, gl, top） */
  function loadPoints(lift) {
    var car = lift.car, p = car.type, ld = lift.load, end = clawEnd(lift.crane, lift.cable, lift.swing), s = lift.swing;
    var gl = car.com[0] + ld.e[0], gw = car.com[1] + ld.e[1], clawH = CRANE.clawH(p);
    var pts = [], xs = [-0.5, -0.25, 0, 0.25, 0.5], ys = [0.08, 0.45, p.lowTop];
    for (var yi = 0; yi < ys.length; yi++) {
      for (var xi = 0; xi < xs.length; xi++) for (var sz = -1; sz <= 1; sz += 2) pts.push([xs[xi] * p.L, ys[yi], sz * p.W / 2]);
      pts.push([p.L / 2, ys[yi], 0]); pts.push([-p.L / 2, ys[yi], 0]);
    }
    return pts.map(function (b) {
      var v = [b[0] - gl, b[1] - lift.top, b[2] - gw];
      v = rotX(-ld.phi[1], rotZ(ld.phi[0], v));          // pivotTilt
      v = rotY(car.yaw, v);                               // pivotYaw
      v = [v[0], v[1] - clawH, v[2]];
      v = rotX(-s.tz, rotZ(s.tx, v));                     // 爪（ケーブルの振れ）
      return [end.x + v[0], end.y + v[1], end.z + v[2]];
    });
  }
  /** 車の当たり形状：車体下部（足跡いっぱい・ボンネット高さまで）＋キャビン（少し細く、屋根の高さまで）。
   *  c＝長手方向の中心（車ローカル、three の rotation.y=yaw 基準） */
  function carBoxes(car) {
    var p = car.type, out = [{ c: 0, hL: p.L / 2, hW: p.W / 2, top: p.lowTop }];
    if (p.cabL > 0) out.push({ c: p.cabX * p.L * car.flip, hL: p.cabL * p.L / 2, hW: p.W * 0.46, top: p.H });
    return out;
  }
  /** 吊った車が他の車に食い込んでいる最大量と押し戻す向き */
  function loadHit(lift) {
    var pts = loadPoints(lift), cars = presentCars(lift.lot), best = null;
    for (var k = 0; k < cars.length; k++) {
      var n = cars[k]; if (n === lift.car) continue;
      var boxes = carBoxes(n);
      for (var i = 0; i < pts.length; i++) {
        var q = pts[i]; if (q[1] >= n.type.H || q[1] < 0) continue;
        var loc = toLocal(q[0] - n.x, q[2] - n.z, n.yaw);
        for (var b = 0; b < boxes.length; b++) {
          var bx = boxes[b]; if (q[1] >= bx.top) continue;
          var pl = bx.hL - Math.abs(loc[0] - bx.c), pw = bx.hW - Math.abs(loc[1]);
          if (pl <= 0 || pw <= 0) continue;
          var py = bx.top - q[1], pen = Math.min(pl, pw, py), nrm;
          if (pw <= pl) nrm = toWorld(0, sign(loc[1]), n.yaw); else nrm = toWorld(sign(loc[0] - bx.c), 0, n.yaw);
          if (!best || pen > best.pen) best = { pen: pen, car: n, nx: nrm[0], nz: nrm[1], x: q[0], y: q[1], z: q[2] };
        }
      }
    }
    return best;
  }
  // 接触の段階：近づく速さで「こすった（軽）」「ぶつけた（重）」
  var CONTACT = { bumpSpeed: 0.35, gap: 0.3, scrape: 0.05, bump: 0.15, neighborBump: 0.10, restitution: 0.25,
    clawScrape: 0.03, clawBump: 0.08 };
  /** 隣の車の修理代（弁償）：その車の今の価値 × 割合。隣の車も傷つき、以後の価値が下がる */
  function damageNeighbor(lot, n, frac) {
    var rep = Math.round(carValue(lot, n) * frac);
    n.damage = clamp(n.damage + frac, 0, 0.9);
    return rep;
  }
  /** 吊り上げ〜運搬〜設置の状態をまとめた入れ物 */
  function makeLift(lot, car, crane, cable, clawX, clawZ, round) {
    var g = gripInfo(car, clawX, clawZ), p = car.type;
    var ld = makeLoad(car, clawX, clawZ);
    var sw = makeSwing();
    // 爪が車の幅の中心へ寄った分、ケーブルは斜めになる（吊り上がると振り子になって振れ戻る）
    sw.tx = Math.asin(clamp((g.clawX - crane.x) / cable, -0.5, 0.5));
    sw.tz = Math.asin(clamp((g.clawZ - crane.z) / cable, -0.5, 0.5));
    return {
      lot: lot, car: car, p: p, crane: crane, swing: sw, load: ld, cable: cable, startCable: cable,
      anchor: { x: g.clawX, z: g.clawZ }, gl: g.local[0], top: topAt(p, g.local[0] * car.flip),
      liftFrac: 0, t: 0, contacts: {}, events: [], round: round || { repairs: 0, log: [] }, placeCable: null, inSlot: true
    };
  }
  function slotClearY(lift) {
    var m = 0; presentCars(lift.lot).forEach(function (c) { if (c !== lift.car) m = Math.max(m, c.type.H); });
    return m + 0.25;
  }
  function loadBottomY(lift) { var pts = loadPoints(lift), m = 1e9; for (var i = 0; i < pts.length; i++) m = Math.min(m, pts[i][1]); return m - 0.08; }
  /** 1ステップ進める。mode: 'lift'（巻き上げ。移動もできる）/'carry'（運搬）/'place'（下ろす）
   *  返り値：この間に起きた接触イベントの配列 */
  function stepLift(lift, mode, input, dt) {
    var p = lift.p, cr = lift.crane, sw = lift.swing, ld = lift.load, events = [];
    lift.t += dt;
    stepCrane(cr, input || { x: 0, z: 0 }, dt, true);
    if (mode === 'lift') {
      var bottom = loadBottomY(lift);
      lift.inSlot = bottom < slotClearY(lift);
      var v = lift.inSlot ? CRANE.slotSpeed : liftSpeed(p);
      lift.cable = Math.max(carryCable(p), lift.cable - v * dt);
      lift.liftFrac = clamp((lift.startCable - lift.cable) / CRANE.liftRamp, 0, 1);
    } else if (mode === 'place') {
      lift.cable = Math.min(lift.placeCable, lift.cable + CRANE.lowerSpeed * 0.55 * dt);
      lift.liftFrac = clamp((lift.placeCable - lift.cable) / CRANE.liftRamp, 0, 1);
    } else lift.liftFrac = 1;
    var free = lift.liftFrac >= 0.5;
    if (!free) {
      // まだ車が地面に着いている：爪は車の上に留まり、ケーブルの角度だけが変わる
      var a = mode === 'place' ? clawEnd(cr, lift.cable, sw) : lift.anchor;
      sw.tx = Math.asin(clamp((a.x - cr.x) / lift.cable, -0.6, 0.6)); sw.tz = Math.asin(clamp((a.z - cr.z) / lift.cable, -0.6, 0.6));
      sw.wx = sw.wz = 0;
    } else stepSwing(sw, cr.ax, cr.az, lift.cable, p, dt);
    stepLoad(ld, p, dt, lift.liftFrac, free ? sw : null);
    if (ld.detached) return events;
    // 隣の車との接触
    if (free) {
      var hit = loadHit(lift);
      if (hit && hit.pen > 1e-5) {
        var L = lift.cable;
        var vn = L * (sw.wx * hit.nx + sw.wz * hit.nz) * Math.cos(sw.tx) + cr.vx * hit.nx + cr.vz * hit.nz; // 押し出す向きの速さ（負＝食い込む向き）
        var speed = Math.max(-vn, Math.min(hit.pen / dt, 0.1), 0);   // 近づく速さ（傾きで寄っていくだけなら小さい）
        // 押し戻す（振り子の角度で）＋食い込む向きの速度をはね返す
        sw.tx += hit.nx * hit.pen / L; sw.tz += hit.nz * hit.pen / L;
        var wn = sw.wx * hit.nx + sw.wz * hit.nz;
        if (wn < 0) { sw.wx -= (1 + CONTACT.restitution) * wn * hit.nx; sw.wz -= (1 + CONTACT.restitution) * wn * hit.nz; }
        var ev = registerContact(lift, hit, speed);
        if (ev) events.push(ev);
      }
    }
    lift.events.push.apply(lift.events, events);
    return events;
  }
  function registerContact(lift, hit, speed) {
    var id = hit.car.id, st = lift.contacts[id], kind = speed >= CONTACT.bumpSpeed ? 'bump' : 'scrape', ev = null;
    if (!st || lift.t - st.last > CONTACT.gap) {
      st = lift.contacts[id] = { last: lift.t, kind: kind, start: lift.t };
      ev = applyLoadContact(lift, hit, kind, false, speed);
    } else if (st.kind === 'scrape' && kind === 'bump') {
      st.kind = 'bump';
      ev = applyLoadContact(lift, hit, 'bump', true, speed);
    }
    st.last = lift.t;
    return ev;
  }
  function applyLoadContact(lift, hit, kind, upgrade, speed) {
    var k = lift.p.scratchK, ld = lift.load;
    var d = kind === 'bump' ? CONTACT.bump * k - (upgrade ? CONTACT.scrape * k : 0) : CONTACT.scrape * k;
    ld.damage += d; recalcCondition(ld);
    var rep = 0;
    if (kind === 'bump') rep = damageNeighbor(lift.lot, hit.car, CONTACT.neighborBump);
    lift.round.repairs += rep;
    var ev = { source: 'load', kind: kind, upgrade: upgrade, car: hit.car, carId: hit.car.id, dmg: d, repair: rep, speed: speed, x: hit.x, y: hit.y, z: hit.z };
    lift.round.log.push(ev);
    return ev;
  }
  /** 爪の下降時の接触：隣の車に傷（弁償） */
  function applyClawContact(lot, round, car, kind) {
    var rep = damageNeighbor(lot, car, kind === 'bump' ? CONTACT.clawBump : CONTACT.clawScrape);
    round.repairs += rep;
    var ev = { source: 'claw', kind: kind, car: car, carId: car.id, dmg: 0, repair: rep };
    round.log.push(ev);
    return ev;
  }

  // ---------------------------------------------------------------- 回収・スコア
  function inZone(x, z) { return x >= ZONE.x0 && x <= ZONE.x1 && z >= ZONE.z0 && z <= ZONE.z1; }
  /** スコア＝価値×状態 − 隣の車の弁償。落下・取れず は弁償だけ */
  function score(value, condition, repairs) { return Math.round(value * clamp(condition, 0, 1)) - (repairs || 0); }
  function conditionLabel(c) {
    if (c >= 0.999) return '無傷';
    if (c >= 0.85) return 'こすり傷';
    if (c >= 0.6) return 'へこみ';
    return '大破';
  }
  /** 理論上の目安：最初の駐車場で価値の高い5台の合計 */
  function maxTotal(lot) {
    var v = presentCars(lot).map(function (c) { return carValue(lot, c); }).sort(function (a, b) { return b - a; });
    return v.slice(0, ROUNDS).reduce(function (a, b) { return a + b; }, 0);
  }
  function rank(total, ref) {
    var r = Math.max(0, total) / ref;
    if (r >= 0.8) return '伝説のクレーン職人';
    if (r >= 0.55) return '現場のエース';
    if (r >= 0.3) return '見習いオペレーター';
    return 'まずは免許から';
  }

  // ---------------------------------------------------------------- まとめて模擬（テスト・バランス確認用）
  /** 爪の位置 (cx,cz) で下ろし、掴めたら吊り上げて plan(t, crane, lift) → input で運ぶ。描画と同じ関数を使う */
  function simulate(lot, car, cx, cz, plan, opts) {
    opts = opts || {};
    var p = car.type, dt = opts.dt || 1 / 60, round = opts.round || { repairs: 0, log: [] };
    var desc = simulateDescent(lot, car, cx, cz);
    desc.hits.forEach(function (h) { applyClawContact(lot, round, h.car, h.kind); });
    if (desc.stop !== 'target') return { result: desc.stop === 'neighbor' ? 'blocked' : 'miss', descent: desc, round: round };
    var cr = makeCrane(opts.craneX != null ? opts.craneX : cx, opts.craneZ != null ? opts.craneZ : cz);
    var cable = CRANE.topY - CRANE.clawH(p) - desc.hubY;
    var lift = makeLift(lot, car, cr, cable, cx, cz, round);
    plan = plan || function () { return { x: 0, z: 0 }; };
    var t = 0;
    while (lift.cable > carryCable(p) + 1e-6 && t < 30) {
      stepLift(lift, 'lift', plan(t, cr, lift, 'lift'), dt); t += dt;
      if (lift.load.detached) return { result: 'fall', phase: 'lift', lift: lift, load: lift.load, descent: desc, round: round };
    }
    var T = opts.T || 10;
    for (var tt = 0; tt < T; tt += dt) {
      stepLift(lift, 'carry', plan(t + tt, cr, lift, 'carry'), dt);
      if (lift.load.detached) return { result: 'fall', phase: 'carry', lift: lift, load: lift.load, descent: desc, round: round };
    }
    return { result: 'held', lift: lift, load: lift.load, crane: cr, descent: desc, round: round };
  }

  // ---------------------------------------------------------------- 慎重な運転手（テスト・画面確認用。ボタンの押す／離すだけで運転する）
  /** 揺れの振幅（rad）：角度と角速度から、1軸ずつの振り子として */
  function swingAmp(s, p, cable) {
    var w = swingOmega(p, cable);
    return Math.hypot(Math.hypot(s.tx, s.wx / w), Math.hypot(s.tz, s.wz / w));
  }
  /** 慎重な運転手（テスト・画面確認用。十字ボタンの押す／離すだけで運転する）。
   *  吊り荷（爪の先）の位置を見て「目標へ向かう速さ ＋ 吊り荷が振れていく向きへ寄せる速さ」を決め、
   *  その速さになるようボタンを押す／離す（0.1 秒ごとに判断＝人が小刻みに押すのと同じ。dt＝前回からの経過秒）。
   *  寄せる分が揺れのエネルギーを抜く（逆位相で殺す）。大きく揺れている間は目標へ向かわず、まず揺れを殺す。止まって揺れも収まったら state.done。
   *  返り値の関数 (crane, swing, cable, p, dt) → {x,z} を毎フレーム呼ぶ */
  function carefulDriver(tx, tz, opts) {
    opts = opts || {};
    var tol = opts.tol || 0.5, settle = (opts.settle || 1.5) * DEG, every = opts.every || 0.1;
    var gLo = opts.gl || 0.35, gHi = opts.gh || 0.6, boost = opts.boost || 0;
    var kp = opts.kp || 0.3, kd = opts.kd || 0.3, vcap = opts.vcap || 1.6, dead = opts.dead || 0.1;
    var st = { done: false, t: 0, next: 0, cmd: { x: 0, z: 0 } };
    function decide(axis, cr, sw, cable, gate) {
      // 速さの目安＝目標への残り×kp ＋ 吊り荷がぶら下がっている側への寄せ（kd×ケーブル×振れ角）。
      // 振れている側へ寄せると、クレーンの加速が吊り荷の振れる向きと揃い、揺れのエネルギーが抜ける
      var th = axis === 'x' ? sw.tx : sw.tz, v = cr['v' + axis], target = axis === 'x' ? tx : tz;
      var vc = gate * clamp(kp * (target - cr[axis]), -vcap, vcap) + (kd + boost * (1 - gate)) * cable * Math.sin(th);
      if (Math.abs(vc) < dead) return 0;                       // ほぼ止まりたい：離す（ブレーキ）
      if (sign(vc) !== sign(v) && Math.abs(v) > 1e-6) return sign(vc); // 逆向きに動いている：逆へ押す（＝減速）
      return Math.abs(vc) > Math.abs(v) ? sign(vc) : 0;        // 足りなければ押す、出すぎなら離す
    }
    var drv = function (cr, sw, cable, p, dt) {
      st.t += dt || 1 / 60;
      var amp = swingAmp(sw, p, cable);
      var near = Math.abs(tx - cr.x) <= tol && Math.abs(tz - cr.z) <= tol, stopped = Math.abs(cr.vx) + Math.abs(cr.vz) < 1e-6;
      st.done = near && stopped && amp < settle;
      if (st.done) { st.cmd = { x: 0, z: 0 }; return { x: 0, z: 0 }; }
      if (st.t >= st.next - 1e-9) { st.next = st.t + every; var lim = p ? p.swingLimit : 20 * DEG, gate = clamp((gHi * lim - amp) / ((gHi - gLo) * lim), 0, 1); /* 振幅が限界の35%までは全速、60%を超えたら揺れを殺すだけ */ st.cmd = { x: decide('x', cr, sw, cable, gate), z: decide('z', cr, sw, cable, gate) }; }
      return { x: st.cmd.x, z: st.cmd.z };
    };
    drv.state = st;
    return drv;
  }

  // ---------------------------------------------------------------- v2.2 落下時の大破・爆発
  /** 落下の激しさ 0.2〜1：地面に当たった速さ（と落下高さから出る速さの大きい方）× 重さ。小さな落下でも必ず壊れる（下限 0.2） */
  function wreckPower(impactSpeed, dropH, p) {
    var v = Math.max(Math.abs(impactSpeed || 0), Math.sqrt(2 * G * Math.max(0, dropH || 0)));
    var massK = p ? 0.85 + 0.15 * p.mass / 1500 : 1;
    return clamp(0.2 + 0.8 * clamp((v - 2) / 6.5, 0, 1) * massK, 0.2, 1);
  }
  /** 激しさから演出の量を決める（飛び散る部品・炎・煙・閃光・揺れ・焦げ跡）。激しいほど全部増える */
  function wreckPlan(power) {
    var k = clamp(power, 0, 1);
    return {
      power: k,
      tyres: 1 + Math.round(k * 3),          // 外れて転がるタイヤ 1〜4
      doors: 1 + Math.round(k * 3),          // 吹き飛ぶドア 1〜4
      roofOff: k >= 0.45,                    // 屋根（キャビン）が吹き飛ぶ
      hoodOff: k >= 0.3,                     // ボンネットが飛ぶ
      shards: Math.round(8 + k * 30),        // 細かい破片
      fire: Math.round(10 + k * 80),         // 炎の粒
      smoke: Math.round(18 + k * 32),        // 煙の粒
      partSpeed: 3 + k * 7,                  // 部品の飛ぶ速さ m/s
      fireball: 2.2 + k * 4.3,               // 火の玉の大きさ m
      shake: 0.6 + k * 1.6,                  // 画面の揺れ
      flash: 0.55 + 0.45 * k,                // 閃光の強さ
      scorch: 2.2 + k * 2.6,                 // 焦げ跡の直径 m
      burn: 8 + k * 16,                      // 残骸がくすぶる秒数
      crush: 0.9 - 0.25 * k                  // 車体の高さのつぶれ（1＝無傷）
    };
  }
  /**
   * 「写真」を撮るカメラ位置：対象（中心 x,y,z と大きさ size）が画角に収まる距離から、斜め上・手前寄りに構える。
   * kind='get' は寄りで車を主役に、'wreck' は引きで煙と散らばった部品まで入れる。
   */
  function photoShot(cx, cy, cz, size, kind, opt) {
    if (opt && opt.box) return photoFit(kind, opt.box, opt.nose);
    var fov = 42, el = (kind === 'wreck' ? 24 : 30) * DEG, az = (kind === 'wreck' ? -28 : 32) * DEG;
    var fill = kind === 'wreck' ? 0.74 : 0.8;             // 対象が画面の何割を占めるか
    var dist = (size / 2) / Math.tan(fov / 2 * DEG) / fill;
    dist = Math.max(dist, size * 0.75 + 2.5);
    var lookY = cy;
    var pos = [cx + Math.sin(az) * Math.cos(el) * dist, lookY + Math.sin(el) * dist, cz + Math.cos(az) * Math.cos(el) * dist];
    if (pos[1] < 1.2) pos[1] = 1.2;
    return { pos: pos, look: [cx, lookY, cz], fov: fov, dist: dist };
  }
  var PHOTO = { get: { fov: 34, el: 32, fill: 0.92 }, wreck: { fov: 38, el: 22, fill: 0.9 }, ang: 42, minZ: 0.35 };
  /** 写真の向き：車の前（nose＝ワールドの水平単位ベクトル）から斜め 42° の「3/4 ビュー」。手前側（+z）から撮れる向きの中で、前寄りを優先 */
  function photoAz(nose, kind) {
    var def = (kind === 'wreck' ? -28 : 32) * DEG;
    if (!nose) return def;
    var best = null, bs = -1e9, a = PHOTO.ang * DEG;
    [1, -1].forEach(function (fs) {
      [1, -1].forEach(function (rs) {
        var nx = nose[0] * fs, nz = nose[1] * fs, c = Math.cos(a * rs), s = Math.sin(a * rs);
        var dx = nx * c - nz * s, dz = nx * s + nz * c;
        if (dz < PHOTO.minZ) return;
        var sc = dz + (fs > 0 ? 0.4 : 0) + (kind === 'wreck' ? -dx : dx) * 0.05;
        if (sc > bs) { bs = sc; best = Math.atan2(dx, dz); }
      });
    });
    return best == null ? def : best;
  }
  /** v2.3：対象の箱（ワールド AABB の min/max）の8つの角が、画角の fill 割に収まる一番近い距離まで寄る */
  function photoFit(kind, box, nose) {
    var P = kind === 'wreck' ? PHOTO.wreck : PHOTO.get, el = P.el * DEG, az = photoAz(nose, kind);
    var T = Math.tan(P.fov / 2 * DEG) * P.fill;
    var look = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    var dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    var f = [-dir[0], -dir[1], -dir[2]], r = [-f[2], 0, f[0]], rl = Math.hypot(r[0], r[2]); r = [r[0] / rl, 0, r[2] / rl];
    var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    function fits(d) {
      var p = [look[0] + dir[0] * d, look[1] + dir[1] * d, look[2] + dir[2] * d];
      for (var i = 0; i < 8; i++) {
        var c = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]];
        var v = [c[0] - p[0], c[1] - p[1], c[2] - p[2]], z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
        if (z < 0.3) return false;
        if (Math.abs(v[0] * r[0] + v[2] * r[2]) / z > T || Math.abs(v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / z > T) return false;
      }
      return true;
    }
    var lo = 0.5, hi = 80;
    for (var k = 0; k < 40; k++) { var mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    var pos = [look[0] + dir[0] * hi, look[1] + dir[1] * hi, look[2] + dir[2] * hi];
    return { pos: pos, look: look, fov: P.fov, dist: hi, az: az / DEG, el: P.el, fill: P.fill };
  }

  // ---------------------------------------------------------------- v2.6 下ろしたら自動で掴んで上げる
  // 止まった直後に少しだけ間を置く（「届いた」「乗り上げた」が目で読めるように）。ボタンは不要
  var AUTO = { gripDelay: 0.25, hoistDelay: 0.25, retractDelay: 0.8 };
  /** フェーズとその経過時間から、自動で起こす操作を返す。'grip'（爪を閉じる）/'hoist'（引き抜き開始）/'retract'（空の爪を戻す）/null */
  function autoNext(phase, timer, gripped) {
    if (phase === 'down') return gripped ? (timer >= AUTO.gripDelay ? 'grip' : null) : (timer >= AUTO.retractDelay ? 'retract' : null);
    if (phase === 'closed') return timer >= AUTO.hoistDelay ? 'hoist' : null;
    return null;
  }
  /** 手で押すボタンが効くフェーズ：下ろす（車の上）／下降中の中止（車に届くまで）／運搬中の「置く」（ゾーンの上） */
  function manualAction(phase, hasAim, inZoneNow) {
    if (phase === 'move') return hasAim ? 'lower' : null;
    if (phase === 'lower') return 'abort';
    if (phase === 'carry') return inZoneNow ? 'place' : null;
    return null;
  }
  /** v2.6 地面の丸い印：常に爪（の先端の吊り点）の真下。車の有無・狙いの有無に関係しない */
  function markerPos(cr, cable, s) { var e = clawEnd(cr, cable, s); return { x: e.x, z: e.z }; }

  var api = {
    AUTO: AUTO, autoNext: autoNext, manualAction: manualAction, markerPos: markerPos,
    wreckPower: wreckPower, wreckPlan: wreckPlan, photoShot: photoShot, photoFit: photoFit, photoAz: photoAz, PHOTO: PHOTO,
    G: G, DEG: DEG, CAR_TYPES: CAR_TYPES, LOT: LOT, YARD: YARD, ZONE: ZONE, CRANE: CRANE, CLAW: CLAW, CONTACT: CONTACT, TRIES: TRIES, ROUNDS: ROUNDS,
    clamp: clamp, lerp: lerp, rng: rng, typeById: typeById, topAt: topAt, topAtWorld: topAtWorld,
    clawScale: clawScale, carryCable: carryCable, clawReach: clawReach, fingerZ: fingerZ, fingerDepth: fingerDepth,
    stallPos: stallPos, makeLot: makeLot, carAt: carAt, neighbors: neighbors, surround: surround, carValue: carValue, gaps: gaps, clawSlack: clawSlack,
    presentCars: presentCars, toLocal: toLocal, toWorld: toWorld, comWorld: comWorld, inFootprint: inFootprint,
    clawProbe: clawProbe, simulateDescent: simulateDescent, gripInfo: gripInfo,
    tiltTarget: tiltTarget, slipOffset: slipOffset, liftSpeed: liftSpeed, swingOmega: swingOmega, swingLeff: swingLeff,
    makeCrane: makeCrane, stepCrane: stepCrane, makeSwing: makeSwing, stepSwing: stepSwing, swingMag: swingMag, clawEnd: clawEnd,
    makeLoad: makeLoad, stepLoad: stepLoad, landingDamage: landingDamage, applyLanding: applyLanding, recalcCondition: recalcCondition,
    loadPoints: loadPoints, loadHit: loadHit, carBoxes: carBoxes, makeLift: makeLift, stepLift: stepLift, loadBottomY: loadBottomY, slotClearY: slotClearY,
    damageNeighbor: damageNeighbor, applyClawContact: applyClawContact,
    inZone: inZone, score: score, conditionLabel: conditionLabel, maxTotal: maxTotal, rank: rank, simulate: simulate,
    swingAmp: swingAmp, carefulDriver: carefulDriver, carUnder: carUnder, craneAxis: craneAxis, swingDamp: swingDamp, EMPTY_SWING: EMPTY_SWING
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CraneLogic = api;
})(typeof window !== 'undefined' ? window : this);
