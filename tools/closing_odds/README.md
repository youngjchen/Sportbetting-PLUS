# 歷史收盤賠率萃取（一次性，2026-10-15）

把專案已記錄過的賠率（含 git 歷史）整理成每場的收盤價，供 `tools/analyst_odds_backfill.js` 補進 `data/analyst_history.json`。只讀資料、不改 repo。

| 來源 | 書商 | 範圍 |
|---|---|---|
| `data/oddsportal_archive/2026-04..08.json`（BetExplorer） | Stake | MLB 4–8 月，`markets.*.close` |
| `oddsportal_summary.json`、`baseball_stake_odds.json`、`stake_api_odds.json` 的 git 歷史 | Stake | MLB 8 月起、NHL 10/1 起 |
| `odds_log.json` 每次提交的開賽前版本（Titan） | bet365 | MLB 6/16–9/30（讓分為港盤，已 +1） |
| `nhl_bet365_odds.json`、`baseball_bet365_odds.json` 的 git 歷史、`divination_lab/titan_backfill/bf_labeled.json` | bet365 | NHL 9/30 起、MLB 4–6 月獨贏 |

步驟（在本資料夾執行；`cache/` 與輸出的 `*.json` 為產物、不提交）：

```
node extract_static.js
node extract_history.js
every=1 node titan_prestart.js
node combine_multi.js            # → closing_multi.json
node ../analyst_odds_backfill.js closing_multi.json
```

品質：A＝明確收盤或開賽前 60 分內；B＝開賽前 1–12 小時。注意 Stake 封存的 ±1.5 常是另開盤（熱門 +1.5），所以每個讓分方向各留一組；8 月中起 Stake MLB 主盤改為 ±1，那段的 ±1.5 主要靠 bet365。
