# NHL 排盤板與 STAKE 官方賠率實作計畫

## 1. 先鎖定可測的核心規則

- 新增 `nhl_core.js`：隊名正規化、NHL 結算、球季週數、推薦分級。
- 先寫測試覆蓋延長賽／點球最終比分、走盤、首週停抓、15／30 注界線與勝率必須大於 60%。

## 2. 建立 STAKE 官方收集器

- 新增 `stake_api_odds.js`，實作官方賽程與 `/odds/{slug}`。
- 以 fixture 測試市場名稱、specifier 盤口與 outcome 賠率的正規化。
- 實作原子寫檔、去重歷史、變盤與翻盤事件。
- 無金鑰或沒有市場時拒絕覆蓋有效檔。

## 3. 建立 NHL 玩運彩資料管線

- 從 WNBA 管線移植空頁保護、滾動保留、台彩線序列與自動結算。
- 改為 allianceid 91、NHL 欄位與三節加延長賽／點球狀態。
- 新增獨立資料空殼及 `nhl-scrape.yml`。

## 4. 接上玩運彩推薦

- `expert_picks.js` 加入 NHL 91 與聯盟別門檻，不改四棒球聯盟及 WNBA 現有門檻。
- `expert_alarm.js` 改讀 `nhl_pregame.json`。
- 新增 `expert-picks-nhl.yml` 與 `nhl-picks-addon.js`。
- `observe`、`candidate`、`formal` 寫入資料；只有 `formal` 進正式共識。

## 5. 建立獨立 NHL 頁

- 以 `nba.html` 的完整比賽卡、結算、統計、日期導覽為基底做機械式複製，再移除 NBA／WNBA 切換與籃球專屬文字。
- 改成 NHL 32 隊、冰球低比分統計與三節顯示。
- 載入 `nhl_pregame.json`、`stake_api_odds.json`、`expert_picks_nhl.json`。
- 確認快取版本與 localStorage 都與其他運動隔離。

## 6. 驗證與交付

- 跑所有新單元測試、既有 scraper/expert 測試與 JS 語法檢查。
- 驗 workflow YAML 無 BOM，資料 JSON 可解析。
- 用本機 HTTP server 開 `nhl.html`，檢查 console、卡片、日期切換與行動版。
- 最後檢查 `git status`、差異範圍與敏感字串；不在沒有 STAKE 金鑰時宣稱 live 賠率已完成驗證。
