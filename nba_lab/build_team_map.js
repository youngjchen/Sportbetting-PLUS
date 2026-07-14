// nba_lab/build_team_map.js — NBA 30 隊三源對照表（官方↔球探網↔玩運彩）
// 官方=權威鍵(TEAM_ID/tricode/英文全名)；球探網 join 英文全名；玩運彩 join 台式短名字典(未知名回報)
// 輸出: nba_lab/nba_team_map.json
// 用法: node nba_lab/build_team_map.js
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = __dirname;
const R = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

// 玩運彩台式短名 → 官方 tricode（含已知變體；跑完會對 ps_lines.json 實際名單驗證，多退少補）
const PS_NAME = {
  '塞爾提克': 'BOS', '賽爾提克': 'BOS', '塞爾提': 'BOS', '籃網': 'BKN', '尼克': 'NYK', '76人': 'PHI', '暴龍': 'TOR',
  '公牛': 'CHI', '騎士': 'CLE', '活塞': 'DET', '溜馬': 'IND', '公鹿': 'MIL',
  '老鷹': 'ATL', '黃蜂': 'CHA', '熱火': 'MIA', '魔術': 'ORL', '巫師': 'WAS',
  '金塊': 'DEN', '灰狼': 'MIN', '雷霆': 'OKC', '拓荒者': 'POR', '爵士': 'UTA',
  '勇士': 'GSW', '快艇': 'LAC', '湖人': 'LAL', '太陽': 'PHX', '國王': 'SAC',
  '獨行俠': 'DAL', '小牛': 'DAL', '火箭': 'HOU', '灰熊': 'MEM', '鵜鶘': 'NOP', '馬刺': 'SAS'
};

const adv = R('official_advanced.json');           // 30 隊: TEAM_ID, TEAM_NAME
const teamGames = R('official_team_games.json');    // 取 tricode: TEAM_ABBREVIATION
const titanTeams = R('titan_teams.json');           // id, cn, tw, en, cnS, twS, enS

const tricodeOf = {};
for (const r of teamGames) tricodeOf[r.TEAM_ID] = r.TEAM_ABBREVIATION;

const map = [];
const titanByEn = {}; for (const t of titanTeams) titanByEn[t.en.toLowerCase()] = t;
// 球探網英文名修正表（若全名對不上時的別名）
const EN_FIX = { 'la clippers': 'los angeles clippers' };

for (const r of adv) {
  const tri = tricodeOf[r.TEAM_ID];
  let en = r.TEAM_NAME.toLowerCase();
  let titan = titanByEn[en] || titanByEn[EN_FIX[en]] || null;
  if (!titan) { // 寬鬆比對：官方名最後一詞(隊名)出現在 titan en
    const last = en.split(' ').pop();
    titan = titanTeams.find(t => t.en.toLowerCase().includes(last)) || null;
  }
  const psNames = Object.keys(PS_NAME).filter(k => PS_NAME[k] === tri);
  map.push({
    teamId: r.TEAM_ID, tricode: tri, official: r.TEAM_NAME,
    titanId: titan ? titan.id : null, titanCn: titan ? titan.cn : null, titanTw: titan ? titan.tw : null,
    titanTwShort: titan ? titan.twS : null, titanEn: titan ? titan.en : null,
    psNames
  });
}

// 驗證 1: titan 對上 30/30？
const noTitan = map.filter(m => !m.titanId);
// 驗證 2: 玩運彩實際名單（若 ps_lines.json 已存在）全部認得？
let psUnknown = [], psSeen = [];
try {
  const ps = R('ps_lines.json');
  psSeen = ps.names || [];
  psUnknown = psSeen.filter(n => !PS_NAME[n]);
} catch (e) { /* ps 未完成，跳過 */ }

fs.writeFileSync(path.join(OUT, 'nba_team_map.json'), JSON.stringify({ builtAt: new Date().toISOString(), teams: map, psNameDict: PS_NAME }, null, 1));
console.log(`對照表 ${map.length} 隊`);
console.log(`titan 未對上: ${noTitan.length}${noTitan.length ? ' → ' + noTitan.map(m => m.official).join(',') : ' ✅'}`);
console.log(`玩運彩名單 ${psSeen.length} 個, 未知: ${psUnknown.length}${psUnknown.length ? ' → ' + psUnknown.join(',') : ' ✅'}`);
