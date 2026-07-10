# pilot 對答案報告 v2（2026-07-11，台彩收盤改用玩運彩結果頁後重跑）

> v1 缺陷（使用者抽查 3 場全中）：pregame feed 的台彩欄位＝開盤一次性快照（287/287 場零變動、距開賽中位 16.2h），被誤當收盤。v2 台彩收盤改玩運彩結果頁（權威），開盤仍用 feed 首值，判定改端點代數。

⚠ 軸聲明不變：自動判定＝bet365 vs 台彩，不代表 STAKE。

## 樣本：配對 288｜可判 283｜na 5（含玩運彩頁缺讓分線/隊名未識別）

## flipState 家族一致率：**237/283＝83.7%**
混淆矩陣（手標→自動）：{"converged→none":15,"flipped→converged":3,"converged→converged":13,"none→none":216,"none→flipped":3,"flipped→flipped":8,"converged→flipped":4,"flipped→none":14,"none→converged":7}

## 手標自洽性 v2（hdFav vs 玩運彩台彩收盤）
flipped 應相反：20自洽/5不自洽｜converged 應同向：32/0｜none 應同向：223/3
不自洽清單（8）：
- 2026-06-28 日本火腿@西武獅［npb］手標=flipped｜你的讓分方=away vs 台彩收盤=away(同向)
- 2026-06-27 水手@守護者［mlb］手標=flipped｜你的讓分方=away vs 台彩收盤=away(同向)
- 2026-07-01 大都會@藍鳥［mlb］手標=flipped｜你的讓分方=away vs 台彩收盤=away(同向)
- 2026-07-01 巨人@響尾蛇［mlb］手標=none｜你的讓分方=away vs 台彩收盤=home(相反)
- 2026-07-02 KT巫師@韓華鷹［kbo］手標=none｜你的讓分方=away vs 台彩收盤=home(相反)
- 2026-07-08 守護者@雙城［mlb］手標=flipped｜你的讓分方=away vs 台彩收盤=away(同向)
- 2026-06-30 羅德@樂天金鷲［npb］手標=flipped｜你的讓分方=away vs 台彩收盤=away(同向)
- 2026-07-10 味全龍@統一獅［cpbl］手標=none｜你的讓分方=away vs 台彩收盤=home(相反)

## 家族不一致清單（46）
- 2026-06-27 太空人@老虎［mlb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-06-27 響尾蛇@光芒［mlb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-06-28 國民@金鶯［mlb］手標=flipped｜自動=converged_intl（intl away→home·曾擺動｜台彩 home→home）
- 2026-06-28 日本火腿@西武獅［npb］手標=flipped｜自動=converged_lottery（intl away→away｜台彩 home→away）
- 2026-06-28 起亞虎@斗山熊［kbo］手標=none｜自動=flipped（intl home→home｜台彩 away→away）
- 2026-06-27 馬林魚@紅雀［mlb］手標=converged_lottery｜自動=flipped（intl home→home｜台彩 home→away）
- 2026-06-29 洋基@紅襪［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-06-30 海盜@費城人［mlb］手標=none｜自動=flipped（intl home→home｜台彩 home→away）
- 2026-07-01 老虎@洋基［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-02 雙城@太空人［mlb］手標=none｜自動=converged_intl（intl away→home·曾擺動｜台彩 home→home）
- 2026-07-02 遊騎兵@守護者［mlb］手標=flipped｜自動=none（intl away→home·曾擺動｜台彩 away→home）
- 2026-07-02 KT巫師@韓華鷹［kbo］手標=none｜自動=converged_lottery（intl home→home｜台彩 away→home）
- 2026-07-03 紅雀@勇士［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-03 老虎@遊騎兵［mlb］手標=converged_lottery｜自動=flipped（intl home→home｜台彩 home→away）
- 2026-07-04 大都會@勇士［mlb］手標=flipped｜自動=none（intl home→home·曾擺動｜台彩 home→home）
- 2026-07-04 光芒@太空人［mlb］手標=none｜自動=converged_intl（intl home→away·曾擺動｜台彩 away→away）
- 2026-07-04 紅襪@天使［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-05 富邦悍將@味全龍［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-06 大都會@勇士［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-06 金鶯@紅人［mlb］手標=none｜自動=converged_intl（intl home→away·曾擺動｜台彩 away→away）
- 2026-07-06 光芒@太空人［mlb］手標=flipped｜自動=none（intl away→home·曾擺動｜台彩 away→home）
- 2026-07-06 馬林魚@運動家［mlb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-07 藍鳥@巨人［mlb］手標=none｜自動=converged_intl（intl home→away·曾擺動｜台彩 away→away）
- 2026-07-07 太空人@國民［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-07 養樂多燕子@廣島鯉魚［npb］手標=converged_intl｜自動=none（intl away→home·曾擺動｜台彩 away→home）
- 2026-07-08 太空人@國民［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-08 響尾蛇@教士［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-08 樂天金鷲@西武獅［npb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-08 LG雙子@三星獅［kbo］手標=none｜自動=flipped（intl away→home·曾擺動｜台彩 away→away）
- 2026-07-08 中信兄弟@統一獅［cpbl］手標=none｜自動=converged_intl（intl home→away·曾擺動｜台彩 away→away）
- 2026-07-08 樂天桃猿@富邦悍將［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-08 台鋼雄鷹@味全龍［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-03 統一獅@台鋼雄鷹［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-03 富邦悍將@味全龍［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-04 統一獅@台鋼雄鷹［cpbl］手標=converged_intl｜自動=flipped（intl home→home｜台彩 home→away）
- 2026-07-04 樂天桃猿@中信兄弟［cpbl］手標=flipped｜自動=converged_lottery（intl home→home｜台彩 away→home）
- 2026-07-04 橫濱DeNA@養樂多燕子［npb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-06-30 大都會@藍鳥［mlb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-03 橫濱DeNA@養樂多燕子［npb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-07 中信兄弟@統一獅［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-09 紅襪@白襪［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-09 勇士@海盜［mlb］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-09 洋基@光芒［mlb］手標=converged_intl｜自動=flipped（intl home→home｜台彩 home→away）
- 2026-07-09 台鋼雄鷹@味全龍［cpbl］手標=converged_intl｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-10 紅襪@白襪［mlb］手標=flipped｜自動=none（intl home→home｜台彩 home→home）
- 2026-07-10 味全龍@統一獅［cpbl］手標=none｜自動=converged_lottery（intl home→home｜台彩 away→home）