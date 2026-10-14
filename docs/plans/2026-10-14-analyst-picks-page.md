# 分析師推薦頁（analysts.html）實作計畫

> 狀態：待使用者確認（2026-10-14）。確認前不動任何程式碼。
> 目的：取代 C 槽兩本 Excel（MLB／NHL tracking master），成為五位分析師（APE、BOOKIE、BANKROLL、SNIPER、MONEY）推薦的唯一主帳；開賽前點選登錄、賽後自動結算、即時統計命中率／ROI／同向衝突。

## 已確認的決定

| 項目 | 決定 |
|---|---|
| 主帳 | 新頁面取代 C 槽 Excel；Excel 歷史一次匯入 |
| 公開 | repo 公開沒關係 |
| 聯盟 | NHL、MLB、NBA；NBA 季前賽照記，但統計要能跟例行賽分開 |
| 登錄版面 | 上方橫排五位分析師標籤、左側豎排聯盟標籤 |
| 點選 | 點隊伍：第 1 下 ML、第 2 下讓分、第 3 下取消；**右鍵**（手機＝長按）＝把該場標成 LOTTO |
| 計算規則 | 主要命中率只算表單、每人每場一張；有表單時 LOTTO 腿另計；當天沒表單的人串關／LOTTO 每腿計入；整張串關不記；ROI 用 Stake 開賽前最後賠率 |
| 名詞 | 絕對同向、相對同向、絕對衝突、相對衝突、單人反對、多人衝突（「無絕對衝突」取消） |

## 架構

```
analysts.html ──讀──> data/nhl_pregame.json、pregame_data.json、nba_pregame.json（賽程，滾動檔）
      │        └─讀──> stake_api_odds.json、baseball_stake_odds.json、nba_stake_odds.json（賠率）
      │
      ├─寫（PAT，沿用 github-sync 的權杖）──> state/analyst_picks.json      ← 只有頁面寫
      │
      └─讀──> data/analyst_results.json  <──寫── analyst-settle.yml（每 30 分＋picks 檔一更新就跑）
                                                       只有工作流寫
```

- **兩個檔、兩個寫手，互不覆蓋**：頁面只寫推薦檔；工作流只寫結果檔。避免同時寫入衝突。
- **為什麼結算放工作流**：賽程比分檔只留最近幾天，要是幾天沒開頁面，比賽會從檔案消失就結算不到。工作流每 30 分把「已完賽」的比分與 Stake 收盤賠率寫死進結果檔，之後永久可查。
- **不碰盤面資料**：不讀寫 `sportbetting_plus_doc_v2`／`board_state.json.gz`，異常統計與七類零風險。

### 推薦檔一筆的欄位（state/analyst_picks.json）

`id`、`league`、`officialId`（對應賽程檔的比賽鍵）、`date`（台灣日期）、`analyst`、`side`（away/home）、`team`、`market`（ML／SPREAD）、`line`（NHL/MLB 固定 1.5；NBA 見待決事項 1）、`lotto`（true/false）、`enteredAt`、`entryOdds`（點下當時的 Stake 價）、`status`（賽前／賽後補登／回溯）、`deleted`（刪除用墓碑，方便多裝置合併）。

### 結果檔（data/analyst_results.json）

每場：`officialId`、比分、`final`、`phase`（季前／例行／季後）、各盤 Stake 收盤賠率；每筆推薦的結果（win/loss/push）、直勝（球隊有沒有贏）、`countsInMain`、`profitUnits`。

- 比分來源：專案爬蟲資料為主；NHL、MLB 另用官方 API（工作流在伺服器端呼叫，沒有瀏覽器跨網域限制）核對，不一致就標「待核對」不結算。
- 賽季階段：NHL、MLB 用官方 API 的 gameType；NBA 用設定表的例行賽開幕日（上線前查證）。

## 登錄頁設計

- 上方：五位分析師標籤（橫排）＋日期切換；左側：NHL／MLB／NBA 標籤（豎排）。
- 主區：當天該聯盟所有比賽，一場一列；每列左客右主兩顆隊伍按鈕，按鈕上顯示 ML 與讓分的 Stake 賠率。
- 點擊：1 下 ML（藍）→ 2 下讓分（綠）→ 3 下取消；右鍵／長按＝LOTTO（虛線框＋小標）。按鈕固定尺寸，狀態只換顏色與框線，點擊不位移。
- 每列右側：五人目前分布、衝突與否、這個組合的歷史命中率（例：APE+BOOKIE+MONEY 88%／25 場）。
- 快捷：「複製上一位」；開賽自動上鎖，開賽後修改標「賽後補登」；「回溯模式」補歷史不上鎖、標「回溯」。
- 存檔：每次點擊先存本機，3 秒沒動作就自動上傳 GitHub（失敗會顯示、不會吞掉）。

## 分析頁設計

- 篩選：聯盟、日期區間、賽季階段（預設排除季前賽）、來源（只表單／含 LOTTO）、盤口、最少樣本（預設 20 場才排名）。
- 情境：全部、絕對同向、相對同向、無反方、單人反對、多人衝突、平票、絕對衝突、相對衝突 → 每人：場數、票命中率、球隊直勝率、ROI。
- 兩兩矩陣：切換「同向時命中率」／「對立時誰較準」；樣本少於 10 場淡化。
- 組合排行榜：精確組合（如 APE+BOOKIE+MONEY）依命中率排序。
- 表單 vs LOTTO：每人兩欄並列命中率與 ROI，LOTTO 再分「跟表單一樣／同隊改盤口」。
- 任何數字可點開看逐場明細。
- 組合一律以「場」為單位（3 人同向算 1 場），票命中與直勝分開顯示。

## 歷史匯入（一次性）

| 聯盟 | 來源（C 槽追蹤資料夾） | 範圍 | 備註 |
|---|---|---|---|
| NHL | `data/derived/official_settlement_*.json` 的 `rows` 與 `lotto_leg_rows` | 美國 9/29–10/13，主帳 319 張＋LOTTO 10 筆 | 大小分 6 筆不匯入（見待決事項 2） |
| MLB | `data/derived/season_team_one_vote_per_game_through_2026-10-13.csv`（9/17 重建的正確版） | 美國 4/1–10/13，8,992 票 | 舊錯誤版 `threads_team_picks_through_2026-08-13.csv` 不用；BANKROLL 8/13 前 1,020 筆標「舊匯入、無法核對」 |

- 匯入的歷史一律標 `status: 回溯`；只有 10/13 起有 Stake 賠率，之前 ROI 空白。
- 舊資料「每人每場一票」，無法還原表單與 LOTTO 並存的情況；歷史的表單 vs LOTTO 比較只從 10/13 起算。
- 匯入後用 C 槽帳本的累積數字逐人對帳（NHL 例：APE 49–23、BOOKIE 61–21…），不一致不得上線。

## 分階段與驗收

| 階段 | 內容 | 驗收 |
|---|---|---|
| 1 | `analyst-core.js`（純函式：配對、結算、統計）＋單元測試 `tests/analyst_core.test.js` | 用 10/13 實際資料重算：NHL 主帳 46–16、LOTTO 10–0、ROI 與 C 槽報告一致 |
| 2 | `analysts.html` 登錄頁＋GitHub 存檔 | 手機與電腦各登錄一天、互相同步不遺失 |
| 3 | `scripts/analyst_settle.js`＋`.github/workflows/analyst-settle.yml` | 完賽後 30 分內結果檔出現比分與收盤賠率；工作流 YAML 無 BOM |
| 4 | 歷史匯入＋對帳 | 各分析師累積數字與 C 槽帳本一致 |
| 5 | 分析頁 | 9/29–10/13 情境數字與 10/14 對話中的分析一致（APE+BOOKIE+MONEY 22/25 等） |
| 6 | 各頁加入口按鈕、C 槽 Excel 停更（保留唯讀） | 推送後線上可用 |

推送遵守 AGENTS.md Git 鐵則（先 rebase、worktree 安全推送、查檔數、bump `?v=`）。

## 已決（2026-10-14 後續）

1. **NBA 讓分線**：第 2 下＝點下當時該隊的 Stake 讓分線；分析師線不同時點該列小鉛筆改線（只有 NBA）。NHL／MLB 第 2 下固定 +1.5。（使用者同意）
2. **大小分**：第一版只做隊伍盤（使用者未回覆，暫採建議，可再加）。
3. **兩層點選**：同一人同一場可能「表單 FLA +1.5、LOTTO FLA ML」並存，所以左鍵＝表單層、右鍵／長按＝LOTTO 層，兩層各自 1 下 ML、2 下讓分、3 下取消。HAIL MARY、RENT PARLAY 等串關也記在右鍵層（不再細分來源標題）。

## 進度

- [x] 階段 1：`analyst-core.js`＋`tests/analyst_core.test.js`（7 項全過；10/13 主帳 46–16、LOTTO 10–0、各來源 Stake ROI 與 C 槽報告一致；9/29–10/13 衝突／單人反對／兩兩／組合數字與 10/14 分析一致）。測試資料 `tests/fixtures/analyst_core_nhl_*.json` 由 C 槽帳本產生。
- [x] 階段 2：`analysts.html` 登錄頁（本機預覽驗證，尚未推送）。實測：左鍵三段循環、右鍵 LOTTO 三段循環（快速連按不漏）、表單＋LOTTO 同場並存、複製自、衝突／同向標示、NBA 預設 Stake 線＋鉛筆改線、完賽自動 ✅❌、手機 375px 無橫向溢出。GitHub 同步以模擬 API 測過：首次建檔、無變更不重傳、409 衝突重試且兩台裝置資料合併。未設權杖時唯讀、只存本機。
