# FREEZE_MANIFEST_S — 實驗 S（小六壬）凍結清單 v1

凍結日：2026-07-12（台北）。tag：`divination-freeze-S-v1`。
敵意審：2026-07-12 CONCERNS（W1/W2 補入附錄 §8，W3/N2 內建於前瞻 workflow）。
**凍結後禁止修改下列工件；分析腳本另建、以本清單 SHA256 為 `--frozen-sha256` 守門。**
凍結時尚未進行任何卦象×結果統計（守門腳本結構性隔離，附錄 §6）。

## 凍結工件 SHA256

| 檔案 | 角色 | SHA256 |
|---|---|---|
| `xiaoliuren_engine.js` | 引擎（S-time/S-rand 雙臂、映射、閉式=逐步斷言） | `0bec05260d205e7f0235da81b0a84e0719865a73bcbd187d06e1e54ae97f4aec` |
| `xiaoliuren_cert.js` | S-time 認證/守門 | `ab4697063a320fdf198d6c306ac18de84aaf61ec31a22ba40b06bab479bb6747` |
| `xiaoliuren_beacon_backfill.js` | S-rand 信標回補/守門 | `1a5986c29d9301675dd958c25c28c5518d08893e23625a26685eeb655848101f` |
| `meihua_engine.js` | 曆法依賴（亦凍結於實驗 M） | `4144e9e08e25232629c6def17c8af8c0b1183e66b358957b491c31e05779e551` |
| `lunar.js` | 農曆函式庫（vendored） | `9750324bfe1aa63c146f8c72b1143df924466c11c8a5277d7d9225c541a18aaa` |
| `divination_lab/xiaoliuren_casts_time.json` | S-time ledger（16,273，無結果欄） | `d81a244be561ad864c900c97ccfd98f00bee3ed811391ed6c248d77d46389e50` |
| `divination_lab/xiaoliuren_casts_rand.json` | S-rand ledger（16,273，含 missed/fail，無結果欄） | `0b8a59e361607e7ee934f36296ee0a7c2352b3d60f69ecf50a5426f3c1aa6636` |
| `divination_lab/xiaoliuren_cert_time.json` | S-time 認證統計 | `f91c6df0669346ec03243abdfcc81fa956b675dd684acea29e9a1bf948c34900` |
| `divination_lab/protocol_S_annex_v0.md` | 協議附錄（Q1–Q6＋§5.1 斷檔＋§8 分析合約） | `ea856205c7c6a6f6eb38e68d947845e19cd8dcae7e29fbbe75247b9d0cd966d1` |

## 凍結鎖值（分析日不可變）

- 合格樣本 n=16,273（M §7 過濾器 `analysis_oneshot.js:32` 沿用）。
- **S-time**：有表態押大 f=**0.6007**、空亡棄場 17.19%、有效 n=13,476。
- **S-rand**：有表態押大 f=**0.5949**、cast 13,588（missedPulse 2,475/fetchFail 210）、有效 n=11,341；NIST 斷檔 2022-04-29→2022-10-01（MCAR，附錄 §5.1）。
- p₀ 與判定式：附錄 §8（q＝全樣本開大率單一常數；null 排除；hit 式鎖定）。
- 主檢：二項雙尾＋置換共同主檢；α 各臂 2.5%（Bonferroni）；TOST ±5pp。
- 絆線：分析日重算押大率/棄場率對上列 ±2pp；S-rand missedPulse 逐年照實全報。

## 前瞻臂（凍結後上線，非凍結工件）

`xiaoliuren_cast_daily.js` + `.github/workflows/xiaoliuren-cast.yml`：import 凍結引擎，對開賽前窗口之比賽即時起卦（S-time＋S-rand），追加 `data/xiaoliuren_casts.json`（out-of-sample 累積，遮蔽至開盒）。前瞻資料與凍結回測分帳、各自報告。
