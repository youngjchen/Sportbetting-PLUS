# 實驗 L 附錄修訂 v1.3 — 獨贏/讓分 exploratory 卦

- **依據**：協議 Q3 決議預留之 exploratory 支流；使用者 2026-07-05 點頭、2026-07-06 併求籤臂部署。
- **內容**：每場在 confirmatory 大小分卦之外，加起獨贏（ml）與讓分（hd）兩卦，`exploratory: true`、`annex: "v1.3"` 標記，開盒只描述不下結論。
- **推導（凍結）**：新市場 = `SHA256(outputValue|gamePk|market)` 前 18 bit（market ∈ {ml, hd}）。輸入含市場後綴，與 legacy `SHA256(outputValue|gamePk)`（大小分）**不相交**；同一錨定脈衝（開賽前 240 分，v1.2 釘選不變）。
- **極性映射（凍結）**：沿用同一世應斷卦引擎；卦極性正（原「押大」側）→ ml 押主、hd 押熱門過盤；負 → 押客、押受讓；平手 → 棄場（與 confirmatory 同構）。讓分結算＝D5 v0.2 來源鏈（盤面卡片 hdFav/hdLine 優先 → 爬蟲收盤 → 棄場）。
- **confirmatory 不變性證明**：固定向量 (outputValue=`deadbeef`×16, gamePk=717000, 月支午/日支巳) 修改前後輸出逐位元相同（backs=[1,1,1,2,2,1]、平手棄場）；legacy 程式路徑零改動（只增區塊）。
- **回溯規則**：v1.3 生效日前之場次不補起 exploratory 卦；生效後 lookback 視窗內未及起卦者記 missedWindow（全報不藏）。
- **遮蔽**：exploratory 卦同受協議 §9 遮蔽（開盒前不顯示命中）。
