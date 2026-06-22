/* 驗證 logo-map.js：板子 LEAGUES 的 58 隊全部對得上、檔案存在、編碼正確 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://example.com/' });
global.window = dom.window; global.document = dom.window.document;
require('./logo-map.js');
const TEAM_LOGO = dom.window.TEAM_LOGO;

let pass = 0, fail = 0;
function ok(n, c, g) { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, '→', JSON.stringify(g)); } }

// ---- 從 index.html 抽出 LEAGUES 的隊名（與實檔同步，不另外硬寫）----
const html = fs.readFileSync('index.html', 'utf8');
const block = html.slice(html.indexOf('const LEAGUES'), html.indexOf('const LEAGUES') + 2500);
let teams = [];
[...block.matchAll(/teams:\s*\[([^\]]*)\]/g)].forEach(a => {
  teams = teams.concat([...a[1].matchAll(/"([^"]+)"/g)].map(x => x[1]));
});

console.log('=== 對照完整性 ===');
ok('從 index.html 抽到 58 隊', teams.length === 58, teams.length);

const noMap = teams.filter(t => !TEAM_LOGO[t]);
ok('每隊都有對照 entry', noMap.length === 0, noMap);

const noFile = teams.filter(t => TEAM_LOGO[t] && !fs.existsSync('Logo/' + TEAM_LOGO[t]));
ok('每隊 logo 檔都真實存在', noFile.length === 0, noFile.map(t => [t, TEAM_LOGO[t]]));

console.log('\n=== 對照表無雜質 ===');
const extra = Object.keys(TEAM_LOGO).filter(t => !teams.includes(t));
ok('對照表沒有多餘/打錯的隊名', extra.length === 0, extra);

const badPath = Object.keys(TEAM_LOGO).filter(t => !fs.existsSync('Logo/' + TEAM_LOGO[t]));
ok('對照表每個檔都存在', badPath.length === 0, badPath.map(t => [t, TEAM_LOGO[t]]));

// 三個跨聯盟「樂天」不可對錯
ok('樂天金鷲(日)→Rakuten_eagles', TEAM_LOGO['樂天金鷲'] === 'Rakuten_eagles_insignia.svg', TEAM_LOGO['樂天金鷲']);
ok('樂天巨人(韓)→Lotte_Giants', TEAM_LOGO['樂天巨人'] === 'Lotte_Giants.png', TEAM_LOGO['樂天巨人']);
ok('樂天桃猿(中)→Rakuten_Monkeys', TEAM_LOGO['樂天桃猿'] === 'Rakuten_Monkeys_logo.png', TEAM_LOGO['樂天桃猿']);

console.log('\n=== src 編碼 + 元件 ===');
ok('教士 src 指到正確檔(括號為合法 URL 字元，保留原樣可正常載入)', dom.window.teamLogoSrc('教士') === './Logo/San_Diego_Padres_(2020)_cap_logo.svg', dom.window.teamLogoSrc('教士'));
ok('斗山熊 中文檔名有被編碼', /%[0-9A-F]{2}/i.test(dom.window.teamLogoSrc('斗山熊')), dom.window.teamLogoSrc('斗山熊'));
ok('未知隊 src=null', dom.window.teamLogoSrc('火星人') === null, dom.window.teamLogoSrc('火星人'));

const el = dom.window.teamLogoEl('教士', 44);
ok('教士 元件含 <img>', !!el.querySelector('img'), el.outerHTML.slice(0, 60));
ok('元件 img src 指到 Logo', /\/Logo\//.test(el.querySelector('img').getAttribute('src')), el.querySelector('img').getAttribute('src'));
const elUnknown = dom.window.teamLogoEl('火星人', 40);
ok('未知隊元件退回首字「火」', elUnknown.textContent === '火' && !elUnknown.querySelector('img'), elUnknown.textContent);

console.log('\n結果：' + pass + ' 過 / ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
