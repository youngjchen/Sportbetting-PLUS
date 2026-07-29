# 交接檔：2026-07-29「卡片沒顯示 BET365／台彩讓分提示條」事故全記錄

> 目的：交給 Codex 審查。本檔由肇事的 Claude 撰寫，包含當日全部做法、犯的錯、補救，
> 以及「我可能還埋著雷」的自首清單。審查者請以懷疑視角逐項驗證，不要信任本檔結論。
> 台灣時間（UTC+8）。repo：youngjchen/Sportbetting-PLUS。

---

## 一、症狀與資料鏈背景

**使用者回報（7/29 下午）**：韓職（KBO）、中職（CPBL）7/29 卡片上「國際軸藍帶」
（顯示 `bet365 X讓N・台彩 Y讓N` 的那條，程式內 class=`intl-strip`/`intl-more`）完全沒出現；MLB 正常。

**資料鏈**（審查時照這條鏈追）：
```
Titan007（賠率源，axios 直抓，無 Cloudflare 問題）
  └─ index.js（scrape.yml 雲端迴圈每 ~6 分跑一次）
       ├─ data/odds_log.json     頂層 {lastUpdated, matches{}}，場次日期在 startISO
       └─ buildIntlState() → data/intl_state.json   鍵=`lg|YYYY-MM-DD|客隊|主隊`（雙重賽加 `|HH:MM`）
            台彩側來源：data/lottery_series.json（序列優先）＋ data/pregame_data.json 的 lotteryHandicap（後備）
板端 index.html：loadIntlState() 每 5 分 fetch data/intl_state.json（相對路徑=GitHub Pages）
  └─ renderCardB 內 intlFor(it) 查 `lg|doc.activeDate|away|home` → 渲染藍帶
```

## 二、診斷過程（含我犯的第一個錯）

1. `intl_state.json`：7/29 只有 mlb 14 場，kbo/cpbl **0 場**；7/28 亞洲場都在 → 斷點在產生器。
2. `odds_log.json`：kbo 5 場、cpbl 3 場 7/29 **都在**，但——
   - **錯誤①（診斷誤判）**：我先用 `Object.keys(g.hd).length` 判斷「有讓分資料」→ 回 true。
     實際上 `g.hd = { bet365: [] }`：**物件有 key、陣列是空的**。正確檢查是 `g.hd.bet365.length`。
     這個誤判讓我先走了一條錯路（懷疑 PK 平手盤被過濾）才回頭。
3. 真相：Titan 上 bet365 對 kbo/cpbl 7/29 的讓分列**全空**＝「Bet365 亞洲盤晚貼」
   （已知行為，7/4 事故記錄過，通常傍晚才開）。同時**台彩中午就開盤了**
   （pregame_data 裡味全@富邦 主讓1.5、培證@雙子 主讓2.5 等）。
4. **架構級根因**：`buildIntlState()` 只在該場有 bet365 讓分證據（`e._hdTs` 非空且有非走地列）
   時才建條目；台彩顯示掛在同一條目上 → **Bet365 沒開＝台彩也整條看不見**。

## 三、修法（commit `2f22fbeca`，14:40）

### index.js — 「台彩先行條目」pass
位置：`buildIntlState()` 內、主建立迴圈之後、「補算 pass」之前。邏輯：
- 掃 `log.matches`，算出與主迴圈**相同規則**的 key（雙開賽時間 ≥2 加 `|HH:MM`）。
- 已有完整條目（`games[key].is` 有值）→ 跳過。
- `serMap[key]`／`lotMap[key]` 都沒有台彩側 → 不建。
- 否則建 stub：`{is:null, il:null, sw:0, tr:null, iseq:[], ls:null, …, u:stamp}`，
  丟給既有 `applyLot()` 算台彩側（`is=null` 時 verdict 邏輯自動跳過），`stub.ls` 有值才留。
- stub 的每輪更新靠這個 pass 自己（既有「補算 pass」開頭是 `if(!e.is) continue`，不碰 stub）。
- Bet365 開盤後，主迴圈用同 key 直接覆寫成完整條目。

### index.html — 藍帶與 bet365 解耦（三處，刻意行數中性，理由見「已知地雷」§7）
- 出帶條件：`if((ist && ist.is) || epSwShow)` → `if((ist && (ist.is || ist.ls)) || epSwShow)`
- 台彩段：`${(has&&ist.ls)?…}` → `${(ist&&ist.ls)?…}`；bet365 無方向時顯示「bet365 未開盤」
- 展開層：「台彩換邊 ⇄N」列從 has(bet365) 分支移出獨立判斷；無 bet365 時顯示
  「bet365 讓分未開盤（亞洲盤常較晚開）」

### 驗證（當時）
- 本機實跑 `node index.js` 一輪 → intl_state 出現 kbo 5、cpbl 2 條目
  （台鋼@統一因台彩自己沒開盤、正確不建）。
- 本機 python 靜態伺服器（port 8156）注入味全@富邦、培證@雙子兩張卡 →
  帶文字分別為「bet365 未開盤・台彩 富邦悍將讓1.5」「…LG雙子讓2.5」。
- 回歸 test_summary 27/27。

## 四、錯誤②（重大事故）：把 git 衝突標記提交上雲

**經過**：本機有一個 Windows 排程任務 `BB-ScrapeFailover`（每 5 分鐘，跑 `local_failover.js`），
它與我的互動操作**共用同一個工作目錄**。我本機跑完 `node index.js`（產生新的
`data/odds_log.json`、`data/intl_state.json`、尚未提交）的空檔，備援輪執行了
`git pull --rebase --autostash`：我的未提交檔被 stash、pull 進雲端新提交（同檔）、
stash 回貼時衝突 → `<<<<<<< Updated upstream / ======= / >>>>>>> Stashed changes`
標記被寫進兩個檔案。我**沒檢查內容**就 `git add data/odds_log.json data/intl_state.json`
一起放進 `2f22fbeca` 推上雲。

**災情**（14:40–14:51）：
- 雲端 scrape.yml 迴圈讀壞 `odds_log.json` → 每輪崩潰 → **賠率更新全停 11 分鐘**。
- 板端 `loadIntlState()` JSON.parse 失敗（try/catch 吞掉）→ `__intl` 為空 →
  **所有聯盟的藍帶全滅**（災情比原始問題更大），強制重新整理也無效。
- `buildIntlState()` 要先讀舊 intl 檔（`readJsonRequired` 擲錯被 catch）→ 每輪跳過重建 →
  **壞檔永遠不會被覆寫＝卡死不自癒**。這就是使用者「過了五分鐘還是沒出現」的直接原因。

## 五、補救（commits `939c03452` 14:50、`a90c3b503`）

1. **資料修復**：衝突塊全域取「上游側」（`<<<<<<< Updated upstream` 與 `=======` 之間）。
   intl_state 1 塊、odds_log **27 塊**。單側一致抽取＝該側完整檔。驗證：JSON.parse 合法、
   matches 981 場吻合。已推回。
2. **三道閘**（防再犯）：
   - `local_failover.js`：pull 後掃 `git diff --name-only -- data` 的檔，內容含 `<<<<<<<`
     即 `git checkout --` 還原乾淨版；
   - `local_failover.js`：提交前 `git diff --cached` 含 `<<<<<<<` → 棄推＋還原；
   - `index.js` `buildIntlState()`：舊 intl 檔讀取容錯，壞檔→從 `{games:{}}` 空表重建
     （條目本就由當前賠率窗＋台彩來源逐輪推導，重建成本一輪、卡死成本無限）。
3. **復活驗證**：14:51 odds 恢復提交；14:50 雲端重建 intl_state，kbo 5＋cpbl 2 stub 都在
   （`cpbl|2026-07-29|味全龍|富邦悍將` = `{is:null, ls:"home", ll:1.5, lsLive:true, …}`）。

## 六、給 Codex 的審查重點（我自首的可疑點）

### A. 今天改動本身
1. **雙重賽 timed-key 的 stub 縫隙**：stub pass 檢查 `!serMap[key] && !lotMap[key]` 用的是
   「最終 key」（可能含 `|HH:MM`）。serMap 有塞 timed 鍵（來源 oid 含 `_HHMM`），lotMap 的
   timed 鍵來自 pregame `g.time`——**若兩邊時間格式或有無不一致，雙重賽的 stub 可能建不出來
   或 applyLot 查不到台彩側**。KBO 雙重賽是真實場景，請驗證。
2. **stub 殘影**：台彩若「開了又收」（stub 已建、serMap/lotMap 之後消失），先行 pass 只在
   `stub.ls` 有值時寫回，舊 stub 不會被清除 → 板上可能殘留過期台彩側直到 bet365 開盤覆寫。
3. **`eo`/verdict 交互**：stub 帶 `eo:null,v:null`；bet365 開盤後主迴圈覆寫時
   `prevEo = eoOf(games[key]…)` 會讀 stub 的 eo（false）——理論上正確（無方向就無「曾相反」），
   但 latch 語義請覆核（`eoOf` 在 index.js:769 附近）。
4. **odds_log 修復的資料完整性**：27 個衝突塊取上游側＝雲端 14:37 版本；我本機那輪
   （14:33 左右）新增的少量賠率點位被捨棄。理論上下一輪自動補；請抽查 7/29 場次的
   `hd.bet365`/`ml` 序列有無斷點或亂序。
5. **index.html 行數中性 hack**：三處修改刻意擠在原行內（見 §7 行號地雷）。可讀性差，
   但別「順手美化」拆行——會弄壞 test_summary。

### B. 近三日相關變更（與今日問題同一片程式，Codex 挖雷建議範圍）
| 變更 | 檔案 | 風險點 |
|---|---|---|
| 傳輸層三層化（curl→隱形瀏覽器→頁內XHR/solve_cloudflare） | `sidecar_client.js`、`fetch_sidecar.py` | 挑戰頁辨識字串是否足夠；JSON 判定靠 `Accept: application/json` header 嗅探；`FetcherSession` 需用 `__enter__` 回傳物 |
| 合併改「按高手取代」 | `expert_picks.js`（`mergePicks`、`fetchedByLg`、`shouldReplaceScope` 放寬） | 高手頁部分失敗時舊單保留＝可能殘留已撤單一輪；`allPagesOk` 判定粒度是「人」不是「人×日期」 |
| 挑戰頁=拋錯計失敗 | `sidecar_client.js` `isChallenged()` | 誤判正常頁含關鍵字的機率（目前掃前 3000 字元） |
| MLB 鬧鐘時刻表（白天保底 9/12/15/18、深掃 04:00） | `expert_alarm.js`、`test_alarm.js` | 無賽日規則與白天波交互 |
| 本機備援（波次對齊、鏈死偵測、衝突標記閘） | `local_failover.js` | 與互動操作共用工作樹的其餘競態（根治=獨立 clone，**未做**） |
| workflows 加 scrapling 安裝 | `.github/workflows/expert-picks-*.yml`、`playsport-scrape.yml` | `scrapling>=0.4.11` **未釘死版本**，上游釋出破壞性更新會直接進生產 |
| 指紋警示抑制（序列有換邊就不跳） | `expert-picks-addon.js`（`hdSwapFor`）、index.html 藍帶 `epSwShow` | `lsw` 只算「今天」的換邊數 |

### C. 未實戰驗證過的路徑（誠實聲明）
- 頁內 XHR fallback（JSON 第 2 層）與 `solve_cloudflare`（HTML 第 2 層）在雲端**從未被真實觸發**。
- 台鋼@統一類「台彩終未開盤」場：整場只有 STAKE 軸與明牌，屬設計行為。
- 備援獨立 clone（根治共用工作樹）＝**未做**。

## 七、已知環境地雷（改碼前必讀）
1. **`test_summary.js` 用寫死行號**從 `live_index.html`（index.html 的舊複本）抽函式：
   改 index.html 上半部要嘛行數中性、要嘛 `cp index.html live_index.html` 並重對 grab() 行號。
2. **workflow YAML 禁 UTF-8 BOM**（PowerShell Out-File 會加）→ GitHub 拒收、每輪 0 jobs。
3. **本機 `git add data/*` 前必 grep `<<<<<<<`**（本次事故的教訓）。
4. 板端有**新舊兩條渲染路徑**（舊 renderCard 約 2449 行、現行 renderCardB 約 2975 行），
   藍帶等卡片區塊只掛在 B 版；改卡片先確認路徑。
5. odds_log 的 `hd` 檢查要看 `hd.bet365.length`，不是 `Object.keys(g.hd).length`（本次錯誤①）。

## 八、當日相關 commit 一覽（7/29 下午）
- `2f22fbeca` 14:40 台彩先行條目修法 ＋（**意外**）衝突標記污染的 odds_log/intl_state
- `939c03452` 14:50 污染修復（27+1 衝突塊取上游側）
- `a90c3b503` 衝突標記三道閘（local_failover ×2 ＋ buildIntlState 容錯）
