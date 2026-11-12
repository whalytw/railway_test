# 本包授權與來源查核紀錄

查核及整理日期：2026-11-11（Asia/Taipei）。適用對象為 Ultimate Stylized Nature Pack（May 2022），本次 63 款；不把 Quaternius 全站或未來版本一概視為 CC0。

## 本包 CC0 證據

- [作者專屬作品頁](https://quaternius.com/packs/ultimatestylizednature.html) 明列 63 款、Blend/FBX/OBJ/glTF 與 CC0，並連到 CC0 1.0。頁面原始 HTML 保留為 `official-pack-page.html`。
- 作品頁下載按鈕連到 [作者官方套組資料夾](https://drive.google.com/drive/folders/1IV3bXHzkNvuNWFHPi4KPx-G4ghuxIuT-)。其中有 Blends、Textures、License.txt 等。
- 官方資料夾內的 [License.txt](https://drive.google.com/file/d/1W3YGLar9Ie0Lwfw7QJv1x8oBLKFPuOkW/view) 374 bytes，指定 CC0 1.0 Universal 與 Public Domain Dedication。這份原文保留在本目錄 `License.txt`，未改寫。
- 此檔抬頭誤寫「Ultimate Platformer Pack by @Quaternius」，和 Nature 包名稱不同，疑似範本沿用。保留此差異；套組身分與授權主要以專屬 Nature 作品頁判讀。
- [作者在 Poly Pizza 的同包頁面](https://poly.pizza/bundle/Ultimate-Stylized-Nature-Pack-zyIyYd9yGr) 也將本包列為 Quaternius、2022 年更新、CC0；其中 12 項是合併的模型組，不是本 ZIP 的單品數。
- [通用 QAL 頁面](https://quaternius.com/license.html) 自 2026-08-28 起另有條款，禁止將 QAL 資產當作獨立素材散布，與本包專屬 CC0 標示不同。舊包已有明確 CC0 證據，本次依該特定版本 CC0 聲明納入；QAL 差異頁一併保留。
- [CC0 正式條文](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en) 的放棄及備援授權不可撤回；因此後來通用條款不會自動抹除同一作品已有效授予的 CC0。

CC0 允許複製、修改、商用及再散布，不強制署名；仍保留 Quaternius 作者資訊，避免把第三方模型寫成自行創作。可在遊戲 Credits 自願列出作者與來源。GameAssets 的保存規則仍要求原 ZIP、查核頁及來源紀錄留在本機素材庫；只複製遊戲實際需要的匯出檔。

## 貼圖取得方式

使用者提供的 ZIP 只有 63 個 Blender 檔，沒有外部貼圖。官方 Textures 目錄列出 21 張 PNG，但本次逐檔下載回傳 Google Drive quota exceeded。

已由公開 CC0 套組鏡像 `https://github.com/tilakpatell/tilakverse-assets/tree/main/quaternius/stylized-nature-pack` 取回 21 張原始 PNG，並完成以下核對：

1. 鏡像的 63 個 Blender 檔名與大小，全部符合使用者 ZIP。
2. 從鏡像取得 NormalTree_1.blend，其 SHA-256 與使用者 ZIP 內同檔完全一致。沒有宣稱已對鏡像全部 63 個檔案逐一比對官方雜湊。
3. 鏡像 21 張 PNG 的檔名與大小全部符合作者官方 Textures 清單。
4. 每張 PNG 通過格式、解碼、大小與 Git blob SHA-1 校驗；另記錄本機 SHA-256。
5. 鏡像授權與官方授權，在只統一 CRLF/LF 後逐字相同；保留 `mirror-License.txt` 作為取得紀錄，原作者官方授權仍使用原 374 bytes 版本。

原始 PNG 保留於共用 `textures/original/`，沒有重畫、補繪或用其他套組材質替代。遊戲版 `textures/runtime_1k/` 為明確標記的衍生版本：最多 1024 px、8-bit，法線貼圖縮放後重新正規化；原始 16-bit/2048 px 檔案完整保留。

`texture-recovery.json` 與 `texture-manifest.json` 提供每張檔案的直接來源、官方對應連結、像素尺寸、位元深度、大小與雜湊。
