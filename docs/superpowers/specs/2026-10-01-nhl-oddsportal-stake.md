# NHL OddsPortal Stake 主盤資料源規格

## 目標

NHL 卡片以 OddsPortal 顯示的 Stake.com 賽前盤為主要資料源，抓取獨贏、亞洲讓分與大小分的主盤基準線及十進位賠率；既有 Bet365 官方資料只作比對與 Stake 缺盤時的有限備援。

## 資料流程

1. 共用 `oddsportal_scraper.py` 新增 NHL 聯盟網址 `/hockey/usa/nhl/`、32 隊英文名對中文短名，以及 `data/nhl_pregame.json` 賽程正規化。
2. NHL 讓分與大小分都取 OddsPortal 展開盤中莊家家數最多、且 Stake.com 有掛價的主盤；獨贏取 Home/Away 的 Stake.com 二項盤。
3. 原始歷史仍合併到 `data/oddsportal_summary.json`，另投影成只含 NHL 的 `data/nhl_oddsportal_stake.json`，讓網頁與後續分析不用載入 4 MB 以上的跨聯盟總檔。
4. 本輪沒有任何有效 Stake 市場時不得覆寫舊檔；未知隊名、賽程配不到、盤口不完整都要跳過並回報錯誤。

## 卡片優先順序

- 手動讓分方、手動讓分值、手動大小分基準線永遠最高。
- Stake 有該市場時，卡片的基準線、賠率與趨勢一律用 Stake。
- Stake 缺少讓分時才退回 Bet365 Puck Line；Stake 缺少獨贏時才用 Bet365 獨贏。
- Bet365 不得覆蓋有效 Stake 資料；卡片的展開資訊會把 Bet365 清楚標為「參考」。
- Stake 與 Bet365 都沒有大小分時，保留目前預設 6.5。

## 驗收

- NHL 賽程能與 OddsPortal 列表的主隊在前、客隊在後正確配對。
- 精簡 feed 每場包含 Stake 的 `ml`、`hd`、`ou` 開盤／現盤／收盤欄位（有資料者），並保留來源網址與觀測時間。
- 畫面顯示 Stake 獨贏、讓分與大小分賠率；Stake 的讓分方與大小分基準線會自動套入卡片。
- 手動對調仍能切換讓分方，且重新整理後不被 Stake 或 Bet365 蓋回。
- 自動測試、真實抓取、桌面與手機瀏覽器驗證都通過後才部署。
