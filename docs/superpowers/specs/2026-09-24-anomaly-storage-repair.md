# 異常統計與大型資料儲存修復規格

## 目標

1. 今天兩場藍鳥對金鶯雙重賽與紅雀對海盜，都能各自保留、結算並進入正確的異常統計。
2. Bet365 與台彩七類統計採用一致的「曾對調」證據，不因 BetExplorer 有資料但未偵測到對調而丟掉 Titan 的永久狀態。
3. 同日同隊雙重賽以開賽時間或官方賽事 ID 區分，不再互相覆蓋。
4. 已結算卡片若曾因舊鍵值被覆蓋，載入時可從卡片的結算快照重建缺少的比賽紀錄。
5. `dvManualCasts` 與 `dvManualCastsWnba` 搬到 IndexedDB；寫入後必須讀回驗證，成功才移除 localStorage 舊資料，失敗則保留舊格式作為保底。
6. 備份檔同時包含棒球盤面、棒球占卜與 WNBA 占卜；舊備份仍可匯入。

## 資料判定

- Bet365 曾對調：`BetExplorer.flipEver`、Titan `intl_state.sw > 0`、既有鎖存狀態任一成立即成立。
- OddsPortal 同日同隊有重複候選時，優先選擇實際賠率活動日期與目標日期一致者，再比較觀測時間。
- 異常組合的人工非 `none` 選擇優先；沒有人工選擇時，以結算快照 `bet365Taiwan.relation` 補足。
- 比賽唯一鍵優先使用 `officialId`，否則使用聯盟、日期、客隊、主隊與時間。

## IndexedDB 安全策略

- 資料庫：`sportbetting_plus_large_v1`，物件庫：`payloads`。
- 每筆保存版本、資料、筆數、JSON 長度與雜湊；寫入後重新讀取並比對全部驗證欄位。
- 遷移成功才移除對應 localStorage；IndexedDB 不可用或驗證失敗時，沿用既有 gzip localStorage 寫法。
- localStorage 儀表只計算 5 MB 小型區；另顯示 IndexedDB 大型資料估算大小。

## 驗收

- 兩場 2026-09-24 藍鳥對金鶯（01:35、06:35）各自存在且不互蓋。
- 紅雀對海盜選到正確的 2026-09-24 OddsPortal 事件。
- 三場 Bet365 × 台彩快照都能建立，並進入異常組合統計。
- IndexedDB 遷移成功、失敗保底、備份匯出／匯入均有自動測試。
- 全套測試通過，部署後再核對線上資料為新版本。
