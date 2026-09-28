# NHL 排盤板與 STAKE 官方賠率管線設計

日期：2026-09-28

## 結論

新增一套與棒球、籃球完全隔離的 NHL 排盤板與資料管線；既有 Titan、棒球、WNBA 工作流不改動。NHL 賽程、比分與台彩盤來自玩運彩 allianceid 91，國際盤優先接 STAKE 官方 Odds Data API。官方賠率先以 shadow（只觀察、不改既有判斷）模式上線，確認隊名、主客、盤口與歷史序列穩定後才可成為卡片的正式盤口來源。

## 已確認規格

- UI：獨立 `nhl.html`，獨立 localStorage `sportbetting_nhl_doc_v1`。
- 資料：使用 `data/nhl_*.json`，不混入 `pregame_data.json`、`wnba_*.json` 或棒球盤面。
- 玩運彩：NHL allianceid 為 91。
- 結算：本頁追蹤的是玩運彩 NHL 賽前推薦；依玩運彩規則包含延長賽與點球大戰，以其公布的最終比分結算；場中盤不納入本功能。台灣運彩官方實體／線上彩券的預設「法定比賽時間」另有不含延長賽的規定，不得把本頁結算直接當作彩券派彩根據。
- 讓分、大小遇到剛好等於盤口時為走盤，不計勝敗。
- 推薦冷啟動：
  - 球季第 1 週：不抓玩運彩推薦。
  - 第 2 週起：只觀察勝率嚴格高於 60% 的高手。
  - 0–14 注：`observe`，留資料但不進卡片共識。
  - 15–29 注：`candidate`，顯示候選觀察，不進正式共識。
  - 30 注以上：`formal`，正式納入推薦與共識。
- 2026–27 球季起日由 workflow 的 `NHL_SEASON_START=2026-09-30` 明確指定；推薦程式優先讀環境變數，其次讀 `nhl_pregame.json` 的 `seasonStart`。下一球季必須同步更新 workflow 環境值。

## STAKE 官方 API

已用官方 OpenAPI 與即時端點確認：

- Base URL：`https://odds-data.stake.com`
- 驗證：HTTP header `X-API-KEY`
- NHL 賽程：`GET /schedule/sport/ice-hockey/usa/tournament/nhl`
- 單場盤口：`GET /odds/{fixtureSlug}`

賽程端點目前無金鑰也能讀取；盤口端點沒有有效金鑰時只回比賽骨架、沒有 `groups` 市場。收集器必須檢查市場是否存在，不能把空市場寫成有效快照。

輸出 `data/stake_api_odds.json`：

- `provider`、`mode`、`updated`
- 每場的 `fixtureId`、`slug`、開始時間、場名兩隊（shadow 階段不假設 API 場名順序等於主客）
- 標準化市場 `ml`、`hd`、`tot`
- `history` 按觀測時間追加，只有盤口或賠率真的變動才新增
- `events` 紀錄讓分熱門方翻轉與讓分線變動；所有賠率變動仍保留在 `history`

原始市場保留在每場的 `rawMarkets`，方便 STAKE 改欄位時追查。API 金鑰只讀取 `STAKE_ODDS_API_KEY`，不可寫入檔案、日誌或前端。

## NHL 資料流

1. `nhl_scraper.js` 抓玩運彩今、明賽程及昨、今結果，輸出 `nhl_pregame.json` 與 `nhl_lottery_series.json`。
2. `stake_api_odds.js` 依官方 NHL 賽程抓賽前市場，輸出 `stake_api_odds.json`。
3. `expert_picks.js` 新增 NHL 聯盟與冷啟動分級，輸出 `expert_picks_nhl.json`。
4. `nhl.html` 由賽程自動產生比賽卡；載入 STAKE 盤口與玩運彩推薦；結算只採用包含延長賽／點球的最終比分。
5. 三條 NHL workflow 各自有獨立 concurrency 群組與 PAT 自我接棒：賽程比分、STAKE 盤口、推薦。

## 失敗保護與上線順序

- 玩運彩空頁不覆蓋既有日期資料。
- STAKE 無金鑰、無市場、HTTP 失敗時保留上一份有效資料並以非零退出；workflow 不提交空檔。
- `stake_api_odds.json` 初期標記 `mode: "shadow"`，前端可以顯示來源與變化，但不覆蓋人工或既有盤口判斷。
- 不修改現役 Titan `scrape.yml`，避免把新供應商故障擴散到棒球。
- 第一次正式切換前至少人工抽查主客、讓分正負、初盤／最新盤各 10 場。

## 不在本次偷偷假設的事項

- STAKE 官方金鑰尚未提供，因此不能宣稱官方賠率已能在 GitHub Actions 長期運行。
- `candidate` 先以「可看、但不影響正式共識」落地；若要半權重或直接進推薦，必須另行明訂。
- NHL 隊名翻譯以固定對照表處理；遇到未識別隊名保留英文並記錄，不猜測配對。
