/* ============================================================
   占卜附加模組（divination-addon.js）——掛在排盤板上的問事介面
   鐵則：手動卦＝興趣紀錄（non-experimental），永不進實驗統計；
        實驗 L 數據只來自排程自動卦（賽前 55–120 分，NIST beacon）。
   結構：FAB「卦」→ 面板三分頁：起卦（一事一占：選比賽+選市場+選法）/ 機器卦 / 紀錄。
   依賴：./lunar.js（UMD 全域）→ ./meihua_engine.js / ./liuyao_engine.js（雙環境版）——本檔自行依序載入。
   隨機源：六爻搖卦先試 NIST beacon（CORS 不通則退 CSPRNG，來源如實標記）；梅花＝當下時刻起卦。
   ============================================================ */
(function () {
  'use strict';
  const V = '20260704a';
  const LS_KEY = 'dvManualCasts';

  function loadScript(src) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src + '?v=' + V; s.onload = ok; s.onerror = () => no(new Error('load fail ' + src)); document.head.appendChild(s); }); }
  // 引擎用 fetch+間接eval 載入：兩支引擎頂層 const 同名（Solar/SHENG/KE…），classic script 共用全域詞法環境會撞名；
  // eval 各有獨立詞法環境 → 隔離載入，引擎檔本身零改動（凍結友善）。
  async function loadEngine(src) { const t = await (await fetch(src + '?v=' + V)).text(); (0, eval)(t); }

  const css = `
  #dv-fab{position:fixed;right:14px;bottom:92px;z-index:99990;width:52px;height:52px;border-radius:50%;border:none;
    background:#5b4b8a;color:#fff;font-size:22px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.45);cursor:pointer}
  #dv-panel{position:fixed;inset:auto 0 0 0;margin:0 auto;max-width:640px;max-height:82vh;z-index:99991;display:none;
    background:#161a23;color:#e8e8ef;border-radius:14px 14px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.6);
    font:14px/1.5 system-ui,-apple-system,"Noto Sans TC",sans-serif;overflow:hidden;flex-direction:column}
  #dv-panel.open{display:flex}
  .dv-head{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#1f2433}
  .dv-head b{font-size:15px}
  .dv-note{font-size:11px;color:#f0b45c;margin-left:auto;text-align:right}
  .dv-x{background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:0 4px}
  .dv-tabs{display:flex;background:#1a1f2b}
  .dv-tab{flex:1;padding:8px 0;text-align:center;color:#9aa;cursor:pointer;border-bottom:2px solid transparent;font-size:13px}
  .dv-tab.on{color:#fff;border-color:#8f7ad6}
  .dv-body{overflow-y:auto;padding:12px 14px 20px}
  .dv-row{margin:8px 0}
  .dv-row label{display:block;color:#9aa;font-size:12px;margin-bottom:4px}
  .dv-row select{width:100%;padding:8px;background:#0f1219;color:#e8e8ef;border:1px solid #333a4d;border-radius:8px}
  .dv-opts{display:flex;gap:6px;flex-wrap:wrap}
  .dv-opt{padding:6px 12px;border:1px solid #333a4d;border-radius:16px;color:#bbc;cursor:pointer;font-size:13px}
  .dv-opt.on{background:#5b4b8a;border-color:#8f7ad6;color:#fff}
  #dv-go{width:100%;margin-top:10px;padding:11px;border:none;border-radius:10px;background:#7a5cd0;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  #dv-go:disabled{opacity:.5}
  .dv-card{margin-top:12px;padding:12px;background:#0f1219;border:1px solid #333a4d;border-radius:10px}
  .dv-verdict{font-size:20px;font-weight:800;margin:4px 0}
  .dv-dim{color:#9aa;font-size:12px}
  .dv-item{padding:8px 10px;border-bottom:1px solid #232a3a;font-size:13px}
  .dv-item .dv-dim{font-size:11px}
  .dv-empty{color:#778;text-align:center;padding:24px 0}
  .dv-danger{background:none;border:1px solid #6b3a3a;color:#c98;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;margin-top:10px}`;

  const ZW = { 大小: ['押大', '押小'], 讓分: ['押主隊盤', '押客隊盤'], 獨贏: ['押主隊', '押客隊'] };
  let games = [], sel = { game: null, market: '大小', method: '六爻' }, ready = false;

  function h(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function nowTW() { return new Date(); } // 使用者裝置＝台北時間

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

  function verdictText(side, market) { return side == null ? '無表態（棄場）' : (side === 0 ? ZW[market][0] : ZW[market][1]); }

  async function doCast() {
    if (!sel.game) return;
    const g = sel.game, market = sel.market, btn = document.getElementById('dv-go');
    btn.disabled = true; btn.textContent = '起卦中…';
    let rec;
    try {
      const t = nowTW();
      if (sel.method === '六爻') {
        const ctx = window.LiuyaoEngine.zhiContext(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        const { bits, src } = await entropy18bits(g.officialId + '|' + market);
        const backs = window.LiuyaoEngine.bitsToBacks(bits);
        const c = window.LiuyaoEngine.castFromBacks(backs, ctx.monthZhi, ctx.dayZhi);
        const side = c.winner === null ? null : (c.winner === '世' ? 0 : 1);
        rec = { detail: `${c.hexLow}下${c.hexUp}上　世${c.shi}爻${c.shiZhi}(${c.sShi}) vs 應${c.ying}爻${c.yingZhi}(${c.sYing})${c.moving.length ? '　動' + c.moving.join(',') : ''}${c.tiebreak ? '　' + c.tiebreak : ''}　月建${ctx.monthZhi} 日辰${ctx.dayZhi}`, side, src };
      } else {
        const c = window.MeihuaEngine.castFromTaipei(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes());
        const side = c.relation === '比和' ? null : (c.pick === '體' ? 0 : 1);
        rec = { detail: `上${c.上卦}下${c.下卦}　動${c.moving}爻　體${c.體卦}用${c.用卦}　${c.relation}`, side, src: '時間起卦 ' + c.lunarText };
      }
      const entry = { ts: new Date().toISOString(), officialId: g.officialId, matchup: `${g.awayTeam}＠${g.homeTeam}`, gameTime: g.date + ' ' + g.time, market, method: sel.method, source: rec.src, detail: rec.detail, verdict: verdictText(rec.side, market), nonExperimental: true };
      const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); list.unshift(entry); localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 200)));
      document.getElementById('dv-result').innerHTML = `<div class="dv-card"><div class="dv-dim">${entry.matchup}　${entry.gameTime}　${market}｜${sel.method}</div><div class="dv-verdict">${entry.verdict}</div><div class="dv-dim">${entry.detail}</div><div class="dv-dim">隨機源：${entry.source}　※興趣紀錄，不入實驗統計</div></div>`;
    } catch (e) {
      document.getElementById('dv-result').innerHTML = `<div class="dv-card">起卦失敗：${e.message}</div>`;
    }
    btn.disabled = false; btn.textContent = '起　卦';
  }

  async function renderAuto() {
    const box = document.getElementById('dv-auto');
    box.innerHTML = '<div class="dv-empty">載入中…</div>';
    try {
      const r = await fetch('data/liuyao_casts.json?nocache=' + Date.now());
      if (!r.ok) throw 0;
      const arr = await r.json();
      const rows = arr.slice(-30).reverse().map(e => e.failedAt
        ? `<div class="dv-item">⚠ beacon 失敗 <span class="dv-dim">${e.failedAt.slice(5, 16)}</span></div>`
        : `<div class="dv-item"><b>${e.pick ? '押' + e.pick : '棄場'}</b>　${e.matchup || e.gamePk}<div class="dv-dim">起卦 ${String(e.castAt).slice(5, 16)}Z｜世${e.shi}${e.shiZhi}(${e.sShi}) vs 應${e.ying}${e.yingZhi}(${e.sYing})｜beacon ${String(e.beaconTS).slice(5, 16)}｜${e.phase}</div></div>`).join('');
      box.innerHTML = rows || '<div class="dv-empty">排程尚未產生卦——每場比賽開打前約一小時自動搖卦</div>';
    } catch (e) { box.innerHTML = '<div class="dv-empty">排程尚未產生卦（ledger 檔尚未建立）</div>'; }
  }

  function renderHistory() {
    const box = document.getElementById('dv-hist');
    const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    box.innerHTML = (list.map(e => `<div class="dv-item"><b>${e.verdict}</b>　${e.matchup}　<span class="dv-dim">${e.market}｜${e.method}</span><div class="dv-dim">${e.ts.slice(5, 16)}Z｜${e.detail}</div></div>`).join('')
      || '<div class="dv-empty">還沒有手動卦</div>')
      + (list.length ? '<button class="dv-danger" id="dv-clear">清空紀錄</button>' : '');
    const c = document.getElementById('dv-clear');
    if (c) c.onclick = () => { if (confirm('清空所有手動卦紀錄？')) { localStorage.removeItem(LS_KEY); renderHistory(); } };
  }

  function buildUI() {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    document.body.appendChild(h(`<button id="dv-fab" title="占卜">卦</button>`));
    document.body.appendChild(h(`<div id="dv-panel">
      <div class="dv-head"><b>占卜</b><span class="dv-note">手動卦＝興趣紀錄，不入實驗統計<br>實驗數據由賽前自動卦產生</span><button class="dv-x" id="dv-close">✕</button></div>
      <div class="dv-tabs"><div class="dv-tab on" data-t="cast">起卦</div><div class="dv-tab" data-t="auto">機器卦</div><div class="dv-tab" data-t="hist">紀錄</div></div>
      <div class="dv-body">
        <div id="dv-p-cast">
          <div class="dv-row"><label>比賽（一事一占：先選比賽與市場，再起卦）</label><select id="dv-game"></select></div>
          <div class="dv-row"><label>市場</label><div class="dv-opts" id="dv-mkt">
            <span class="dv-opt on" data-v="大小">大小分</span><span class="dv-opt" data-v="讓分">讓分</span><span class="dv-opt" data-v="獨贏">獨贏</span></div></div>
          <div class="dv-row"><label>起卦法</label><div class="dv-opts" id="dv-mtd">
            <span class="dv-opt on" data-v="六爻">六爻搖卦（隨機）</span><span class="dv-opt" data-v="梅花">梅花起卦（依當下時刻）</span></div></div>
          <button id="dv-go">起　卦</button><div id="dv-result"></div>
        </div>
        <div id="dv-p-auto" style="display:none"></div>
        <div id="dv-p-hist" style="display:none"></div>
      </div></div>`));
    const panel = document.getElementById('dv-panel');
    document.getElementById('dv-fab').onclick = async () => { panel.classList.add('open'); if (!ready) { await fetchGames(); ready = true; } };
    document.getElementById('dv-close').onclick = () => panel.classList.remove('open');
    panel.querySelectorAll('.dv-tab').forEach(tb => tb.onclick = () => {
      panel.querySelectorAll('.dv-tab').forEach(x => x.classList.toggle('on', x === tb));
      ['cast', 'auto', 'hist'].forEach(k => document.getElementById('dv-p-' + k).style.display = tb.dataset.t === k ? '' : 'none');
      if (tb.dataset.t === 'auto') { document.getElementById('dv-p-auto').innerHTML = '<div id="dv-auto"></div>'; renderAuto(); }
      if (tb.dataset.t === 'hist') { document.getElementById('dv-p-hist').innerHTML = '<div id="dv-hist"></div>'; renderHistory(); }
    });
    document.getElementById('dv-game').onchange = (e) => { sel.game = games[+e.target.value] || null; };
    const bindOpts = (id, key) => document.getElementById(id).querySelectorAll('.dv-opt').forEach(o => o.onclick = () => {
      document.getElementById(id).querySelectorAll('.dv-opt').forEach(x => x.classList.toggle('on', x === o)); sel[key] = o.dataset.v;
    });
    bindOpts('dv-mkt', 'market'); bindOpts('dv-mtd', 'method');
    document.getElementById('dv-go').onclick = doCast;
  }

  (async function boot() {
    try {
      await loadScript('./lunar.js');
      await loadEngine('./meihua_engine.js');
      await loadEngine('./liuyao_engine.js');
      if (!window.MeihuaEngine || !window.LiuyaoEngine) throw new Error('engine global missing');
      buildUI();
    } catch (e) { console.error('[divination-addon] 載入失敗', e); }
  })();
})();
