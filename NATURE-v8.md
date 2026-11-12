# v8 自然模型：63 款的用途與技術註解

## 使用範圍

來源為 Quaternius **Ultimate Stylized Nature Pack（May 2022）**，本次 63 款：58 款植物、5 款岩石。模型已在 GameAssets 整理成公尺、Y 向上及遊戲 GLB；此專案只複製實際使用的遊戲匯出、縮圖、授權與來源紀錄，原 Blender 檔與下載 ZIP 留在素材庫。

遊戲每個世界先嘗試為當前相容款式安排代表實例，再依自然群落規則填滿物件數。未選沙漠時五款棕櫚不出現；棕櫚還需要水岸，不在乾燥沙丘任意散布。雪地／火山以枯木、適合的松樹與岩石為主。`Petals` 四款是靜態花冠／花頭構件，不是單片飄落花瓣，也沒有新增落花粒子動畫。

可重現全部 63 款的例子：森林 50%、沙漠 50%、8 km、種子 `V8-HABITATS-0`、至少 1,000 物件、橋隧開啟。這個示例包含沙漠綠洲；其餘配置按真實可用空間決定是否能放置，缺席款式會保留在實際報告中。

## 不改變外觀的容量整理

63 個原 GLB 共 99,264,084 bytes。將重複的內嵌 PNG 提取成 18 張按內容雜湊命名的本機貼圖後，主模型 7,333,896 bytes、貼圖 13,494,235 bytes，合計 20,828,131 bytes；加上 26 個 LOD1 為 26,274,875 bytes。主模型的 457 個 accessor 有效資料全部逐位元保留，包括頂點、索引、法線與 UV；不藉由重畫材質縮小檔案。

28 款含兩個 primitive，載入器保留全部材質分件。原材質合計 91 個，包含 48 個 MASK 與 43 個 OPAQUE；MASK 的 alphaCutoff 0.45 與 doubleSided 保留。GPU 快取按貼圖的網址、取樣設定、UV channel、色彩空間與翻轉狀態共用，避免把 sRGB 顏色貼圖與線性法線貼圖混用；相同材質定義也可共用。

26 款 LOD 只挑選完整、分離的葉片島嶼，保留外緣分布；樹皮與花朵幾何不變，不切碎枝幹或改 UV。這 26 款由 92,848 降為 74,032 三角形，屬保守簡化。樹木約 90 m、灌木約 65 m 的基準，搭配分塊半徑與 12 m 遲滯切換；實際切換距離由既有分塊系統計算。其他款式保留原幾何。

`sourceDerivation` 刻意與舊 `derivation` 欄位分開，避免新植物誤進入舊版山丘／火山的貼地網格變形流程。所有新模型仍須通過足跡、軌道淨空、車站、田區、水域及坡度檢查。

## 款式對照

表中的「相容地形」只列本版八種環境；完整分類、尺寸、縮放建議、腳底基準、雜湊、原始 Blender 檔名見 `asset-manifest.json` 與 `assets/provenance/Quaternius_UltimateStylizedNature_202205/`。

| 模型 ID | 名稱 | 三角形（主／LOD1） | 相容地形 | 限制 |
|---|---|---:|---|---|
| `Plant_Quaternius_BushFlowers_001` | 中型開花灌木 | 478／258 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BushLargeFlowers_001` | 大型開花灌木 | 402／252 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BushLarge_001` | 大型灌木 | 276／126 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BushSmallFlowers_001` | 小型開花灌木 | 274／170 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BushSmall_001` | 小型灌木 | 190／86 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Bush_001` | 中型灌木 | 400／180 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Petals_001` | 花瓣部件 01 | 90／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Petals_002` | 花瓣部件 02 | 12／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Petals_003` | 花瓣部件 03 | 6／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Petals_004` | 花瓣部件 04 | 6／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_FlowerClump_001` | 花叢 01 | 620／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_FlowerClump_002` | 花叢 02 | 136／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_FlowerClump_003` | 花叢 03 | 136／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_FlowerClump_004` | 花叢 04 | 136／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_FlowerClump_005` | 花叢 05 | 136／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Flower_001` | 單株花 01 | 162／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_Flower_002` | 單株花 02 | 34／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_GrassLargeExtruded_001` | 加厚大草叢 | 516／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_GrassLarge_001` | 大草叢 | 108／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_GrassSmall_001` | 小草叢 | 58／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_LeafyPlantFlowers_001` | 開花葉叢植物 | 330／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_LeafyPlant_001` | 葉叢植物 01 | 420／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_LeafyPlant_002` | 葉叢植物 02 | 160／— | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BirchTree_001` | 白樺樹 01 | 4,596／3,548 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BirchTree_002` | 白樺樹 02 | 7,660／6,454 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BirchTree_003` | 白樺樹 03 | 6,818／4,544 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BirchTree_004` | 白樺樹 04 | 3,562／2,960 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_BirchTree_005` | 白樺樹 05 | 4,520／3,716 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_001` | 枯樹 01 | 4,792／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_002` | 枯樹 02 | 5,344／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_003` | 枯樹 03 | 4,928／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_004` | 枯樹 04 | 3,528／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_005` | 枯樹 05 | 1,360／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_006` | 枯樹 06 | 2,984／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_007` | 枯樹 07 | 3,504／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_008` | 枯樹 08 | 4,944／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_009` | 枯樹 09 | 824／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_DeadTree_010` | 枯樹 10 | 3,208／— | 森林、丘陵、雪地、火山 | 依足跡與坡度配置 |
| `Plant_Quaternius_MapleTree_001` | 楓樹 01 | 3,848／3,374 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_MapleTree_002` | 楓樹 02 | 4,800／4,088 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_MapleTree_003` | 楓樹 03 | 6,678／5,726 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_MapleTree_004` | 楓樹 04 | 1,256／1,020 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_MapleTree_005` | 楓樹 05 | 4,504／3,792 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_NormalTree_001` | 一般闊葉樹 01 | 8,520／6,470 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_NormalTree_002` | 一般闊葉樹 02 | 8,084／6,578 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_NormalTree_003` | 一般闊葉樹 03 | 7,096／5,904 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_NormalTree_004` | 一般闊葉樹 04 | 6,338／4,794 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_NormalTree_005` | 一般闊葉樹 05 | 2,182／1,730 | 森林、丘陵、田園、鄉村、湖畔 | 依足跡與坡度配置 |
| `Plant_Quaternius_PalmTree_001` | 棕櫚樹 01 | 472／— | 沙漠 | 僅水岸／綠洲 |
| `Plant_Quaternius_PalmTree_002` | 棕櫚樹 02 | 368／— | 沙漠 | 僅水岸／綠洲 |
| `Plant_Quaternius_PalmTree_003` | 棕櫚樹 03 | 344／— | 沙漠 | 僅水岸／綠洲 |
| `Plant_Quaternius_PalmTree_004` | 棕櫚樹 04 | 472／— | 沙漠 | 僅水岸／綠洲 |
| `Plant_Quaternius_PalmTree_005` | 棕櫚樹 05 | 264／— | 沙漠 | 僅水岸／綠洲 |
| `Plant_Quaternius_PineTree_001` | 松樹 01 | 2,128／1,796 | 森林、丘陵、田園、鄉村、湖畔、雪地 | 依足跡與坡度配置 |
| `Plant_Quaternius_PineTree_002` | 松樹 02 | 2,716／2,112 | 森林、丘陵、田園、鄉村、湖畔、雪地 | 依足跡與坡度配置 |
| `Plant_Quaternius_PineTree_003` | 松樹 03 | 1,998／1,744 | 森林、丘陵、田園、鄉村、湖畔、雪地 | 依足跡與坡度配置 |
| `Plant_Quaternius_PineTree_004` | 松樹 04 | 2,686／2,146 | 森林、丘陵、田園、鄉村、湖畔、雪地 | 依足跡與坡度配置 |
| `Plant_Quaternius_PineTree_005` | 松樹 05 | 838／464 | 森林、丘陵、田園、鄉村、湖畔、雪地 | 依足跡與坡度配置 |
| `Environment_Quaternius_Rock_001` | 岩石 01 | 228／— | 森林、丘陵、田園、鄉村、湖畔、雪地、沙漠、火山 | 依足跡與坡度配置 |
| `Environment_Quaternius_Rock_002` | 岩石 02 | 202／— | 森林、丘陵、田園、鄉村、湖畔、雪地、沙漠、火山 | 依足跡與坡度配置 |
| `Environment_Quaternius_Rock_003` | 岩石 03 | 712／— | 森林、丘陵、田園、鄉村、湖畔、雪地、沙漠、火山 | 依足跡與坡度配置 |
| `Environment_Quaternius_Rock_004` | 岩石 04 | 456／— | 森林、丘陵、田園、鄉村、湖畔、雪地、沙漠、火山 | 依足跡與坡度配置 |
| `Environment_Quaternius_Rock_005` | 岩石 05 | 632／— | 森林、丘陵、田園、鄉村、湖畔、雪地、沙漠、火山 | 依足跡與坡度配置 |

## 授權與來源

本次採用的是有專屬 CC0 證據的 2022 年這一包，不把作者全站其他版本一概視為 CC0。保留作者頁、原始 License.txt、授權差異與貼圖鏡像復原查核；原授權檔標題誤寫 Platformer Pack 的差異也保留，沒有改寫來源檔。

- 作者作品頁：https://quaternius.com/packs/ultimatestylizednature.html
- 完整查核：`assets/licenses/Quaternius_UltimateStylizedNature_202205/LicensingReview.zh-TW.md`
- 63 款來源及遊戲版雜湊：`assets/provenance/Quaternius_UltimateStylizedNature_202205/pack.json`
- 貼圖復原：授權資料夾中的 `texture-recovery.json`、`texture-manifest.json`；使用原始來源貼圖的 1K 遊戲衍生版，未重畫替代。
- 幾何與圖片驗證：`validation/nature-v8-assets.json`；LOD：`validation/nature-v8-lod.json`。

整理腳本為 `scripts/import-nature-v8.mjs` 與 `scripts/build-nature-lod-v8.mjs`。前者需指定原 GameAssets 素材庫 `--source-root`；`--verify-only` 不改寫素材庫，後者可在遊戲專案獨立檢查 LOD。正常遊玩不需要 Blender、素材庫或這些整理腳本。
