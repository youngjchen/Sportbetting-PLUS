/* ============================================================
   排盤板 ⇄ 自動賠率  add-on
   用法：把這支檔放到 index.html 同一個資料夾（同 repo），
        然後在 index.html 的  </body>  正上方、原本那段大 <script> 之後，加一行：
            <script src="./odds-integration.js"></script>
   它不改動上面任何一行；不要時把那一行刪掉即可。

   做的事：
   - 讀 ./data/odds_log.json（scraper commit 進同 repo 的賠率），每 5 分鐘自動再讀
   - 以「日期＋兩隊」對到卡片（主客顛倒也認得）；用每場的 league 判聯盟
   - 卡片上長出「📡 盤口動向（自動）」：三家賠率只在背景跑，卡上只出現分析
       三個市場都用同一套 3 段方向評語（逐漸看好 / 看好 / 大幅轉向）＋原始數字：
       · 獨贏：三家去水隱含勝率自初盤到現在的平均移動 → 看好某隊  +X.Xpp
       · 讓分：Bet365 水位去水移動（讓分方＝獨贏熱門）→ 看好 某隊讓分／某隊受讓  +X.Xpp · 盤±1.5
       · 大小：Bet365 大/小水位去水移動 → 看好 大分／小分  +X.Xpp · 基準8.5→9.0
   - 三家方向不一致 → 標「分歧」
   - 抓到的讓分熱門與 STAKE（卡片 hdFav）相反 → 卡上提示，並記錄 it.autoHdFlip（顛倒）
   - 現有「市場」那條（STAKE 算的）改標「市場·STAKE（參考）」、淡化、改成同一套 3 段用詞；差距計算保留
   - 對不到比賽且該聯盟有在抓 → 卡上淡淡「無盤口資料」
   - 選單：「⚡ 用賠率自動排今天的盤」；快捷鍵（右下）：「🔄」手動更新賠率
   ============================================================ */
(function () {
  if (window.__oddsAddonLoaded) return;
  window.__oddsAddonLoaded = true;

  var FEED_URL = "./data/odds_log.json";
  var REFRESH_MS = 5 * 60 * 1000;
  var feed = { matches: {}, lastUpdated: null };

  // 3 段門檻（去水隱含機率變化，pp）— 三個市場共用，讀起來一致
  var T1 = 1.0, T2 = 2.5, T3 = 4.0;
  function tierOf(x) { return x >= T3 ? "大幅轉向" : (x >= T2 ? "看好" : "逐漸看好"); }

  /* ---- 樣式（純新增；乾淨一致：標籤一色、評語一色、隊名只用顏色強調不加粗） ---- */
  var css = document.createElement("style");
  css.textContent =
    ".odds-flow{margin:6px 12px 9px;padding:8px 10px;border-radius:8px;font-size:12px;" +
      "background:rgba(61,139,253,.06);border:1px solid rgba(61,139,253,.22);}" +
    ".odds-flow .ofhd{font-family:'Oswald';font-size:10px;letter-spacing:.08em;color:#7fb0ff;margin-bottom:5px;}" +
    ".odds-flow .of-row{display:flex;align-items:baseline;gap:8px;padding:2.5px 0;line-height:1.45;}" +
    ".odds-flow .of-mk{flex:0 0 30px;font-family:'Oswald';font-size:10px;letter-spacing:.05em;color:var(--ink-dim);}" +
    ".odds-flow .of-txt{flex:1 1 auto;color:#c4d3e6;font-weight:500;}" +
    ".odds-flow .of-txt .of-tm{color:#9bd5ff;}" +                       /* 隊名/方向：顏色強調，不加粗 */
    ".odds-flow .of-row.strong .of-txt{color:#e6f0ff;}" +
    ".odds-flow .of-row.flat .of-txt{color:var(--ink-dim);font-weight:400;}" +
    ".odds-flow .of-num{flex:0 0 auto;font-family:'Oswald';font-size:10px;color:#6f7f92;white-space:nowrap;}" +
    ".odds-flow .of-note{margin-top:5px;color:#ffb347;font-weight:600;font-size:11px;line-height:1.4;}" +
    ".odds-flow .of-foot{margin-top:5px;font-family:'Oswald';font-size:10px;color:#5b6b80;}" +
    ".odds-flow.nomatch{background:rgba(255,255,255,.02);border-style:dashed;border-color:var(--line);}" +
    ".card.collapsed .odds-flow{display:none;}" +
    ".frow.model.stake-ref{opacity:.5;}" +
    ".frow.model.stake-ref .mlbl{color:#7a8696;}";
  document.head.appendChild(css);

  /* ---- 工具 ---- */
  function safeEsc(s) { return (typeof esc === "function") ? esc(s) : String(s); }
  // 獨贏（歐賠）去水：優先用排盤板自己的 impliedAway
  function impAway(oa, oh) {
    if (typeof impliedAway === "function") return impliedAway(oa, oh);
    if (isNaN(oa) || isNaN(oh) || oa <= 1 || oh <= 1) return null;
    return (1 / oa) / (1 / oa + 1 / oh);
  }
  // 讓分/大小水位去水：自動辨識歐賠或港盤（兩邊都 ≤1.4 視為港盤，+1 約當歐賠）
  function devig(a, b) {
    a = parseFloat(a); b = parseFloat(b);
    if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
    if (a <= 1.4 && b <= 1.4) { a += 1; b += 1; }
    return (1 / a) / (1 / a + 1 / b);
  }
  function fmtHd(v) { var n = parseFloat(v); if (isNaN(n)) return String(v || "—"); return n > 0 ? "+" + n : "" + n; }
  function fmtOu(v) { var n = parseFloat(v); if (isNaN(n)) return String(v || "—"); return "" + n; }

  /* ---- 對應這張卡的比賽（日期＋兩隊，主客顛倒也認） ---- */
  function feedGameFor(it) {
    if (!feed || !feed.matches || typeof doc === "undefined" || !doc.activeDate) return null;
    var dateKey = doc.activeDate, ms = feed.matches;
    for (var id in ms) {
      var g = ms[id];
      if (!g.homeTeam || !g.awayTeam) continue;
      if ((g.startISO || "").slice(0, 10) !== dateKey) continue;
      if ((g.homeTeam === it.home && g.awayTeam === it.away) ||
          (g.homeTeam === it.away && g.awayTeam === it.home)) return g;
    }
    return null;
  }

  /* ---- 資料裡有哪些聯盟（優先用 g.league，隊名沒對上也認得） ---- */
  function feedLeagues() {
    var set = {};
    for (var id in (feed.matches || {})) {
      var g = feed.matches[id];
      if (g.league) { set[g.league] = true; continue; }
      var t = g.homeTeam || g.awayTeam; if (!t) continue;
      if (typeof LEAGUES !== "undefined") for (var k in LEAGUES) { if (LEAGUES[k].teams.indexOf(t) >= 0) { set[k] = true; break; } }
    }
    return set;
  }

  /* ---- 獨贏熱門隊（用最新去水隱含勝率，避免猜讓分正負號） ---- */
  function feedFavTeam(g) {
    var books = ["bet365", "12bet", "bwin"], ps = [];
    for (var i = 0; i < books.length; i++) {
      var b = g.ml && g.ml[books[i]]; if (!b || !b.open) continue;
      var last = (b.live && b.live.length) ? b.live[b.live.length - 1] : b.open;
      var p = impAway(last.away, last.home); if (p != null) ps.push(p);
    }
    if (!ps.length) return null;
    var avgAway = ps.reduce(function (s, x) { return s + x; }, 0) / ps.length;
    if (Math.abs(avgAway - 0.5) < 0.02) return null;
    return avgAway > 0.5 ? g.awayTeam : g.homeTeam;
  }

  /* ---- 獨贏：三家去水隱含勝率自初盤到現在的平均移動 ---- */
  function mlSentiment(g) {
    var books = ["bet365", "12bet", "bwin"], moves = [];
    for (var i = 0; i < books.length; i++) {
      var b = g.ml && g.ml[books[i]]; if (!b || !b.open) continue;
      var openP = impAway(b.open.away, b.open.home);
      var last = (b.live && b.live.length) ? b.live[b.live.length - 1] : b.open;
      var nowP = impAway(last.away, last.home);
      if (openP == null || nowP == null) continue;
      moves.push(nowP - openP);
    }
    if (!moves.length) return null;
    var avg = moves.reduce(function (s, x) { return s + x; }, 0) / moves.length;
    var pos = 0, neg = 0;
    moves.forEach(function (m) { if (m > 0.005) pos++; else if (m < -0.005) neg++; });
    return { mvpp: avg * 100, split: (pos > 0 && neg > 0), towardAway: avg > 0 };
  }

  /* ---- 讓分：水位去水移動（讓分方＝獨贏熱門）→ 方向評語；盤口數字另外原樣顯示 ---- */
  function hdSentiment(g) {
    var rows = g.hd && g.hd.bet365;
    if (!rows || rows.length < 1) return null;
    var now = rows[0], init = rows[rows.length - 1];
    var lineChanged = String(now.line) !== String(init.line);
    var lean = null;
    var fav = feedFavTeam(g);
    if (fav) {
      var favIsHome = (fav === g.homeTeam);
      var pNow = devig(favIsHome ? now.home : now.away, favIsHome ? now.away : now.home);
      var pInit = devig(favIsHome ? init.home : init.away, favIsHome ? init.away : init.home);
      if (pNow != null && pInit != null) {
        var mvpp = (pNow - pInit) * 100;
        if (Math.abs(mvpp) < T1) lean = { flat: true, mvpp: mvpp };
        else {
          var und = favIsHome ? g.awayTeam : g.homeTeam;
          lean = { team: mvpp > 0 ? fav : und, suffix: mvpp > 0 ? "讓分" : "受讓", mvpp: mvpp };
        }
      }
    }
    return { lean: lean, nowLine: now.line, initLine: init.line, lineChanged: lineChanged };
  }

  /* ---- 大小：大/小水位去水移動 → 方向評語；基準數字另外原樣顯示 ---- */
  function ouSentiment(g) {
    var rows = g.ou && g.ou.bet365;
    if (!rows || rows.length < 1) return null;
    var now = rows[0], init = rows[rows.length - 1];
    var pNow = devig(now.over, now.under), pInit = devig(init.over, init.under);
    var lean = null;
    if (pNow != null && pInit != null) {
      var mvpp = (pNow - pInit) * 100;
      if (Math.abs(mvpp) < T1) lean = { flat: true, mvpp: mvpp };
      else lean = { side: mvpp > 0 ? "大分" : "小分", mvpp: mvpp };
    }
    return { lean: lean, nowBasis: now.line, initBasis: init.line, basisChanged: String(now.line) !== String(init.line) };
  }

  /* ---- 一列 ---- */
  function ofRow(mk, txt, num, cls) {
    return "<div class='of-row " + (cls || "") + "'><span class='of-mk'>" + mk + "</span>" +
           "<span class='of-txt'>" + txt + "</span>" +
           (num ? "<span class='of-num'>" + num + "</span>" : "") + "</div>";
  }

  /* ---- 卡片上的分析區塊 ---- */
  function buildFlowBlock(it, g) {
    var wrap = document.createElement("div");
    wrap.className = "odds-flow no-drag";
    var rows = "";

    // 獨贏
    var ml = mlSentiment(g);
    if (ml) {
      var a1 = Math.abs(ml.mvpp);
      if (a1 < T1) rows += ofRow("獨贏", "持平", "", "flat");
      else {
        var team = ml.towardAway ? g.awayTeam : g.homeTeam;
        rows += ofRow("獨贏",
          tierOf(a1) + " <span class='of-tm'>" + safeEsc(team) + "</span>",
          "+" + a1.toFixed(1) + "pp" + (ml.split ? " · 分歧" : ""),
          a1 >= T2 ? "strong" : "");
      }
    }

    // 讓分
    var hd = hdSentiment(g);
    if (hd) {
      var lineStr = hd.lineChanged ? ("盤 " + fmtHd(hd.initLine) + "→" + fmtHd(hd.nowLine)) : ("盤 " + fmtHd(hd.nowLine));
      if (hd.lean && !hd.lean.flat) {
        var a2 = Math.abs(hd.lean.mvpp);
        rows += ofRow("讓分",
          tierOf(a2) + " <span class='of-tm'>" + safeEsc(hd.lean.team) + hd.lean.suffix + "</span>",
          "+" + a2.toFixed(1) + "pp · " + lineStr,
          a2 >= T2 ? "strong" : "");
      } else rows += ofRow("讓分", "持平", lineStr, "flat");
    }

    // 大小
    var ou = ouSentiment(g);
    if (ou) {
      var basisStr = ou.basisChanged ? ("基準 " + fmtOu(ou.initBasis) + "→" + fmtOu(ou.nowBasis)) : ("基準 " + fmtOu(ou.nowBasis));
      if (ou.lean && !ou.lean.flat) {
        var a3 = Math.abs(ou.lean.mvpp);
        rows += ofRow("大小",
          tierOf(a3) + " <span class='of-tm'>" + ou.lean.side + "</span>",
          "+" + a3.toFixed(1) + "pp · " + basisStr,
          a3 >= T2 ? "strong" : "");
      } else rows += ofRow("大小", "持平", basisStr, "flat");
    }

    var html = "<div class='ofhd'>📡 盤口動向（自動）</div>" + rows;

    var fav = feedFavTeam(g), cardFav = it[it.hdFav];
    if (fav && cardFav && fav !== cardFav)
      html += "<div class='of-note'>⚠ 抓到讓分熱門（" + safeEsc(fav) + "）與 STAKE 相反，已記錄顛倒</div>";

    if (g.lastUpdated) html += "<div class='of-foot'>更新 " + g.lastUpdated.slice(11, 16) + "</div>";
    wrap.innerHTML = html;
    return wrap;
  }

  function buildNoMatchBlock() {
    var wrap = document.createElement("div");
    wrap.className = "odds-flow nomatch no-drag";
    wrap.innerHTML = "<div class='ofhd'>📡 盤口動向</div><div class='of-row flat'><span class='of-txt'>無盤口資料（隊名可能對不上，或尚未開盤）</span></div>";
    return wrap;
  }

  /* ---- 把現有「市場」那條改標「市場·STAKE（參考）」、淡化、改 3 段用詞；差距計算保留 ---- */
  function reframeStakeRow(cardEl, it) {
    var rows = cardEl.querySelectorAll(".formline .frow.model");
    for (var i = 0; i < rows.length; i++) {
      var lbl = rows[i].querySelector(".mlbl");
      if (!lbl || lbl.textContent.trim() !== "市場") continue;
      if (rows[i].classList.contains("stake-ref")) break;
      rows[i].classList.add("stake-ref");
      lbl.textContent = "市場·STAKE";
      var mp = impAway(parseFloat(it.flipOddsAway), parseFloat(it.flipOddsHome));
      var mp0 = impAway(parseFloat(it.openOddsAway), parseFloat(it.openOddsHome));
      var mvEl = rows[i].querySelector(".mv");
      if (mvEl && mp != null && mp0 != null) {
        var mv = (mp - mp0) * 100, amv = Math.abs(mv);
        if (amv < T1) mvEl.textContent = "初盤至今幾乎沒動";
        else mvEl.innerHTML = tierOf(amv) + " " + safeEsc(mv > 0 ? it.away : it.home);
      }
      var tag = document.createElement("span");
      tag.style.cssText = "margin-left:5px;font-size:10px;color:#7a8696;";
      tag.textContent = "（參考）";
      rows[i].appendChild(tag);
      break;
    }
  }

  /* ---- 包住 renderCard ---- */
  if (typeof renderCard === "function") {
    var _origRenderCard = renderCard;
    renderCard = function (it) {
      _origRenderCard(it);
      try {
        var cardEl = world.querySelector('.card[data-id="' + it.id + '"]');
        if (!cardEl) return;
        reframeStakeRow(cardEl, it);
        var g = feedGameFor(it), block = null;
        if (g) block = buildFlowBlock(it, g);
        else {
          var lg = (typeof leagueOf === "function") ? leagueOf(it) : null;
          if (lg && feedLeagues()[lg]) block = buildNoMatchBlock();
        }
        if (block) {
          var anchor = cardEl.querySelector(".summary-line");
          if (anchor) cardEl.insertBefore(block, anchor); else cardEl.appendChild(block);
        }
      } catch (e) { /* 永遠不讓 add-on 弄壞排盤板 */ }
    };
  }

  /* ---- 每次抓到新資料後，記錄「顛倒」旗標一次 ---- */
  function syncFlipFlags() {
    if (typeof state === "undefined" || !state.items) return false;
    var changed = false;
    state.items.forEach(function (it) {
      if (it.type !== "match") return;
      var g = feedGameFor(it); if (!g) return;
      var fav = feedFavTeam(g), cardFav = it[it.hdFav];
      var flip = !!(fav && cardFav && fav !== cardFav);
      if (!!it.autoHdFlip !== flip) { it.autoHdFlip = flip; changed = true; }
    });
    return changed;
  }

  /* ---- 自動排當天盤（讓分盤口/大小基準留空） ---- */
  function autoArrangeFromFeed() {
    if (typeof closeMore === "function") closeMore();
    if (!feed || !feed.matches || !Object.keys(feed.matches).length) {
      alert("目前沒有抓到任何即將開打的比賽資料。\n（先確認 scraper 跑過、data/odds_log.json 已產生。）");
      return;
    }
    var byDate = {};
    for (var id in feed.matches) {
      var g = feed.matches[id];
      if (!g.homeTeam || !g.awayTeam) continue;
      var d = (g.startISO || "").slice(0, 10);
      if (d) (byDate[d] = byDate[d] || []).push(g);
    }
    var target = doc.activeDate;
    if (!byDate[target] || !byDate[target].length) {
      var best = null;
      for (var dd in byDate) { if (!best || byDate[dd].length > byDate[best].length) best = dd; }
      if (!best) { alert("抓到的資料裡沒有可排的比賽（隊名可能都沒對上）。"); return; }
      if (!confirm("今天（" + fmtDate(target) + "）沒有抓到比賽。\n\n抓到 " + fmtDate(best) + " 的 " +
                   byDate[best].length + " 場，要切到那天並排盤嗎？")) return;
      switchDate(best);
      target = best;
    }
    if (typeof snapshot === "function") snapshot();
    var have = {};
    state.items.forEach(function (it) { if (it.type === "match") have[[it.away, it.home].sort().join("|")] = true; });
    var added = 0;
    byDate[target].forEach(function (g) {
      var key = [g.awayTeam, g.homeTeam].sort().join("|");
      if (have[key]) return;
      var lg = g.league || null;
      if (!lg && typeof LEAGUES !== "undefined") for (var k in LEAGUES) { if (LEAGUES[k].teams.indexOf(g.homeTeam) >= 0) { lg = k; break; } }
      var col = (lg && typeof LEAGUES !== "undefined" && LEAGUES[lg]) ? LEAGUES[lg].color : "var(--mlb)";
      var fav = feedFavTeam(g);
      state.items.push({
        id: uid++, type: "match", x: 0, y: 0,
        away: g.awayTeam, home: g.homeTeam, awayColor: col, homeColor: col,
        mlAway: { lights: 0 }, mlHome: { lights: 0 },
        hdFav: (fav === g.awayTeam ? "away" : "home"), hdVal: "",
        hdGive: { lights: 0 }, hdRecv: { lights: 0 },
        totVal: "", over: { lights: 0 }, under: { lights: 0 }
      });
      have[key] = true; added++;
    });
    if (added === 0) { alert("這天的比賽都已經在盤面上了，沒有新增。"); return; }
    if (typeof autoLayout === "function") {
      var ws = (typeof suppress !== "undefined");
      if (ws) suppress = true;
      try { autoLayout(); } finally { if (ws) suppress = false; }
    } else { save(); render(); }
    badge("已自動排入 " + added + " 場 ✓");
  }

  function badge(txt) {
    var b = document.getElementById("saveBadge");
    if (b) { b.textContent = txt; b.classList.add("show"); setTimeout(function () { b.classList.remove("show"); }, 1700); }
  }

  /* ---- 非干擾自動更新：只在資料有變、且沒開彈窗/沒在打字時重畫；手動刷新則強制 ---- */
  function anyModalOpen() {
    return !!document.querySelector("#settleModal.show, #modal.show, #editStat.show, .modal-overlay.show, #importModal.show");
  }
  function editingNow() {
    var a = document.activeElement;
    return !!(a && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"));
  }
  function fetchFeed(force) {
    fetch(FEED_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) {
        if (!j || !j.matches) return;
        var changed = (j.lastUpdated !== feed.lastUpdated);
        feed = j;
        var flipChanged = syncFlipFlags();
        if (flipChanged && typeof save === "function") save();
        if ((force || ((changed || flipChanged) && !anyModalOpen() && !editingNow())) && typeof render === "function") render();
      })
      .catch(function () { /* 離線 / 還沒在 Pages 上 / 檔還沒生 — 排盤板照常 */ });
  }

  /* ---- 鈕：自動排盤→選單；手動更新→快捷鍵（右下，跟 🔍 / 結算 同排） ---- */
  function injectButtons() {
    var menu = document.getElementById("moreMenu");
    if (menu && !document.getElementById("autoArrangeBtn")) {
      var sep = document.createElement("div"); sep.className = "sep";
      var b1 = document.createElement("button"); b1.id = "autoArrangeBtn"; b1.textContent = "⚡ 用賠率自動排今天的盤";
      b1.onclick = function (e) { e.stopPropagation(); autoArrangeFromFeed(); };
      menu.appendChild(sep); menu.appendChild(b1);
    }
    var qb = document.getElementById("zoomctlBtns");
    if (qb && !document.getElementById("refreshOddsQuickBtn")) {
      var r = document.createElement("button");
      r.id = "refreshOddsQuickBtn"; r.className = "fit"; r.title = "更新賠率"; r.textContent = "🔄";
      r.onclick = function (e) { e.stopPropagation(); fetchFeed(true); badge("已更新賠率 ✓"); };
      qb.appendChild(r);
    }
  }

  /* ---- 啟動 ---- */
  function boot() { injectButtons(); fetchFeed(false); setInterval(function () { fetchFeed(false); }, REFRESH_MS); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { mlSentiment: mlSentiment, hdSentiment: hdSentiment, ouSentiment: ouSentiment, feedFavTeam: feedFavTeam, devig: devig, tierOf: tierOf, T1: T1, T2: T2, T3: T3 };
  }
})();
