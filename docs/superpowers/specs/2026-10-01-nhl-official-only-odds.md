# NHL 官方來源限定賠率管線規格

日期：2026-10-01

## 目標

NHL 比賽卡只接受 Stake 與 Bet365 官方來源的賽前盤。BetExplorer 與 OddsPortal 不再參與 NHL 賽程驗證、賠率更新、盤口變化判斷或前端備援；既有檔案僅保留作歷史稽核，不再更新或讀取。

## 今日資料修復

2026-10-01 三場比賽以已保存、且觀測時間早於排盤開賽時間的最後快照回復：

- 企鵝＠飛人：Stake 05:05 快照，獨贏客 2.12／主 1.67、飛人 -1.5（客 1.47／主 2.60）、大小 6（大 1.84／小 1.89）。
- 島人＠楓葉：Stake 05:05 快照，獨贏客 2.05／主 1.75、大小 6（大 1.90／小 1.88）；Stake 當時沒有讓分，讓分以 Bet365 最後賽前快照楓葉 -1.5（客 1.40／主 2.85）補位。
- 國王＠雪崩：Stake 08:50 快照，獨贏客 2.50／主 1.52、雪崩 -1.5（客 1.65／主 2.21）、大小 6（大 1.79／小 2.00）。

修復後不得保留 `page-post-start`、開賽後 `active`，也不得顯示錯誤的「讓分方曾換邊」或 `-4.5→-1.5`。

## 官方來源與優先順序

1. Stake 官方賽程 API `https://odds-data.stake.com/schedule/sport/ice-hockey/usa/tournament/nhl` 提供賽事 slug、隊伍與開始時間。
2. 有 `STAKE_ODDS_API_KEY` 時，優先使用 `GET /odds/{fixtureSlug}` 的官方市場資料。
3. 沒有金鑰或 API 沒有 `groups` 時，以 Scrapling 讀取相同 slug 的 Stake 官方賽事頁；只解析 `Winner/Total/Handicap (Incl. Overtime and Penalties)`。
4. Bet365 官方 NHL hub 提供 Money Line 與 Puck Line，僅在 Stake 對應市場缺席時補位並作交叉核對。
5. Bet365 hub 沒有穩定大小分，因此大小分只用 Stake；Stake 缺盤時維持可手動輸入及預設 6.5。

## 賽前硬閘

- 只有 `observedAt < startTime` 的觀測可以寫入 `active` 與 `history`。
- 到達排定開賽時間後不再請求該場盤口；既有最後賽前快照原樣凍結。
- 官方頁即使仍顯示盤口、狀態仍為 `active`，只要時間已到便視為走地，不得寫入。
- 資料源失敗時保留上一份有效 JSON 並回報失敗；不可用聚合商或走地盤補空缺。

## 主盤辨識

- 獨贏只接受兩項的全場 Winner，且市場名稱必須明確包含延長賽與點球。
- 讓分只接受全場 Handicap；把同一對相反符號檔位配成一組，選兩邊賠率差距最小的檔位作主盤。不得用最早出現的替代盤當開盤。
- 大小分只接受全場 Total；把相同基準線的 Over／Under 配成一組，選兩邊賠率差距最小的檔位作主盤。
- 讓分負號一方是讓分方；不得用賠率高低猜測。

## 資料格式與前端

- `data/stake_api_odds.json` 成為 Stake 官方 NHL 正式資料檔，不再是等待金鑰的 shadow 空檔。
- 每場保留 `startTime`、`startISO`、中英文主客隊、`markets.ml/hd/ou`、`history`、來源模式與最後賽前觀測時間。
- `nhl.html` 改讀 `stake_api_odds.json`，不再請求 `nhl_oddsportal_stake.json`。
- Stake 市場逐項優先；缺少某一市場才由 Bet365 補該市場，不得整場覆蓋。
- 顯示文字改為「STAKE 官方」，不得再出現「OddsPortal」。

## 工作流

- `stake-api-odds.yml` 即使沒有 API key 也會以官方賽事頁模式運作；有 key 時自動使用官方 API。
- `nhl-bet365-odds.yml` 保留獨立運作並加上同樣的賽前硬閘。
- OddsPortal 的共用工作流與本機排程仍可服務棒球／WNBA，但明確排除 NHL，且不再提交 `data/nhl_oddsportal_stake.json`。
- 工作流只 commit 自己的 NHL 官方資料檔；失敗不得寫空檔。

## 驗收

- 單元測試先證明開賽後 fixture 被排除、Stake 官方頁三市場能正確解析、替代盤不會冒充主盤、Bet365 開賽後資料不會更新。
- 前端測試證明只載入 Stake／Bet365 官方檔、今日三場呈現修復後盤口、手動對調仍優先、大小分缺盤仍預設 6.5。
- workflow 測試證明 OddsPortal NHL 閘與資料提交已移除，Stake 無金鑰仍會運行官方頁模式。
- 全部測試、JSON 驗證、YAML/BOM 檢查及瀏覽器檢查通過後才推送 `main`。

