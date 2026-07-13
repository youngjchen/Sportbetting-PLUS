/* ============================================================
   占卜附加模組 v3（divination-addon.js）
   UI：快捷鍵列（#zoomctlBtns）一顆「卦」鈕（.fit 同風格）→ 整頁 #divpage（承襲數據回顧樣式/字級）。
   四分頁：起卦（一事一占）/ 機器卦（實驗 L ledger）/ 統計（人vs機、六爻vs梅花，含已完賽命中率）/ 紀錄（人工卦，六爻·梅花分開）。
   鐵則：手動卦＝興趣紀錄（non-experimental），永不進實驗統計；實驗數據只來自排程自動卦。
   結果一律用「隊名＋盤口線」呈現；每筆附可展開的「為什麼是這個結果」說明（世應旺衰／體用生剋）。
   依賴：./lunar.js（UMD）；兩引擎以 fetch+間接eval 隔離載入（頂層 const 撞名，共用全域詞法環境會炸）。
   ============================================================ */
(function () {
  'use strict';
  const V = '20260713a';
  const LS_KEY = 'dvManualCasts';

  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src + '?v=' + V; s.onload = ok; s.onerror = () => no(new Error('load fail ' + src)); document.head.appendChild(s); }); }
  async function loadEngine(src) { const t = await (await fetch(src + '?v=' + V)).text(); (0, eval)(t); }

  const ZHI_WX = { 子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水' };
  const GUA_WX = { 乾: '金', 兌: '金', 離: '火', 震: '木', 巽: '木', 坎: '水', 艮: '土', 坤: '土' };
  // 中文隊名 → MLB teamId（與 mlb_gamepk_join.js 同表）：統計結算直接對 MLB 官方 API，不依賴爬蟲快照
  const TEAM_ID = { 天使: 108, 響尾蛇: 109, 金鶯: 110, 紅襪: 111, 小熊: 112, 紅人: 113, 守護者: 114, 印地安人: 114, 印第安人: 114, 落磯: 115, 老虎: 116, 太空人: 117, 皇家: 118, 道奇: 119, 國民: 120, 大都會: 121, 運動家: 133, 海盜: 134, 教士: 135, 水手: 136, 巨人: 137, 紅雀: 138, 光芒: 139, 遊騎兵: 140, 藍鳥: 141, 雙城: 142, 費城人: 143, 勇士: 144, 白襪: 145, 馬林魚: 146, 洋基: 147, 釀酒人: 158 };
  const MARKETS = ['獨贏', '讓分', '大小'];

  // ---- 結果解析：pregame 快照優先，MLB 官方 API 補漏（比賽一結束即可結算，與板上手動結算/爬蟲頻率脫鉤） ----
  async function resolveOutcomes(casts) {
    const res = {};   // officialId → {finished, as, hs}
    let gmap = {};
    try { (await (await fetch('data/pregame_data.json?nocache=' + Date.now())).json()).forEach(g => { gmap[g.officialId] = g; }); } catch (e) {}
    const pending = [];
    for (const c of casts) {
      if (res[c.officialId]) continue;
      const g = gmap[c.officialId];
      if (g && g.status === 'finished' && g.awayScore != null) res[c.officialId] = { finished: true, as: g.awayScore, hs: g.homeScore };
      else pending.push(c);
    }
    if (pending.length) {
      const dates = [...new Set(pending.map(c => { const ts = Date.parse(c.gameTime.replace(' ', 'T') + ':00+08:00'); return new Date(ts).toISOString().slice(0, 10); }))].slice(0, 6);
      const sched = [];
      for (const d of dates) {
        try { const j = await (await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + d)).json(); (j.dates || []).forEach(dd => (dd.games || []).forEach(g => sched.push(g))); } catch (e) {}
      }
      for (const c of pending) {
        if (res[c.officialId]) continue;
        const aId = TEAM_ID[c.away], hId = TEAM_ID[c.home];
        const ts = Date.parse(c.gameTime.replace(' ', 'T') + ':00+08:00');
        let best = null, bd = Infinity;
        for (const g of sched) {
          if (!g.teams || g.teams.away.team.id !== aId || g.teams.home.team.id !== hId) continue;
          const d = Math.abs(Date.parse(g.gameDate) - ts); if (d < bd) { bd = d; best = g; }
        }
        if (best && bd <= 100 * 60000 && best.status && best.status.abstractGameState === 'Final' && best.teams.away.score != null)
          res[c.officialId] = { finished: true, as: best.teams.away.score, hs: best.teams.home.score };
      }
    }
    return res;
  }

  const css = `
  #divpage{position:fixed;inset:0;z-index:170;background:var(--bg);display:none;flex-direction:column;overflow:hidden}
  #divpage.show{display:flex}
  #divpage .stats-toolbar .dv-exp{margin-left:auto;color:var(--ink-dim);font-size:12.5px;line-height:1.45;text-align:right}
  #divpage .tabbtn.on{border-color:var(--lit);color:var(--lit)}
  #divBody{overflow-y:auto;flex:1}
  .dvp-wrap{max-width:1080px;margin:0 auto;padding:24px clamp(16px,4vw,56px) 48px;width:100%;box-sizing:border-box}
  .dvp-h{font-weight:700;font-size:19px;margin:0 0 6px;color:var(--ink)}
  .dvp-note{color:var(--ink-dim);font-size:13.5px;line-height:1.7;margin:0 0 16px}
  .dvp-lbl{display:block;color:var(--ink-dim);font-size:13.5px;margin:18px 0 8px;letter-spacing:.04em}
  #dv-game{width:100%;padding:12px 14px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;font-size:16px}
  .dv-opts{display:flex;gap:10px;flex-wrap:wrap}
  .dv-opt{padding:10px 18px;border:1px solid var(--line);border-radius:10px;color:var(--ink);cursor:pointer;font-size:15.5px;background:var(--panel)}
  .dv-opt.on{border-color:var(--lit);color:var(--lit);background:var(--panel-2)}
  #dv-go{margin-top:22px;padding:14px 26px;border:none;border-radius:12px;background:var(--lit);color:#1a1206;font-size:18px;font-weight:800;cursor:pointer;letter-spacing:.2em}
  #dv-go:disabled{opacity:.55}
  .dv-card{margin-top:22px;padding:18px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
  .dv-verdict{font-size:30px;font-weight:800;margin:6px 0 10px;color:var(--ink)}
  .dv-dim{color:var(--ink-dim);font-size:14px;line-height:1.7}
  .dv-details{margin-top:14px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);overflow:hidden}
  .dv-details summary{padding:11px 16px;cursor:pointer;color:var(--lit);font-size:14.5px;list-style:none;user-select:none}
  .dv-details summary::-webkit-details-marker{display:none}
  .dv-details summary::before{content:'▸ '}
  .dv-details[open] summary::before{content:'▾ '}
  .dv-details .dv-exp-body{padding:2px 16px 14px;color:var(--ink);font-size:14.5px;line-height:1.9}
  .dv-details .dv-exp-body p{margin:0 0 8px}
  .dv-item{padding:12px 4px;border-bottom:1px solid var(--line);font-size:15.5px;color:var(--ink)}
  .dv-item b{font-size:16px}
  .dv-item .dv-sub{color:var(--ink-dim);font-size:13px;margin-top:3px}
  .dv-empty{color:var(--ink-dim);text-align:center;padding:36px 0;font-size:15px;line-height:1.8}
  .dv-danger{background:none;border:1px solid #6b3a3a;color:#c98;border-radius:10px;padding:9px 16px;cursor:pointer;font-size:13.5px;margin-top:16px}
  .dv-stat{width:100%;border-collapse:collapse;font-size:16.5px;margin:4px 0 12px;color:var(--ink)}
  .dv-stat th,.dv-stat td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
  .dv-stat th:first-child,.dv-stat td:first-child{text-align:left}
  .dv-stat th{color:var(--ink-dim);font-size:13px;font-weight:600;letter-spacing:.04em}
  .dv-stat tr:not(.dv-subrow) td:first-child{font-weight:700;font-size:16px}
  .dv-stat td.hr-high{font-weight:800;font-size:17.5px;color:var(--lit)}
  .dv-stat td.hr-mid{font-weight:700;font-size:17px;color:var(--ink)}
  .dv-stat td.hr-low{font-weight:600;font-size:16.5px;color:var(--ink-dim)}
  .dv-stat td.hr-none{color:var(--ink-dim)}
  .dv-stat tr.dv-subrow td:first-child{color:var(--ink-dim)}
  .dv-htabs{display:flex;gap:8px;margin:10px 0 18px;flex-wrap:wrap}
  .dv-htab{padding:9px 20px;border:1px solid var(--line);border-radius:10px;color:var(--ink-dim);cursor:pointer;font-size:15.5px;background:var(--panel)}
  .dv-htab.on{border-color:var(--lit);color:var(--lit);background:var(--panel-2)}
  .dv-sec{margin:0 0 30px}
  .dv-gt{width:100%;border-collapse:collapse;font-size:15.5px;color:var(--ink);min-width:560px}
  .dv-gt th{color:var(--ink-dim);font-size:12.5px;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  .dv-gt td.dv-c{padding:12px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  .dv-gt tr.dv-grow{cursor:pointer}
  .dv-gt tr.dv-grow:hover td{background:rgba(255,255,255,.035)}
  .dv-t{font-weight:700}
  .dv-none{color:#3a4353}
  .dv-gold{color:var(--lit);font-weight:800;text-shadow:0 0 12px var(--lit-glow)}
  .dv-win{color:#28c76f;font-weight:700}
  .dv-lose{color:#e23b3b;font-weight:700}
  .dv-cnt{color:var(--ink-dim);font-size:11px}
  .dv-dwrap{padding:4px 4px 12px}
  .dv-dcard{margin:8px 0;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
  .dv-del{float:right;background:none;border:1px solid #6b3a3a;color:#c98;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12.5px;margin-left:10px}
  .dv-mask{color:var(--ink-dim);font-size:13px;letter-spacing:.03em}
  #divpage .dv-subrow td{padding-top:4px;padding-bottom:4px;border-bottom:1px dotted var(--line)}
  #divpage .dv-subm{padding-left:16px;color:var(--ink-dim);font-size:13px}
  .dv-anim{margin-top:22px;padding:36px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:16px}
  .dv-coins{display:flex;gap:18px}
  .dv-coin{width:46px;height:46px;border-radius:50%;border:2px solid var(--lit);display:flex;align-items:center;justify-content:center;font-size:19px;color:var(--lit);animation:dvflip .3s linear infinite}
  .dv-coin:nth-child(2){animation-delay:.1s}.dv-coin:nth-child(3){animation-delay:.2s}
  @keyframes dvflip{from{transform:rotateX(0)}to{transform:rotateX(360deg)}}
  .dv-yaostack{display:flex;flex-direction:column-reverse;gap:7px}
  .dv-yao{width:98px;height:10px;border-radius:3px;background:var(--lit);opacity:0;animation:dvyao .18s ease-out forwards}
  .dv-yao.broken{background:linear-gradient(90deg,var(--lit) 0 40%,transparent 40% 60%,var(--lit) 60% 100%)}
  @keyframes dvyao{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
  .dv-animlbl{color:var(--ink-dim);font-size:13.5px;letter-spacing:.14em}
  .dv-glyph{font-size:27px;letter-spacing:.12em;color:var(--ink);margin:2px 0 0}
  .dv-coin.dv-jiao{border-radius:50% 50% 42% 42%}
  #divpage .dv-poem{font-size:17px;line-height:1.85;color:var(--ink);margin:6px 0 10px;letter-spacing:.04em}
  .dv-abstain .dv-verdict{color:var(--ink-dim)}
  .dv-okbadge{display:inline-block;border:1px solid var(--lit);color:var(--lit);border-radius:8px;padding:2px 10px;font-size:12.5px;margin-left:8px}
  .dv-pals{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .dv-pal{padding:9px 14px;border:1px solid var(--line);border-radius:9px;color:var(--ink-dim);font-size:15.5px;letter-spacing:.08em;animation:dvpal .9s steps(1) infinite}
  @keyframes dvpal{0%,15%{color:var(--lit);border-color:var(--lit)}16%,100%{color:var(--ink-dim);border-color:var(--line)}}`;

  let games = [], sel = { game: null, market: '大小', method: '六爻' }, gamesLoaded = false;
  const h = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---- 盤口線字串（讓分：某隊的帶號線） ----
  function teamSpread(g, home) {
    const lh = g && g.lotteryHandicap; if (!lh || lh.line == null) return '';
    const mag = lh.line, signed = home ? (lh.favSide === 'home' ? -mag : +mag) : (lh.favSide === 'away' ? -mag : +mag);
    return ' ' + (signed > 0 ? '+' : '') + signed;
  }
  // ---- 判詞（隊名版） ----
  function verdictDisplay(market, side, g) {
    if (side == null) return '無表態（棄場）';
    if (market === '大小') return side === 0 ? '押 大（＞' + g.lotteryTotal + '）' : '押 小（＜' + g.lotteryTotal + '）';
    if (market === '獨贏') return '押 ' + (side === 0 ? g.homeTeam : g.awayTeam);
    if (market === '讓分') { const home = side === 0; return '押 ' + (home ? g.homeTeam : g.awayTeam) + teamSpread(g, home); }
    return '';
  }

  // ---- 說明文字（為什麼是這個結果） ----
  function explainHTML(e) {
    const c = e.cast; if (!c) return '<p class="dv-dim">（舊版紀錄，無詳解）</p>';
    const homeRep = e.market === '大小' ? '大分' : e.home, awayRep = e.market === '大小' ? '小分' : e.away;
    if (e.method === '求籤') {
      if (c.aborted) return `<p>擲筊求籤過程中，連續五次未得聖杯，插問「弟子是否改日再問」得聖杯 → <b>神示改日，棄場</b>（不代為決定方向）。</p>`;
      const en = c.entry || {};
      const jie = en.officialJie || {};
      const jieRows = Object.entries(jie).map(([k, v]) => `<b>${esc(k)}</b>　${esc(v)}`).join('　｜　');
      const vtxt = c.verdict === '吉' ? ('吉 → 押 ' + esc(homeRep)) : (c.verdict === '凶' ? ('凶 → 押 ' + esc(awayRep)) : '中平／無明確方向 → 棄場');
      return `<p><b>第 ${c.lot} 籤　${esc(en.ganzhi || '')}</b>　<span class="dv-dim">${esc(en.wuxing || '')}</span></p>
      <p class="dv-poem">${(en.poem || []).map(esc).join('<br>')}</p>
      ${jieRows ? `<p>${jieRows}</p>` : ''}
      ${(en.officialStoryTitles && en.officialStoryTitles.length) ? `<p><b>典故</b>　${esc(en.officialStoryTitles.join('、'))}<br><span class="dv-dim">${esc(en.officialStoryGist || '')}</span></p>` : ''}
      <p>本場判讀：<b>${vtxt}</b>　<span class="dv-dim">（依凍結判讀表；此為興趣紀錄，不入實驗統計）</span></p>
      <p class="dv-dim">求籤程序：擲筊 ${esc((c.log || []).join(' '))}</p>`;
    }
    if (e.method === '小六壬') {
      const vtxt = c.verdict === '吉' ? `吉 → 斷 <b>${esc(homeRep)}</b>` : (c.verdict === '凶' ? `凶 → 斷 <b>${esc(awayRep)}</b>` : '空亡＝落空無表態 → <b>棄場</b>（不代為決定方向）');
      return `<p>以起課當下農曆：月 ${c.nMonth}、日 ${c.nDay}、時支序 ${c.nHour}。掌訣三步：正月起大安順數至本月 → <b>月宮 ${esc(c.monthPalace)}</b>（主起因）；月宮上起初一順數至本日 → <b>日宮 ${esc(c.dayPalace)}</b>（主經過）；日宮上起子時順數至本時 → <b>時宮 ${esc(c.palace)}</b>（主結果，成敗以此裁決）。</p>
      <p>時宮 ${esc(c.palace)} 屬「<b>${esc(c.verdict)}</b>」：${vtxt}。</p>
      <p class="dv-dim">時刻起課的本質：同一時辰內對任何比賽起課都得同一宮——它是時間的函數，跟問哪場無關。另提醒：實驗 S 已開盒，小六壬時間盤與信標報數盤在 1.6 萬場回測皆為 null（上行 ≥1.49pp／0.48pp 被排除），此為興趣紀錄。</p>`;
    }
    if (e.method === '六爻') {
      const sw = ZHI_WX[c.shiZhi], yw = ZHI_WX[c.yingZhi], ctx = e.ctx || {};
      let line3;
      if (c.sShi > c.sYing) line3 = `世旺於應 → 斷 <b>${esc(homeRep)}</b>`;
      else if (c.sYing > c.sShi) line3 = `應旺於世 → 斷 <b>${esc(awayRep)}</b>`;
      else line3 = c.tiebreak === '平手棄場' ? '世應同分且互不相剋 → 卦無明確表態，<b>棄場</b>' : `世應同分，以 ${esc(c.tiebreak)} 裁決`;
      return `<p>起出本卦 <b>${esc(c.hexLow)}</b>（下）配 <b>${esc(c.hexUp)}</b>（上）。世爻在第 ${c.shi} 爻（${esc(c.shiZhi)}·${sw}）代表 <b>${esc(homeRep)}</b>；應爻在第 ${c.ying} 爻（${esc(c.yingZhi)}·${yw}）代表 <b>${esc(awayRep)}</b>。</p>
      <p>以月建 ${esc(ctx.monthZhi)}、日辰 ${esc(ctx.dayZhi)} 對世應論旺衰計分：世 ${c.sShi} 分、應 ${c.sYing} 分${c.moving && c.moving.length ? `，動爻第 ${c.moving.join('、')} 爻的生剋已計入` : '（六爻安靜，無動爻）'}。</p>
      <p>${line3}。</p>
      <p class="dv-dim">六爻斷勝負只有「世應強弱」這一條訊號軸。獨贏與讓分若分開起卦＝兩次獨立抽卦，本來就約一半機率給出不同的隊——不是矛盾，是隨機。</p>`;
    }
    const tG = c['體卦'], yG = c['用卦'], tw = GUA_WX[tG], yw = GUA_WX[yG];
    const relMean = { '體克用': `體(${tw})剋用(${yw})，己方壓制對方`, '用克體': `用(${yw})剋體(${tw})，對方壓制己方`, '用生體': `用(${yw})生體(${tw})，對方來助己方`, '體生用': `體(${tw})生用(${yw})，己方耗洩於對方`, '比和': `體用同為 ${tw}，勢均力敵` }[c.relation] || '';
    const last = c.relation === '比和' ? '原典斷比和為吉但不分勝負；本實驗定為 <b>棄場</b>（無方向）' : `故斷 <b>${esc(c.pick === '體' ? homeRep : awayRep)}</b>`;
    return `<p>上卦 <b>${esc(c['上卦'])}</b>、下卦 <b>${esc(c['下卦'])}</b>，動第 ${c.moving} 爻 → 體卦 <b>${esc(tG)}</b>（${tw}）代表 <b>${esc(homeRep)}</b>、用卦 <b>${esc(yG)}</b>（${yw}）代表 <b>${esc(awayRep)}</b>。</p>
    <p>兩卦關係為「<b>${esc(c.relation)}</b>」：${relMean}。</p><p>${last}。</p>
    <p class="dv-dim">梅花以體用生剋定方向，同樣只有一條訊號軸；不同市場分開起卦可能不一致，屬獨立隨機。</p>`;
  }

  // ---- 已完賽命中判定（興趣統計用；.5 線無和局；o=resolveOutcomes 的結果） ----
  function hitOf(e, o) {
    if (e.side == null || !o || !o.finished) return null;
    const as = o.as, hs = o.hs;
    if (e.market === '大小') { if (e.totLine == null) return null; const t = as + hs; if (t === e.totLine) return null; return ((e.side === 0) === (t > e.totLine)) ? 1 : 0; }
    if (e.market === '獨贏') { if (as === hs) return null; return ((e.side === 0) === (hs > as)) ? 1 : 0; }
    if (e.market === '讓分') { if (e.hdLine == null || !e.hdFav) return null; const hSigned = e.hdFav === 'home' ? -e.hdLine : e.hdLine; const cov = (hs - as) + hSigned; if (cov === 0) return null; return ((e.side === 0) === (cov > 0)) ? 1 : 0; }
    return null;
  }
  // ---- 格內短判詞（一場一排用） ----
  function shortVerdict(e) {
    if (e.side == null) return '無表態';
    if (e.market === '大小') return e.side === 0 ? '大' : '小';
    if (e.market === '獨贏') return e.side === 0 ? e.home : e.away;
    const home = e.side === 0, team = home ? e.home : e.away;
    let sp = '';
    if (e.hdLine != null) { const s = home ? (e.hdFav === 'home' ? -e.hdLine : e.hdLine) : (e.hdFav === 'away' ? -e.hdLine : e.hdLine); sp = (s > 0 ? '+' : '') + s; }
    return team + sp;
  }

  async function fetchGames() {
    try {
      const arr = await (await fetch('data/pregame_data.json?nocache=' + Date.now())).json();
      const now = Date.now();
      games = arr.filter(g => g.league === 'MLB' && g.status !== 'finished' && g.date && g.time)
        .map(g => ({ ...g, ts: Date.parse(g.date + 'T' + g.time + ':00+08:00') }))
        .filter(g => g.ts > now - 2 * 3600e3).sort((a, b) => a.ts - b.ts).slice(0, 40);
    } catch (e) { games = []; }
    const s = document.getElementById('dv-game');
    s.innerHTML = games.length ? games.map((g, i) => `<option value="${i}">${g.date.slice(5)} ${g.time}　${esc(g.awayTeam)}＠${esc(g.homeTeam)}${g.lotteryTotal != null ? '　大小' + g.lotteryTotal : ''}${g.lotteryHandicap && g.lotteryHandicap.line != null ? '　' + (g.lotteryHandicap.favSide === 'away' ? '客' : '主') + '讓' + g.lotteryHandicap.line : ''}</option>`).join('') : '<option value="">（目前無未開打賽事）</option>';
    sel.game = games.length ? games[0] : null;
  }

  async function entropy18(tag) {
    let src, hex;
    try { const p = (await (await fetch('https://beacon.nist.gov/beacon/2.0/pulse/last', { signal: AbortSignal.timeout(6000) })).json()).pulse; hex = p.outputValue; src = 'NIST ' + p.timeStamp; }
    catch (e) { const u = new Uint8Array(32); crypto.getRandomValues(u); hex = [...u].map(x => x.toString(16).padStart(2, '0')).join(''); src = '瀏覽器 CSPRNG'; }
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hex + '|' + tag + '|' + Date.now())));
    const bits = []; for (let i = 0; i < 18; i++) bits.push((d[i >> 3] >> (7 - (i & 7))) & 1);
    return { bits, src };
  }

  // 手動求籤儀式（瀏覽器 CSPRNG；手動卦非實驗，不需 HMAC 可驗證性）：允筊3聖→抽籤(拒絕采樣)→確筊3聖；連5非聖插問改日=棄場。同 qiuqian_engine.js 邏輯。
  function qiuqianManualRitual() {
    let pool = [], pi = 0;
    const grow = () => { const u = new Uint8Array(32); crypto.getRandomValues(u); for (const b of u) for (let k = 7; k >= 0; k--) pool.push((b >> k) & 1); };
    const bits = n => { while (pi + n > pool.length) grow(); let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | pool[pi++]; return v; };
    const jiao = () => { const v = bits(2); return v <= 1 ? '聖' : (v === 2 ? '笑' : '陰'); };
    const stage = (need, tag) => { let sheng = 0, run = 0, log = []; while (sheng < need) { const t = jiao(); log.push(tag + t); if (t === '聖') { sheng++; run = 0; } else if (++run >= 5) { const m = jiao(); log.push(tag + '改?' + m); if (m === '聖') return { aborted: true, log }; run = 0; } } return { aborted: false, log }; };
    const yun = stage(3, '允'); if (yun.aborted) return { aborted: 'oracle-yun', log: yun.log };
    let lot; for (;;) { const v = bits(6); if (v < 60) { lot = v + 1; break; } }
    const que = stage(3, '確'); if (que.aborted) return { aborted: 'oracle-que', lot, log: yun.log.concat(que.log) };
    return { aborted: null, lot, log: yun.log.concat(que.log) };
  }

  // 一事不二問防呆：同場＋同市場＋同起卦法已占過（含棄場）→ 鎖起卦鈕
  function alreadyCast() {
    if (!sel.game) return false;
    try { const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      return list.some(e => e.officialId === sel.game.officialId && e.market === sel.market && e.method === sel.method);
    } catch (_) { return false; }
  }
  function refreshGoState() {
    const btn = document.getElementById('dv-go'); if (!btn) return;
    if (!sel.game) { btn.disabled = true; btn.textContent = '起　卦'; return; }
    if (alreadyCast()) { btn.disabled = true; btn.textContent = '此場此法已占（一事不二問）'; }
    else { btn.disabled = false; btn.textContent = '起　卦'; }
  }
  async function doCast() {
    if (!sel.game || alreadyCast()) return;
    const g = sel.game, market = sel.market, btn = document.getElementById('dv-go');
    btn.disabled = true; btn.textContent = '起卦中…';
    try {
      const t = new Date();
      let cast, side, src, ctx = null;
      if (sel.method === '六爻') {
        ctx = window.LiuyaoEngine.zhiContext(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        const e = await entropy18(g.officialId + '|' + market); src = e.src;
        cast = window.LiuyaoEngine.castFromBacks(window.LiuyaoEngine.bitsToBacks(e.bits), ctx.monthZhi, ctx.dayZhi);
        side = cast.winner === null ? null : (cast.winner === '世' ? 0 : 1);
      } else if (sel.method === '梅花') {
        cast = window.MeihuaEngine.castFromTaipei(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        side = cast.relation === '比和' ? null : (cast.pick === '體' ? 0 : 1); src = '時間起卦　' + cast.lunarText;
      } else if (sel.method === '小六壬') { // 掌訣時刻起課：農曆(月+日+時−3)%6 → 時宮吉凶（實驗 S 同式；曆法同梅花凍結層）
        const n = window.MeihuaEngine.numbersFromTaipei(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        const P = ['大安', '留連', '速喜', '赤口', '小吉', '空亡'];
        const JI6 = { 大安: '吉', 留連: '凶', 速喜: '吉', 赤口: '凶', 小吉: '吉', 空亡: '空亡' };
        const idx = (((n.nMonth + n.nDay + n.nHour - 3) % 6) + 6) % 6;
        const palace = P[idx], vd = JI6[palace];
        side = vd === '吉' ? 0 : (vd === '凶' ? 1 : null);   // 吉→大/主、凶→小/客；空亡→棄場
        cast = { xlr: true, palace, verdict: vd, nMonth: n.nMonth, nDay: n.nDay, nHour: n.nHour, monthPalace: P[(((n.nMonth - 1) % 6) + 6) % 6], dayPalace: P[(((n.nMonth + n.nDay - 2) % 6) + 6) % 6] };
        src = '掌訣時刻起課　' + n.lunarText;
      } else { // 求籤（六十甲子）：瀏覽器儀式抽籤 → 查凍結籤詩庫與判讀表
        const db = window.__qiuqianDB, tabs = window.__qiuqianTables;
        if (!db) throw new Error('籤詩庫尚未載入，請稍候再試');
        const r = qiuqianManualRitual();
        if (r.aborted) { side = null; cast = { qiuqian: true, aborted: r.aborted, log: r.log }; src = '求籤·擲筊（神示改日）'; }
        else {
          const en = db.entries.find(x => x.n === r.lot) || null;
          let vd = null;
          if (tabs) { const l3 = tabs.layer3 && tabs.layer3.byLot[r.lot], l1 = tabs.layer1 && tabs.layer1.byLot[r.lot]; vd = (l3 && l3.verdict) || (l1 && l1.verdict) || null; }
          side = vd === '吉' ? 0 : (vd === '凶' ? 1 : null);   // 吉→大/主、凶→小/客（同 directionFor；中平→棄）
          cast = { qiuqian: true, lot: r.lot, entry: en, verdict: vd, log: r.log }; src = '求籤　第' + r.lot + '籤 ' + (en ? en.ganzhi : '');
        }
      }
      const entry = {
        ts: new Date().toISOString(), officialId: g.officialId, matchup: g.awayTeam + '＠' + g.homeTeam,
        away: g.awayTeam, home: g.homeTeam, gameTime: g.date + ' ' + g.time, market, method: sel.method,
        side, source: src, verdict: verdictDisplay(market, side, g), cast, ctx,
        totLine: g.lotteryTotal != null ? g.lotteryTotal : null,
        hdFav: g.lotteryHandicap ? g.lotteryHandicap.favSide : null, hdLine: g.lotteryHandicap ? g.lotteryHandicap.line : null,
        nonExperimental: true,
      };
      const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); list.unshift(entry); localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 300)));
      // 起卦動畫（純 CSS，~1.15s）→ 結果卡帶「起卦完成 ✓ 時:分:秒」戳與卦象字符——三市場連占、全棄場也能一眼確認每一卦都真的起過
      const TRI = { 乾: '☰', 兌: '☱', 離: '☲', 震: '☳', 巽: '☴', 坎: '☵', 艮: '☶', 坤: '☷' };
      let glyph;
      if (sel.method === '六爻') glyph = (TRI[cast.hexUp] || esc(cast.hexUp || '')) + (TRI[cast.hexLow] || esc(cast.hexLow || '')) + (cast.moving && cast.moving.length ? '　動' + cast.moving.join('·') : '　六爻安靜');
      else if (sel.method === '梅花') glyph = (TRI[cast['上卦']] || '') + (TRI[cast['下卦']] || '') + '　動' + cast.moving;
      else if (sel.method === '小六壬') glyph = '時宮　' + cast.palace;
      else glyph = cast.aborted ? '⤫ 神示改日（棄場）' : ('第 ' + cast.lot + ' 籤　' + (cast.entry ? esc(cast.entry.ganzhi) : ''));
      const stamp = t.toTimeString().slice(0, 8);
      const anim = sel.method === '六爻'
        ? `<div class="dv-anim"><div class="dv-coins"><div class="dv-coin">錢</div><div class="dv-coin">錢</div><div class="dv-coin">錢</div></div><div class="dv-animlbl">三錢六擲中…</div></div>`
        : sel.method === '梅花'
        ? `<div class="dv-anim"><div class="dv-yaostack">${[0, 1, 2, 3, 4, 5].map(i => `<div class="dv-yao${i % 3 === 1 ? ' broken' : ''}" style="animation-delay:${(i * 0.16).toFixed(2)}s"></div>`).join('')}</div><div class="dv-animlbl">梅花起卦中…</div></div>`
        : sel.method === '小六壬'
        ? `<div class="dv-anim"><div class="dv-pals">${['大安', '留連', '速喜', '赤口', '小吉', '空亡'].map((p, i) => `<span class="dv-pal" style="animation-delay:${(i * 0.15).toFixed(2)}s">${p}</span>`).join('')}</div><div class="dv-animlbl">月上起日、日上起時…</div></div>`
        : `<div class="dv-anim"><div class="dv-coins"><div class="dv-coin dv-jiao">筊</div><div class="dv-coin dv-jiao" style="animation-delay:.12s">筊</div></div><div class="dv-animlbl">擲筊求籤中…</div></div>`;
      const resultHTML =
        `<div class="dv-card${side == null ? ' dv-abstain' : ''}"><div class="dv-dim">${esc(entry.matchup)}　${esc(entry.gameTime)}　${market}｜${sel.method}<span class="dv-okbadge">起卦完成 ✓ ${stamp}</span></div>
         <div class="dv-glyph">${glyph}</div>
         <div class="dv-verdict">${esc(entry.verdict)}</div>
         <div class="dv-dim">隨機源：${esc(entry.source)}　｜　※ 興趣紀錄，不入實驗統計</div>
         <details class="dv-details"><summary>為什麼是這個結果？</summary><div class="dv-exp-body">${explainHTML(entry)}</div></details></div>`;
      document.getElementById('dv-result').innerHTML = anim;
      setTimeout(() => { document.getElementById('dv-result').innerHTML = resultHTML; refreshGoState(); }, 1150);   // 起卦後鎖此場此法
      return;
    } catch (e) { document.getElementById('dv-result').innerHTML = `<div class="dv-card">起卦失敗：${esc(e.message)}</div>`; }
    refreshGoState();
  }

  async function renderAuto() {
    const box = document.getElementById('dv-p-auto'); box.innerHTML = '<div class="dvp-wrap"><div class="dv-empty">載入中…</div></div>';
    try {
      const arr = await (await fetch('data/liuyao_casts.json?nocache=' + Date.now())).json();
      const main = arr.filter(e => !e.market);   // v1.3 起 ledger 混有獨贏/讓分 exploratory 條目（e.market），本區只列 confirmatory 大小分
      const xN = arr.length - main.length;
      const rows = main.slice(-60).reverse().map(e => e.failedAt
        ? `<div class="dv-item">⚠ beacon 失敗<div class="dv-sub">${esc(String(e.failedAt).slice(5, 16))}</div></div>`
        : e.missedWindow
        ? `<div class="dv-item"><b>漏卦（棄場留痕）</b>　${esc(e.matchup || e.gamePk)}<div class="dv-sub">開打 ${esc(String(e.gameTimeUTC).slice(5, 16))}Z｜排程未在窗口內起卦，依附錄規則棄場${e.reason ? '｜' + esc(e.reason) : ''}</div></div>`
        : `<div class="dv-item"><b>${e.pick ? '押 ' + e.pick + '分' : '棄場'}</b>　${esc(e.matchup || e.gamePk)}<div class="dv-sub">起卦 ${esc(String(e.castAt).slice(5, 16))}Z｜世${e.shi}${esc(e.shiZhi)}(${e.sShi}) vs 應${e.ying}${esc(e.yingZhi)}(${e.sYing})｜beacon ${esc(String(e.beaconTS).slice(5, 16))}｜${esc(e.phase)}</div></div>`).join('');
      let qHtml;
      try {
        const qarr = await (await fetch('data/qiuqian_casts.json?nocache=' + Date.now())).json();
        const MK = { totals: '大小', ml: '獨贏', hd: '讓分' };
        const qRows = qarr.slice(-45).reverse().map(e => e.failedAt
          ? `<div class="dv-item">⚠ beacon 失敗<div class="dv-sub">${esc(String(e.failedAt).slice(5, 16))}</div></div>`
          : e.missedWindow
          ? `<div class="dv-item"><b>漏籤（棄場留痕）</b>　${esc(e.matchup || e.gamePk)}［${MK[e.market] || esc(e.market)}］<div class="dv-sub">開打 ${esc(String(e.gameTimeUTC).slice(5, 16))}Z｜窗口已過未起籤</div></div>`
          : e.aborted
          ? `<div class="dv-item"><b>棄場（神示改日）</b>　${esc(e.matchup || e.gamePk)}［${MK[e.market] || esc(e.market)}］<div class="dv-sub">起籤 ${esc(String(e.castAt).slice(5, 16))}Z｜${e.aborted === 'oracle-yun' ? '允筊' : '確筊'}階段連五非聖後插問得聖｜beacon ${esc(String(e.beaconTS).slice(5, 16))}</div></div>`
          : `<div class="dv-item"><b>已起籤 ✓</b>　${esc(e.matchup || e.gamePk)}［${MK[e.market] || esc(e.market)}］<div class="dv-sub">起籤 ${esc(String(e.castAt).slice(5, 16))}Z｜<span class="dv-mask">🔒 籤號與判讀遮蔽至開盒</span>｜beacon ${esc(String(e.beaconTS).slice(5, 16))}｜${esc(e.phase)}</div></div>`).join('');
        qHtml = qRows || '<div class="dv-empty">排程尚未產生籤——第一批將在下一個比賽日窗口出現</div>';
      } catch (e) { qHtml = '<div class="dv-empty">排程尚未產生籤（ledger 檔尚未建立）</div>'; }
      let sHtml;
      try {
        const sArr = await (await fetch('data/xiaoliuren_casts.json?nocache=' + Date.now())).json();
        const pk = (p, pal) => p ? `押 ${p}（${pal}）` : `棄場（${pal}·空亡）`;
        sHtml = sArr.slice(-45).reverse().map(e =>
          `<div class="dv-item"><b>時盤 ${pk(e.timePicks && e.timePicks.totals, e.timePalace)}｜數盤 ${e.randStatus === 'cast' ? pk(e.randPicks && e.randPicks.totals, e.randPalace) : (e.randStatus === 'missedPulse' ? '信標斷檔（棄場留痕）' : esc(e.randStatus))}</b>　${esc(e.matchup || e.gamePk)}<div class="dv-sub">卜 ${esc(String(e.castAt).slice(5, 16))}Z｜錨 ${esc(String(e.anchorUtc).slice(5, 16))}Z（開賽−240 分）｜${esc(e.phase)}</div></div>`).join('')
          || '<div class="dv-empty">排程尚未產生卦——第一批將在下一個比賽日窗口出現</div>';
      } catch (e) { sHtml = '<div class="dv-empty">排程尚未產生卦（ledger 檔尚未建立）</div>'; }
      box.innerHTML = `<div class="dvp-wrap"><div class="dvp-h">機器卦（實驗 L・六爻・大小分）</div>
        <div class="dvp-note">排程在每場開打前 40–180 分鐘自動搖卦（NIST 隨機信標），一場一卦永不重抽；錯過窗口的比賽記「漏卦」棄場留痕。2026 剩餘賽季＝試車；2027 全季＝正式樣本，季後才開盒。${xN ? `另有 v1.3 獨贏/讓分 exploratory 卦 ${xN} 筆（遮蔽中，不列示）。` : ''}</div>${rows || '<div class="dv-empty">排程尚未產生卦——第一批將在下一個比賽日窗口出現</div>'}
        <div class="dvp-h" style="margin-top:36px">機器籤（實驗 Q・六十甲子籤・三市場）</div>
        <div class="dvp-note">照北港朝天宮官方線上求籤程序機械執行：允筊三聖杯 → 抽籤 → 確筊三聖杯；任一筊階段連五非聖即插問「弟子是否改日再問」，得聖＝棄場留痕。籤號與判讀遮蔽至開盒（協議 §9 同 L）。</div>${qHtml}
        <div class="dvp-h" style="margin-top:36px">機器小六壬（實驗 S・前瞻・雙臂）</div>
        <div class="dvp-note">凍結後 out-of-sample 累積：每場以「開賽前 240 分」為錨，時盤＝該刻農曆掌訣起課、數盤＝該刻 NIST 信標脈衝報數起課，一場一卦永不重卜；此處列大小分主檢方向（讓分／獨贏為同宮投影）。<b>回測 1.6 萬場已開盒＝雙臂 null</b>（RESULTS_S_v1）；前瞻命中率統計遮蔽至申報分析日，卦象本身公開（repo 有時間戳公證）。</div>${sHtml}</div>`;
    } catch (e) { box.innerHTML = '<div class="dvp-wrap"><div class="dvp-h">機器卦</div><div class="dv-empty">排程尚未產生卦（ledger 檔尚未建立）</div></div>'; }
  }

  function statBlock(title, casts, res) {
    const n = casts.length, ab = casts.filter(e => e.side == null).length;
    let settled = 0, hit = 0;
    casts.forEach(e => { const o = hitOf(e, res[e.officialId]); if (o != null) { settled++; hit += o; } });
    const hr = settled ? (100 * hit / settled).toFixed(1) + '%' : '—';
    const hrCls = settled ? (hit / settled >= 0.6 ? 'hr-high' : (hit / settled >= 0.5 ? 'hr-mid' : 'hr-low')) : 'hr-none';
    return `<tr><td>${esc(title)}</td><td>${n}</td><td>${ab}</td><td>${settled}</td><td>${settled ? hit + '／' + settled : '—'}</td><td class="${hrCls}">${hr}</td></tr>`;
  }
  // Q3：一個 method 展開為「總＋三市場」四列（獨贏/讓分/大小分開看命中率）
  function statRows(title, casts, res) {
    const rows = [['', title, true]].concat(MARKETS.map(mk => [mk, '└ ' + mk, false]));
    return rows.map(([mk, lbl, main]) => {
      const arr = mk ? casts.filter(e => e.market === mk) : casts;
      const n = arr.length, ab = arr.filter(e => e.side == null).length;
      let settled = 0, hit = 0;
      arr.forEach(e => { const o = hitOf(e, res[e.officialId]); if (o != null) { settled++; hit += o; } });
      const hr = settled ? (100 * hit / settled).toFixed(1) + '%' : '—';
      const hrCls = settled ? (hit / settled >= 0.6 ? 'hr-high' : (hit / settled >= 0.5 ? 'hr-mid' : 'hr-low')) : 'hr-none';
      const c = main ? '' : ' class="dv-subrow"';
      return `<tr${c}><td>${main ? esc(title) : '<span class="dv-subm">' + esc(lbl) + '</span>'}</td><td>${n}</td><td>${ab}</td><td>${settled}</td><td>${settled ? hit + '／' + settled : '—'}</td><td class="${hrCls}">${hr}</td></tr>`;
    }).join('');
  }
  // 共識（多法同讖）命中率：同場同市場，六爻/梅花/求籤中最新卦「≥2 法同向」＝一個共識選向；看多法同讖準不準。
  function consensusStats(list, res) {
    const latest = {};
    list.forEach((e, i) => { const k = e.method + '|' + e.officialId + '|' + e.market; if (!(k in latest)) latest[k] = i; });
    const bySlot = {};
    for (const k in latest) { const e = list[latest[k]]; if (e.side == null) continue; const slot = e.officialId + '|' + e.market; (bySlot[slot] = bySlot[slot] || []).push(e); }
    const mk = () => ({ n: 0, settled: 0, hit: 0 });
    const out = { all: mk(), market: { 獨贏: mk(), 讓分: mk(), 大小: mk() }, three: mk(), two: mk() };
    for (const slot in bySlot) {
      const casts = bySlot[slot];
      const sideCount = {}; casts.forEach(e => sideCount[e.side] = (sideCount[e.side] || 0) + 1);
      let side = null, cnt = 0; for (const s in sideCount) { if (sideCount[s] > cnt) { cnt = sideCount[s]; side = s; } }
      if (cnt < 2) continue;                                    // 少於兩法同向＝無共識
      const rep = casts.find(e => String(e.side) === String(side));
      const o = hitOf(rep, res[rep.officialId]);
      const bump = b => { b.n++; if (o != null) { b.settled++; b.hit += o; } };
      bump(out.all); bump(out.market[rep.market] || (out.market[rep.market] = mk()));
      bump(cnt >= 3 ? out.three : out.two);
    }
    return out;
  }
  function consRow(lbl, b, sub) {
    const hr = b.settled ? (100 * b.hit / b.settled).toFixed(1) + '%' : '—';
    const cls = b.settled ? (b.hit / b.settled >= 0.6 ? 'hr-high' : (b.hit / b.settled >= 0.5 ? 'hr-mid' : 'hr-low')) : 'hr-none';
    return `<tr${sub ? ' class="dv-subrow"' : ''}><td>${sub ? '<span class="dv-subm">└ ' + esc(lbl) + '</span>' : '<b>' + esc(lbl) + '</b>'}</td><td>${b.n}</td><td>${b.settled}</td><td>${b.settled ? b.hit + '／' + b.settled : '—'}</td><td class="${cls}">${hr}</td></tr>`;
  }

  async function renderStats() {
    const box = document.getElementById('dv-p-stats'); box.innerHTML = '<div class="dvp-wrap"><div class="dv-empty">計算中（即時對 MLB 官方結果結算）…</div></div>';
    const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    const res = await resolveOutcomes(list);
    const liu = list.filter(e => e.method === '六爻'), mei = list.filter(e => e.method === '梅花'), qiu = list.filter(e => e.method === '求籤'), xlr = list.filter(e => e.method === '小六壬');
    let machine = { n: 0, ab: 0, big: 0, missed: 0 };
    try { const arr = await (await fetch('data/liuyao_casts.json?nocache=' + Date.now())).json(); arr.forEach(e => { if (e.failedAt) return; if (e.market) return; /* v1.3 exploratory 另冊，不入本表 */ if (e.missedWindow) { machine.missed++; return; } machine.n++; if (e.pick == null) machine.ab++; else if (e.pick === '大') machine.big++; }); } catch (e) {}
    let mS = null;
    try { const sArr = await (await fetch('data/xiaoliuren_casts.json?nocache=' + Date.now())).json(); mS = { n: 0, tAb: 0, rMiss: 0 }; sArr.forEach(e => { mS.n++; if (e.timeVerdict === '空亡') mS.tAb++; if (e.randStatus !== 'cast') mS.rMiss++; }); } catch (e) {}
    const mDec = machine.n - machine.ab, mBig = mDec ? (100 * machine.big / mDec).toFixed(1) + '%' : '—';
    const cs = consensusStats(list, res);
    box.innerHTML = `<div class="dvp-wrap">
      <div class="dvp-h">興趣統計（人 vs 機器）</div>
      <div class="dvp-note">手動卦是興趣紀錄，不入實驗；此處純為好玩。命中率<b>即時對 MLB 官方結果結算</b>（比賽結束數分鐘內生效，與板上手動結算、爬蟲快照無關）；樣本通常很小，僅供參考。</div>
      <div class="dv-sec"><table class="dv-stat"><thead><tr><th>來源</th><th>起卦數</th><th>棄場</th><th>已完賽</th><th>命中</th><th>命中率</th></tr></thead><tbody>
        ${statRows('人・六爻搖卦', liu, res)}
        ${statRows('人・梅花起卦', mei, res)}
        ${statRows('人・求籤', qiu, res)}
        ${statRows('人・小六壬', xlr, res)}
        <tr><td>機器・六爻（實驗 L）</td><td>${machine.n}</td><td>${machine.ab}</td><td colspan="3" class="dv-mask">🔒 遮蔽至開盒（協議 §9，2027 季後）</td></tr>
        ${mS ? `<tr><td>機器・小六壬（實驗 S 前瞻）</td><td>${mS.n}</td><td>${mS.tAb}</td><td colspan="3" class="dv-mask">🔒 命中率遮蔽至申報分析日（回測已開盒＝雙臂 null）</td></tr>` : ''}
      </tbody></table><div class="dvp-note" style="margin-top:8px">三市場（獨贏／讓分／大小）分開列命中率——手動卦樣本小，各市場再拆更小，看看即可，統計上不可推論。</div></div>
      <div class="dvp-h" style="font-size:16px">共識（多法同讖）命中率</div>
      <div class="dvp-note">只算「同場同市場，六爻／梅花／求籤／小六壬中<b>≥2 法最新卦同向</b>」的共識選向——多法同時指同一邊時，準不準。棄場不算；命中率即時對 MLB 官方結果。實驗 S 開盒的跨臂數據先打預防針：兩臂同向率 52.07%＝獨立隨機理論值、同向場命中 50.28%＝共識不加分。</div>
      <div class="dv-sec"><table class="dv-stat"><thead><tr><th>共識選向</th><th>共識數</th><th>已完賽</th><th>命中</th><th>命中率</th></tr></thead><tbody>
        ${consRow('全部共識', cs.all)}
        ${consRow('獨贏', cs.market['獨贏'], true)}
        ${consRow('讓分', cs.market['讓分'], true)}
        ${consRow('大小', cs.market['大小'], true)}
        ${consRow('≥3 法同', cs.three)}
        ${consRow('2 法同', cs.two)}
      </tbody></table>
      <div class="dvp-note" style="margin-top:8px">獨立隨機來源就算「同向」也還是隨機——三法同源同引擎、同向約半數機率；共識命中率高<b>不代表</b>有預測力，小樣本尤其別當真。</div></div>
      <div class="dvp-h" style="font-size:16px">押向分布</div>
      <div class="dvp-note">機器六爻押大率 ${mBig}（有表態 ${mDec} 卦${machine.missed ? '；另漏卦 ' + machine.missed + ' 場棄場留痕' : ''}）。理論值：六爻押大約 51.8%、棄場約 12.6%；小六壬時間盤押大 60.07%、報數盤 60% 整、空亡棄場約 1/6（回測認證）。</div>
      <div class="dvp-note">🔒 <b>機器卦命中率為什麼不顯示？</b>不是故障——凍結協議 §9 明文「命中率對照在分析日前遮蔽」（分析日＝2027 季後）。即時盯命中率會誘發偷看、中途起念改規則，正是當初審核堵掉的漏洞；試車期照樣遮，養成乾淨習慣。手動卦不受此限（本來就不入實驗）。</div>
      <div class="dv-sec dv-dim" style="line-height:1.9">
        <p><b>專業提醒（不是討好）：</b></p>
        <p>1. 人的六爻和機器的六爻用的是<b>同一支引擎、同一種隨機品質</b>，差別只在起卦時刻。理論上兩者押向分布應該一致；若看到差異，在樣本小的時候<b>純屬隨機</b>，不代表「人比較準」或「機器比較準」。</p>
        <p>2. 梅花和六爻是不同系統，分布本就不同（梅花約 54.7% 押大），不能直接比高下。</p>
        <p>3. 命中率要等比賽打完才有意義，而且手動卦樣本太小、又是想到才占（選擇性occasion），統計上不可推論。<b>唯一有推論力的是機器卦的 2027 正式樣本。</b></p>
        <p>4. 提醒你已知的結論：梅花在 1.6 萬場回測是<b>乾淨的 null（不準）</b>；小六壬雙臂（時間盤＋信標報數盤）也在 1.6 萬場開盒為 <b>null</b>（上行 ≥1.49pp／0.48pp 被排除，讓分獨贏 exploratory 亦 null）；六爻的強先驗也是 null。這個統計頁看看分布可以，別拿來下注。</p>
      </div></div>`;
  }

  async function renderHist() {
    const box = document.getElementById('dv-p-hist');
    box.innerHTML = '<div class="dvp-wrap"><div class="dv-empty">整理中…</div></div>';
    const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');   // unshift 序：越前越新
    const res = await resolveOutcomes(list);
    const latest = {}, counts = {};
    list.forEach((e, i) => { const k = e.method + '|' + e.officialId + '|' + e.market; if (!(k in latest)) latest[k] = i; counts[k] = (counts[k] || 0) + 1; });
    // 金字：同場同市場，三法（六爻/梅花/求籤）最新卦中，任兩法以上有表態且同向 → 同向那幾法標金字（棄場不算）
    const gold = new Set();
    const bySlot = {};
    for (const k in latest) {
      const e = list[latest[k]]; if (e.side == null) continue;
      const parts = k.split('|'); const slot = parts[1] + '|' + parts[2];   // officialId|market
      (bySlot[slot] = bySlot[slot] || []).push({ side: e.side, key: k });
    }
    for (const slot in bySlot) {
      const sideCount = {};
      bySlot[slot].forEach(x => sideCount[x.side] = (sideCount[x.side] || 0) + 1);
      bySlot[slot].forEach(x => { if (sideCount[x.side] >= 2) gold.add(x.key); });   // 該向有≥2法 → 標金字
    }
    const section = (method, title) => {
      const games = {};
      list.forEach(e => { if (e.method !== method || games[e.officialId]) return; games[e.officialId] = { away: e.away, home: e.home, gameTime: e.gameTime, oid: e.officialId, ts: Date.parse(e.gameTime.replace(' ', 'T') + ':00+08:00') }; });
      const rows = Object.values(games).sort((a, b) => b.ts - a.ts).map(g => {
        const cells = MARKETS.map(mk => {
          const k = method + '|' + g.oid + '|' + mk;
          if (!(k in latest)) return '<td class="dv-c dv-none">—</td>';
          const e = list[latest[k]], hit = hitOf(e, res[e.officialId]);
          const mark = hit == null ? '' : (hit ? ' <span class="dv-win">✓</span>' : ' <span class="dv-lose">✗</span>');
          const cnt = counts[k] > 1 ? ` <span class="dv-cnt">×${counts[k]}</span>` : '';
          return `<td class="dv-c${gold.has(k) ? ' dv-gold' : ''}">${esc(shortVerdict(e))}${mark}${cnt}</td>`;
        });
        return `<tr class="dv-grow" data-oid="${esc(g.oid)}" data-m="${method}"><td class="dv-c dv-t">${esc(g.away)}＠${esc(g.home)}<div class="dv-sub">${esc(g.gameTime.slice(5))}</div></td>${cells.join('')}</tr>` +
          `<tr class="dv-detail" data-for="${esc(g.oid)}|${method}" style="display:none"><td colspan="4"><div class="dv-dwrap"></div></td></tr>`;
      }).join('');
      return `<div class="dv-sec"><div class="dvp-h" style="font-size:16px">${title}</div>` +
        (rows ? `<div style="overflow-x:auto"><table class="dv-gt"><thead><tr><th>比賽（點列展開詳解／刪除）</th><th>獨贏</th><th>讓分</th><th>大小分</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="dv-empty">還沒有紀錄</div>') + '</div>';
    };
    box.innerHTML = `<div class="dvp-wrap"><div class="dvp-h">手動卦紀錄</div>
      <div class="dvp-note">一場一排、市場固定序（獨贏／讓分／大小分），最新比賽在上；格內為該市場「最新」一卦，×N＝重複起卦次數。<span class="dv-gold">金字＝多法同讖</span>（六爻／梅花／求籤／小六壬任兩法以上最新卦同向；趣味標記，獨立隨機同向約半數機率）；✓✗＝已完賽命中結果。點比賽列展開每一筆卦的詳解與單筆刪除。</div>
      <div class="dv-htabs"><span class="dv-htab on" data-m="六爻">六爻搖卦</span><span class="dv-htab" data-m="梅花">梅花起卦</span><span class="dv-htab" data-m="求籤">求籤</span><span class="dv-htab" data-m="小六壬">小六壬</span></div>
      <div class="dv-hsec" data-m="六爻">${section('六爻', '六爻搖卦')}</div>
      <div class="dv-hsec" data-m="梅花" style="display:none">${section('梅花', '梅花起卦')}</div>
      <div class="dv-hsec" data-m="求籤" style="display:none">${section('求籤', '求籤（六十甲子）')}</div>
      <div class="dv-hsec" data-m="小六壬" style="display:none">${section('小六壬', '小六壬（掌訣）')}</div>
      ${list.length ? '<button class="dv-danger" id="dv-clear">清空所有手動紀錄</button>' : ''}</div>`;
    box.querySelectorAll('.dv-htab').forEach(t => t.onclick = () => {
      box.querySelectorAll('.dv-htab').forEach(x => x.classList.toggle('on', x === t));
      box.querySelectorAll('.dv-hsec').forEach(s => s.style.display = (s.dataset.m === t.dataset.m) ? '' : 'none');
    });
    const c = document.getElementById('dv-clear'); if (c) c.onclick = () => { if (confirm('清空所有手動卦紀錄？')) { localStorage.removeItem(LS_KEY); renderHist(); } };
    box.querySelectorAll('.dv-grow').forEach(tr => tr.onclick = () => {
      const det = tr.nextElementSibling;
      if (!det || !det.classList.contains('dv-detail')) return;
      const open = det.style.display !== 'none';
      if (open) { det.style.display = 'none'; return; }
      const wrap = det.querySelector('.dv-dwrap');
      wrap.innerHTML = list.map((e, i) => ({ e, i })).filter(x => x.e.method === tr.dataset.m && x.e.officialId === tr.dataset.oid)
        .map(x => `<div class="dv-dcard"><button class="dv-del" data-i="${x.i}">刪除此卦</button><b>${esc(x.e.market)}｜${esc(x.e.verdict)}</b>
          <div class="dv-sub">${esc(x.e.ts.slice(5, 16))}Z｜${esc(x.e.source)}</div>
          <details class="dv-details"><summary>為什麼是這個結果？</summary><div class="dv-exp-body">${explainHTML(x.e)}</div></details></div>`).join('');
      wrap.querySelectorAll('.dv-del').forEach(b => b.onclick = (ev) => {
        ev.stopPropagation();
        const i = +b.dataset.i, e = list[i];
        if (!confirm(`刪除這筆卦？\n${e.market}｜${e.verdict}｜${e.ts.slice(5, 16)}Z`)) return;
        const cur = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
        cur.splice(i, 1); localStorage.setItem(LS_KEY, JSON.stringify(cur)); renderHist();
      });
      det.style.display = '';
    });
  }

  const TABS = { cast: null, auto: renderAuto, stats: renderStats, hist: renderHist };
  function switchTab(t) {
    Object.keys(TABS).forEach(k => { document.getElementById('dv-p-' + k).style.display = (k === t) ? '' : 'none'; document.getElementById('divTab-' + k).classList.toggle('on', k === t); });
    if (TABS[t]) TABS[t]();
  }

  function buildUI() {
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
    document.body.appendChild(h(`<div id="divpage">
      <div class="stats-toolbar"><span class="title">☯ 占卜</span>
        <button class="btn tabbtn on" id="divTab-cast">起卦</button>
        <button class="btn tabbtn" id="divTab-auto">機器卦</button>
        <button class="btn tabbtn" id="divTab-stats">統計</button>
        <button class="btn tabbtn" id="divTab-hist">紀錄</button>
        <span class="dv-exp">手動卦＝興趣紀錄，不入實驗統計<br>實驗數據由賽前自動卦產生</span>
        <button class="btn closebtn" id="divClose">關閉</button></div>
      <div class="stats-body" id="divBody">
        <div id="dv-p-cast"><div class="dvp-wrap">
          <div class="dvp-h">起卦（一事一占）</div>
          <div class="dvp-note">先選比賽與市場、再起卦；一次問一個方向，想算三盤就起三次卦。</div>
          <label class="dvp-lbl">比賽</label><select id="dv-game"></select>
          <label class="dvp-lbl">市場</label><div class="dv-opts" id="dv-mkt"><span class="dv-opt on" data-v="大小">大小分</span><span class="dv-opt" data-v="讓分">讓分</span><span class="dv-opt" data-v="獨贏">獨贏</span></div>
          <label class="dvp-lbl">起卦法</label><div class="dv-opts" id="dv-mtd"><span class="dv-opt on" data-v="六爻">六爻搖卦（隨機）</span><span class="dv-opt" data-v="梅花">梅花起卦（依當下時刻）</span><span class="dv-opt" data-v="求籤">求籤（六十甲子）</span><span class="dv-opt" data-v="小六壬">小六壬（掌訣・依當下時刻）</span></div>
          <button id="dv-go">起　卦</button><div id="dv-result"></div>
        </div></div>
        <div id="dv-p-auto" style="display:none"></div>
        <div id="dv-p-stats" style="display:none"></div>
        <div id="dv-p-hist" style="display:none"></div>
      </div></div>`));
    document.getElementById('divClose').onclick = () => document.getElementById('divpage').classList.remove('show');
    Object.keys(TABS).forEach(k => document.getElementById('divTab-' + k).onclick = () => switchTab(k));
    document.getElementById('dv-game').onchange = (e) => { sel.game = games[+e.target.value] || null; refreshGoState(); };
    const bind = (id, key) => document.getElementById(id).querySelectorAll('.dv-opt').forEach(o => o.onclick = () => { document.getElementById(id).querySelectorAll('.dv-opt').forEach(x => x.classList.toggle('on', x === o)); sel[key] = o.dataset.v; refreshGoState(); });
    bind('dv-mkt', 'market'); bind('dv-mtd', 'method');
    document.getElementById('dv-go').onclick = doCast;

    let tries = 0;
    (function mount() {
      const bar = document.getElementById('zoomctlBtns'); if (!bar) { if (tries++ < 20) return setTimeout(mount, 500); return; }
      if (document.getElementById('divQuickBtn')) return;
      const b = document.createElement('button'); b.className = 'fit'; b.id = 'divQuickBtn'; b.title = '占卜'; b.textContent = '卦'; bar.appendChild(b);
      b.onclick = async () => { document.getElementById('divpage').classList.add('show'); switchTab('cast'); if (!gamesLoaded) { await fetchGames(); gamesLoaded = true; } refreshGoState(); };
    })();
  }

  (async function boot() {
    try {
      await loadScript('./lunar.js'); await loadEngine('./meihua_engine.js'); await loadEngine('./liuyao_engine.js');
      if (!window.MeihuaEngine || !window.LiuyaoEngine) throw new Error('engine global missing');
      // 求籤籤詩庫＋凍結判讀表（手動求籤用；失敗不阻斷六爻/梅花）
      try { window.__qiuqianDB = await (await fetch('divination_lab/qiuqian_db.json?v=' + V)).json(); } catch (e) { window.__qiuqianDB = null; }
      try { const t1 = await (await fetch('divination_lab/qiuqian_layer_tables.json?v=' + V)).json(); const t3 = await (await fetch('divination_lab/qiuqian_layer3_table.json?v=' + V)).json(); window.__qiuqianTables = { layer1: t1.layer1, layer3: t3.layer3 }; } catch (e) { window.__qiuqianTables = null; }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI); else buildUI();
    } catch (e) { console.error('[divination-addon] 載入失敗', e); }
  })();
})();
