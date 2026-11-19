# v13 驗證紀錄

2026-11-19，版本 13.0.0。以 GameAssets 的 `RailLoopLab-v12-20261119.zip` 為基礎。

- 逐一核對 3、4、5、6、7、8、9、10 公里。每種長度都生成三條對齊起終點的開放軌道，沿坡面量得各自的選定里程。0 公尺起伏時全線平坦，設起伏上限時仍維持 25‰ 縱坡限制及 5,000 公尺最小豎曲線半徑。
- Chrome 1920 × 1080 測試以三個等寬視窗跑完 3 公里。三車在 3,000 公尺停車，完賽畫面依時間排名。測試另驗證起點倒車限制、同步推桿及渦輪、暫停和返回標題。[競速畫面](validation/straight-driving-v13.jpg) · [完賽畫面](validation/straight-finish-v13.jpg)
- Chrome 載入 10 公里設定，三車各取得 10,000 公尺賽道。切換回環狀後保有先前選過的環狀長度與圈數，三車通過環狀測試路線一周後可以繼續行駛。[標題畫面](validation/straight-title-v13.jpg) · [瀏覽器測試數據](validation/browser-v13.json)
- 既有模型、材質與執行庫的封裝成員均與 v12 相同。運行 `node scripts/verify-v13.mjs` 可重做 103 項自動測試，包含軌道端點、終點計時、並列判定及既有環狀行為。[自動測試結果](validation/automated-v13.json)
