# WNBA 板塊建置計畫（決策記錄＋分階段任務＋驗收）

> 建檔 2026-08-03。依據＝使用者七題拍板（Q1甲/Q2完整/Q3隊伍統計+卡面過盤率/Q4棒球標準不變/Q5獨立工作流/Q6要titan/Q7不用隊徽）＋當日全端點實抓驗證。
> 執行方式：勾選 `- [x]` = 完成；每任務含驗收標準，過驗收才勾。改本文件需說明理由並更新日期。
> **未經使用者核准前不動工**。待核准清單見文末。

**Goal**：籃球頁（nba.html）長出 WNBA 聯盟：完整排盤板（卡片/燈號/注/結算）＋隊伍統計（全隊主客場獨贏/讓分/受讓/大分過盤率，自動結算自動更新）＋明牌工作流（棒球同標準）。同時為 10 月 NBA 開季鋪好整條管線（本計畫即 NBA 階段2 的先行整測）。

**架構**：甲案＝nba.html 單頁雙聯盟（NBA/WNBA 聯盟列切換，照棒球頁四聯盟模式）；資料源＝玩運彩（台彩線/比分/明牌/隊伍數據）＋ titan007 籃球資料庫（賽果月檔/Bet365 變盤序列＝異常偵測軸）；工作流與棒球完全分離（獨立 yml、獨立資料檔）。

**技術棧**：與棒球板一致——單檔 HTML+原生 JS、Node 爬蟲（curl 傳輸層＋sidecar 備援）、GitHub Actions 迴圈式工作流、data/*.json 上雲。

---

## A. 已驗證端點（2026-08-03 全實抓，非假設）

| 用途 | 端點 | 驗證結果 |
|---|---|---|
| 賽程/比分/台彩盤口 | `playsport.cc/livescore/7?gamedate=YYYYMMDD&mode=1&` | ✅ 8/3 四場、頁面結構與棒球同款（team-data-a/gameid）；gameid 格式 `YYYYMMDD7 1001` 起 |
| 台彩線+賽果（回補） | `playsport.cc/gamesData/result?allianceid=7&gametime=YYYYMMDD` | 端點同棒球 playsport_totals.js 用法；籃球版欄位結構需 selftest（T2） |
| 隊伍數據對照 | `playsport.cc/gamesData/teams?allianceid=7&teamid=X` | ✅ 近10場＋運彩盤(讓/受讓/不讓分/大分)×主客全＋國際盤(讓/受讓/大分)×主客全 過盤率；15 隊 teamid 清單已枚舉（含新軍 火焰/節奏） |
| 明牌勝率榜 | `playsport.cc/billboard/winRate?during=season&allianceid=7&mode=M&page=P` | ✅ **page 從 0 起算**（0=1-30名、1=31-60…）；gametype 同棒球（mode1:1讓/2大小/3不讓分；mode2:11讓/12大小） |
| 明牌主推榜 | `billboard/mainPrediction?allianceid=7&during=season&page=P` | ✅ 前30名兩盤全數 60%+ |
| titan 賽果月檔 | `nba.titan007.com/jsData/matchResult/26/l2_1_{y}_{m}.js` | ✅ **WNBA=聯盟2、季資料夾=『26』**（單年季→二位數）；UTF-8（NBA 檔同）；5/6/7/8 月檔全通；arrTeam 繁中隊名內建；arrData 含比分+半場+收盤讓分/大小線 |
| titan Bet365 讓分變盤 | `nba.titan007.com/odds/Handicap.aspx?ScheId={id}&companyId=8` | ✅ 6月場 ScheId 714913 回 995 列 |
| titan Bet365 大小變盤 | `odds/OverDownChart.aspx?scheId={id}&companyId=8&num=1&t=1` | 同 NBA 格式（NBA 已驗，WNBA T1 補一發確認） |

明牌池實測（本季、前120名、60%+30注）：運彩讓分5／大小4／不讓分54（35人≥65%，榜首 Ian23 74%）；國際讓分8／大小9；主推榜前30名兩盤全合格（榜首71%）。玩運彩 WNBA 榜自身門檻=90注。**棒球標準（60%+30注、during=season）原樣沿用，可行性充分。**

⚠ 探測教訓（防重踩）：billboard `page` 參數 **0 起算**；帶 `page=1` 拿到的是 31-60 名。現役 expert_picks.js 迴圈本來就是 `page=0..3`＝正確，勿「修」它。

## B. 決策記錄（延續 NBA_ARCHITECTURE.md，新增 D8-D13）

- **D8 聯盟維度**（取代 D1 對籃球的單聯盟假設）：nba.html＝籃球頁，內建聯盟列 NBA｜WNBA（棒球頁 lgnav 同款交互）；localStorage 仍單一 `sportbetting_nba_doc_v1`，卡片/games 記錄帶 `league` 欄位。理由：卡型、市場語義（半分制、無和局）兩聯盟全同；nba.html 尚是 208 行骨架，現在加維度成本最低。
- **D9 WNBA 卡片主軸＝台彩線**（棒球主軸是 STAKE；使用者未要求 WNBA 接 STAKE）：卡面讓分/大小基準、隊伍統計過盤判定都以台彩線為準——與玩運彩隊伍頁『運彩盤』口徑一致（可互相驗證）。國際軸＝titan Bet365（藍帶+線移異常），口徑=玩運彩『國際盤』。
- **D10 隊伍統計引擎照抄棒球**：`doc.games`（每場結算一筆）唯一真相源＋推導快取（index.html:1740-1860 機制移植）；市場= ml/hd/recv/tot＋得失分＋連勝，主/客/全三欄。籃球差異：ml 無和局（t 欄保留恆 0 無害）、hd/tot 半分制無 push（push 分支保留防整數線）。得失分顯示均分取 1 位小數（分數量級 80-100）。
- **D11 明牌歸燈映射（籃球版）**：運彩盤讓分→讓分、大小→大小、不讓分→獨贏（同棒球）；**國際盤讓分→讓分燈、大小→大小燈**（棒球的「國際讓分→獨贏」是棒球盤特性，籃球兩盤讓分同為分差盤，直接對位）。※待使用者核准（文末#3）。
- **D12 工作流全獨立**：`wnba-scrape.yml`（賽程/賠率/比分迴圈）＋`expert-picks-wnba.yml`（明牌智慧鬧鐘）；資料檔 `data/wnba_pregame.json`、`data/wnba_odds_log.json`、`data/expert_picks_wnba.json`、歸檔 `data/expert_archive/YYYY-MM-wnba.json`。與棒球零共檔（故障隔離；Q5B 拍板）。
- **D13 不做**：隊徽（Q7 拍板）；STAKE 爬取；模型%（WNBA 無需求，NBA 開季再說）；占卜（沿 D7）。

## C. 檔案地圖

| 檔案 | 動作 | 職責 |
|---|---|---|
| `nba_lab/wnba_pull_titan.js` | 新建 | 拉 titan l2 月檔（5~10月）→ `nba_lab/wnba_titan_games.json`；含 UTF-8 讀取、arrData 欄位解析 |
| `nba_lab/wnba_pull_ps.js` | 新建 | 逐日拉 `gamesData/result?allianceid=7` → `nba_lab/wnba_ps_lines.json`（台彩讓分/大小線+比分） |
| `nba_lab/wnba_join_audit.js` | 新建 | 雙源 join 稽核：主客方向/讓分符號雙法檢定、比分不符=0 容忍、守門值分布 → `nba_lab/WNBA_AUDIT_REPORT.md` |
| `nba_lab/wnba_build_games.js` | 新建 | 稽核通過後合成 `data/wnba_games.json`（板面種子＝doc.games 格式） |
| `nba.html` | 大改 | 聯盟列、doc.games+推導統計移植、隊伍統計 modal、卡片過盤率、種子載入 |
| `wnba_scraper.js` | 新建 | 每日賽程+台彩盤口+比分（livescore/7 籃球版解析；officialId `WNBA_YYYYMMDD_客_主_HHMM`） |
| `wnba_titan_odds.js` | 新建 | 當日 ScheId 對應→Handicap/OverDownChart 序列→`data/wnba_odds_log.json` |
| `.github/workflows/wnba-scrape.yml` | 新建 | 迴圈式（棒球 scrape.yml 模式：每輪 reset --hard 自癒＋timeout＋自我重觸發） |
| `expert_picks.js` | 小改 | ALLIANCES 加 `{id:7, lg:'wnba'}`；boardMarket 籃球映射分支；守門白名單鍵 |
| `expert_alarm.js` | 小改 | BASELINES.wnba＋PFX.wnba |
| `.github/workflows/expert-picks-wnba.yml` | 新建 | 複製棒球單聯盟 yml 改參數 |
| `expert-picks-addon.js` | 小改 | 讀第五檔合併；籃球頁掛載（sport 感知） |
| `data/expert_whitelist.json` | 小改 | 加 `wnba: []` 空陣列 |
| `test_league_env.js`、新 `test_wnba_*.js` | 擴充 | 守門/解析/統計單元測試 |

---

## 階段 0：語義稽核（不動板子、不上雲；全部本機）

### T1 titan 月檔全季拉取＋解析
- [ ] `wnba_pull_titan.js`：讀 `matchResult/26/l2_1_2026_{5..8}.js`（開季 5/15~今），strip BOM、`eval` 沙箱或正則抽 arrLeague/arrTeam/arrData；輸出 `{scheId,dateStr,teamAId,teamBId,scoreA,scoreB,halfA,halfB,hdLine,totLine}` 陣列＋隊名對照（繁中短名）
- [ ] 同輪抽 3 個近期 ScheId 打 `OverDownChart.aspx?scheId=&companyId=8&num=1&t=1` 確認 WNBA 大小變盤格式=NBA 同款
- 驗收：場次數=官方賽程量級（5~8月約 280±場）；無解析例外；隊 15 支全出現

### T2 玩運彩台彩線回補解析
- [ ] `wnba_pull_ps.js`：先 `--selftest 20260801` 單日印欄位（td-bank-bet01 讓分/bet02 大小/td-teaminfo 隊名——棒球 playsport_totals.js 選擇器基礎上校籃球差異）；確認 OK 後逐日 5/15~今（4~8s 抖動，~80 請求）
- 驗收：selftest 與 livescore/7 同日對戰互驗一致；全季筆數與 T1 對齊（±延賽）

### T3 join 稽核（照 NBA join_audit.js 方法論，**勿沿用任何棒球/NBA 符號假設**）
- [ ] 雙源以 日期+隊名對照 join；比分不符容忍=0；跨日場（美國時間差）用 ±1 日候選+比分精確匹配（NBA 連日重賽教訓：候選清單制）
- [ ] 讓分符號雙法檢定：勝率法（讓方過盤應≈50%）＋玩運彩同側比對；確認 titan teamA=主或客、線負=誰讓
- [ ] 產出守門值：|讓分| 與大小線分布（p1~p99），寫入 `WNBA_AUDIT_REPORT.md`
- 驗收：join 率 ≥99%、比分不符 0、符號兩法一致；報告落檔

## 階段 1：回補＋隊伍統計＋板面聯盟化

### T4 合成板面種子
- [ ] `wnba_build_games.js`：T1+T2 合成 `data/wnba_games.json`，每場 `{sid:"WNBA_YYYYMMDD_客_主_HHMM", date, league:"WNBA", awayTeam, homeTeam, awayScore, homeScore, hdFav, hdVal, totBasis}`（台彩線口徑=D9；台彩未開盤場 hdFav/totBasis 留空→統計自動略過該市場）
- 驗收：抽 3 隊算過盤率 vs 玩運彩隊伍頁『運彩盤』欄位全對（捨入±1%）

### T5 nba.html 聯盟化＋統計引擎移植
- [ ] 聯盟列（NBA｜WNBA 膠囊，樣式沿棒球 lgnav）＋`LEAGUES={NBA:{teams:30},WNBA:{teams:15 繁中短名=titan/玩運彩對照}}`＋活動聯盟過濾卡片
- [ ] 移植 index.html 推導統計整段（emptyTeamRow/_gameResultFor/_rebuildTeamCache/statRead/runsRead/streakRead/recentRead＋gamesVersion 快取）；basketball 調整=D10
- [ ] 隊伍統計 modal（📊鈕+桌機寬表/手機堆疊卡，複製棒球 renderStatsPage 版型；聯盟下拉 NBA/WNBA）
- [ ] 開板載入 `data/wnba_games.json` 種子 merge 入 doc.games（sid 鍵冪等去重；raw CDN 失敗退本地快取）
- 驗收：jsdom/preview DOM 斷言（此 app 截圖必逾時）——統計頁 15 隊×4市場×3欄全渲染、數字=T4 驗收值；棒球頁完全不受影響（index.html 零改動）
- [ ] Commit（僅本任務檔）

### T6 卡片過盤率呈現
- [ ] 先做 DEMO 兩形態給使用者挑：a) 讓分/大小區塊頭右側小字「主過41% 客過38%」（對戰雙方各自該市場+場地的過盤率）b) 卡尾一條兩隊統計帶。**遵守圖標>顏色>文字鐵則、點擊不變形**
- [ ] 使用者定稿後實裝＋結算後即時重算（doc.games 增量→bumpGamesVersion 已天然覆蓋）
- 驗收：使用者點頭；結算一場後卡面數字即變

## 階段 2：每日管線上雲

### T7 賽程/盤口/比分爬蟲＋工作流
- [ ] `wnba_scraper.js`：livescore/7（mode=1）解析賽程+台彩讓分/大小/獨贏賠率+比分+狀態（含延賽）；輸出 `data/wnba_pregame.json`（結構同棒球 pregame_data 慣例、officialId=WNBA_ 前綴；KEEP_DAYS=5 滾動）
- [ ] 台彩線序列記錄（讓分方向翻面偵測用，沿 lottery_series 概念但獨立檔 `data/wnba_lottery_series.json`）
- [ ] `wnba-scrape.yml`：迴圈式、每輪 `rebase --abort; fetch; reset --hard` 自癒、timeout、自我重觸發、**Write 工具產檔防 BOM**；cron 錯開棒球分鐘
- 驗收：雲端連跑 2 輪有真資料 commit；棒球工作流零干擾
- [ ] pipeline-watchdog.yml 納入 wnba 檔年齡監控

### T8 titan 變盤軸
- [ ] `wnba_titan_odds.js`：由 T1 解析器抓當月月檔枚舉今日 ScheId（隊名對照配對玩運彩場次）→ Handicap/OverDownChart companyId=8 → `data/wnba_odds_log.json`（rows 時序注意：**titan 為 prepend、rows[0]=最新**——棒球 7/23 釘死的鐵則直接沿用並以首場實抓複驗）
- [ ] 板端國際軸藍帶（bet365 收盤/現價+線移幅度異常晶片；「顛倒」在籃球=稀有強訊號沿 NBA D6）
- 驗收：當日場次 ScheId 配對率 100%；藍帶 DOM 斷言

### T9 板端結算迴路
- [ ] 排卡（pregame→卡片，含台彩線自動帶入）、比分即時、自動結算→`doc.games` 追加（sid 冪等）→統計/卡面過盤率自動更新
- [ ] 延賽/取消處理沿棒球 postponed 語義
- 驗收：連 2 個比賽日全自動：排卡→結算→統計增量正確（與玩運彩隊伍頁次日數字對照）

## 階段 3：明牌工作流

### T10 爬蟲聯盟擴充
- [ ] `expert_picks.js`：ALLIANCES 加 `{id:7, lg:'wnba'}`；EP_LEAGUE 守門自動涵蓋；boardMarket 籃球映射（D11：intl 讓分→hd）——**實作為 league 感知函式，棒球行為零變**（test_league_env 斷言四棒球聯盟映射不動）
- [ ] 個人頁 parsePick 對籃球格式跑真頁驗證（讓分「{隊} ±N.5」/大小「{n} 大分」/不讓分「{隊} 主|客」；美東時間 AM/PM 規則同 MLB——v1.2 修正已覆蓋）
- [ ] 歸檔器聯盟後綴自動生效（`-wnba`）；`expert_whitelist.json` 加 `wnba:[]`
- 驗收：本機 `EP_LEAGUE=wnba EP_MODE=full` 一輪：合格量級≈本計畫 A 節實測、picks 非空、四棒球聯盟檔零變動
### T11 鬧鐘＋工作流
- [ ] `expert_alarm.js`：PFX.wnba='WNBA'；BASELINES.wnba 提案 `{hot:[[12,0],[18,0],[22,0]], deep:[4,40]}`（單貼單多在台灣白天；簇波 T-120/T-35 自動貼賽程；比賽多在台灣早晨 07-11 時＝簇波主場景；週末美日場=台灣深夜自動有簇波）＋賽程源改讀 `data/wnba_pregame.json`（loadGames 檔名參數化）
- [ ] `expert-picks-wnba.yml`（複製棒球單聯盟 yml：PAT 接棒、cron 兜底、concurrency 群組 wnba）
- 驗收：test_alarm 加 wnba 案例；首夜實錄波表全準點（±補償窗）
### T12 板端明牌
- [ ] expert-picks-addon 讀五檔合併（akey 防撞）；籃球頁掛載＝卡片膠囊/面板/未讀紅點/總結三帳（epStrong K=6 沿用）；歸檔懶載含 -wnba
- 驗收：真資料膠囊亮於籃球頁、棒球頁零回歸（test_summary 綠）

## 階段 4：收尾
- [ ] github-sync 籃球 doc 命名空間跨裝置實測（上傳/下載語義沿 7/17 版）
- [ ] AGENTS.md＋交接文檔補 WNBA 章節；NBA_PLAN.md 標注「階段2 由 WNBA 管線繼承」對應表
- [ ] 10 月 NBA 開季切換演練清單（l1 月檔、allianceid 3、alarm baselines.nba）

## 風險與負載
- 玩運彩負載：隊伍統計不需每日爬（板面自算）；新增請求=wnba 賽程迴圈（輕）＋明牌波（合格~80-100人，full 約 3-5 分）。WAF 再封鎖→sidecar/scrapling 備援線已在（sidecar_client 傳輸層直接沿用）。
- titan 負載：月檔每日 1 發＋當日場次×2 變盤端點（≤12 場/日）＝極輕。
- 賽季窗：例行賽至 9/13、季後賽至 10 月中；階段 0-2 目標一週內上線即可吃到 5+ 週實戰。
- 回滾：全部新檔+獨立 yml；nba.html 單檔可 git revert；index.html 全程零改動。

## 待使用者核准（動工前）
1. 計畫整體與階段順序
2. WNBA 深掃時刻 **04:40**（錯開 mlb 04:00/kbo 04:00/cpbl 04:20）
3. **D11**：國際盤讓分明牌歸「讓分燈」（非棒球的歸獨贏）
4. **D9**：WNBA 卡片主軸=台彩線（不接 STAKE）
5. 卡片過盤率形態（T6 出 DEMO 二選一）
