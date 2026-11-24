// index.html を生成する：src/game.html に Three.js（ローカル node_modules）と src/logic.js をインライン化（お好み焼きの build.js を踏襲）
// Three.js r18x は ESM のみなので、import/export を外して classic script（window.THREE）に変換する。
const fs = require('fs');
const path = require('path');

const THREE_DIR = path.resolve(__dirname, 'node_modules/three/build');
const core = fs.readFileSync(path.join(THREE_DIR, 'three.core.js'), 'utf8');
const mod = fs.readFileSync(path.join(THREE_DIR, 'three.module.js'), 'utf8');
const threeVersion = require(path.resolve(THREE_DIR, '../package.json')).version;

function names(list) {
  return list.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.split(/\s+as\s+/);
    return { local: m[0].trim(), exported: (m[1] || m[0]).trim() };
  });
}

// three.core.js：末尾の export { ... }; を回収
const coreExportRe = /^export\s*\{([^}]*)\};?\s*$/m;
const ce = core.match(coreExportRe);
if (!ce) throw new Error('core export not found');
const coreNames = names(ce[1]);
const coreBody = core.replace(coreExportRe, '');

// three.module.js：import from core / re-export from core / 自前 export
let modBody = mod;
const imp = modBody.match(/^import\s*\{([^}]*)\}\s*from\s*'\.\/three\.core\.js';?\s*$/m);
if (!imp) throw new Error('module import not found');
const impNames = names(imp[1]);
modBody = modBody.replace(imp[0], 'var { ' + impNames.map(n => `${n.local === n.exported ? n.local : n.local + ': ' + n.exported}`).join(', ') + ' } = __core;');
// 注: import { a as b } は 'a' を 'b' としてローカル束縛。上は簡略（three には alias が無いことを確認済み）
if (impNames.some(n => n.local !== n.exported)) throw new Error('aliased import not supported');
modBody = modBody.replace(/^export\s*\{[^}]*\}\s*from\s*'\.\/three\.core\.js';?\s*$/m, '');
const me = modBody.match(/^export\s*\{([^}]*)\};?\s*$/m);
if (!me) throw new Error('module export not found');
const modNames = names(me[1]);
modBody = modBody.replace(me[0], '');
if (/^\s*(import|export)\s/m.test(coreBody + modBody)) throw new Error('leftover import/export');

const threeScript = [
  `/* three.js ${threeVersion} (MIT) — inlined from local node_modules, converted to classic script */`,
  'var THREE = (function () {',
  'var __core = (function () {', coreBody,
  'return {' + coreNames.map(n => `${n.exported}: ${n.local}`).join(',') + '};',
  '})();',
  '(function () {', modBody,
  modNames.map(n => `__core.${n.exported} = ${n.local};`).join('\n'),
  '})();',
  'return __core;',
  '})();'
].join('\n');

const logic = fs.readFileSync(path.join(__dirname, 'src/logic.js'), 'utf8');
let html = fs.readFileSync(path.join(__dirname, 'src/game.html'), 'utf8');
const safe = s => s.replace(/<\/script/gi, '<\\/script');
html = html.replace('/*__THREE__*/', () => safe(threeScript));
html = html.replace('/*__LOGIC__*/', () => safe(logic));
// 地雷チェック：JS文字列中のリンクタグ（a＋href）は配信先プレビューが真っ黒になる。ソースにも成果物にも一切置かない
for (const [name, text] of [['src/game.html', fs.readFileSync(path.join(__dirname, 'src/game.html'), 'utf8')], ['src/logic.js', logic], ['index.html', html]]) {
  if (/<a\s+href\s*=/i.test(text)) { console.error("ERROR: link tag (a+href) found in " + name); process.exit(1); }
}
fs.writeFileSync(path.join(__dirname, 'index.html'), html);

// 公開用：dist/real-crane-game/ に index.html と public/ の中身（favicon・OGP 画像など）を出す。毎回空にしてから書く
const SLUG = 'real-crane-game';
const DIST = path.join(__dirname, 'dist', SLUG);
fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), html);
fs.cpSync(path.join(__dirname, 'public'), DIST, { recursive: true });

// 実際の外部読み込み（src/href 属性、CSS url()、import）だけを検出（ソース内コメントの URL は対象外）
if (/<script[^>]+src=|<link[^>]+href=["']?https?:|(src|href)\s*=\s*["']https?:|url\(\s*["']?https?:|import\s*\(\s*["']https?:/i.test(html)) {
  console.warn('WARNING: external reference found in index.html');
}
console.log(`built index.html (${(html.length / 1024 / 1024).toFixed(2)} MB, three r${threeVersion.split('.')[1]}, ${coreNames.length + modNames.length} exports)`);
