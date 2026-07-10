# titan007 回補 pilot 對答案報告（2026-07-10）

⚠ 軸聲明：自動判定＝bet365(國際) vs 台彩；使用者手標時盯的是 STAKE。此比對驗證管線正確率，**不證明 STAKE 行為**。

## 樣本
- 手標窗內 291 場：titan 配對成功 288、對不上 0、雙重賽模糊 3
- 可自動判定（兩側序列齊）283 場、資料不足(na) 5 場

## flipState 對答案（家族層級：flipped/converged/none）
- 家族一致：**231/283＝81.6%**；含收斂方向全等：231/283
- 混淆矩陣（手標→自動）：{"converged→none":19,"flipped→converged":3,"none→none":216,"flipped→flipped":8,"converged→converged":7,"none→flipped":5,"converged→flipped":6,"flipped→none":14,"none→converged":5}

## 不一致清單（逐場，供裁決——自動判可能才是對的，也可能解析錯）
- 2026-06-27 太空人@老虎［mlb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-27 響尾蛇@光芒［mlb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-28 國民@金鶯［mlb］手標=flipped｜自動=converged_intl（相反持續218分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-27 樂天桃猿@富邦悍將［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-28 起亞虎@斗山熊［kbo］手標=none｜自動=flipped（相反持續265分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-06-27 馬林魚@紅雀［mlb］手標=converged_lottery｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-29 水手@守護者［mlb］手標=converged_intl｜自動=flipped（相反持續1062分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-06-29 洋基@紅襪［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-01 老虎@洋基［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-01 大都會@藍鳥［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-01 巨人@響尾蛇［mlb］手標=none｜自動=flipped（相反持續575分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-07-02 雙城@太空人［mlb］手標=none｜自動=converged_intl（相反持續344分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-02 KT巫師@韓華鷹［kbo］手標=none｜自動=flipped（相反持續352分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-07-03 紅雀@勇士［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-03 老虎@遊騎兵［mlb］手標=converged_lottery｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-04 大都會@勇士［mlb］手標=flipped｜自動=converged_intl（相反持續38分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-04 光芒@太空人［mlb］手標=none｜自動=converged_intl（相反持續1142分；國際收盤=away/台彩收盤=away；序列齊）
- 2026-07-04 紅襪@天使［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-05 富邦悍將@味全龍［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-06 大都會@勇士［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-06 金鶯@紅人［mlb］手標=none｜自動=converged_intl（相反持續539分；國際收盤=away/台彩收盤=away；序列齊）
- 2026-07-06 馬林魚@運動家［mlb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-07 響尾蛇@教士［mlb］手標=converged_intl｜自動=flipped（相反持續1237分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-07-07 太空人@國民［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-07 洋基@光芒［mlb］手標=converged_lottery｜自動=flipped（相反持續163分；國際收盤=away/台彩收盤=home；序列齊）
- 2026-07-07 養樂多燕子@廣島鯉魚［npb］手標=converged_intl｜自動=flipped（相反持續27分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-07-08 太空人@國民［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-08 守護者@雙城［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-08 響尾蛇@教士［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-08 樂天金鷲@西武獅［npb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-08 LG雙子@三星獅［kbo］手標=none｜自動=flipped（相反持續27分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-07-08 中信兄弟@統一獅［cpbl］手標=none｜自動=converged_intl（相反持續340分；國際收盤=away/台彩收盤=away；序列齊）
- 2026-07-08 樂天桃猿@富邦悍將［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-08 台鋼雄鷹@味全龍［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-03 統一獅@台鋼雄鷹［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-03 富邦悍將@味全龍［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-04 統一獅@台鋼雄鷹［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-04 橫濱DeNA@養樂多燕子［npb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-30 大都會@藍鳥［mlb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-06-30 西武獅@軟銀鷹［npb］手標=converged_lottery｜自動=flipped（相反持續313分；國際收盤=away/台彩收盤=home；序列齊）
- 2026-07-03 橫濱DeNA@養樂多燕子［npb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-07 中信兄弟@統一獅［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-09 紅襪@白襪［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-09 守護者@雙城［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-09 藍鳥@巨人［mlb］手標=none｜自動=converged_intl（相反持續347分；國際收盤=away/台彩收盤=away；序列齊）
- 2026-07-09 小熊@金鶯［mlb］手標=flipped｜自動=converged_intl（相反持續260分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-09 勇士@海盜［mlb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-09 洋基@光芒［mlb］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-09 台鋼雄鷹@味全龍［cpbl］手標=converged_intl｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-10 紅襪@白襪［mlb］手標=flipped｜自動=none（相反持續0分；國際收盤=home/台彩收盤=home；序列齊）
- 2026-07-10 歐力士@羅德［npb］手標=converged_intl｜自動=flipped（相反持續468分；國際收盤=home/台彩收盤=away；序列齊）
- 2026-07-10 味全龍@統一獅［cpbl］手標=none｜自動=flipped（相反持續284分；國際收盤=home/台彩收盤=away；序列齊）

## 對調（不同軸，僅資訊性——手標=你盯 STAKE；自動=國際或台彩側）
- 兩邊都有 16｜只有手標 35｜只有自動 9

## 背離（國際盤內，資訊性）
- 自動背離 2／不背離 232／不可判 49

## 線值 QA（自動收盤線 vs 你卡片上的線；你的線=STAKE，僅代理對照）
- 讓分線：可比 283 場，完全相等 281（99%），差≥1 2
- 大小線：可比 283 場，完全相等 193（68%），差≥1 75

## 回補涵蓋預告（若通過）
- 每場可得：國際讓分方向序列(ts+走地濾)、收盤讓分線、收盤大小線、bet365 開/收盤獨贏 → 讓分過盤/開大/獨贏三市場都可算（比分由 MLB API/matchResult 取）
## 裁決附錄（主會話交叉檢核，2026-07-10）

### 手標自洽性檢核（不靠 bet365——用你自己卡片的 hdFav(STAKE收盤讓分方) vs 台彩收盤方向）
- flipped 應相反：自洽 18／不自洽 7；converged 應同向：自洽 22／不自洽 10；none 應同向：自洽 225／不自洽 1
- **共 18 場（6.5%）三角不閉合**（flipState × hdFav × 台彩收盤對不攏）＝手標誤標或卡片 hdFav 未跟上晚場換邊，清單見主報告輸出；**其中 4 場屬預註冊凍結的 MLB flipped 名單**（6/27水手@守護者、6/27馬林魚@紅雀、7/2遊騎兵@守護者、7/6光芒@太空人）——凍結快照不動，但確認性分析前建議覆核。

### 52 場不一致拆解
- **40 場手標自洽**＝STAKE 軸與 bet365 軸真實不同（或 bet365 晚貼致自動側盲區）——不是管線錯誤，是兩個平台本來就不同。
- **12 場手標不自洽**＝疑誤標（上表 18 場的子集，落在不一致集內的部分）。
- 自動另抓到 **10 場你標 none 但兩側曾長時間相反（344~1142 分鐘）**——人工沒盯到的異常，自動判很可能才是對的（該軸上）。

### 線值來源結論
- 讓分線：變動表收盤=卡片 99%、月檔=卡片 99% → 讓分解析雙源皆實。
- 大小線：變動表 68%、月檔 59% → **跨書真實差異**（bet365 vs 你的 STAKE 線），非解析錯；回補的大小分析一律用 bet365 線＋比分自行結算，絕不與卡片線混用。
- 月檔收盤方向 vs bet365 變動表收盤方向 92.6% → 月檔線疑為站方預設書（非 bet365），僅作 sanity、不作權威。

### 總裁決：管線 PASS，軸差異已量化——**准予回補（4/1–6/26），附三條件**
1. 回補標籤一律存 **flipStateIntl / swapIntl / divergeIntl** 獨立欄位（bet365 vs 台彩軸），永不寫入/覆寫你的手標 flipState，**不得宣稱代表 STAKE**（使用者紅線）。
2. 每場保留：方向序列(ts+走地濾)、bet365 收盤讓分線＋大小線＋開/收盤獨贏、比分 → **獨贏／讓分／大小三市場全部可算**（使用者紅線）。
3. bet365 晚貼＝該軸結構性盲區（早期相反不可見）：回補標籤附 firstSeen 時戳，分析時可依「開盤觀測起點」分層。