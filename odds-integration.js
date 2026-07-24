/* ============================================================
   排盤板 ⇄ 自動賠率  add-on
   用法：把這支檔放到 index.html 同一個資料夾（同 repo），
        然後在 index.html 的  </body>  正上方、原本那段大 <script> 之後，加一行：
            <script src="./odds-integration.js"></script>
   它不改動上面任何一行；不要時把那一行刪掉即可。

   做的事：
   - 讀 ./data/odds_log.json（scraper commit 進同 repo 的賠率），每 5 分鐘自動再讀
   - 以「日期＋兩隊＋開球時間」對到卡片（主客顛倒也認得；雙重賽同日同對戰兩場用開球時間區分）；用每場的 league 判聯盟
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

  // 直接讀 GitHub raw，繞過 GitHub Pages 的 build 節流。
  // 原因：Pages 每次 commit 要重新 build 才更新對外檔，而每 5 分鐘 commit 會灌爆
  // Pages 的 build 速率(約每小時 10 次)→ 對外檔嚴重落後。raw 反映 commit 幾乎即時，
  // 且回應帶 CORS 允許跨來源讀取。若 raw 讀失敗(極少數)，自動退回 Pages 相對路徑。
  var REPO = "youngjchen/Sportbetting-PLUS";   // 你的 owner/repo（改名要同步改）
  var BRANCH = "main";
  var FEED_URL = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/data/odds_log.json";
  var FEED_FALLBACK = "./data/odds_log.json";
  var REFRESH_MS = 5 * 60 * 1000;
  var feed = { matches: {}, lastUpdated: null };
  // 收盤讓分方（供結算防呆核對用；刻意不掛在卡片物件上——doc normalizer 可能濾掉不認得的欄位，
  // 掛上去等於污染同步。只存在這支模組的記憶體裡，重整頁面就重建，volatile 沒關係，settle 當下讀得到即可）。
  var feedCloseHd = {};

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
  // 讓分/大小水位去水：自動辨識歐賠或港盤。
  // 港盤的讓分/大小至少有一邊 <1（讓分方水位低），歐賠兩邊都 >1，
  // 故以「任一邊 <1」判港盤，整列 +1 約當歐賠（HK→Dec = 賠率+1）。
  function devig(a, b) {
    a = parseFloat(a); b = parseFloat(b);
    if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
    if (a < 1.0 || b < 1.0) { a += 1; b += 1; }
    return (1 / a) / (1 / a + 1 / b);
  }
  function fmtHd(v) { var n = parseFloat(v); if (isNaN(n)) return String(v || "—"); return n > 0 ? "+" + n : "" + n; }
  function fmtOu(v) { var n = parseFloat(v); if (isNaN(n)) return String(v || "—"); return "" + n; }

  /* ---- 開球時間工具：雙重賽(同日同對戰兩場)用開球時間區分 ---- */
  // TOL_MIN：兩個時間差在此內視為「同一場」。雙重賽兩場至少差 2 小時以上（比賽本身就要打 2.5h+），
  // 而來源的時間微調（如 Titan007 給 07:07、官方 07:15）都在 1 小時內 → 120 分是安全分界，
  // 與 pregame-integration.js findGame 的 TOL 同值。
  var TOL_MIN = 120;
  function hhmmToMin(s) { var m = /(\d{1,2}):(\d{2})/.exec(s == null ? "" : String(s)); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function gStartHHMM(g) { return g && g.startISO ? String(g.startISO).slice(11, 16) : (g && g.time ? (String(g.time).match(/\d{1,2}:\d{2}/) || [""])[0] : ""); }
  function minDiff(a, b) { var x = hhmmToMin(a), y = hhmmToMin(b); return (x == null || y == null) ? null : Math.abs(x - y); }
  // 官方/玩運彩的開球時間（__psFusion 融合資料：MLB=官方 API、其他=玩運彩）。
  // Titan007 的時間偶有錯（2026-07-17 白襪@藍鳥給 07:07、官方 07:15）→ 卡片顯示時間以這裡為權威。
  function tmMatch(b, s) { b = String(b == null ? "" : b).trim(); s = String(s == null ? "" : s).trim(); return !!b && !!s && (b === s || b.indexOf(s) >= 0 || s.indexOf(b) >= 0); }
  function pregameTimesFor(away, home, dateKey) {
    try {
      var ps = (window.__psFusion && window.__psFusion.getData) ? window.__psFusion.getData() : null;
      if (!ps || !ps.length) return [];
      var out = [];
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (String(p.date || "").slice(0, 10) !== dateKey) continue;
        if (!(tmMatch(away, p.awayTeam) && tmMatch(home, p.homeTeam))) continue;
        var m = String(p.gameTime || p.time || "").match(/\d{1,2}:\d{2}/);
        if (m) out.push(m[0].length === 4 ? "0" + m[0] : m[0]);
      }
      return out;
    } catch (e) { return []; }
  }
  // 這場 feed 比賽的「權威顯示時間」：官方/玩運彩裡挑離 Titan 時間 ≤TOL 的最近場次；沒有→用 Titan 的
  function authTimeFor(g, dateKey) {
    var titanT = gStartHHMM(g) || "";
    var cands = pregameTimesFor(g.awayTeam, g.homeTeam, dateKey);
    var best = null, bd = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var d = minDiff(cands[i], titanT);
      if (d != null && d < bd) { bd = d; best = cands[i]; }
    }
    return (best && bd <= TOL_MIN) ? best : titanT;
  }
  // 歸檔場(id 帶 @)是否可信：官方/玩運彩同對戰有 ±TOL 內的場次才算真場次
  //（2026-07-18 Titan 錯標 04:10 歸檔＝官方沒有的時段 → 排盤/認領都不該把它當一場）；
  // 官方完全沒該對戰資料時放行（寧可信 Titan，別因 ps 斷線丟掉真歸檔場）。
  function archiveCorroborated(g, dateKey) {
    if (String(g.id).indexOf("@") < 0) return true;
    var ts = pregameTimesFor(g.awayTeam, g.homeTeam, dateKey);
    if (!ts.length) return true;
    var t = gStartHHMM(g);
    return ts.some(function (x) { var d = minDiff(x, t); return d != null && d <= TOL_MIN; });
  }
  // 多個候選(雙重賽)時，用卡片開球時間(it.gameTime)挑最接近的那場；差超過 TOL 寧可不配（絕不錯配）。
  // 單一候選照舊回傳（真改期時要能跟隨）。
  function pickByTime(cands, it) {
    if (cands.length <= 1) return cands[0] || null;
    var want = hhmmToMin(it && it.gameTime);
    if (want == null) return cands[0];                       // 卡片未記開球時間 → 退回第一場(盡力)
    var best = null, bd = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var t = hhmmToMin(gStartHHMM(cands[i])); if (t == null) continue;
      var d = Math.abs(t - want); if (d < bd) { bd = d; best = cands[i]; }
    }
    return (best && bd <= TOL_MIN) ? best : null;
  }
  // 純函式：給「盤面已有卡片」與「當天 feed 的場」，回傳「還要新增哪幾場」(雙重賽會回該對戰缺的每一場)
  // 唯一鍵＝對戰＋開球時間；時間差 ≤TOL 視為同一場（吸收 Titan/官方之間的分鐘級差異，避免重複排卡）；
  // 沒記時間的舊卡每場扣一張。
  // 同對戰 feed 場次先自我去重：歸檔場(id 帶 @) 與活列時間 ±TOL 內＝同一場（2026-07-19
  // 海盜@守護者 172743(01:10)+歸檔172759@0110(01:10) 被當兩場 → 每次自動排盤多生一張空白卡）。
  function dedupeFeedGames(games) {
    var live = games.filter(function (g) { return String(g.id).indexOf("@") < 0; });
    var out = live.slice();
    games.forEach(function (g) {
      if (String(g.id).indexOf("@") < 0) return;
      var t = hhmmToMin(gStartHHMM(g));
      var dup = out.some(function (o) {
        var d = (t == null) ? null : minDiff(gStartHHMM(o), gStartHHMM(g));
        return d != null && d <= TOL_MIN;
      });
      if (!dup) out.push(g);
    });
    return out;
  }
  function gamesToAdd(existingItems, feedGames) {
    function pk(a, b) { return [a, b].sort().join("|"); }
    var byPair = {};
    (feedGames || []).forEach(function (g) {
      if (!g || !g.homeTeam || !g.awayTeam) return;
      var k = pk(g.awayTeam, g.homeTeam);
      (byPair[k] = byPair[k] || []).push(g);
    });
    var out = [];
    Object.keys(byPair).forEach(function (key) {
      var games = dedupeFeedGames(byPair[key]).sort(function (a, b) { return (hhmmToMin(gStartHHMM(a)) || 0) - (hhmmToMin(gStartHHMM(b)) || 0); });
      var cardTimes = [], noTime = 0;
      (existingItems || []).forEach(function (it) {
        if (!it || it.type !== "match" || pk(it.away, it.home) !== key) return;
        var t = hhmmToMin(it.gameTime);
        if (t != null) cardTimes.push({ t: t, used: false }); else noTime++;
      });
      games.forEach(function (g) {
        var gm = hhmmToMin(gStartHHMM(g));
        if (gm != null) {
          var best = null, bd = Infinity;
          cardTimes.forEach(function (c) { if (!c.used) { var d = Math.abs(c.t - gm); if (d < bd) { bd = d; best = c; } } });
          if (best && bd <= TOL_MIN) { best.used = true; return; }   // 這場已有卡（±TOL 內）
        }
        if (noTime > 0) { noTime--; return; }                 // 有沒記時間的舊卡 → 視為已涵蓋一場
        out.push(g);
      });
    });
    return out;
  }

  /* ---- 對應這張卡的比賽（唯一鍵：先認 oddsId，再 日期＋兩隊＋開球時間；主客顛倒也認） ----
     oddsId 直配加「時間檢核」：Titan007 會把同一列搬去另一場（2026-07-17 光芒@紅襪雙重賽，
     id=172742 從 01:35 整列搬到 07:10）→ 卡片記的開球時間與 id 對到的場差超過 TOL 時，
     id 只降級為普通候選，交給開球時間分辨；否則 01:35 的卡會吃到 07:10 場的賠率、
     連卡片時間都被改寫（一天兩張 07:10 卡的事故根因）。 */
  function feedGameFor(it) {
    if (!feed || !feed.matches || typeof doc === "undefined" || !doc.activeDate) return null;
    var dateKey = doc.activeDate, ms = feed.matches, cands = [];
    for (var id in ms) {
      var g = ms[id];
      if (!g.homeTeam || !g.awayTeam) continue;
      if ((g.startISO || "").slice(0, 10) !== dateKey) continue;
      var teamsOk = (g.homeTeam === it.home && g.awayTeam === it.away) ||
                    (g.homeTeam === it.away && g.awayTeam === it.home);
      if (it.oddsId != null && String(g.id) === String(it.oddsId)) {
        var dt = minDiff(it.gameTime, gStartHHMM(g));
        if (dt == null || dt <= TOL_MIN) return g;             // 時間相符(或無從比對) → 直配(最穩)
        if (!teamsOk) { cands.push(g); continue; }             // 時間差太大 → 降級為候選
      }
      if (teamsOk) cands.push(g);
    }
    var picked = pickByTime(cands, it);                        // 雙重賽用開球時間區分
    if (!picked) return null;
    // 唯一候選但時間差超過 TOL：官方顯示這天該對戰 ≥2 場（雙重賽）→ 那是別場，寧可回 null
    // （Titan 常只列雙重賽其中一場）；官方單場 → 真改期，跟隨（syncFlipFlags 會更新卡片時間）。
    var d = minDiff(it.gameTime, gStartHHMM(picked));
    if (d != null && d > TOL_MIN && pregameTimesFor(it.away, it.home, dateKey).length >= 2) return null;
    return picked;
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

  /* ---- 結算防呆用：收盤讓分方（Bet365 via Titan feed，proxy，只標記不糾正）----
     rows[0]＝最新（收盤，或抓取窗內最後一次更新）；rows[末]＝初盤——同 index.js parseHistoryTable
     的註解「rows[0]=最新, rows[末]=初盤」與上面 hdSentiment() 的 now=rows[0] 一致，
     千萬別讀反（讀到 rows[末] 等於拿初盤當收盤，整個防呆會失效、也驗證不出響尾蛇@紅雀那種事故）。
     line 正負號（同 index.js parseHistoryTableTs 註解）：正＝主讓、負＝客讓。 */
  function deriveCloseHd(g) {
    var rows = g && g.hd && g.hd.bet365;
    if (!rows || !rows.length) return null;
    var row = rows[0];
    if (!row) return null;
    var line = parseFloat(row.line);
    if (isNaN(line)) return null;
    return { fav: line < 0 ? "away" : "home", line: Math.abs(line) };
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
          tierOf(a1) + " <span class='of-tm'>" + safeEsc(team) + "</span>" + (ml.split ? " · 分歧" : ""),
          "", a1 >= T2 ? "strong" : "");
      }
    }

    // 讓分
    var hd = hdSentiment(g);
    if (hd) {
      if (hd.lean && !hd.lean.flat) {
        var a2 = Math.abs(hd.lean.mvpp);
        rows += ofRow("讓分",
          tierOf(a2) + " <span class='of-tm'>" + safeEsc(hd.lean.team) + hd.lean.suffix + "</span>",
          "", a2 >= T2 ? "strong" : "");
      } else rows += ofRow("讓分", "持平", "", "flat");
    }

    // 大小
    var ou = ouSentiment(g);
    if (ou) {
      if (ou.lean && !ou.lean.flat) {
        var a3 = Math.abs(ou.lean.mvpp);
        rows += ofRow("大小",
          tierOf(a3) + " <span class='of-tm'>" + ou.lean.side + "</span>",
          "", a3 >= T2 ? "strong" : "");
      } else rows += ofRow("大小", "持平", "", "flat");
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

  /* ---- 填入卡片每個市場的「賠率動向」評語（B 版兩區式卡：.bcmt[data-cmt]） ---- */
  function setCmt(cardEl, key, html, cls) {
    var sp = cardEl.querySelector('.bcmt[data-cmt="' + key + '"]');
    if (!sp) return;
    sp.className = "bcmt" + (cls ? (" " + cls) : "");
    sp.innerHTML = html;
  }
  function L(t) { return "<span class='l'>賠率</span>" + t; }
  function fillCmt(cardEl, it, g) {
    // 對到比賽但三市場都沒抓到盤口(常見於雙重賽第二場：Titan007 只有賽程、無賠率)→ 明確標「尚無盤口」，不要留白
    var noOdds = (!g.ml || !Object.keys(g.ml).length)
      && !(g.hd && g.hd.bet365 && g.hd.bet365.length)
      && !(g.ou && g.ou.bet365 && g.ou.bet365.length);
    if (noOdds) { ["ml", "hd", "tot"].forEach(function (k) { setCmt(cardEl, k, L("尚無盤口"), "flat"); }); return; }
    // 獨贏
    var ml = mlSentiment(g);
    if (ml) {
      var a1 = Math.abs(ml.mvpp);
      if (a1 < T1) setCmt(cardEl, "ml", L("持平"), "flat");
      else {
        var team = ml.towardAway ? g.awayTeam : g.homeTeam;
        setCmt(cardEl, "ml", L(tierOf(a1) + " <span class='tm'>" + safeEsc(team) + "</span>" + (ml.split ? " · 分歧" : "")), a1 >= T2 ? "strong" : "");
      }
    }
    // 讓分
    var hd = hdSentiment(g);
    if (hd) {
      if (hd.lean && !hd.lean.flat) {
        var a2 = Math.abs(hd.lean.mvpp);
        setCmt(cardEl, "hd", L(tierOf(a2) + " <span class='tm'>" + safeEsc(hd.lean.team) + hd.lean.suffix + "</span>"), a2 >= T2 ? "strong" : "");
      } else setCmt(cardEl, "hd", L("持平"), "flat");
    }
    // 大小
    var ou = ouSentiment(g);
    if (ou) {
      if (ou.lean && !ou.lean.flat) {
        var a3 = Math.abs(ou.lean.mvpp);
        setCmt(cardEl, "tot", L(tierOf(a3) + " <span class='tm'>" + ou.lean.side + "</span>"), a3 >= T2 ? "strong" : "");
      } else setCmt(cardEl, "tot", L("持平"), "flat");
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
        var g = feedGameFor(it);
        if (g) fillCmt(cardEl, it, g);
        else {
          // 對不到比賽且該聯盟有在抓 → 淡淡標一下
          var lg = (typeof leagueOf === "function") ? leagueOf(it) : null;
          if (lg && feedLeagues()[lg]) {
            ["ml", "hd", "tot"].forEach(function (k) { setCmt(cardEl, k, "<span class='l'>賠率</span>無盤口", "flat"); });
          }
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
      feedCloseHd[it.id] = deriveCloseHd(g);   // 收盤讓分方快照，供結算防呆核對（見檔頭 feedCloseHd 註解）
      // 開球時間：以官方/玩運彩為權威（±TOL 內修正 Titan 的怪時間，如藍鳥主場 07:07→官方 07:15），
      // 沒對到才用 Titan 的。feedGameFor 已保證 g 與卡片時間相符（或單場改期），這裡放心跟隨。
      var t = (typeof doc !== "undefined" && doc.activeDate) ? authTimeFor(g, doc.activeDate) : gStartHHMM(g);
      if (t && it.gameTime !== t) { it.gameTime = t; changed = true; }
      var fav = feedFavTeam(g), cardFav = it[it.hdFav];
      // 記錄工作流判定的讓分熱門隊，讓卡片可即時比對（切換讓分方後提示會即時更新）
      if (it.feedFavTeam !== (fav || null)) { it.feedFavTeam = fav || null; changed = true; }
      var flip = !!(fav && cardFav && fav !== cardFav);
      if (!!it.autoHdFlip !== flip) { it.autoHdFlip = flip; changed = true; }
    });
    return changed;
  }

  // 卡片是否帶使用者資料（燈/注/結算）。hdVal/totVal 可能是自動帶入不算；
  // 空白卡若對不到真實場次可安全移除。
  function cardHasData(c) {
    if (!c) return false;
    if (c.settled) return true;
    var opts = [c.mlAway, c.mlHome, c.hdGive, c.hdRecv, c.over, c.under];
    return opts.some(function (o) { return o && (((o.lights | 0) > 0) || o.bet); });
  }

  /* ---- 卡片時間自癒（認領制）：修「重複卡」與「孤兒卡」兩種殘局 ----
     重複卡：同對戰同開球時間 ≥2 張（2026-07-17 Titan 搬列事故：01:35 卡被改成 07:10）。
     孤兒卡：卡片時間對不上該對戰任何已知場次 ±TOL（2026-07-18 事故：官方 G1=01:10、
             Titan 給 04:10，卡片掛在不存在的時段 → 台彩盤/比分/自動結算全對不到）。
     已知場次 = odds feed（含歸檔舊場）∪ 官方/玩運彩(__psFusion)。
     作法：每個對戰做一輪「認領」——卡片【由新到舊】認領 ±TOL 內最近的未被認領場次；
     認領不到的卡【由舊到新】依序改到沒人認領的場次（時間由早到晚）。
     新卡先認領 → 重複時被改的是最舊那張（事發時先建立的才是被改走的原場）。 */
  function healDupCards() {
    if (typeof state === "undefined" || !state.items || typeof doc === "undefined" || !doc.activeDate) return false;
    var dateKey = doc.activeDate, changed = false;
    function pk(a, b) { return [a, b].sort().join("|"); }
    var byPair = {};
    state.items.forEach(function (it) {
      if (!it || it.type !== "match" || !it.gameTime) return;
      var k = pk(it.away, it.home);
      (byPair[k] = byPair[k] || []).push(it);
    });
    Object.keys(byPair).forEach(function (key) {
      var cards = byPair[key];
      var away = cards[0].away, home = cards[0].home;
      // 這天該對戰的完整場次時間：odds feed（含歸檔場）∪ 官方/玩運彩
      var times = {};
      for (var id in (feed.matches || {})) {
        var g = feed.matches[id];
        if (!g || !g.homeTeam || !g.awayTeam) continue;
        if ((g.startISO || "").slice(0, 10) !== dateKey) continue;
        var ok = (g.homeTeam === home && g.awayTeam === away) || (g.homeTeam === away && g.awayTeam === home);
        if (!ok) continue;
        if (!archiveCorroborated(g, dateKey)) continue;   // 官方沒有的孤立歸檔時段不算場次
        var t = gStartHHMM(g); if (t) times[t] = g;
      }
      pregameTimesFor(away, home, dateKey).forEach(function (t) { if (!(t in times)) times[t] = null; });
      var known = Object.keys(times).sort();
      if (!known.length) return;
      // 認領順序：有使用者資料的卡最優先（空白卡不得搶走真卡的時段——2026-07-19 大都會@費城人
      // 空白新卡先佔走 03:05、資料卡永遠流浪的死循環），同類再新卡先認。claimed[t]=認領的卡。
      var claimed = {}, unplaced = [];
      cards.slice().sort(function (a, b) {
        var da = cardHasData(a) ? 1 : 0, db = cardHasData(b) ? 1 : 0;
        if (da !== db) return db - da;
        return (+b.id || 0) - (+a.id || 0);
      }).forEach(function (c) {
        var best = null, bd = Infinity;
        known.forEach(function (t) {
          if (claimed[t]) return;
          var d = minDiff(c.gameTime, t);
          if (d != null && d < bd) { bd = d; best = t; }
        });
        if (best != null && bd <= TOL_MIN) claimed[best] = c;
        else unplaced.push(c);
      });
      if (!unplaced.length) return;
      var missing = known.filter(function (t) { return !claimed[t]; });
      unplaced.sort(function (a, b) {
        var da = cardHasData(a) ? 1 : 0, db = cardHasData(b) ? 1 : 0;
        if (da !== db) return db - da;
        return (+a.id || 0) - (+b.id || 0);
      });
      var rest = [];
      unplaced.forEach(function (card) {
        if (missing.length) {
          var t2 = missing.shift(), g2 = times[t2];
          card.gameTime = t2;
          card.oddsId = g2 ? g2.id : null;
          claimed[t2] = card; changed = true;
          try { console.log("[賠率] 修復卡片開球時間：", away, "@", home, "→", t2); } catch (e) {}
        } else rest.push(card);
      });
      rest.forEach(function (card) {
        if (cardHasData(card)) {
          // 資料卡沒場次可認：若某時段被空白卡占走 → 資料卡取代、空白卡移除；否則不動使用者資料
          var t3 = known.find(function (t) { return claimed[t] && !cardHasData(claimed[t]); });
          if (t3) {
            var blank = claimed[t3], g3 = times[t3];
            state.items = state.items.filter(function (x) { return x.id !== blank.id; });
            card.gameTime = t3;
            card.oddsId = g3 ? g3.id : null;
            claimed[t3] = card; changed = true;
            try { console.log("[賠率] 資料卡取代空白卡：", away, "@", home, "→", t3); } catch (e) {}
          }
          return;
        }
        // 空白且對不到任何已知場次（歸檔重複／改期遺留，如 04:10 幽靈卡）→ 移除
        state.items = state.items.filter(function (x) { return x.id !== card.id; });
        changed = true;
        try { console.log("[賠率] 移除找不到場次的空白卡：", away, "@", home, card.gameTime); } catch (e) {}
      });
    });
    if (changed) badge("已修復卡片開球時間 ✓");
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
    // 孤立歸檔時段（官方沒有）先剔除，避免替不存在的場次排卡
    var candGames = byDate[target].filter(function (g) { return archiveCorroborated(g, target); });
    var toAdd = gamesToAdd(state.items, candGames);        // 雙重賽會回該對戰缺的每一場(含第二場)
    var added = 0;
    toAdd.forEach(function (g) {
      var lg = g.league || null;
      if (!lg && typeof LEAGUES !== "undefined") for (var k in LEAGUES) { if (LEAGUES[k].teams.indexOf(g.homeTeam) >= 0) { lg = k; break; } }
      var col = (lg && typeof LEAGUES !== "undefined" && LEAGUES[lg]) ? LEAGUES[lg].color : "var(--mlb)";
      var fav = feedFavTeam(g);
      state.items.push({
        id: uid++, type: "match", x: 0, y: 0,
        away: g.awayTeam, home: g.homeTeam, awayColor: col, homeColor: col,
        gameTime: authTimeFor(g, target) || "", oddsId: g.id, // 唯一鍵：開球時間(官方為權威) + Titan007 id
        mlAway: { lights: 0 }, mlHome: { lights: 0 },
        hdFav: (fav === g.awayTeam ? "away" : "home"), hdVal: "",
        hdGive: { lights: 0 }, hdRecv: { lights: 0 },
        totVal: "", over: { lights: 0 }, under: { lights: 0 }
      });
      added++;
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
  function getJSON(url) {
    return fetch(url + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  // 永遠可見的賠率時間戳記（標頭 #oddsStamp）
  function updateOddsStamp() {
    var el = document.getElementById("oddsStamp");
    if (!el) return;
    var t = (feed && feed.lastUpdated) ? feed.lastUpdated.slice(5, 16).replace("T", " ") : null;  // MM-DD HH:MM
    el.textContent = t ? ("賠率更新 " + t) : "賠率：尚未取得";
  }
  function fetchFeed(force) {
    return getJSON(FEED_URL)
      .catch(function () { return getJSON(FEED_FALLBACK); })   // raw 失敗(如 CORS) → 退回 Pages 相對路徑
      .then(function (j) {
        if (!j || !j.matches) throw new Error("空檔");
        var changed = (j.lastUpdated !== feed.lastUpdated);
        feed = j;
        var healed = healDupCards();                       // 先修殘局（重複卡），再同步旗標
        var flipChanged = syncFlipFlags();
        if ((healed || flipChanged) && typeof save === "function") save();
        if ((force || ((changed || healed || flipChanged) && !anyModalOpen() && !editingNow())) && typeof render === "function") render();
        updateOddsStamp();
        return { ok: true, lastUpdated: j.lastUpdated, changed: changed };
      });
  }

  /* ---- 鈕：自動排盤→選單；手動更新→快捷鍵（右下，跟 🔍 / 結算 同排） ---- */
  function injectButtons() {
    var menu = document.getElementById("moreMenu");
    if (menu && !document.getElementById("autoArrangeBtn")) {
      var b1 = document.createElement("button"); b1.id = "autoArrangeBtn"; b1.textContent = "⚡ 用賠率自動排今天的盤";
      b1.onclick = function (e) { e.stopPropagation(); autoArrangeFromFeed(); };
      var anchor = document.getElementById("collapseAllBtn");   // 放到原「依聯盟排版」的位置(收合/展開全部 之前)
      if (anchor) menu.insertBefore(b1, anchor); else menu.appendChild(b1);
    }
    var qb = document.getElementById("zoomctlBtns");
    if (qb && !document.getElementById("refreshOddsQuickBtn")) {
      var r = document.createElement("button");
      r.id = "refreshOddsQuickBtn"; r.className = "fit"; r.title = "更新賠率"; r.textContent = "🔄";
      r.onclick = function (e) {
        e.stopPropagation();
        badge("更新中…");
        fetchFeed(true).then(function (res) {
          var t = (res.lastUpdated || "").slice(5, 16).replace("T", " ");   // MM-DD HH:MM
          badge(res.changed ? ("賠率已更新 " + t + " ✓") : ("雲端仍是 " + t + "（scraper 未產新檔）"));
        }).catch(function () {
          badge("抓取失敗 · 是否在 GitHub Pages 上？");
        });
      };
      qb.appendChild(r);
    }
  }

  /* ---- 啟動 ---- */
  function boot() {
    injectButtons(); fetchFeed(false).catch(function () {});
    setInterval(function () { fetchFeed(false).catch(function () {}); }, REFRESH_MS);
    // 手機回前景立即補抓（背景分頁計時器被凍結，回來不補會停在舊賠率）
    document.addEventListener("visibilitychange", function () { if (!document.hidden) fetchFeed(false).catch(function () {}); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // ---- 對外只讀 accessor（供 index.html 結算流程核對收盤讓分方；本檔案原本沒有掛任何 window.__odds*
  // 物件，只有 window.__oddsAddonLoaded 這個布林旗標——這裡仿照 __expertPicks / __ghSync 的既有慣例
  // 新開一個物件掛出去，additive，不影響任何既有行為）----
  window.__oddsIntegration = { closeHdFor: function (id) { return feedCloseHd[id] || null; } };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { mlSentiment: mlSentiment, hdSentiment: hdSentiment, ouSentiment: ouSentiment, feedFavTeam: feedFavTeam, devig: devig, tierOf: tierOf, T1: T1, T2: T2, T3: T3, pickByTime: pickByTime, gStartHHMM: gStartHHMM, hhmmToMin: hhmmToMin, gamesToAdd: gamesToAdd, TOL_MIN: TOL_MIN, minDiff: minDiff, authTimeFor: authTimeFor, pregameTimesFor: pregameTimesFor, feedGameFor: feedGameFor, healDupCards: healDupCards, dedupeFeedGames: dedupeFeedGames, archiveCorroborated: archiveCorroborated, cardHasData: cardHasData, deriveCloseHd: deriveCloseHd, _setFeed: function (f) { feed = f; } };
  }
})();
