# 排盤板（Sportbetting-PLUS）— AI 代理操作手冊

> 完整交接書（歷史、地雷、未完事項）在 `docs/交接文檔.md`，動工前先讀它。
> 本檔只放「每次動手都必須遵守」的鐵則。

## 這是什麼

台灣運彩棒球排盤板：GitHub Pages 部署的單頁 PWA（`index.html` ~7600 行＋四支 add-on JS），
背後七條 GitHub Actions 自動化（賠率爬蟲、比分爬蟲、四聯盟明牌智慧鬧鐘、看門狗、三支占卜）。
資料全存 `data/*.json`，由 Actions 每幾分鐘自動 commit。部署＝push 到 `main`。

## Git 鐵則（違反=事故，每條都真實發生過）

1. **push 前必 `git pull --rebase origin main`**——爬蟲每 5 分鐘 commit，本地永遠落後。
2. **commit 前先 `git status` 看 staged 區、commit 後 `git show --stat` 驗檔數**——曾有殘留 staged 資料檔搭便車進提交造成 rebase 衝突。
3. **push 成功判定不可用 `cmd | tail` 的退出碼**（tail 恆為 0 會誤報成功）；要 grep `main -> main` 或直接看 `$?`。
4. 併發安全推送法：`git worktree add <tmp> origin/main --detach` → 複製要改的檔進去 → commit → `git push origin HEAD:main`——不會被本機髒工作區卡住。
5. **workflow YAML 禁 UTF-8 BOM**（PowerShell Out-File 會加）→ GitHub 靜默拒收整檔、每輪 `conclusion=failure 且 0 jobs`。用無 BOM 工具寫檔，改完驗前 3 bytes。
6. **改 `package.json` 必同步重生並 commit `package-lock.json`**——三支占卜工作流用嚴格 `npm ci`，lock 不同步＝它們全滅且其他工作流無感（7/18 起死 9 天的真實事故）。
7. 改任何 add-on JS 必 bump `index.html` 對應 `<script src>` 的 `?v=`，否則瀏覽器吃舊快取。
8. 測試檔（repo 根的 `test_*.js`）依慣例**不 commit**。

## GitHub Actions 鐵則

- 爬蟲類是「單 run 迴圈 5h+，cron 只負責斷鏈重點火」，**不是每 cron 跑一次**。
- **絕不取消「執行中」的 run**——會觸發 concurrency 群組死鎖（佇列永不升格，曾停更 4.5 小時）。
  救援 SOP：先取消全部 queued → 再取消 running → **立刻** dispatch。
- 停用某條工作流＝Actions 頁 **Disable workflow**，不是取消 run。
- `WORKFLOW_PAT` secret 驅動「run 結束自我接棒」（實測無縫，交接空窗 ≈0 秒）；cron 常遲到 25~55 分、會整批丟，是備援不是主力。
- 看門狗 `pipeline-watchdog.yml`：賠率/比分資料停更 >25 分自動清障重啟（不含明牌管線）。

## 資料檔語義速查（詳見交接文檔 §4）

- `data/odds_log.json`：Titan 賠率。`matches[id].hd.bet365` 的 **rows[0]=最新/收盤、末端=初盤**；line 正=主隊讓、負=客隊讓。開賽後 30 分寬限窗會混入場中盤。
- `data/pregame_data.json`：玩運彩賽程+比分，`officialId` 形如 `KBO_20260726_NEXEN@KIA_1700`（台灣時間）。
- `data/expert_picks_{mlb,npb,cpbl,kbo}.json`：四聯盟明牌（picks 欄位是 `league` 不是 lg）；唯一鍵 akey＝`uid|league|date|away|home|time|market|(team||side)`（不含 line＝改線視為同注更新）。
- `data/expert_archive/YYYY-MM-{lg}.json`：歸檔。**讀舊日期一律「主檔∪歸檔」聯集，嚴禁二選一**。
- 玩運彩個人頁 `gameday` 只支援 `today/tomorrow/yesterday/2daysAgo/3daysAgo/4daysAgo`（第 5 天起空頁）。
- `state/board_state.json.gz`：跨裝置盤面同步（union 合併）；`state/dv_casts.json.gz`：卜卦紀錄雲備份（union、只增不減）。

## WNBA／籃球頁（2026-08-03 上線,權威文件=nba_lab/WNBA_PLAN.md）

- `nba.html`＝籃球頁（NBA｜WNBA 聯盟切換;localStorage `sportbetting_nba_doc_v1` 與棒球隔離）。隊伍統計=doc.games 推導（快取鍵帶聯盟:NBA太陽≠WNBA太陽）。
- 玩運彩 WNBA=allianceid **7**（livescore/gamesData/billboard 同號）;billboard `page` **0 起算**（0=前30名,帶 page=1 是 31-60 名——勿「修」現役 0 起算迴圈）。
- titan 籃球庫 WNBA=聯盟 **2**、季資料夾 **26**：`matchResult/26/l2_1_{y}_{m}.js`（UTF-8;含未來賽程+進行中現場分）;變盤 `odds/Handicap.aspx?ScheId=&companyId=8`（rows[0]=最新）。**實證：titan teamA=主場、讓分負=客讓**（wnba_join_audit.js）。
- `data/wnba_pregame.json`（wnba-scrape.yml,台灣 00~14 時窗）/`wnba_odds_log.json`（titan bet365）/`wnba_games.json`（隊伍統計種子+自動結算累積）/`expert_picks_wnba.json`（明牌,深掃 04:40）。
- 台彩對超大熱門**不開獨贏盤**：結果頁 `td-bank-bet03` 空=未開;統計不讓分分母只算有開盤場（mlOffered）。
- 明牌 D11：wnba 國際盤讓分歸**讓分**（棒球歸獨贏是棒球盤特性,勿混用）。

## 使用者協作鐵則

- **繁體中文、白話**：術語當場解釋；前文代號重提必須展開，不准讓使用者回滑翻找。
- **照字面執行**，規格或數值語意不明時**先問再動手**，不要自行假設。
- UI 改動：圖標>顏色>文字；互動元件點擊不得變形位移；能少一塊就少一塊。
- 報告簡單明瞭、先講結論；命中率等數字為主。
- 收工宣告前必須跑驗證命令拿到證據；宣稱「救回/修好」前先確認資料真的是新的。
- 每次回覆結尾附：①我最沒把握的事 ②使用者可能的最大遺漏。

## 建議安裝的 Codex skills

`$skill-installer obra/superpowers`（計畫/TDD/系統化除錯/收工驗證方法論）、
`$skill-installer gh-fix-ci`、`code-reviewer`、`codebase-recon`、`create-plan`、`webapp-testing`。
