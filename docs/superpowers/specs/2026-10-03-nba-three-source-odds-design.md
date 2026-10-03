# NBA 三方盤口與 STAKE 即時監控設計

日期：2026-10-03

## 目標

讓 `nba.html` 的 NBA 聯盟真正使用每日管線產生卡片，並在卡片上同時呈現 STAKE、Bet365、台彩的獨贏、讓分、大小分。STAKE 是卡片讓分方、讓分值與大小分基準線的自動填入權威；人工修改後不得被覆寫。

## 已確認根因與現況

- `nba.html` 目前只在 `activeLeague === "WNBA"` 時渲染賽程，NBA 分支只有空白說明。
- 玩運彩 `allianceid=3` 已有 2026-10-04 07:00 熱火@暴龍，並提供台彩三盤與雙邊賠率。
- STAKE NBA 季前賽與正規賽是兩個 tournament：`nba-preseason` 與 `nba`；只抓 `nba` 會漏掉熱火季前賽。
- STAKE 熱火@暴龍已有獨贏、讓分 3.5、大小 229.5。
- Bet365 官方 NBA hub 目前未列該場季前賽；沒有資料時顯示未開盤，不製造數值。正規賽使用既有 Titan companyId=8 取得 Bet365 三盤與歷史。
- 棒球日職 STAKE 已有三場完整資料；中職 STAKE 官方 API 與官方頁目前均為零場。

## 資料管線

### NBA 賽程與台彩

新增 `nba_scraper.js`，抓玩運彩今、明賽程與昨、今、明結果頁，輸出：

- `data/nba_pregame.json`
- `data/nba_lottery_series.json`

每場保留台彩三盤：

- `taiwan.ml.away/home`
- `taiwan.hd.favorite/line/away/home`
- `taiwan.ou.line/over/under`

### STAKE

新增 `nba_stake_odds.js` 與可測試核心，合併官方 `nba-preseason`、`nba` 兩條賽程，逐場讀 `/odds/{slug}`。全場盤只接受 `Winner (Incl. Overtime)`、`Handicap (Incl. Overtime)`、`Total (Incl. Overtime)`；讓分與大小有多條時選雙邊賠率最接近的一條作主基準線。

只收開賽前資料。觀測完成時間距開賽不足 30 秒或已開賽，一律拒絕該筆並凍結最後有效資料。盤口或賠率真的改變才追加歷史。

### Bet365

新增 `nba_bet365_odds.js`，沿用已驗證的 Titan NBA `companyId=8` 路徑讀獨贏、讓分、大小分。只保留開賽前列；沒有有效資料時保留上一筆，不寫空資料。官方 Bet365 頁可取得的獨贏／讓分作交叉驗證，不用來捏造缺少的季前賽。

## 卡片行為

- NBA 與 WNBA 共用卡片渲染器，但各讀自己的資料檔。
- NBA 卡片新增三條精簡盤口列：STAKE、BET365、台彩；每條均直接列獨贏、讓分雙邊、大小雙邊。
- STAKE 有效且新鮮時，自動填入卡片讓分方、讓分值與大小分基準線。
- 人工對調讓分方或編輯大小分後只鎖該欄位；提供 `↻讓`、`↻大` 恢復自動。
- STAKE 歷史明細可展開，顯示時間、讓分方、基準線與三盤賠率。
- Bet365／台彩僅展示與比較，不覆蓋 STAKE 自動主軸。

## 棒球補強

- 日職卡片的 STAKE 列改為直接顯示獨贏、讓分、大小分雙邊賠率，避免有資料卻看似未接入。
- 中職在官方零場時仍顯示監控列「STAKE 官方目前未開盤」，並保留聯盟健康狀態與持續輪詢。
- 不用 Bet365、BetExplorer 或其他來源冒充中職 STAKE。

## 工作流與安全

- 新增 NBA 賽程、NBA STAKE、NBA Bet365 三個獨立五分鐘長迴圈工作流，`cancel-in-progress: false`。
- 看門狗監控三個 NBA 資料檔。
- 每個工作流只 stage 自己的資料檔；YAML 禁 BOM。
- 前端把外部資料視為不可信文字，以 `textContent` 呈現。

## 驗收

- 2026-10-04 NBA 頁可看見熱火@暴龍卡片。
- STAKE 與台彩三盤數值和即時來源一致；Bet365 未開盤時明確標示。
- STAKE 自動填入暴龍讓 3.5、大小 229.5；人工修改與恢復自動均有效。
- 最後 30 秒與開賽後觀測不進歷史。
- 日職三場顯示完整 STAKE 三盤；中職顯示官方未開盤而不是整列消失。
