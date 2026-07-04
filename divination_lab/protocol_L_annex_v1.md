# 實驗 L 協議附錄 v1（六爻 × 前瞻 × 大小分）

> 隸屬主協議 `protocol_frozen_M_v1.md`（SHA256 `e9aed1ac…5851219`），為 confirmatory 家族第二成員（主協議 §8），α=0.05。
> 修訂紀律：2027 confirmatory 開跑（開幕日）前可發 v2（重雜湊、重 tag、全記錄）；開跑後凍結不得改。

## 1. 可證偽主張

系統排程於賽前 55–120 分鐘，以 NIST Randomness Beacon 公開隨機脈衝模擬三錢六擲起卦，經本附錄凍結之六爻映射產生大小分二元預測；confirmatory 樣本中，命中率顯著異於調整後虛無值 p₀（雙尾 α=0.05）。

## 2. 起卦程序（凍結）

- 執行體：`liuyao_cast_daily.js`（雜湊見凍結 commit）。**一場一卦，永不重抽**。
- 隨機源：`GET https://beacon.nist.gov/beacon/2.0/pulse/last`（記錄 pulseIndex / timeStamp / outputValue——任何人可對 NIST 官方存檔驗證該時刻的脈衝值）。派生：SHA256(outputValue|gamePk) 前 18 bit → 每爻 3 bit 計背數（0背交/1背單/2背拆/3背重）。
- 曆法脈絡：月建＝節氣月支、日辰＝日支（0 點換日）——與實驗 M 同約定。
- 失敗政策：beacon 失敗＝留痕跳過本輪、下輪重試；窗口關閉仍未起卦＝棄場留痕。**絕不以偽隨機頂替。**
- 帳本：`data/liuyao_casts.json` 逐筆追加（含棄場與失敗），git commit 時間戳公證，全報不藏。

## 3. 映射（凍結）

`liuyao_engine.js`：尋世訣（八宮卦例 8/8 驗證）＋納甲（《卜筮全書》表）＋世應計分——月建/日辰對爻：同/生 +2、剋 −2、洩耗 −1；每一動爻（非自身）對世/應：生/同 +1、剋 −1。世分＞應分→世方；＜→應方；平手→世應本爻相剋裁決；**再平＝卦無表態→棄場**。

**平手裁定理由（2026-07-03 定案）**：計分平手且世應互不相剋＝系統對勝負無表態，若由「極性約定」代打，12.57% 的預測是我們寫的、不是卦出的——稀釋假說訊號亦弄髒解讀。棄場與實驗 M 排除比和同構（比和＝無表態）。成本：樣本 −12.57%，一季仍餘 ~2,120 場，MDE ±3.0pp、TOST ±5pp 充足。

極性（僅適用有表態場次）：世＝「大」方。

## 4. 認證值（2026-07-03，10⁶ 均勻模擬，`liuyao_cert_v1_frozen.txt`）

- 棄場 12.566%；有表態 87.434%；**有表態中押大 51.816%**（各月支 48.80%–54.22%）。
- 偏差 1.816pp > 0.5pp → 依主協議 §3 既定機制：p₀ 於 confirmatory 樣本重算吸收。
- 交叉驗證：動爻數分布吻合二項理論（0 動 17.76% vs 17.80%）。
- 絆線：confirmatory 樣本押大率偏離 51.82% 超過 ±3pp（考量月支組成差異放寬至 3pp）→ 凍結調查。

## 5. 統計（同主協議 §3/§4，全部預註冊）

p₀ = p̂側·P̂over + (1−p̂側)(1−P̂over)，兩參數皆於 confirmatory 合格樣本重算；精確式二項雙尾＋Wilson 95% CI＋TOST ±5pp＋日期分層置換檢定（10,000 次，seed=本附錄 SHA256 前 8 hex）；結論三模板只准填空。對照臂＝HMAC(key=SHA256(本附錄檔), msg=gamePk) 生成同格式卦、套同一映射（含棄場規則），僅作管線完整性檢查。

## 6. 期程（凍結）

- **啟用日 → 2026 季末＝pilot**：驗管線與 beacon 可靠度，數據全公開，**不入 confirmatory**。
- **2027 例行賽全季＝confirmatory**：固定範圍、單一分析日（2027 季後）；期間任何面板遮蔽命中率（只顯示起卦成功率/資料完整度/押向分布）。
- 樣本預估：2,430 × 87.4% ≈ 2,120；MDE ≈ ±3.0pp（80% power）。

## 7. 合格樣本與排除

同主協議 §7：gameType=R、Final、非 7 局、有大小線、非 ambiguous、gamePk 唯一性硬斷言；加：棄場卦、beacon 失敗未起卦場次（留痕記數）。

## 7b. 修訂紀錄

**v1.1（2026-07-04，pilot 期間、confirmatory 開跑前）**：起卦窗口 55–120 分 → **40–180 分**；新增**漏卦留痕**條目（missedWindow＝棄場，不得無聲消失）。
原因：2026-07-04 漏卦事故——GitHub cron 常態遲到 10–40 分鐘，加上當日 cron 空窗與一次 YAML BOM 啟動失敗，65 分鐘寬的窗口被整段吃掉（gamePk 822716 未起卦）。窗口加寬不改變任何斷卦規則與統計程序；40 分下限仍在開打前、資訊環境不變。本修訂在任何 confirmatory 卦產生之前生效；附錄雜湊隨本節更新，對照臂 key 以分析日檔案雜湊為準。

## 8. 啟用程序（唯一未完成步驟，使用者執行）

1. repo Settings → Actions → Workflow permissions → **Read and write**。
2. `cp divination_lab/liuyao-cast.yml.example .github/workflows/liuyao-cast.yml` → commit → push。
3. Actions 頁手動 `workflow_dispatch` 跑一次 → 確認 ledger 出現首筆（或「視窗內 0 場」日誌）。
