# NHL Bet365 官方賠率管線設計

日期：2026-09-30

## 目標

建立獨立的 NHL Bet365 官方賠率來源，固定抓取獨贏（Money Line）與讓分（Puck Line），每 5 分鐘更新一次，並把最新盤口與賠率接到 `nhl.html` 的比賽卡片。大小分因 Bet365 聯盟頁目前沒有提供可穩定擷取的盤口，維持使用者可編輯、預設 6.5，不製造假資料。

## 範圍

- 新增 `nhl_bet365_odds.js`，只負責 Bet365 NHL。
- 新增 `data/nhl_bet365_odds.json`，與既有 Stake 實驗資料完全隔離。
- 新增 `.github/workflows/nhl-bet365-odds.yml`，採單一 run 約 5 小時持續迴圈、每 5 分鐘抓一次，再由 `WORKFLOW_PAT` 自我接棒；cron 只作備援。
- `nhl.html` 改讀 Bet365 檔案，把獨贏與讓分賠率顯示在卡片上。
- 保留既有 `stake_api_odds.js` 與 workflow，等待未來有 API key 時使用，但不再作為現役 NHL 卡片來源。
- 不更動棒球賠率管線，也不把 NHL 資料混入 `data/stake_api_odds.json`。

## 官方頁面與解析

來源頁面：`https://www.bet365.com/hub/en-us/ice-hockey/nhl`

抓取使用現有 `sidecar_client.fetchText()`：先嘗試一般 HTTP；遇到 403/503 時切換到 Scrapling 瀏覽器 sidecar。工作流安裝現有 `requirements-scraping.txt`、Scrapling 與 Chromium。

解析規則：

- 賽事節點：`li[data-item-category2="NHL"][data-item-name]`
- 盤別：`data-item-category3="Money Line"`、`data-item-category3="Puck Line"`
- 對戰：`data-item-name="客隊 @ 主隊"`
- 開賽時間：節點內 `[data-utc]`
- Bet365 賽事識別：`data-fixture-id`
- 選項：`[data-item-variant]`
- 十進位賠率：`data-item-odds`
- 讓分：從選項文字解析 `+1.5` 或 `-1.5`；負數一方是讓分方，不能只用賠率高低猜測。

若頁面是 Cloudflare 挑戰、沒有完整賽事、或只有一邊選項，整輪視為失敗，不覆蓋舊資料。

## 資料格式

`data/nhl_bet365_odds.json`：

```json
{
  "provider": "bet365-official",
  "updated": "ISO-8601",
  "health": { "status": "ok", "gameCount": 24 },
  "games": {
    "穩定鍵": {
      "startTime": 1790784000000,
      "away": "FLA Panthers",
      "home": "CAR Hurricanes",
      "awayZh": "佛羅里達美洲豹",
      "homeZh": "卡羅萊納颶風",
      "ml": {
        "market": "Money Line",
        "outcomes": [
          { "name": "FLA Panthers", "side": "away", "odds": 2.05 },
          { "name": "CAR Hurricanes", "side": "home", "odds": 1.72 }
        ]
      },
      "hd": {
        "market": "Puck Line",
        "line": 1.5,
        "favSide": "home",
        "outcomes": [
          { "name": "FLA Panthers", "side": "away", "line": 1.5, "odds": 1.40 },
          { "name": "CAR Hurricanes", "side": "home", "line": -1.5, "odds": 2.85 }
        ]
      },
      "history": []
    }
  }
}
```

穩定鍵由開賽時間、客隊與主隊組成，不依賴 Money Line 與 Puck Line 可能不同的 fixture id。賽事保留至開賽後 3 天。只有盤口或賠率真的改變才把前一版快照加入 `history`，最新在前並限制長度。

## 隊名與前端配對

- 程式內維護 NHL 32 隊 Bet365 英文縮寫／名稱到既有繁中隊名的明確對照表。
- 未知隊名視為解析錯誤並列入訊息；避免把錯隊賠率塞進卡片。
- 前端用「客隊繁中名稱＋主隊繁中名稱＋開賽時間容許差」配對，不假設 Bet365 的 id 與玩運彩官方 id 相同。

## 卡片行為

- 成功配對 Bet365 時，以 Puck Line 負數一方作為自動讓分方，讓分值為絕對值（通常 1.5）。
- 使用者手動對調讓分方的 `hdFavOverride` 仍是最高優先權；重新整理後也維持既有儲存行為。
- 卡片顯示 Bet365 的客／主獨贏賠率與客／主讓分賠率，來源標示改為 `BET365`。
- Bet365 尚未抓到或該場未配對時，卡片保持可手動輸入，不拿 Stake 舊資料偽裝成即時盤。
- 大小分維持可編輯，預設基準線 6.5；不顯示 Bet365 大小分賠率。
- NHL 延長賽／點球大戰是否納入結算，沿用既有比賽結果與市場定義；本次賠率接入不改寫結算規則。

## 更新與失敗保護

1. 抓取官方頁面。
2. 驗證頁面不是挑戰頁、盤別完整且至少有一場有效 NHL 賽事。
3. 正規化隊名、時間、獨贏及讓分盤。
4. 與舊檔合併歷史，剔除過期賽事。
5. 先寫暫存檔並驗證 JSON，再原子替換正式資料。
6. workflow 只有資料真的變動才 commit；抓取失敗時保留舊檔並讓該輪命令失敗，交由下一輪重試。

## 驗證

- 單元測試：Money Line、Puck Line、正負讓分、讓分方、十進位賠率、未知隊名、缺邊與挑戰頁。
- 合併測試：無變化不增加 history；盤口或賠率改變才增加。
- 前端測試：隊伍＋時間配對、Bet365 自動讓分方、手動對調優先、大小分仍為 6.5。
- 實站測試：用 Scrapling 抓官方頁並產生可解析 JSON。
- 工作流檢查：YAML 可解析、檔案前三 bytes 不是 UTF-8 BOM。
- 瀏覽器檢查：桌面與手機版卡片可見、對調鍵不位移且有效。

## 不做的事

- 不從台灣運彩抓 NHL 讓分。
- 不把其他莊家賠率混入 Bet365。
- 不臆造 Bet365 大小分。
- 不在本次改動更改玩運彩推薦門檻；既有規則維持第一週不抓、第二週起觀察 60% 以上，滿 15 場才考慮、滿 30 場正式納入。
