# RailLoopLab v8：Rapier 物理

v8 將 Rapier **0.21.0** 的 WASM 相容版直接放入 `vendor/rapier/`，透過本機 HTTP 伺服器執行時不必連線下載物理引擎。套件原檔、Apache-2.0 授權與下載來源／完整性雜湊隨專案保留。

## 實際模擬的範圍

這是受軌道約束的動力學模型。Rapier 的 X 座標代表沿軌道的連續、有正負號里程，畫面再以同一個 `route.sample(distance)` 映射到三維軌道。Y 是車體懸吊位移，Z 與旋轉自由度受限。

- **130 kg 轉向架 + 520 kg 簧上車體**，合計沿用 650 kg 車重，兩者都是會受力與關節影響的 dynamic 剛體。
- 垂直 prismatic 關節使用 **ForceBased** 彈簧馬達，預設彈簧常數 60,000 N/m、阻尼 9,000 N·s/m；初始位置已補償靜態重量，不會開局掉落彈跳。
- 原有馬達功率、牽引上限、反向煞車、滾動阻力、空氣阻力、坡度重力與調速器由 `core.stepPhysics` 在暫存狀態上計算成受力參考。**暫存狀態的速度與里程不作為結果**；實際速度、位移由 Rapier 的積分、關節與碰撞求解後讀回。
- 垂直軌道曲率造成的法向加速度會改變簧上車體負載，因此起伏處的懸吊運動來自受力，不加入固定頻率的裝飾抖動。
- 可選的固定測試擋車器會與車體的實體包絡碰撞，接觸衝量會改變行車速度。使用單一簧上車體碰撞包絡；轉向架碰撞體只提供其質量，避免同一車輛重複解算擋車器接觸。
- 開啟 CCD，使用 1/120 秒固定物理步長、8 次求解迭代及最多 2 個 CCD 子步。每當本機 X 超過約 192 m，所有剛體與擋車器一起更換座標原點，維持長時間行車的浮點精度。

這套模型沒有模擬輪緣與鋼軌的三維網格接觸、脫軌或完整輪軸幾何。曲線導向與車身方向仍由共享軌道路徑約束。

## 程式介面

```js
import { initRapier, RapierRailPhysics } from './src/rapier-rail.js';

await initRapier(); // 一次即可；WASM 已嵌入本機 ESM
const railPhysics = new RapierRailPhysics(route);
railPhysics.reset(state); // state 由 core.createPhysics() 建立
railPhysics.step(state, 1 / 120, state.throttle, grade);
```

建構子的可選參數與預設值：

```js
new RapierRailPhysics(route, {
  rebaseDistance: 192,           // m；支援 100–300
  suspensionStiffness: 60000,    // N/m；支援 20000–200000
  suspensionDamping: 9000       // N·s/m；支援 1000–30000
});
```

| 方法 | 行為 |
| --- | --- |
| `step(state, dt, throttle, grade)` | 原地更新狀態。沿用倒數計時；倒數期間不推進 Rapier。`dt` 必須大於 0 且不超過 0.1 秒，正常遊玩使用固定 1/120 秒。 |
| `placeBumper(unwrappedDistance)` | 在未取餘數的沿軌里程放置固定擋車器，回傳距離與碰撞包絡尺寸。 |
| `clearBumper()` | 移除擋車器與目前接觸紀錄。 |
| `reset(state)` | 清理舊 Rapier 世界，依給定狀態的里程與速度重新建立；清除擋車器及碰撞／求解步數。 |
| `reset()` | 將目前綁定的狀態原地重設為 `createPhysics()` 預設值，重新建立物理世界並回傳該狀態。 |
| `applySuspensionImpulse(impulseNs)` | 對簧上車體施加垂直衝量，限制於 ±100 N·s；供物理測試使用。 |
| `diagnostics()` | 回傳版本、實際總質量、求解步數、碰撞、座標原點、局部 X 與懸吊參數。 |
| `dispose()` | 釋放事件佇列與整個 WASM 世界；重複呼叫安全。釋放後應建立新實例。 |

`step` 保留原有狀態欄位，並加入：

| 欄位 | 單位／意義 |
| --- | --- |
| `suspensionY` | m；相對平直軌道靜態平衡位置的車體位移。渲染時應插值，輪組維持軌道位置。 |
| `suspensionVelocity` | m/s；簧上車體垂直速度。 |
| `contactImpulse` | N·s；最近一次物理步的擋車器淨接觸衝量。由實際總動量變化扣除已知驅動／阻力衝量求得，不含調速器；沒有接觸事件則為 0。 |
| `collisionCount` | 累積擋車器撞擊次數。 |
| `rapierSteps` | 實際完成的 Rapier 步數，不含起步倒數。 |
| `solverVersion` | 固定套件版本 `0.21.0`。 |

暫停時由主程式停止呼叫 `step`，恢復時重設牆鐘時間，避免補算暫停期間。顯示里程、速度與懸吊位移以相鄰固定步狀態插值；不要把插值結果回寫物理世界。

## 驗證

```text
node --test tests/rapier-v8.test.mjs
```

10 項測試涵蓋：封鎖所有 `fetch` 後仍可初始化、實際總質量與受力結果、平地滑行與正反坡度、靜止阻力與反向煞車、正反向限速、倒數與不規則畫面幀率下的一致結果、120 km/h 擋車器碰撞、懸吊衝量與回穩、10 億公尺座標起點的長距離重定基準及碰撞、反覆重設與釋放。

此驗證是數值與生命週期測試；畫面互動、顯示插值與懸吊輪組對位由整合後的遊戲驗證。

## 官方來源與套件出處

- [官方 npm 固定版本中繼資料](https://registry.npmjs.org/@dimforge%2frapier3d-compat/0.21.0)：版本、授權、壓縮檔來源與 SHA-512 完整性；本機記錄為 `vendor/rapier/version.json`。
- [Rapier JavaScript 入門](https://rapier.rs/docs/user_guides/javascript/getting_started_js/) 與 [官方原始碼儲存庫](https://github.com/dimforge/rapier)：引擎與 JavaScript 套件。
- [Dynamic／kinematic 剛體差異](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/)：dynamic 剛體受外力與接觸影響；kinematic 軌跡由程式指定。
- [受力與衝量](https://rapier.rs/docs/user_guides/javascript/rigid_body_forces_and_impulses/)：外力持續作用，因此本介面每步先清除再加入新的受力。
- [Prismatic 關節 API](https://rapier.rs/javascript3d/classes/PrismaticImpulseJoint.html) 與 [CCD 說明](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/)：懸吊馬達與高速碰撞設定。
