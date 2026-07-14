# NBA 排盤板 架構決策文件（ADR）
定稿 2026-07-14。依據＝與使用者三輪討論拍板＋當日實抓驗證。改動本文件需說明理由並更新日期。

## D1 頁面結構：同 repo、雙獨立頁、標頭切換
- 棒球＝現有 `index.html` 原封不動；籃球＝新檔 **`nba.html`** 獨立頁。
- 切換鈕放標頭最左（「排盤板」旁）：`⚾ 棒球 | 🏀 籃球`，位於聯盟列上一層；點擊＝導頁（URL 帶日期參數）。
- **理由**：index.html 5500 行且每日在用，塞 sport 維度＝高回歸風險；籃球卡片形狀本來就不同（無投手、節數、點差多值）。

## D2 邏輯共用：add-on 共用加參數、渲染器分家
- 會反覆迭代的分析邏輯（燈號/結算/命中率/異常軸/交叉表）住共用 add-on JS，加 `sport` 參數，單一來源兩頁生效。
- 卡片渲染器各自持有（nba.html 內建籃球版 renderCard）。
- localStorage 獨立 key：籃球 `sportbetting_nba_doc_v1`；github-sync 獨立命名空間。

## D3 爬蟲：程式碼共用、工作流獨立
- 底層抓取/解析函式加 sport 參數共用；**`nba-scrape.yml` 獨立工作流**、cron 與棒球錯開分鐘。
- **理由**：故障隔離（MLB 曾停擺 3h43m 吞窗）、10 月雙賽季重疊窗、淡季可單獨停用。

## D4 資料源（2026-07-14 全部實抓驗證）
| 用途 | 端點 | 驗證 |
|---|---|---|
| 比賽枚舉+收盤線+半場比分 | `nba.titan007.com/jsData/matchResult/{季}/l1_1_{y}_{m}.js`(例行賽)、`l1_2.js`(季後賽系,pfData 巢狀) | ✅ 1230 場整 |
| bet365 讓分逐筆變盤 | `nba.titan007.com/odds/Handicap.aspx?ScheId={id}&companyId=8` | ✅ 帶時間戳,8個月保留 |
| bet365 大小逐筆變盤 | `nba.titan007.com/odds/OverDownChart.aspx?scheId={id}&companyId=8&num=1&t=1` | ✅ |
| 獨贏歐指 | `nba.titan007.com/1x2/oddslist/{id}.htm` | ✅ 多公司 |
| 台彩收盤/賽果 | `playsport.cc/gamesData/result?allianceid=3&gametime=YYYYMMDD` | ✅ 客先主後、客/主前綴讓分 |
| 賽程/即時比分/box/PBP | `cdn.nba.com/static/json/liveData/...`（boxscore_{gid}/playbyplay_{gid}）+ `staticData/scheduleLeagueV2.json` | ✅ 舊場留存、**Actions 可通** |
| 官方彙總表(進階) | `stats.nba.com/stats/...` | ✅ 本機可通、**❌ Actions 被擋** |

- **鐵則：雲端管線只依賴 cdn.nba.com＋球探網＋玩運彩**；stats.nba.com 僅限本機（回補/對照）。
- 攻防效率**自算**（box score 回合數公式），不依賴 stats.nba.com；垃圾時間過濾用 cdn PBP。
- 玩運彩賽前頁有先發名單+傷兵（僅名字、常賽前 ~1h 才定、有「不確定」狀態）→ 爬蟲需臨場加密輪詢；格式開季前實抓釘死（夏聯無盤,現在驗不了）。

## D5 模型%：官方數據輸入＋標準轉換公式
- 輸入＝自算淨效率（每百回合淨勝分,垃圾時間過濾版為目標形態）。
- 轉換＝淨效率差×節奏＋主場優勢→預期分差→常態(σ)轉勝率（Stern 模型;HFA/σ/收縮 N0 由 25-26 回補擬合）。
- 冷啟動＝**球員層陣容先驗**（上季球員貢獻×現役名單×預估時間合成;解大洗牌+擴編新隊）;開季前 N 場卡片標「樣本不足」。
- **上卡片資格＝分檔校準通過**（模型說 X% 實際≈X%），不通過不上。

## D6 市場語義（與棒球的差異）
- 讓分/大小全半分制、級距 1、無 push（25-26 全季實證半分 100%）；基準線**由爬蟲現值自動帶入，不寫死預設**；範圍守門值取自回補分布（見 AUDIT_REPORT.md）。
- 獨贏無和局（OT 打到分勝負）→ 棒球和局/走盤分支不移植。
- 「顛倒」（讓分方換邊）在 NBA＝稀有事件（僅五五波盤會穿零）→ 異常軸主角改**線移幅度**（門檻由回補分布定），顛倒旗標保留當稀有強訊號。異常統計一律開季前瞻累積，不回填。
- titan 月檔方向/符號語義：**以 join_audit.js 實證結果為準**（雙假設比分檢定），不沿用棒球慣例假設。

## D7 明確不做（本階段）
- 占卜實驗室整條（投手類無主體；時間類 MLB 全 null）。教練當主體已評估否決（教練=球隊固定效應,拆不開）。
- 球員盤口資料庫（無自動源、使用者策略不需要）；球員模組＝得分地板頁+個人注單帳本。
- Cleaning the Glass / ESPN BPI / CourtOptix：不接（付費/脆弱/無關）。PBP Stats 留作二期對照。
