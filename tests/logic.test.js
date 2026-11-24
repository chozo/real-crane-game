// 純ロジックの単体テスト： node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic.js');
const DEG = L.DEG;
const T = id => L.typeById(id);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const still = () => ({ x: 0, z: 0 });
const SEEDS = [1, 2, 3, 7, 42, 99, 12345];

// 左右とも車に挟まれた車（なければ null）
function sandwiched(lot) { return lot.cars.find(c => { const n = L.neighbors(lot, c); return n.left && n.right; }) || null; }
// 重心の真上（幅方向は中心）
function overCom(car) { const c = L.comWorld(car); return [car.x, c[1]]; }

test('車種：6種類（軽・コンパクト・セダン・ワゴン・オープン・スポーツ）、価格と形と色が違う', () => {
  assert.deepEqual(L.CAR_TYPES.map(p => p.name), ['軽自動車', 'コンパクト', 'セダン', 'ワゴン', 'オープンカー', 'スポーツカー']);
  const bases = L.CAR_TYPES.map(p => p.base);
  for (let i = 1; i < bases.length; i++) assert.ok(bases[i] > bases[i - 1], 'base price rises');
  // スポーツカーは低くて幅広、軽は背が高くて細い
  assert.ok(T('sports').H < T('sedan').H && T('sports').W > T('sedan').W);
  assert.ok(T('kei').H > T('sedan').H && T('kei').W < T('compact').W);
  // オープンカーは屋根が無い（掴む面はドアの上）
  assert.equal(L.topAt(T('open'), 0), T('open').lowTop);
  assert.equal(L.topAt(T('sedan'), T('sedan').cabX * T('sedan').L), T('sedan').H);
  for (const p of L.CAR_TYPES) assert.ok(p.colors.length >= 3, p.name + ' colors');
  // 高級車ほど傷の減額が大きい
  assert.ok(T('sports').scratchK > T('sedan').scratchK && T('sedan').scratchK >= T('kei').scratchK);
});

test('駐車場：2列×6区画、10台＋空き2、決定的、重なりなし、隙間は狭い（0.4〜1.2m）', () => {
  for (const seed of SEEDS) {
    const a = L.makeLot(seed), b = L.makeLot(seed);
    assert.equal(a.cars.length, 10); assert.equal(a.empty.length, 2);
    assert.deepEqual(a.cars.map(c => [c.type.id, c.x, c.z]), b.cars.map(c => [c.type.id, c.x, c.z]));
    assert.ok(new Set(a.cars.map(c => c.type.id)).size >= 5, 'variety');
    for (const c of a.cars) {
      // 区画の中に収まる
      const s = L.stallPos(c.row, c.col);
      assert.ok(Math.abs(c.x - s.x) + c.type.W / 2 < L.LOT.SW / 2 + 0.05, 'fits stall width');
      assert.ok(Math.abs(c.z - s.z) + c.type.L / 2 < L.LOT.SD / 2, 'fits stall depth');
      const g = L.gaps(a, c);
      for (const v of [g.left, g.right]) if (v != null) assert.ok(v > 0.4 && v < 1.2, `gap ${v.toFixed(2)}`);
      assert.ok(!L.inZone(c.x, c.z));
    }
  }
});

test('囲まれ度と価値：挟まれた車・奥の列ほど高い。隣の車がいなくなると下がる', () => {
  const lot = L.makeLot(1);
  for (const c of lot.cars) {
    const s = L.surround(lot, c), n = L.neighbors(lot, c);
    assert.equal(s.side, (n.left ? 1 : 0) + (n.right ? 1 : 0));
    assert.equal(s.across, n.across ? 1 : 0);
    assert.equal(s.back, c.row === 0 ? 1 : 0);
    assert.ok(near(s.mult, 1 + 0.3 * s.side + 0.2 * s.across + 0.15 * s.back, 1e-9));
    assert.equal(L.carValue(lot, c), Math.round(c.type.base * s.mult));
  }
  // 最大は 2 台に挟まれ・背中合わせあり・奥の列 → ×1.95
  assert.ok(near(1 + 0.6 + 0.2 + 0.15, 1.95));
  // 同じ車種なら、囲まれている方が高い
  const c = sandwiched(lot), before = L.carValue(lot, c);
  const nb = L.neighbors(lot, c);
  nb.left.present = false;
  assert.ok(L.carValue(lot, c) < before, 'value drops when a neighbour leaves');
  assert.equal(L.gaps(lot, c).left, null, 'gap becomes open');
});

test('傷ついた車は価値が下がる（隣の車への接触の後遺症）', () => {
  const lot = L.makeLot(2), c = lot.cars[0], v0 = L.carValue(lot, c);
  const rep = L.damageNeighbor(lot, c, 0.1);
  assert.equal(rep, Math.round(v0 * 0.1));
  assert.ok(L.carValue(lot, c) < v0);
});

test('爪の下降：真上なら隣に触れず屋根に届く', () => {
  for (const seed of SEEDS) {
    const lot = L.makeLot(seed);
    for (const car of lot.cars) {
      const [x, z] = overCom(car), d = L.simulateDescent(lot, car, x, z);
      assert.equal(d.stop, 'target', `seed ${seed} car ${car.id}`);
      assert.equal(d.hits.length, 0);
      assert.ok(near(d.hubY, L.topAtWorld(car, x, z), 0.03));
    }
  }
});

test('爪の下降：隙間の余裕を超えてずれると「こすった」、さらにずれると「ぶつけた」で隣の車に乗り上げる', () => {
  const bumped = { n: 0, skip: 0 };
  for (const seed of [...SEEDS, 5, 11, 13, 21, 77]) {
    const lot = L.makeLot(seed), car = sandwiched(lot);
    if (!car) continue;
    const [x, z] = overCom(car), slack = L.clawSlack(lot, car);
    for (const side of ['left', 'right']) {
      const sx = side === 'right' ? 1 : -1, nb = L.neighbors(lot, car)[side];
      // 余裕の内側：接触なし
      let d = L.simulateDescent(lot, car, x + sx * (slack[side] - 0.03), z);
      assert.equal(d.hits.length, 0, `${seed} ${side} inside slack`);
      // 余裕を少し超える：こする（そのまま下りて掴める）
      if (slack[side] + 0.05 < L.CLAW.openMargin - L.CLAW.tipR) {
        d = L.simulateDescent(lot, car, x + sx * (slack[side] + 0.05), z);
        assert.equal(d.stop, 'target', `${seed} ${side} scrape still reaches`);
        assert.equal(d.hits.length, 1); assert.equal(d.hits[0].kind, 'scrape'); assert.equal(d.hits[0].car, nb);
      }
      // 大きく超える：指が隣の車に乗り上げて止まる（ずれが爪の開きを超える場合は、先に自分の屋根に指が乗るので対象外）
      const bumpOff = slack[side] + L.CLAW.scrapeDepth + 0.06;
      if (bumpOff >= L.CLAW.openMargin - L.CLAW.tipR) { bumped.skip++; continue; }
      bumped.n++;
      d = L.simulateDescent(lot, car, x + sx * bumpOff, z);
      assert.equal(d.stop, 'neighbor', `${seed} ${side} bump`);
      assert.ok(d.hits.some(h => h.kind === 'bump' && h.car === nb));
      assert.ok(d.hubY > L.topAtWorld(car, x, z), 'claw stopped above the target roof');
    }
  }
  assert.ok(bumped.n >= 4, JSON.stringify(bumped));
});

test('爪の下降：隣が空き区画なら大きくずれても隣には当たらない（ずれすぎると自分の屋根に指が乗るだけ）', () => {
  let tested = 0;
  for (const seed of SEEDS) {
    const lot = L.makeLot(seed);
    for (const car of lot.cars) {
      const n = L.neighbors(lot, car);
      for (const [side, sx] of [['left', -1], ['right', 1]]) {
        if (n[side] || (car.col === 0 && sx < 0) || (car.col === 5 && sx > 0)) continue;
        const [x, z] = overCom(car);
        let d = L.simulateDescent(lot, car, x + sx * 0.3, z);
        assert.equal(d.stop, 'target'); assert.equal(d.hits.length, 0);
        d = L.simulateDescent(lot, car, x + sx * 0.6, z);
        assert.equal(d.stop, 'ownRoof'); assert.equal(d.hits.length, 0);
        tested++;
      }
    }
  }
  assert.ok(tested > 3);
});

test('爪の下降の接触は隣の車に傷（弁償）：こすり 3%、ぶつけ 8%', () => {
  const lot = L.makeLot(1), car = sandwiched(lot), nb = L.neighbors(lot, car).right;
  const v = L.carValue(lot, nb), round = { repairs: 0, log: [] };
  const e1 = L.applyClawContact(lot, round, nb, 'scrape');
  assert.equal(e1.repair, Math.round(v * 0.03));
  const v2 = L.carValue(lot, nb);
  const e2 = L.applyClawContact(lot, round, nb, 'bump');
  assert.equal(e2.repair, Math.round(v2 * 0.08));
  assert.equal(round.repairs, e1.repair + e2.repair);
  assert.ok(near(nb.damage, 0.11, 1e-9));
});

test('吊った車の姿勢：吊った直後のサンプル点は区画に置かれた車の箱と一致', () => {
  const lot = L.makeLot(1), car = lot.cars[6], [x, z] = overCom(car);
  const d = L.simulateDescent(lot, car, x, z);
  const cr = L.makeCrane(x, z), cable = L.CRANE.topY - L.CRANE.clawH(car.type) - d.hubY;
  const lift = L.makeLift(lot, car, cr, cable, x, z);
  const pts = L.loadPoints(lift), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), zs = pts.map(p => p[2]);
  assert.ok(near(Math.min(...xs), car.x - car.type.W / 2, 1e-6) && near(Math.max(...xs), car.x + car.type.W / 2, 1e-6));
  assert.ok(near(Math.min(...zs), car.z - car.type.L / 2, 1e-6) && near(Math.max(...zs), car.z + car.type.L / 2, 1e-6));
  assert.ok(near(Math.min(...ys), 0.08, 1e-6));
  assert.equal(L.loadHit(lift), null, 'parked car does not overlap its neighbours');
});

test('引き抜き：真上を掴んで動かさなければ、隣に触れずに引き抜ける（全車・複数の配置）', () => {
  for (const seed of [1, 2, 42]) {
    const lot = L.makeLot(seed);
    for (const car of lot.cars) {
      const [x, z] = overCom(car), r = L.simulate(lot, car, x, z, still, { T: 2 });
      assert.equal(r.result, 'held', `${seed} ${car.type.id}`);
      assert.equal(r.lift.events.length, 0, `${seed} ${car.type.id} no contact`);
      assert.equal(r.load.condition, 1);
    }
  }
});

test('引き抜き：区画の中にいる間はゆっくり上がる', () => {
  const lot = L.makeLot(1), car = lot.cars[6], [x, z] = overCom(car);
  const r = L.simulate(lot, car, x, z, still, { T: 0.01 });
  // 隣の屋根の高さ＋余裕まで slotSpeed、その後は速い
  const clear = L.slotClearY(r.lift) + 0.08;
  assert.ok(r.lift.t > clear / L.CRANE.slotSpeed, `took ${r.lift.t.toFixed(2)}s`);
  assert.ok(L.liftSpeed(car.type) > L.CRANE.slotSpeed * 2);
});

test('引き抜き中に横へ動かすと、吊った車が隣の車に「ぶつかる」：状態が下がり、隣の車も傷ついて弁償', () => {
  let n = 0;
  for (const seed of [1, 2, 42]) {
    const lot = L.makeLot(seed), car = sandwiched(lot);
    if (!car) continue;
    const nb = L.neighbors(lot, car).right, v = L.carValue(lot, nb), [x, z] = overCom(car);
    const r = L.simulate(lot, car, x, z, (t, cr, lift, m) => ({ x: m === 'lift' && t > 0.1 && t < 4.5 ? 1 : 0, z: 0 }), { T: 3 });
    const ev = r.lift.events.find(e => e.kind === 'bump');
    assert.ok(ev, `seed ${seed}: bump`); assert.equal(ev.car, nb);
    assert.ok(near(r.load.condition, 1 - L.CONTACT.bump * car.type.scratchK, 1e-9) || r.load.condition < 1 - L.CONTACT.bump * car.type.scratchK);
    assert.equal(ev.repair, Math.round(v * L.CONTACT.neighborBump));
    assert.ok(nb.damage >= L.CONTACT.neighborBump - 1e-9);
    assert.ok(r.round.repairs >= ev.repair);
    n++;
  }
  assert.ok(n >= 2);
});

test('接触の段階：ゆっくり触れると「こすった」（軽）、速くぶつかると「ぶつけた」（重）。重いほど減額が大きい', () => {
  const lot = L.makeLot(1), car = lot.cars[6], [x, z] = overCom(car);
  const d = L.simulateDescent(lot, car, x, z), cr = L.makeCrane(x, z);
  const mk = () => { const lt = L.makeLot(1), c = lt.cars[6]; const lf = L.makeLift(lt, c, L.makeCrane(x, z), L.CRANE.topY - L.CRANE.clawH(c.type) - d.hubY, x, z); lf.startCable = lf.cable + 2; return lf; };
  // 吊り上がった状態で、隣の車へ向かって振れている
  const slow = mk(), fast = mk(), gapR = L.gaps(lot, car).right;
  for (const [lf, w] of [[slow, 0.006], [fast, 0.08]]) {
    lf.crane.x = x + gapR - 0.03; lf.swing.tx = 0; lf.swing.wx = w; // 隣の車のすぐ手前に吊られ、右（+x）へ振れる
    let ev = null;
    for (let i = 0; i < 400 && !ev; i++) { const es = L.stepLift(lf, 'carry', still, 1 / 60); if (es.length) ev = es[0]; }
    lf.ev = ev;
  }
  assert.ok(slow.ev && fast.ev, 'both touch');
  assert.equal(slow.ev.kind, 'scrape'); assert.equal(fast.ev.kind, 'bump');
  assert.ok(slow.ev.speed < L.CONTACT.bumpSpeed && fast.ev.speed >= L.CONTACT.bumpSpeed);
  assert.ok(slow.load.condition > fast.load.condition);
  assert.equal(slow.ev.repair, 0, 'scrape: neighbour not charged'); assert.ok(fast.ev.repair > 0);
  // ぶつかった後は押し戻され、隣の車にめり込み続けない
  for (let i = 0; i < 120; i++) L.stepLift(fast, 'carry', still, 1 / 60);
  const h = L.loadHit(fast); assert.ok(!h || h.pen < 0.05);
});

test('ずれて掴むと、爪が車の中心へ寄ってケーブルが斜めになり、吊り上がると振れる', () => {
  const lot = L.makeLot(1), car = lot.cars.find(c => !L.neighbors(lot, c).right && c.col < 5) || lot.cars[9];
  const [x, z] = overCom(car), off = 0.3;
  const d = L.simulateDescent(lot, car, x + off, z);
  assert.equal(d.stop, 'target');
  const cr = L.makeCrane(x + off, z), cable = L.CRANE.topY - L.CRANE.clawH(car.type) - d.hubY;
  const lift = L.makeLift(lot, car, cr, cable, x + off, z);
  assert.ok(near(L.clawEnd(cr, cable, lift.swing).x, car.x, 1e-6), 'claw centred on the car');
  assert.ok(lift.swing.tx < 0);
  let maxDx = 0;
  for (let t = 0; t < 8; t += 1 / 60) { L.stepLift(lift, 'lift', still, 1 / 60); maxDx = Math.max(maxDx, L.clawEnd(cr, lift.cable, lift.swing).x - car.x); }
  assert.ok(maxDx > off * 1.2, `swings toward the hoist side ${maxDx.toFixed(2)}`);
});

test('重心ずれ→傾き（v1 継続）：真上なら 0、ずれるほど大きく、滑落限界のずれでちょうど tiltLimit', () => {
  for (const p of L.CAR_TYPES) {
    assert.equal(L.tiltTarget(p, 0), 0);
    let prev = 0;
    for (let e = 0.1; e <= 1.5; e += 0.1) { const t = L.tiltTarget(p, e); assert.ok(t > prev); prev = t; }
    assert.ok(near(L.tiltTarget(p, L.slipOffset(p)), p.tiltLimit, 1e-12));
    assert.ok(p.L / 2 > L.slipOffset(p), p.name + ' end of the car is beyond the slip offset');
  }
});

test('滑落（v1 継続）：限界の 85% は傾いても持つ、120% は引き抜き中に滑り落ちる', () => {
  const lot0 = L.makeLot(1);
  for (const car0 of lot0.cars) {
    for (const [f, expect] of [[0.85, 'held'], [1.2, 'fall']]) {
      const lot = L.makeLot(1), car = lot.cars[car0.id], p = car.type;
      const w = L.toWorld(car.com[0] + Math.sign(car.com[0] || 1) * L.slipOffset(p) * f, 0, car.yaw);
      const r = L.simulate(lot, car, car.x + w[0], car.z + w[1], still, { T: 2 });
      assert.equal(r.result, expect, `${p.name} ${f}`);
      if (expect === 'held') assert.ok(r.load.maxTilt > 0.6 * p.tiltLimit && r.load.maxTilt < p.tiltLimit);
      else { assert.equal(r.load.cause, 'tilt'); assert.equal(r.phase, 'lift'); }
    }
  }
});

test('振り子（v1 継続）：加速で揺れが育ち、静止すると減衰する。吊り荷は吊り元の加速と同じ向きに遅れてついてくる', () => {
  const p = T('sedan'), s = L.makeSwing(), cable = 8.6, cr = L.makeCrane(0, 0);
  for (let t = 0; t < 0.5; t += 1 / 60) { L.stepCrane(cr, { x: 1, z: 0 }, 1 / 60, true); L.stepSwing(s, cr.ax, cr.az, cable, p, 1 / 60); }
  assert.ok(s.tx < 0, 'lags behind');
  assert.ok(L.clawEnd(cr, cable, s).x > -1e-3, 'but never moves backward in the world');
  const w = L.swingOmega(p, cable);
  const amp = () => { for (let t = 0; t < 3; t += 1 / 60) L.stepSwing(s, 0, 0, cable, p, 1 / 60); return Math.hypot(s.tx, s.wx / w); };
  const a = amp(), b = amp(), c = amp();
  assert.ok(a > b && b > c);
});

test('クレーン移動（v1 継続）：吊ると加速が遅い、離すと止まる、車止めで止まる', () => {
  const run = loaded => { const c = L.makeCrane(-5, 0); let t = 0; for (; t < 10 && c.vx < (loaded ? L.CRANE.vmaxLoaded : L.CRANE.vmaxEmpty) * 0.97; t += 1 / 60) L.stepCrane(c, { x: 1, z: 0 }, 1 / 60, loaded); return { t, c }; };
  const e = run(false), l = run(true);
  assert.ok(l.t > e.t * 3);
  for (let t = 0; t < 8; t += 1 / 60) L.stepCrane(l.c, { x: 0, z: 0 }, 1 / 60, true);
  assert.ok(Math.abs(l.c.vx) < 1e-6);
  const d = L.makeCrane(8.5, 0); for (let t = 0; t < 3; t += 1 / 60) L.stepCrane(d, { x: 1, z: 0 }, 1 / 60, false);
  assert.equal(d.x, L.YARD.xMax);
});

test('揺れで落下（v1 継続）：吊ったまま急な往復を続けると揺れ落ちる', () => {
  const lot = L.makeLot(1), car = lot.cars[6], [x, z] = overCom(car);
  const rough = L.simulate(lot, car, x, z, (t, cr, lift, m) => m === 'carry' ? { x: Math.floor(t / 2.6) % 2 ? -1 : 1, z: Math.floor(t / 3.1) % 2 ? -1 : 1 } : { x: 0, z: 0 }, { T: 40 });
  assert.equal(rough.result, 'fall'); assert.equal(rough.load.cause, 'swing');
});

test('着地の衝撃とスコア：価値×状態−弁償、ランク', () => {
  assert.equal(L.landingDamage(T('kei'), 2 * DEG, 2 * DEG), 0);
  assert.ok(L.landingDamage(T('kei'), 12 * DEG, 0) > 0);
  assert.equal(L.score(500, 1, 0), 500);
  assert.equal(L.score(500, 0.8, 30), 370);
  assert.equal(L.score(500, 0, 30), -30, 'failed round still pays repairs');
  assert.equal(L.conditionLabel(1), '無傷');
  assert.equal(L.conditionLabel(0.95), 'こすり傷');
  assert.equal(L.conditionLabel(0.7), 'へこみ');
  const Z = L.ZONE;
  assert.ok(L.inZone((Z.x0 + Z.x1) / 2, (Z.z0 + Z.z1) / 2));
  assert.ok(!L.inZone(Z.x0 - 0.1, Z.z0 + 1));
  const lot = L.makeLot(1), ref = L.maxTotal(lot);
  assert.ok(ref > 0);
  assert.equal(L.rank(ref, ref), '伝説のクレーン職人');
  assert.equal(L.rank(-50, ref), 'まずは免許から');
});

test('全5ラウンド：高い車の真上へ爪を動かして掴み、慎重に運べば（押す／離すだけ）、接触ゼロ・落とさずに全部 GET できる（遊べることの確認）', () => {
  // v2.1：揺れが強く収まりにくいので、運転手は「目標へ向かいつつ、吊り荷がぶら下がっている側へ寄せて揺れを殺す」運転をする
  // 最後の2つは低いフレームレート（1/12 秒刻み：ヘッドレスの画面確認と同程度）でも運べることの確認
  for (const [seed, dt] of [...SEEDS.map(s => [s, 1 / 60]), [1, 1 / 12], [42, 1 / 12]]) {
    const lot = L.makeLot(seed);
    const zx = (L.ZONE.x0 + L.ZONE.x1) / 2, zz = (L.ZONE.z0 + L.ZONE.z1) / 2;
    let total = 0;
    for (let round = 0; round < L.ROUNDS; round++) {
      const best = L.presentCars(lot).sort((a, b) => L.carValue(lot, b) - L.carValue(lot, a))[0];
      const [x, z] = overCom(best);
      // 選択フェーズは無い：爪の真下にある車がそのまま狙い（掴んだ時点で確定）
      const car = L.carUnder(lot, x, z);
      assert.equal(car, best, `seed ${seed} round ${round}: the car under the claw is the one we aimed at`);
      const value = L.carValue(lot, car);
      const drv = L.carefulDriver(zx, zz);
      let doneT = null;
      const r = L.simulate(lot, car, x, z, (t, cr, lift, m) => {
        if (m !== 'carry') return still();
        const o = drv(cr, lift.swing, lift.cable, lift.p, dt);
        if (drv.state.done && doneT == null) doneT = t;
        return o;
      }, { T: 90, dt });
      assert.equal(r.result, 'held', `seed ${seed} round ${round} ${car.type.name}`);
      assert.equal(r.lift.events.length, 0, `seed ${seed} round ${round} no contact`);
      assert.ok(doneT != null && doneT < 60, `seed ${seed} round ${round}: arrived and settled (t=${doneT && doneT.toFixed(1)}s)`);
      assert.ok(L.inZone(r.crane.x, r.crane.z), `reached zone (${r.crane.x.toFixed(1)}, ${r.crane.z.toFixed(1)})`);
      assert.ok(r.load.maxSwing < 0.7 * car.type.swingLimit, `seed ${seed} round ${round}: careful driving keeps a margin (${(r.load.maxSwing / DEG).toFixed(1)}° / ${(car.type.swingLimit / DEG)}°)`);
      // 置くとき：揺れが収まっているので着地の衝撃なし
      const amp = L.swingAmp(r.lift.swing, car.type, r.lift.cable);
      assert.equal(L.landingDamage(car.type, amp, r.load.maxTilt * 0), 0);
      total += L.score(value, r.load.condition, r.round.repairs);
      car.present = false; // 取った車は駐車場から消える
    }
    assert.ok(total > 0.8 * L.maxTotal(L.makeLot(seed)) * 0.7);
  }
});

// ---------------------------------------------------------------- v2.1：揺れの強化
const carryRun = (p, dist, seconds) => {
  // 吊った車をゾーン方向へ dist 押しっぱなしで運び、着いたら離す（雑な運転）
  const cable = L.carryCable(p), cr = L.makeCrane(0, 0), s = L.makeSwing();
  let mx = 0;
  for (let t = 0; t < seconds; t += 1 / 60) { L.stepCrane(cr, { x: 0, z: cr.z < dist ? 1 : 0 }, 1 / 60, true); L.stepSwing(s, cr.ax, cr.az, cable, p, 1 / 60); mx = Math.max(mx, L.swingMag(s)); }
  return { cr, s, cable, max: mx };
};

test('v2.5 揺れ：減衰は v2.1 から少し戻した。止まった揺れは 10 秒で3〜6割残る（半減 6〜10 秒。v2.1 は約 20〜28 秒、v2 は約 3 秒）', () => {
  for (const p of L.CAR_TYPES) {
    assert.ok(p.damp >= 0.12 && p.damp <= 0.25, p.name + ' damp ' + p.damp);
    const cable = L.carryCable(p), s = L.makeSwing(); s.tz = 8 * DEG;
    const a0 = L.swingAmp(s, p, cable);
    for (let t = 0; t < 10; t += 1 / 60) L.stepSwing(s, 0, 0, cable, p, 1 / 60);
    const a1 = L.swingAmp(s, p, cable);
    assert.ok(a1 > 0.3 * a0 && a1 < 0.6 * a0, `${p.name}: ${(a1 / DEG).toFixed(1)}° left of ${(a0 / DEG).toFixed(1)}°`);
    const half = 2 * Math.LN2 / p.damp; assert.ok(half > 6 && half < 10, p.name + ' half-life ' + half.toFixed(1));
  }
});

test('v2.1 揺れ：加減速で揺れが育つ。押しっぱなしで運んで離すと大きく振れ、止まった後も長く収まらない', () => {
  const p = T('sedan');
  for (const dist of [8, 10, 12]) {
    const r = carryRun(p, dist, 20), amp = L.swingAmp(r.s, p, r.cable);
    assert.ok(Math.abs(r.cr.vz) < 1e-6, 'stopped');
    assert.ok(r.max > 9 * DEG, `${dist}m: max swing ${(r.max / DEG).toFixed(1)}°`);
    assert.ok(amp > 3 * DEG, `${dist}m: still swinging ${(amp / DEG).toFixed(1)}° after stopping`);
    // v2.5：待つだけでもちゃんと収まる（2° 未満まで 5〜40 秒。v2.1 は 60 秒超）
    const s = { ...r.s }; let t = 0;
    while (L.swingAmp(s, p, r.cable) > 2 * DEG && t < 300) { L.stepSwing(s, 0, 0, r.cable, p, 1 / 60); t += 1 / 60; }
    assert.ok(t > 5 && t < 40, `${dist}m: takes ${t.toFixed(0)}s to settle by waiting`);
  }
  // 加速度そのものが v2 より強い（育ちやすさの元）
  assert.ok(L.CRANE.accelLoaded >= 1.1 && L.CRANE.jerkLoaded >= 2.5);
});

test('v2.1 揺れ：吊り荷がぶら下がっている側へ小刻みに寄せる（逆位相）と、待つよりずっと早く揺れを殺せる', () => {
  const p = T('wagon'), r = carryRun(p, 10, 20), a0 = L.swingAmp(r.s, p, r.cable);
  assert.ok(a0 > 4 * DEG);
  // 待つだけ
  const sw = { ...r.s }; for (let t = 0; t < 15; t += 1 / 60) L.stepSwing(sw, 0, 0, r.cable, p, 1 / 60);
  // 慎重な運転手でその場に留まりつつ揺れを殺す
  const cr = { ...r.cr }, sd = { ...r.s }, drv = L.carefulDriver(cr.x, cr.z, { tol: 0.6 });
  for (let t = 0; t < 15; t += 1 / 60) { L.stepCrane(cr, drv(cr, sd, r.cable, p, 1 / 60), 1 / 60, true); L.stepSwing(sd, cr.ax, cr.az, r.cable, p, 1 / 60); }
  const waitAmp = L.swingAmp(sw, p, r.cable), dampAmp = L.swingAmp(sd, p, r.cable);
  assert.ok(waitAmp > 0.25 * a0, `waiting: ${(waitAmp / DEG).toFixed(1)}°`);
  assert.ok(dampAmp < 0.5 * waitAmp, `active ${(dampAmp / DEG).toFixed(1)}° vs waiting ${(waitAmp / DEG).toFixed(1)}°`);
  assert.ok(dampAmp < 0.2 * a0, `active damping: ${(dampAmp / DEG).toFixed(1)}° from ${(a0 / DEG).toFixed(1)}°`);
  assert.ok(Math.abs(cr.z - r.cr.z) < 1.5, 'stayed nearby');
});

test('v2.5 揺れ：運搬中に育つ揺れは v2.1 から大きく変えず（8割以上）、止めてから 2° まで収まる時間は半分以下', () => {
  const V21 = { kei: 0.07, compact: 0.065, sedan: 0.055, wagon: 0.05, open: 0.055, sports: 0.06 };
  const run = (p, dist) => {
    const cable = L.carryCable(p), cr = L.makeCrane(0, -10), s = L.makeSwing(); let mx = 0;
    for (let t = 0; t < 60; t += 1 / 60) { L.stepCrane(cr, { x: 0, z: cr.z < -10 + dist ? 1 : 0 }, 1 / 60, true); L.stepSwing(s, cr.ax, cr.az, cable, p, 1 / 60); mx = Math.max(mx, L.swingMag(s)); if (cr.z >= -10 + dist && Math.abs(cr.vz) < 1e-9) break; }
    let ts = 0; while (L.swingAmp(s, p, cable) > 2 * DEG && ts < 600) { L.stepSwing(s, 0, 0, cable, p, 1 / 60); ts += 1 / 60; }
    return { mx, ts };
  };
  for (const p0 of L.CAR_TYPES) {
    const old = { ...p0, damp: V21[p0.id] };
    let mxN = 0, mxO = 0, tsN = 0, tsO = 0;
    for (let d = 3; d <= 16; d += 0.5) { const a = run(p0, d), b = run(old, d); mxN = Math.max(mxN, a.mx); mxO = Math.max(mxO, b.mx); tsN = Math.max(tsN, a.ts); tsO = Math.max(tsO, b.ts); }
    assert.ok(mxN > 0.8 * mxO && mxN > 15 * DEG, `${p0.name}: 運搬中の最大揺れ ${(mxN / DEG).toFixed(1)}° (v2.1 ${(mxO / DEG).toFixed(1)}°)`);
    assert.ok(tsN < 0.5 * tsO && tsN < 35, `${p0.name}: 2°まで ${tsN.toFixed(1)}s (v2.1 ${tsO.toFixed(1)}s)`);
  }
});

// ---------------------------------------------------------------- v2.1：選択フェーズの廃止（爪の真下の車が狙い）
test('v2.1 狙い：爪の真下にある車がそのまま狙いの車。隙間の上なら近い方、空き区画・通路・ゾーンの上は無し', () => {
  for (const seed of SEEDS) {
    const lot = L.makeLot(seed);
    for (const car of lot.cars) {
      assert.equal(L.carUnder(lot, car.x, car.z), car);
      const [x, z] = overCom(car); assert.equal(L.carUnder(lot, x, z), car);
      // 隙間の上：中心からわずかに寄った側の車
      const nb = L.neighbors(lot, car);
      if (nb.right) {
        const mid = (car.x + nb.right.x) / 2;
        assert.equal(L.carUnder(lot, mid - 0.05, car.z), car);
        assert.equal(L.carUnder(lot, mid + 0.05, car.z), nb.right);
      }
    }
    for (const s of lot.empty) { const row = Math.floor(s / L.LOT.cols), col = s % L.LOT.cols, sp = L.stallPos(row, col); assert.equal(L.carUnder(lot, sp.x, sp.z), null, 'empty stall'); }
    assert.equal(L.carUnder(lot, 0, (L.ZONE.z0 + L.ZONE.z1) / 2), null, 'zone');
    assert.equal(L.carUnder(lot, 0, 0.6), null, 'start position (aisle)');
    assert.equal(L.carUnder(lot, 0, L.YARD.zMax), null, 'far edge');
    // 取った車の区画は空になる
    const c = lot.cars[0]; c.present = false; assert.equal(L.carUnder(lot, c.x, c.z), null);
  }
});

test('v2.1 狙い：隙間の上で下ろすと、近い方の車が狙いになり、爪が隣の車に当たる（v2 の接触の核は維持）', () => {
  let n = 0;
  for (const seed of SEEDS) {
    const lot = L.makeLot(seed), car = sandwiched(lot); if (!car) continue;
    const nb = L.neighbors(lot, car).right, [, z] = overCom(car);
    const x = (car.x + car.type.W / 2 + nb.x - nb.type.W / 2) / 2 - 0.02; // 隙間の真ん中（少し左）
    const target = L.carUnder(lot, x, z);
    assert.ok(target === car || target === nb);
    const d = L.simulateDescent(lot, target, x, z);
    assert.notEqual(d.stop, 'target', `seed ${seed}: cannot grip from above the gap`);
    n++;
  }
  assert.ok(n >= 3);
});

test('v2.1 揺れ：引き抜き中にぶつけて大きく揺れても、まず揺れを殺してから運べば落とさずにゾーンへ届く', () => {
  let n = 0;
  for (const [seed, dt] of [[1, 1 / 60], [2, 1 / 60], [42, 1 / 60], [1, 1 / 12], [2, 1 / 12]]) {
    const lot = L.makeLot(seed), car = sandwiched(lot); if (!car) continue;
    const [x, z] = overCom(car), zx = (L.ZONE.x0 + L.ZONE.x1) / 2, zz = (L.ZONE.z0 + L.ZONE.z1) / 2;
    let contact = false, drv = null, maxAfter = 0;
    const r = L.simulate(lot, car, x, z, (t, cr, lift, m) => {
      if (!contact) { contact = lift.events.some(e => e.kind === 'bump'); return { x: m === 'lift' && t > 0.1 ? 1 : 0, z: 0 }; }
      if (m !== 'carry') return still();
      if (!drv) drv = L.carefulDriver(zx, zz);
      maxAfter = Math.max(maxAfter, L.swingAmp(lift.swing, lift.p, lift.cable));
      return drv(cr, lift.swing, lift.cable, lift.p, dt);
    }, { T: 90, dt });
    assert.ok(contact, `seed ${seed}: bumped`);
    assert.equal(r.result, 'held', `seed ${seed}`);
    assert.ok(maxAfter > 6 * DEG, `seed ${seed}: was swinging hard (${(maxAfter / DEG).toFixed(1)}°)`);
    assert.ok(drv.state.done && L.inZone(r.crane.x, r.crane.z), `seed ${seed}: delivered`);
    n++;
  }
  assert.ok(n >= 2);
});

test('v2.2 大破：落下が高い・速いほど激しい（単調増加）。小さな落下でも必ず壊れる（下限 0.2）、上限 1', () => {
  for (const p of L.CAR_TYPES) {
    let prev = 0;
    for (let h = 0; h <= 8; h += 0.25) {
      const k = L.wreckPower(0, h, p);
      assert.ok(k >= 0.2 && k <= 1, `${p.id} h=${h}: ${k}`);
      assert.ok(k >= prev - 1e-12, `${p.id} monotonic in height`);
      prev = k;
    }
    assert.ok(L.wreckPower(0, 0.3, p) < 0.35, `${p.id}: 引き抜き中の低い落下は控えめ`);
    assert.ok(L.wreckPower(0, 3.0, p) > 0.6, `${p.id}: 運搬の高さからの落下は派手`);
    // 衝突速度で決まる（高さより速度が大きければ速度を使う）
    assert.ok(L.wreckPower(9, 0.5, p) > L.wreckPower(0, 0.5, p));
  }
  // 重い車ほど少し派手
  assert.ok(L.wreckPower(6, 0, T('wagon')) > L.wreckPower(6, 0, T('kei')));
});

test('v2.2 大破：激しいほど部品・炎・煙・閃光・揺れ・焦げ跡が全部増える。最大ならタイヤ4本・ドア4枚・屋根も飛ぶ', () => {
  const keys = ['tyres', 'doors', 'shards', 'fire', 'smoke', 'partSpeed', 'fireball', 'shake', 'flash', 'scorch', 'burn'];
  let prev = null;
  for (let k = 0.2; k <= 1.0001; k += 0.05) {
    const w = L.wreckPlan(k);
    assert.ok(w.tyres >= 1 && w.tyres <= 4 && w.doors >= 1 && w.doors <= 4);
    assert.ok(w.crush > 0.5 && w.crush < 1);
    if (prev) for (const key of keys) assert.ok(w[key] >= prev[key], `${key} non-decreasing at ${k.toFixed(2)}`);
    prev = w;
  }
  const lo = L.wreckPlan(0.2), hi = L.wreckPlan(1);
  assert.equal(hi.tyres, 4); assert.equal(hi.doors, 4); assert.ok(hi.roofOff && hi.hoodOff);
  assert.ok(!lo.roofOff, '小さな落下では屋根は残る');
  assert.ok(hi.fire >= 3 * lo.fire && hi.shake >= 2 * lo.shake && hi.fireball >= 2 * lo.fireball);
  assert.ok(hi.crush < lo.crush, '激しいほど車体がつぶれる');
});

test('v2.2 写真：撮影カメラは対象を画角に収め、地面より上・斜め上から見下ろす（GET は寄り、残骸は引き）', () => {
  for (const kind of ['get', 'wreck']) for (const size of [3.4, 4.75, 9]) {
    const s = L.photoShot(2, 0.7, 5, size, kind);
    const d = Math.hypot(s.pos[0] - 2, s.pos[1] - 0.7, s.pos[2] - 5);
    assert.ok(near(d, s.dist, 1e-6));
    const half = Math.atan((size / 2) / d) / DEG;
    assert.ok(half < s.fov / 2, `${kind} ${size}: fits (${half.toFixed(1)}° < ${s.fov / 2}°)`);
    assert.ok(s.pos[1] > 1.2 - 1e-9 && s.pos[1] > s.look[1], 'above, looking down');
    assert.ok(s.pos[2] > 5, '手前側（画面のカメラと同じ側）から撮る');
  }
  assert.ok(L.photoShot(0, 0, 0, 4.5, 'wreck').dist > L.photoShot(0, 0, 0, 4.5, 'get').dist);
});

test('v2.3 写真：車の箱に合わせて寄る（8つの角が画角の fill 割に収まり、旧方式より車が大きく写る）。前寄りの 3/4 ビューで手前側から撮る', () => {
  const proj = (s, c) => {
    const f = [s.look[0] - s.pos[0], s.look[1] - s.pos[1], s.look[2] - s.pos[2]], fl = Math.hypot(...f); f.forEach((v, i) => f[i] = v / fl);
    let r = [-f[2], 0, f[0]]; const rl = Math.hypot(r[0], r[2]); r = [r[0] / rl, 0, r[2] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const v = [c[0] - s.pos[0], c[1] - s.pos[1], c[2] - s.pos[2]], z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    return [(v[0] * r[0] + v[2] * r[2]) / z, (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / z];
  };
  for (const p of L.CAR_TYPES) for (const flip of [1, -1]) for (const kind of ['get', 'wreck']) {
    // 回収ゾーンの車（yaw=90°：長手が z 方向）
    const cx = 0.5, cz = 4.6, box = { min: [cx - p.W / 2, 0, cz - p.L / 2], max: [cx + p.W / 2, p.H, cz + p.L / 2] };
    const nw = L.toWorld(flip, 0, Math.PI / 2), s = L.photoShot(cx, p.H * 0.45, cz, 0, kind, { box, nose: nw });
    const T = Math.tan(s.fov / 2 * DEG);
    let maxK = 0;
    for (let i = 0; i < 8; i++) {
      const c = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]];
      const q = proj(s, c); maxK = Math.max(maxK, Math.abs(q[0]) / T, Math.abs(q[1]) / T);
    }
    assert.ok(maxK <= s.fill + 1e-6 && maxK > s.fill - 0.02, `${p.id} ${kind}: 端の角が画角の ${(maxK * 100).toFixed(1)}%（目標 ${s.fill * 100}%）`);
    assert.ok(s.pos[2] > cz + 1 && s.pos[1] > 1.2 && s.pos[1] > s.look[1], `${p.id}: 手前・上から`);
    // 旧方式（v2.2）の GET 写真で車が画角に占めた割合と比べて、はっきり大きく写る
    const old = L.photoShot(cx, p.H * 0.45, cz, Math.max(p.L, p.W) * 1.25, 'get'), To = Math.tan(old.fov / 2 * DEG);
    // 写真の中で車の外接矩形が占める面積の割合
    const area = (sh, Tn) => { let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (let i = 0; i < 8; i++) { const c = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]; const q = proj(sh, c); x0 = Math.min(x0, q[0] / Tn); x1 = Math.max(x1, q[0] / Tn); y0 = Math.min(y0, q[1] / Tn); y1 = Math.max(y1, q[1] / Tn); } return Math.min(2, x1 - x0) * Math.min(2, y1 - y0) / 4; };
    const aOld = area(old, To), aNew = area(s, T);
    if (kind === "get") assert.ok(aNew > aOld * 1.6, `${p.id}: 車の占める面積 旧 ${(aOld * 100).toFixed(0)}% → 新 ${(aNew * 100).toFixed(0)}%`);
    if (kind === 'get' && flip === 1) console.log(`  ${p.id}: 写真内の車の面積 ${(aOld * 100).toFixed(0)}% → ${(aNew * 100).toFixed(0)}%  距離 ${old.dist.toFixed(1)}m → ${s.dist.toFixed(1)}m`);
    // 3/4 ビュー：車の長手から 42°。前が手前を向いていれば前から、奥を向いていれば後ろから
    const cam = [s.pos[0] - cx, s.pos[2] - cz], cl = Math.hypot(...cam), cosA = (cam[0] * nw[0] + cam[1] * nw[1]) / cl;
    assert.ok(near(Math.abs(cosA), Math.cos(42 * DEG), 1e-6), `${p.id}: 3/4 view`);
    if (kind === 'get') assert.equal(Math.sign(cosA), flip < 0 ? 1 : -1, 'nose toward camera side → front view');
  }
});

// ---------------------------------------------------------------- v2.6
// 画面（game.html の update）と同じ順でフェーズを進める小さな再現。ボタンを押すのは「下ろす」の1回だけ
function autoFlow(lot, car, x, z, opts = {}) {
  const dt = 1 / 60, p = car.type, log = [];
  let phase = 'lower', timer = 0, cable = L.carryCable(p), stop = null, gripped = false, lift = null, closeT = 0, presses = 1;
  const cr = L.makeCrane(x, z), sw = L.makeSwing(), set = ph => { phase = ph; timer = 0; log.push(ph); };
  for (let i = 0; i < 60 * 40; i++) {
    timer += dt;
    if (opts.abortAt != null && phase === 'lower' && timer >= opts.abortAt && L.manualAction(phase, true, false) === 'abort') { presses++; stop = 'abort'; set('liftEmpty'); continue; }
    if (phase === 'lower') {
      cable += L.CRANE.lowerSpeed * dt;
      const e = L.clawEnd(cr, cable, sw), pr = L.clawProbe(lot, car, e.x, e.z, e.y - L.CRANE.clawH(p));
      if (pr.stop) { cable = L.CRANE.topY - L.CRANE.clawH(p) - pr.stopY; stop = pr.stop; gripped = pr.stop === 'target'; set('down'); }
    } else if (phase === 'down' || phase === 'closed') {
      assert.equal(L.manualAction(phase, true, false), null, phase + ': no button needed / accepted');
      const a = L.autoNext(phase, timer, gripped);
      if (a === 'grip') { lift = L.makeLift(lot, car, cr, cable, x, z); set('closing'); }
      else if (a === 'retract') set('liftEmpty');
      else if (a === 'hoist') set('lift');
    } else if (phase === 'closing') {
      closeT = Math.min(1, closeT + dt / 0.7); if (closeT >= 1) set('closed');
    } else if (phase === 'lift') {
      L.stepLift(lift, 'lift', still(), dt);
      if (lift.load.detached) { set('fall'); break; }
      if (lift.cable <= L.carryCable(p) + 1e-6) { set('carry'); break; }
    } else if (phase === 'liftEmpty') {
      cable = Math.max(L.carryCable(p), cable - 3.2 * dt);
      if (cable <= L.carryCable(p) + 1e-6) { set('miss'); break; }
    }
  }
  return { phase, log, stop, lift, presses, cable };
}

test('v2.6 自動：autoNext は届いたら少し間を置いて掴む／掴めたら少し間を置いて引き抜く／掴めなければ戻す。それ以外のフェーズでは何もしない', () => {
  const A = L.AUTO;
  assert.equal(L.autoNext('down', A.gripDelay - 0.01, true), null);
  assert.equal(L.autoNext('down', A.gripDelay, true), 'grip');
  assert.equal(L.autoNext('down', A.retractDelay - 0.01, false), null);
  assert.equal(L.autoNext('down', A.retractDelay, false), 'retract');
  assert.equal(L.autoNext('closed', A.hoistDelay - 0.01, true), null);
  assert.equal(L.autoNext('closed', A.hoistDelay, true), 'hoist');
  for (const ph of ['move', 'lower', 'closing', 'lift', 'carry', 'place', 'liftEmpty', 'miss', 'release', 'fall'])
    assert.equal(L.autoNext(ph, 99, true), null, ph);
  assert.ok(A.gripDelay <= 0.5 && A.hoistDelay <= 0.5 && A.retractDelay <= 1.2, 'waits are short');
});

test('v2.6 ボタン：効くのは「下ろす」（車の上）・下降中の「中止」・運搬中の「置く」（ゾーンの上）だけ。届いた後の掴む・上げるは押せない', () => {
  assert.equal(L.manualAction('move', true, false), 'lower');
  assert.equal(L.manualAction('move', false, false), null);
  assert.equal(L.manualAction('lower', true, false), 'abort');
  assert.equal(L.manualAction('carry', false, true), 'place');
  assert.equal(L.manualAction('carry', false, false), null);
  for (const ph of ['down', 'closing', 'closed', 'lift', 'place', 'liftEmpty', 'miss', 'release', 'fall', 'get'])
    assert.equal(L.manualAction(ph, true, true), null, ph);
});

test('v2.6 自動：真上で「下ろす」を1回押すだけで、届く→掴む→引き抜く→運搬の高さまで上がる（全車・複数の配置）', () => {
  for (const seed of [1, 2, 42]) {
    const lot = L.makeLot(seed);
    for (const car of lot.cars) {
      const [x, z] = overCom(car), r = autoFlow(lot, car, x, z);
      assert.deepEqual(r.log, ['down', 'closing', 'closed', 'lift', 'carry'], `${seed} ${car.type.id}`);
      assert.equal(r.presses, 1);
      assert.ok(r.lift.cable <= L.carryCable(car.type) + 1e-6, 'at carry height');
      assert.ok(L.loadBottomY(r.lift) > L.slotClearY(r.lift) - 1e-6 || !r.lift.inSlot, `${seed} ${car.type.id}: out of the slot`);
      assert.equal(r.lift.load.detached, false);
    }
  }
});

test('v2.6 自動：隣の車にぶつけて掴めなかったときも、ボタン無しで空の爪が運搬の高さまで戻る（miss＝従来どおり1回分）', () => {
  let n = 0;
  for (const seed of SEEDS) {
    const lot = L.makeLot(seed), car = sandwiched(lot); if (!car) continue;
    const slack = L.clawSlack(lot, car), [x, z] = overCom(car);
    const off = slack.right + 0.35, d = L.simulateDescent(lot, car, x + off, z);
    if (d.stop === 'target') continue;
    const r = autoFlow(lot, car, x + off, z);
    assert.notEqual(r.stop, 'target');
    assert.deepEqual(r.log, ['down', 'liftEmpty', 'miss'], `seed ${seed}`);
    assert.equal(r.presses, 1);
    assert.ok(Math.abs(r.cable - L.carryCable(car.type)) < 1e-6);
    n++;
  }
  assert.ok(n >= 3, 'cases ' + n);
});

test('v2.6 中止：車に届く前なら「上げる」で下降を中止でき、空の爪が戻る（miss 扱い）。届いた後は中止ボタンは効かない', () => {
  const lot = L.makeLot(1), car = lot.cars[6], [x, z] = overCom(car);
  const r = autoFlow(lot, car, x, z, { abortAt: 0.3 });
  assert.deepEqual(r.log, ['liftEmpty', 'miss']);
  assert.equal(r.presses, 2);
  assert.equal(L.manualAction('down', true, false), null);
});

test('v2.6 丸い印：位置は常に爪の吊り点の真下（clawEnd の x,z）。車の上かどうか・狙いの有無に関係なく、クレーンの動きに連続して追従', () => {
  const lot = L.makeLot(1), cr = L.makeCrane(-9, 0.6), sw = L.makeSwing();
  let prev = null, onCar = 0, offCar = 0, maxJump = 0;
  const dt = 1 / 60, cable = L.carryCable(L.typeById('compact'));
  for (let i = 0; i < 60 * 12; i++) {
    const t = i * dt, input = { x: t < 6 ? 1 : -1, z: Math.sin(t * 1.3) > 0 ? -1 : 1 };
    L.stepCrane(cr, input, dt, false); L.stepSwing(sw, cr.ax, cr.az, cable, null, dt);
    const m = L.markerPos(cr, cable, sw), e = L.clawEnd(cr, cable, sw);
    assert.ok(near(m.x, e.x, 1e-12) && near(m.z, e.z, 1e-12));
    if (L.carUnder(lot, e.x, e.z)) onCar++; else offCar++;
    if (prev) maxJump = Math.max(maxJump, Math.hypot(m.x - prev.x, m.z - prev.z));
    prev = m;
  }
  assert.ok(onCar > 30 && offCar > 30, `visited both: on ${onCar} / off ${offCar}`);
  assert.ok(maxJump < 0.2, 'no jumps between frames: ' + maxJump.toFixed(3));
});
