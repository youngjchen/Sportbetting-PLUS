/* ============================================================
   占卜附加模組 v2（divination-addon.js）
   UI：快捷鍵列（#zoomctlBtns）一顆「卦」鈕（.fit 同風格）→ 整頁視圖 #divpage
       （複製數據回顧模式：stats-toolbar + stats-body + var(--bg/--ink/--line) 設計變數，字體同級）。
   鐵則：手動卦＝興趣紀錄（non-experimental），永不進實驗統計；
        實驗 L 數據只來自排程自動卦（賽前 55–120 分，NIST beacon）。
   一事一占：先選比賽＋市場（大小/讓分/獨贏）＋起卦法（六爻搖卦/梅花時刻），再起卦。
   依賴：./lunar.js（UMD 全域）；兩引擎以 fetch+間接eval 隔離載入（頂層 const 撞名，共用全域詞法環境會炸）。
   ============================================================ */
(function () {
  'use strict';
  const V = '20260704b';
  const LS_KEY = 'dvManualCasts';

  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src + '?v=' + V; s.onload = ok; s.onerror = () => no(new Error('load fail ' + src)); document.head.appendChild(s); }); }
  async function loadEngine(src) { const t = await (await fetch(src + '?v=' + V)).text(); (0, eval)(t); }

  const css = `
  #divpage{position:fixed;inset:0;z-index:170;background:var(--bg);display:none;flex-direction:column;overflow:hidden}
  #divpage.show{display:flex}
  #divpage .stats-toolbar .dv-exp{margin-left:auto;color:var(--ink-dim);font-size:12.5px;line-height:1.45;text-align:right}
  #divpage .tabbtn.on{border-color:var(--lit);color:var(--lit)}
  #divBody{overflow-y:auto;flex:1}
  .dvp-wrap{max-width:1080px;margin:0 auto;padding:24px clamp(16px,4vw,56px) 48px;width:100%;box-sizing:border-box}
  .dvp-h{font-weight:700;font-size:18px;margin:0 0 6px;color:var(--ink)}
  .dvp-note{color:var(--ink-dim);font-size:13.5px;line-height:1.7;margin:0 0 16px}
  .dvp-lbl{display:block;color:var(--ink-dim);font-size:13.5px;margin:18px 0 8px;letter-spacing:.04em}
  #dv-game{width:100%;padding:12px 14px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;font-size:16px}
  .dv-opts{display:flex;gap:10px;flex-wrap:wrap}
  .dv-opt{padding:10px 18px;border:1px solid var(--line);border-radius:10px;color:var(--ink);cursor:pointer;font-size:15.5px;background:var(--panel)}
  .dv-opt.on{border-color:var(--lit);color:var(--lit);background:var(--panel-2)}
  #dv-go{margin-top:22px;padding:14px 26px;border:none;border-radius:12px;background:var(--lit);color:#1a1206;font-size:18px;font-weight:800;cursor:pointer;letter-spacing:.2em}
  #dv-go:disabled{opacity:.55}
  .dv-card{margin-top:22px;padding:18px 20px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
  .dv-verdict{font-size:32px;font-weight:800;margin:6px 0 10px;color:var(--ink)}
  .dv-dim{color:var(--ink-dim);font-size:14px;line-height:1.7}
  .dv-item{padding:12px 4px;border-bottom:1px solid var(--line);font-size:15.5px;color:var(--ink)}
  .dv-item b{font-size:16px}
  .dv-item .dv-dim{font-size:13px}
  .dv-empty{color:var(--ink-dim);text-align:center;padding:36px 0;font-size:15px;line-height:1.8}
  .dv-danger{background:none;border:1px solid #6b3a3a;color:#c98;border-radius:10px;padding:9px 16px;cursor:pointer;font-size:13.5px;margin-top:16px}`;

  const ZW = { 大小: ['押大', '押小'], 讓分: ['押主隊盤', '押客隊盤'], 獨贏: ['押主隊', '押客隊'] };
  let games = [], sel = { game: null, market: '大小', method: '六爻' }, gamesLoaded = false;

  function h(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

  async function fetchGames() {
    try {
      const r = await fetch('data/pregame_data.json?nocache=' + Date.now()); const arr = await r.json();
      const now = Date.now();
      games = arr.filter(g => g.league === 'MLB' && g.status !== 'finished' && g.date && g.time)
        .map(g => ({ ...g, ts: Date.parse(g.date + 'T' + g.time + ':00+08:00') }))
        .filter(g => g.ts > now - 2 * 3600e3).sort((a, b) => a.ts - b.ts).slice(0, 40);
    } catch (e) { games = []; }
    const s = document.getElementById('dv-game');
    s.innerHTML = games.length ? games.map((g, i) => `<option value="${i}">${g.date.slice(5)} ${g.time}　${g.awayTeam}＠${g.homeTeam}${g.lotteryTotal ? '　大小' + g.lotteryTotal : ''}${g.lotteryHandicap && g.lotteryHandicap.line != null ? '　' + (g.lotteryHandicap.favSide === 'away' ? '客' : '主') + '讓' + g.lotteryHandicap.line : ''}</option>`).join('') : '<option value="">（目前無未開打賽事）</option>';
    sel.game = games.length ? games[0] : null;
  }

  async function sha256Bytes(str) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return new Uint8Array(b); }
  async function entropy18bits(tag) {
    let src, hex;
    try {
      const r = await fetch('https://beacon.nist.gov/beacon/2.0/pulse/last', { signal: AbortSignal.timeout(6000) });
      const p = (await r.json()).pulse; hex = p.outputValue; src = 'NIST ' + p.timeStamp;
    } catch (e) {
      const u = new Uint8Array(32); crypto.getRandomValues(u);
      hex = [...u].map(x => x.toString(16).padStart(2, '0')).join(''); src = '瀏覽器 CSPRNG';
    }
    const d = await sha256Bytes(hex + '|' + tag + '|' + Date.now());
    const bits = []; for (let i = 0; i < 18; i++) bits.push((d[i >> 3] >> (7 - (i & 7))) & 1);
    return { bits, src };
  }
  const verdictText = (side, market) => side == null ? '無表態（棄場）' : ZW[market][side];

  async function doCast() {
    if (!sel.game) return;
    const g = sel.game, market = sel.market, btn = document.getElementById('dv-go');
    btn.disabled = true; btn.textContent = '起卦中…';
    try {
      const t = new Date();   // 裝置＝台北時間
      let rec;
      if (sel.method === '六爻') {
        const ctx = window.LiuyaoEngine.zhiContext(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        const { bits, src } = await entropy18bits(g.officialId + '|' + market);
        const c = window.LiuyaoEngine.castFromBacks(window.LiuyaoEngine.bitsToBacks(bits), ctx.monthZhi, ctx.dayZhi);
        const side = c.winner === null ? null : (c.winner === '世' ? 0 : 1);
        rec = { side, src, detail: `${c.hexLow}下${c.hexUp}上　世${c.shi}爻${c.shiZhi}(${c.sShi}) vs 應${c.ying}爻${c.yingZhi}(${c.sYing})${c.moving.length ? '　動' + c.moving.join(',') : ''}${c.tiebreak ? '　' + c.tiebreak : ''}　月建${ctx.monthZhi}・日辰${ctx.dayZhi}` };
      } else {
        const c = window.MeihuaEngine.castFromTaipei(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        const side = c.relation === '比和' ? null : (c.pick === '體' ? 0 : 1);
        rec = { side, src: '時間起卦　' + c.lunarText, detail: `上${c.上卦}下${c.下卦}　動${c.moving}爻　體${c.體卦}用${c.用卦}　${c.relation}` };
      }
      const entry = { ts: new Date().toISOString(), officialId: g.officialId, matchup: `${g.awayTeam}＠${g.homeTeam}`, gameTime: g.date + ' ' + g.time, market, method: sel.method, source: rec.src, detail: rec.detail, verdict: verdictText(rec.side, market), nonExperimental: true };
      const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); list.unshift(entry); localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 200)));
      document.getElementById('dv-result').innerHTML = `<div class="dv-card"><div class="dv-dim">${entry.matchup}　${entry.gameTime}　${market}｜${sel.method}</div><div class="dv-verdict">${entry.verdict}</div><div class="dv-dim">${entry.detail}</div><div class="dv-dim">隨機源：${entry.source}　｜　※ 興趣紀錄，不入實驗統計</div></div>`;
    } catch (e) {
      document.getElementById('dv-result').innerHTML = `<div class="dv-card">起卦失敗：${e.message}</div>`;
    }
    btn.disabled = false; btn.textContent = '起　卦';
  }

  async function renderAuto() {
    const box = document.getElementById('dv-p-auto');
    box.innerHTML = '<div class="dv-empty">載入中…</div>';
    try {
      const r = await fetch('data/liuyao_casts.json?nocache=' + Date.now());
      if (!r.ok) throw 0;
      const arr = await r.json();
      const rows = arr.slice(-40).reverse().map(e => e.failedAt
        ? `<div class="dv-item">⚠ beacon 失敗 <span class="dv-dim">${e.failedAt.slice(5, 16)}</span></div>`
        : `<div class="dv-item"><b>${e.pick ? '押' + e.pick : '棄場'}</b>　${e.matchup || e.gamePk}<div class="dv-dim">起卦 ${String(e.castAt).slice(5, 16)}Z｜世${e.shi}${e.shiZhi}(${e.sShi}) vs 應${e.ying}${e.yingZhi}(${e.sYing})｜beacon ${String(e.beaconTS).slice(5, 16)}｜${e.phase}</div></div>`).join('');
      box.innerHTML = `<div class="dvp-wrap"><div class="dvp-h">機器卦（實驗 L・大小分）</div><div class="dvp-note">排程在每場開打前 55–120 分鐘自動搖卦（NIST 隨機信標），一場一卦永不重抽。2026 剩餘賽季＝試車；2027 全季＝正式樣本。</div>${rows || '<div class="dv-empty">排程尚未產生卦——第一批將在下一個比賽日窗口出現</div>'}</div>`;
    } catch (e) { box.innerHTML = '<div class="dvp-wrap"><div class="dv-empty">排程尚未產生卦（ledger 檔尚未建立）</div></div>'; }
  }

  function renderHistory() {
    const box = document.getElementById('dv-p-hist');
    const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    box.innerHTML = `<div class="dvp-wrap"><div class="dvp-h">手動卦紀錄</div><div class="dvp-note">興趣紀錄（不入實驗統計）；重複起卦全部留痕，最新在上。</div>` +
      (list.map(e => `<div class="dv-item"><b>${e.verdict}</b>　${e.matchup}　<span class="dv-dim">${e.market}｜${e.method}</span><div class="dv-dim">${e.ts.slice(5, 16)}Z｜${e.detail}</div></div>`).join('') || '<div class="dv-empty">還沒有手動卦</div>') +
      (list.length ? '<button class="dv-danger" id="dv-clear">清空紀錄</button>' : '') + '</div>';
    const c = document.getElementById('dv-clear');
    if (c) c.onclick = () => { if (confirm('清空所有手動卦紀錄？')) { localStorage.removeItem(LS_KEY); renderHistory(); } };
  }

  function switchTab(t) {
    ['cast', 'auto', 'hist'].forEach(k => {
      document.getElementById('dv-p-' + k).style.display = (k === t) ? '' : 'none';
      document.getElementById('divTab-' + k).classList.toggle('on', k === t);
    });
    if (t === 'auto') renderAuto();
    if (t === 'hist') renderHistory();
  }

  function buildUI() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    document.body.appendChild(h(`<div id="divpage">
      <div class="stats-toolbar">
        <span class="title">☯ 占卜</span>
        <button class="btn tabbtn on" id="divTab-cast">起卦</button>
        <button class="btn tabbtn" id="divTab-auto">機器卦</button>
        <button class="btn tabbtn" id="divTab-hist">紀錄</button>
        <span class="dv-exp">手動卦＝興趣紀錄，不入實驗統計<br>實驗數據由賽前自動卦產生</span>
        <button class="btn closebtn" id="divClose">關閉</button>
      </div>
      <div class="stats-body" id="divBody">
        <div id="dv-p-cast"><div class="dvp-wrap">
          <div class="dvp-h">起卦（一事一占）</div>
          <div class="dvp-note">先選比賽與市場、再起卦；想算三個方向就起三次卦，各得各的卦。</div>
          <label class="dvp-lbl">比賽</label><select id="dv-game"></select>
          <label class="dvp-lbl">市場</label><div class="dv-opts" id="dv-mkt">
            <span class="dv-opt on" data-v="大小">大小分</span><span class="dv-opt" data-v="讓分">讓分</span><span class="dv-opt" data-v="獨贏">獨贏</span></div>
          <label class="dvp-lbl">起卦法</label><div class="dv-opts" id="dv-mtd">
            <span class="dv-opt on" data-v="六爻">六爻搖卦（隨機）</span><span class="dv-opt" data-v="梅花">梅花起卦（依當下時刻）</span></div>
          <button id="dv-go">起　卦</button><div id="dv-result"></div>
        </div></div>
        <div id="dv-p-auto" style="display:none"></div>
        <div id="dv-p-hist" style="display:none"></div>
      </div></div>`));
    document.getElementById('divClose').onclick = () => document.getElementById('divpage').classList.remove('show');
    ['cast', 'auto', 'hist'].forEach(k => document.getElementById('divTab-' + k).onclick = () => switchTab(k));
    document.getElementById('dv-game').onchange = (e) => { sel.game = games[+e.target.value] || null; };
    const bindOpts = (id, key) => document.getElementById(id).querySelectorAll('.dv-opt').forEach(o => o.onclick = () => {
      document.getElementById(id).querySelectorAll('.dv-opt').forEach(x => x.classList.toggle('on', x === o)); sel[key] = o.dataset.v;
    });
    bindOpts('dv-mkt', 'market'); bindOpts('dv-mtd', 'method');
    document.getElementById('dv-go').onclick = doCast;

    // 快捷鍵列掛入口鈕（與 🔍 同 .fit 風格；zoomctl 尚未渲染就重試）
    let tries = 0;
    (function mountBtn() {
      const bar = document.getElementById('zoomctlBtns');
      if (!bar) { if (tries++ < 20) return setTimeout(mountBtn, 500); return; }
      if (document.getElementById('divQuickBtn')) return;
      const b = document.createElement('button');
      b.className = 'fit'; b.id = 'divQuickBtn'; b.title = '占卜'; b.textContent = '卦';
      bar.appendChild(b);
      b.onclick = async () => { document.getElementById('divpage').classList.add('show'); switchTab('cast'); if (!gamesLoaded) { await fetchGames(); gamesLoaded = true; } };
    })();
  }

  (async function boot() {
    try {
      await loadScript('./lunar.js');
      await loadEngine('./meihua_engine.js');
      await loadEngine('./liuyao_engine.js');
      if (!window.MeihuaEngine || !window.LiuyaoEngine) throw new Error('engine global missing');
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI); else buildUI();
    } catch (e) { console.error('[divination-addon] 載入失敗', e); }
  })();
})();
