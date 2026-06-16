/* ============================================================
   排盤板 ⇄ 自動賠率  add-on
   用法：把這支檔放到 index.html 同一個資料夾（同 repo），
        然後在 index.html 的  </body>  正上方、原本那段大 <script> 之後，加一行：
            <script src="./odds-integration.js"></script>
   它不改動上面任何一行；不要時把那一行刪掉即可。

   它做的事：
   - 讀 ./data/odds_log.json（scraper commit 進同 repo 的賠率），每 5 分鐘自動再讀
   - 以「日期＋兩隊」對到卡片，主客顛倒也認得
   - 在卡片上長出一條「📡 盤口動向（自動）」：三家賠率只在背景跑，卡上只出現分析
       · 獨贏：三家去水隱含勝率自初盤到現在的平均移動 → 逐漸看好 / 看好 / 大幅轉向（3 段）
       · 讓分：Bet365 完整變動 → 讓分方翻轉 / 讓分加深 / 讓分縮小 / 持平
       · 大小：Bet365 完整變動 → 基準上移 / 下移 / 持平
   - 三家方向不一致 → 標「三家分歧」
   - 抓到的讓分方與 STAKE（卡片 hdFav）相反 → 卡上提示，並在卡片上記錄 it.autoHdFlip（顛倒）
   - 把現有「市場」那條（STAKE 算的）改標成「市場·STAKE（參考）」並淡化、改成同一套 3 段用詞；差距計算保留
   - 對不到比賽且該聯盟有在抓 → 卡上淡淡「無盤口資料」（順便抓出隊名沒對上的場）
   - 選單多一顆「⚡ 用賠率自動排今天的盤」：用提前抓到的資料自動生當天的卡（讓分盤口/大小基準留空）
   ============================================================ */
(function () {
  if (window.__oddsAddonLoaded) return;          // 防止重複載入
  window.__oddsAddonLoaded = true;

  var FEED_URL = "./data/odds_log.json";
  var REFRESH_MS = 5 * 60 * 1000;                 // 跟 scraper 一樣 5 分鐘
  var feed = { matches: {}, lastUpdated: null };

  // 獨贏動向 3 段門檻（去水隱含勝率變化，單位：百分點 pp）
  var T1 = 1.0;   // ≥1.0  逐漸看好
  var T2 = 2.5;   // ≥2.5  看好
  var T3 = 4.0;   // ≥4.0  大幅轉向

  /* ---- 樣式（純新增，不覆蓋既有） ---- */
  var css = document.createElement("style");
  css.textContent =
    ".odds-flow{margin:6px 12px 9px;padding:7px 9px;border-radius:7px;font-size:12px;" +
      "background:rgba(61,139,253,.06);border:1px solid rgba(61,139,253,.28);color:var(--ink-dim);}" +
    ".odds-flow .ofhd{font-family:'Oswald';font-size:10px;letter-spacing:.06em;color:#7fb0ff;margin-bottom:3px;}" +
    ".odds-flow .ofrow{padding:1px 0;}" +
    ".odds-flow .ofrow .mk{font-family:'Oswald';font-size:10px;letter-spacing:.04em;color:var(--ink-dim);margin-right:5px;}" +
    ".odds-flow .ofrow b{color:#cfe3ff;font-weight:700;}" +
    ".odds-flow .ofrow.strong b{color:#9bd5ff;}" +
    ".odds-flow .ofrow.flat{opacity:.5;}" +
    ".odds-flow .ofnote{margin-top:3px;color:#ffb02e;font-weight:700;}" +
    ".odds-flow .ofsplit{color:#ff9d5c;font-weight:700;}" +
    ".odds-flow .offoot{margin-top:3px;font-family:'Oswald';font-size:10px;color:#5b6b80;}" +
    ".odds-flow.nomatch{background:rgba(255,255,255,.02);border-style:dashed;border-color:var(--line);}" +
    ".card.collapsed .odds-flow{display:none;}" +
    ".frow.model.stake-ref{opacity:.55;}" +
    ".frow.model.stake-ref .mlbl{color:#7a8696;}";
  document.head.appendChild(css);

  /* ---- 去水隱含（優先用排盤板自己的 impliedAway） ---- */
  function impAway(oa, oh) {
    if (typeof impliedAway === "function") return impliedAway(oa, oh);
    if (isNaN(oa) || isNaN(oh) || oa <= 1 || oh <= 1) return null;
    return (1 / oa) / (1 / oa + 1 / oh);
  }
  function safeEsc(s) { return (typeof esc === "function") ? esc(s) : String(s); }

  /* ---- 找出對應這張卡的比賽（日期＋兩隊，主客顛倒也認） ---- */
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

  /* ---- 資料裡實際有哪些聯盟（只對「有在抓」的聯盟顯示「無盤口資料」） ---- */
  function feedLeagues() {
    var set = {};
    if (!feed || !feed.matches || typeof LEAGUES === "undefined") return set;
    for (var id in feed.matches) {
      var g = feed.matches[id], t = g.homeTeam || g.awayTeam;
      if (!t) continue;
      for (var k in LEAGUES) { if (LEAGUES[k].teams.indexOf(t) >= 0) { set[k] = true; break; } }
    }
    return set;
  }

  /* ---- 獨贏：三家去水隱含勝率自初盤到現在的平均移動 ---- */
  function mlSentiment(g) {
    var books = ["bet365", "12bet", "bwin"], moves = [];
    for (var i = 0; i < books.length; i++) {
      var b = g.ml && g.ml[books[i]];
      if (!b || !b.open) continue;
      var openP = impAway(b.open.away, b.open.home);
      var last = (b.live && b.live.length) ? b.live[b.live.length - 1] : b.open;
      var nowP = impAway(last.away, last.home);
      if (openP == null || nowP == null) continue;
      moves.push(nowP - openP);                    // 客隊隱含勝率變化（fraction）
    }
    if (!moves.length) return null;
    var avg = moves.reduce(function (s, x) { return s + x; }, 0) / moves.length;
    var pos = 0, neg = 0;
    moves.forEach(function (m) { if (m > 0.005) pos++; else if (m < -0.005) neg++; });
    return { mvpp: avg * 100, split: (pos > 0 && neg > 0), books: moves.length, towardAway: avg > 0 };
  }

  /* ---- 讓分：Bet365 完整變動（row0 最新、末列初盤） ---- */
  function hdMovement(g) {
    var rows = g.hd && g.hd.bet365;
    if (!rows || rows.length < 1) return null;
    var nl = parseFloat(rows[0].line), il = parseFloat(rows[rows.length - 1].line);
    if (isNaN(nl) || isNaN(il)) return null;
    var flipped = (nl > 0 && il < 0) || (nl < 0 && il > 0);   // 受讓方翻轉
    var dAbs = Math.abs(nl) - Math.abs(il);
    return { nl: nl, il: il, flipped: flipped, deepen: dAbs > 0.01, shrink: dAbs < -0.01 };
  }

  /* ---- 大小：Bet365 完整變動 ---- */
  function ouMovement(g) {
    var rows = g.ou && g.ou.bet365;
    if (!rows || rows.length < 1) return null;
    var nl = parseFloat(rows[0].line), il = parseFloat(rows[rows.length - 1].line);
    if (isNaN(nl) || isNaN(il)) return null;
    return { nl: nl, il: il, up: nl - il > 0.01, down: nl - il < -0.01 };
  }

  /* ---- 抓到的「獨贏熱門隊」（用最新去水隱含勝率，避免猜 Titan007 讓分正負號） ---- */
  function feedFavTeam(g) {
    var books = ["bet365", "12bet", "bwin"], ps = [];
    for (var i = 0; i < books.length; i++) {
      var b = g.ml && g.ml[books[i]];
      if (!b || !b.open) continue;
      var last = (b.live && b.live.length) ? b.live[b.live.length - 1] : b.open;
      var p = impAway(last.away, last.home);
      if (p != null) ps.push(p);
    }
    if (!ps.length) return null;
    var avgAway = ps.reduce(function (s, x) { return s + x; }, 0) / ps.length;
    if (Math.abs(avgAway - 0.5) < 0.02) return null;          // 太接近，不判熱門
    return avgAway > 0.5 ? g.awayTeam : g.homeTeam;
  }

  /* ---- 組出卡片上的分析區塊 ---- */
  function buildFlowBlock(it, g) {
    var wrap = document.createElement("div");
    wrap.className = "odds-flow no-drag";
    var html = "<div class='ofhd'>📡 盤口動向（自動）</div>";

    var ml = mlSentiment(g);
    if (ml) {
      var amv = Math.abs(ml.mvpp);
      if (amv < T1) {
        html += "<div class='ofrow flat'><span class='mk'>獨贏</span>幾乎沒動</div>";
      } else {
        var team = ml.towardAway ? g.awayTeam : g.homeTeam;
        var word = amv >= T3 ? "大幅轉向" : (amv >= T2 ? "看好" : "逐漸看好");
        var strong = amv >= T2;
        var splitTag = ml.split ? " <span class='ofsplit'>· 三家分歧</span>" : "";
        html += "<div class='ofrow " + (strong ? "strong" : "") + "'><span class='mk'>獨贏</span>市場<b>" +
                word + " " + safeEsc(team) + "</b> <span style='opacity:.7'>+" + amv.toFixed(1) + "pp</span>" + splitTag + "</div>";
      }
    }

    var hd = hdMovement(g);
    if (hd) {
      var t, cls;
      if (hd.flipped)      { t = "<b>讓分方翻轉</b>（" + hd.il + "→" + hd.nl + "）"; cls = "strong"; }
      else if (hd.deepen)  { t = "讓分加深 " + Math.abs(hd.il) + "→" + Math.abs(hd.nl); cls = ""; }
      else if (hd.shrink)  { t = "讓分縮小 " + Math.abs(hd.il) + "→" + Math.abs(hd.nl); cls = ""; }
      else                 { t = "持平"; cls = "flat"; }
      html += "<div class='ofrow " + cls + "'><span class='mk'>讓分</span>" + t + "</div>";
    }

    var ou = ouMovement(g);
    if (ou) {
      var ut;
      if (ou.up)        ut = "基準上移 " + ou.il + "→" + ou.nl;
      else if (ou.down) ut = "基準下移 " + ou.il + "→" + ou.nl;
      else              ut = "持平";
      html += "<div class='ofrow " + (ou.up || ou.down ? "" : "flat") + "'><span class='mk'>大小</span>" + ut + "</div>";
    }

    // 抓到的讓分方 vs STAKE（卡片 hdFav）
    var fav = feedFavTeam(g), cardFav = it[it.hdFav];
    if (fav && cardFav && fav !== cardFav) {
      html += "<div class='ofnote'>⚠ 抓到的讓分方（" + safeEsc(fav) + "）與 STAKE 相反，已記錄顛倒</div>";
    }

    if (g.lastUpdated) html += "<div class='offoot'>更新於 " + g.lastUpdated.slice(11, 16) + "</div>";
    wrap.innerHTML = html;
    return wrap;
  }

  function buildNoMatchBlock() {
    var wrap = document.createElement("div");
    wrap.className = "odds-flow nomatch no-drag";
    wrap.innerHTML = "<div class='ofhd'>📡 盤口動向</div><div class='ofrow flat'>無盤口資料（隊名可能對不上，或尚未開盤）</div>";
    return wrap;
  }

  /* ---- 把現有「市場」那條改標成「市場·STAKE（參考）」、淡化、改成同一套 3 段用詞；差距計算保留 ---- */
  function reframeStakeRow(cardEl, it) {
    var rows = cardEl.querySelectorAll(".formline .frow.model");
    for (var i = 0; i < rows.length; i++) {
      var lbl = rows[i].querySelector(".mlbl");
      if (!lbl || lbl.textContent.trim() !== "市場") continue;
      if (rows[i].classList.contains("stake-ref")) break;     // 已處理過
      rows[i].classList.add("stake-ref");
      lbl.textContent = "市場·STAKE";
      var mp = impAway(parseFloat(it.flipOddsAway), parseFloat(it.flipOddsHome));
      var mp0 = impAway(parseFloat(it.openOddsAway), parseFloat(it.openOddsHome));
      var mvEl = rows[i].querySelector(".mv");
      if (mvEl && mp != null && mp0 != null) {
        var mv = (mp - mp0) * 100, amv = Math.abs(mv);
        if (amv < T1) { mvEl.textContent = "初盤至今幾乎沒動"; }
        else {
          var team = mv > 0 ? it.away : it.home;
          mvEl.innerHTML = (amv >= T3 ? "大幅轉向" : (amv >= T2 ? "看好" : "逐漸看好")) + " " + safeEsc(team);
        }
      }
      var tag = document.createElement("span");
      tag.style.cssText = "margin-left:5px;font-size:10px;color:#7a8696;";
      tag.textContent = "（參考）";
      rows[i].appendChild(tag);
      break;
    }
  }

  /* ---- 包住 renderCard：原樣畫完，再加我的區塊 + 改 STAKE 那條 ---- */
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

  /* ---- 每次抓到新資料後，偵測並記錄「顛倒」旗標一次（避免 render 內狂存檔） ---- */
  function syncFlipFlags() {
    if (typeof state === "undefined" || !state.items) return false;
    var changed = false;
    state.items.forEach(function (it) {
      if (it.type !== "match") return;
      var g = feedGameFor(it);
      if (!g) return;
      var fav = feedFavTeam(g), cardFav = it[it.hdFav];
      var flip = !!(fav && cardFav && fav !== cardFav);
      if (!!it.autoHdFlip !== flip) { it.autoHdFlip = flip; changed = true; }
    });
    return changed;
  }

  /* ---- 用提前抓到的資料自動排當天盤（讓分盤口/大小基準留空） ---- */
  function autoArrangeFromFeed() {
    if (typeof closeMore === "function") closeMore();
    if (!feed || !feed.matches || !Object.keys(feed.matches).length) {
      alert("目前沒有抓到任何即將開打的比賽資料。\n（先確認 scraper 跑過、data/odds_log.json 已產生。）");
      return;
    }
    var byDate = {};
    for (var id in feed.matches) {
      var g = feed.matches[id];
      if (!g.homeTeam || !g.awayTeam) continue;               // 隊名沒對上的先略過
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
      switchDate(best);                                       // 切換後 state.items 指向新看板
      target = best;
    }
    if (typeof snapshot === "function") snapshot();           // 我的復原點（加卡前）
    var have = {};                                            // 盤面已有的兩隊（不分主客）
    state.items.forEach(function (it) {
      if (it.type === "match") have[[it.away, it.home].sort().join("|")] = true;
    });
    var added = 0;
    byDate[target].forEach(function (g) {
      var key = [g.awayTeam, g.homeTeam].sort().join("|");
      if (have[key]) return;
      var lg = null;
      for (var k in LEAGUES) { if (LEAGUES[k].teams.indexOf(g.homeTeam) >= 0) { lg = k; break; } }
      var col = lg ? LEAGUES[lg].color : "var(--mlb)";
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
    if (typeof autoLayout === "function") {                   // 整理版面（只動位置、不動任何燈或內容）
      var ws = (typeof suppress !== "undefined");
      if (ws) suppress = true;                                // 壓掉 autoLayout 內建的 snapshot → 只留一個復原步
      try { autoLayout(); } finally { if (ws) suppress = false; }
    } else { save(); render(); }
    var b = document.getElementById("saveBadge");
    if (b) { b.textContent = "已自動排入 " + added + " 場 ✓"; b.classList.add("show"); setTimeout(function () { b.classList.remove("show"); }, 1800); }
  }

  /* ---- 抓資料 ---- */
  function fetchFeed() {
    fetch(FEED_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) {
        if (j && j.matches) {
          feed = j;
          if (syncFlipFlags() && typeof save === "function") save();
          if (typeof render === "function") render();
        }
      })
      .catch(function () { /* 離線 / 還沒在 Pages 上 / 檔還沒生 — 排盤板照常運作 */ });
  }

  /* ---- 選單加兩顆鈕 ---- */
  function injectButtons() {
    var menu = document.getElementById("moreMenu");
    if (!menu) return;
    var sep = document.createElement("div"); sep.className = "sep";
    var b1 = document.createElement("button"); b1.textContent = "⚡ 用賠率自動排今天的盤";
    b1.onclick = function (e) { e.stopPropagation(); autoArrangeFromFeed(); };
    var b2 = document.createElement("button"); b2.textContent = "🔄 更新賠率資料";
    b2.onclick = function (e) {
      e.stopPropagation(); fetchFeed();
      var b = document.getElementById("saveBadge");
      if (b) { b.textContent = "已重新抓取賠率 ✓"; b.classList.add("show"); setTimeout(function () { b.classList.remove("show"); }, 1500); }
    };
    menu.appendChild(sep); menu.appendChild(b1); menu.appendChild(b2);
  }

  /* ---- 啟動 ---- */
  function boot() { injectButtons(); fetchFeed(); setInterval(fetchFeed, REFRESH_MS); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 給測試用（在瀏覽器無副作用）
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { mlSentiment: mlSentiment, hdMovement: hdMovement, ouMovement: ouMovement, feedFavTeam: feedFavTeam, T1: T1, T2: T2, T3: T3 };
  }
})();
