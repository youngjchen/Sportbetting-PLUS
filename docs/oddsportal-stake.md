# OddsPortal／Stake 賽前賠率紀錄

## 範圍

- 網站來源：OddsPortal 正常比賽頁；不直接連 Stake 網站。
- 莊家：OddsPortal 表格內的 `Stake.com` 列。
- 聯盟：MLB、NPB、KBO、CPBL。
- 市場：獨贏、亞洲讓分、大小分。
- 輪詢：本機 `BB-ScrapeFailover` 每 5 分鐘喚醒，OddsPortal 模組以 15 分鐘節流；只抓已排程且距開賽 18 小時內的比賽，首次進窗時從 hover 歷史回補真正初盤與此前變價，開賽後停止更新收盤。
- 效能：使用兩個彼此獨立的 Scrapling browser worker 分批抓取；資料仍由主執行緒合併後原子寫入。

GitHub hosted runner 實測雖能取得 OddsPortal HTTP 200，但事件頁不提供 bookmaker rows，無法讀取 `Stake.com`。正式輪詢因此沿用專案既有的台灣本機 failover 專用 clone、共用防重入鎖與安全 push；GitHub Actions 僅在 push 跑合約測試，手動 dispatch 才保留雲端診斷入口。這個安排不需要代理、API key 或額外付費。

## 資料

- `data/oddsportal_summary.json`：板端使用。每場保存初盤、最新賽前盤（開賽後即為收盤）、首次換邊、最後換邊與是否曾換邊。
- `data/oddsportal_history/YYYY-MM-DD.jsonl.gz`：每輪的完整正規化觀測，採每日 gzip JSON Lines。
- 雙重賽唯一鍵固定包含聯盟、日期、主客隊、開球時間與 OddsPortal event ID。

缺盤、局部頁面失敗與整輪 0 場都採 fail-closed：只保留舊資料，不會用空值覆蓋或刪除。

## 時間精度

OddsPortal 的 hover 歷史會提供開盤與每次變價時間，但劃線本身沒有獨立時間戳。若首次抓取時已經換邊：

- 新盤開啟時間可作為換邊時間時，標為 `line-open-time`。
- 換回早先盤而只能知道舊盤最後變價時，最後換邊標為 `detected-after-old-line`，表示「在該舊盤最後變價後、此次抓取前發生」，不冒充精確時間。
- 若 hover 歷史暫時取不到，但畫面同時存在劃掉的相反盤與有效盤，標為 `struck-opposite-detected`；只確認曾換邊，不虛構換邊時刻。

## 安全

不需要 OddsPortal API key，也不保存 cookies、登入資訊或 Stake 憑證。抓取器只接受 `https://www.oddsportal.com` URL；前端把來源資料當不可信文字，以 `textContent` 顯示，不注入 HTML。
