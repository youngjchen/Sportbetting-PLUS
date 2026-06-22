/* 驗證 index.html 的 mkLights：固定 5 槽、第 6 盞起變色覆蓋、左右半點擊加減 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://x.com/' });
global.window = dom.window; global.document = dom.window.document;

// 樁掉 mkLights 會呼叫的板子函式
let saved = 0;
const snapshot = () => {}, save = () => { saved++; }, render = () => {}, repackColumns = () => {};

// 從實檔抽出 mkLights（避免與檔案分歧）
const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/function mkLights\(obj\)\{[\s\S]*?\n\}/);
if (!m) { console.log('找不到 mkLights'); process.exit(1); }
eval(m[0]);

let pass = 0, fail = 0;
function ok(n, c, g) { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, '→', JSON.stringify(g)); } }
function tiers(N) {
  const el = mkLights({ lights: N });
  return [].slice.call(el.children).map(d => d.className.replace('lslot ', ''));
}

console.log('=== 固定五槽 + 覆蓋層級 ===');
ok('永遠 5 槽 (N=0)', tiers(0).length === 5, tiers(0));
ok('N=0 全空', tiers(0).join() === 'e,e,e,e,e', tiers(0));
ok('N=3 → 三琥珀兩空', tiers(3).join() === 't1,t1,t1,e,e', tiers(3));
ok('N=5 → 五琥珀', tiers(5).join() === 't1,t1,t1,t1,t1', tiers(5));
ok('N=6 → 第6盞變紅蓋左槽 (t2,t1,t1,t1,t1)', tiers(6).join() === 't2,t1,t1,t1,t1', tiers(6));
ok('N=7 → 紅2+琥珀3', tiers(7).join() === 't2,t2,t1,t1,t1', tiers(7));
ok('N=10 → 全紅', tiers(10).join() === 't2,t2,t2,t2,t2', tiers(10));
ok('N=11 → 紫1+紅4', tiers(11).join() === 't3,t2,t2,t2,t2', tiers(11));
ok('N=12 → 紫2+紅3', tiers(12).join() === 't3,t3,t2,t2,t2', tiers(12));
ok('永遠 5 槽 (N=12)', tiers(12).length === 5, tiers(12).length);

console.log('\n=== 點燈條 = 加燈（減燈已移到隊名，於 optRow 處理）===');
function clickInc(N) {
  const obj = { lights: N };
  const el = mkLights(obj);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return obj.lights;
}
ok('點一下 → +1', clickInc(3) === 4, clickInc(3));
ok('加到上限 12 不超過', clickInc(12) === 12, clickInc(12));
ok('點擊有觸發 save', saved > 0, saved);

console.log('\n結果：' + pass + ' 過 / ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
