# 选品侦探 · Shopify 店铺侦察兵（中文版）

> Shopify Spy & Dropshipping - Koala Inspector 的中文复刻版。
> **完全离线**：签名库内置在扩展里，扫描时零第三方请求。Manifest V3，**无需构建步骤**。

---

## 一、安装（30 秒）

**Chrome 和 Edge 都支持**，步骤完全一样，手动加载没有任何限制。

### Chrome（已在 Chrome 153 实测通过）

1. 地址栏输入 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 这一层）
4. 打开任意 Shopify 店铺页面，**点一下浏览器工具栏上的扩展图标**
   （这一步是必需的：扩展只用 `activeTab` 权限，必须由你的点击授予当前页面访问权）
5. 右侧侧边栏自动打开并开始扫描

### Edge

同上，第 1 步换成 `edge://extensions`。

> 图标如果被折叠了，点工具栏的拼图按钮，把「选品侦探」固定到工具栏。

> **关于 Chrome 的 `--load-extension`**：Chrome 137 起移除了这个**命令行开关**，
> 所以用命令行自动装扩展的脚本会失效。**但手动「加载已解压的扩展程序」完全不受影响。**
> 本项目的自动化测试改用 CDP 的 `Extensions.loadUnpacked` 装载，见 `tools/chrome-load.mjs`。

---

## 二、功能

| 标签页 | 内容 |
|---|---|
| **概览** | Shopify 判定 + 判定依据、主题（名称/schema/厂商/是否二开）、Plus 推测、规模统计、营收量级估算（含公式） |
| **店铺变化** | 店铺动态：变动事件流（售罄/补货/上架/下架/改价/排名升降/应用增减）、最近上架、断货分析、上新节奏曲线、当前爆款榜 |
| **应用** | 已装机应用，按分类分组，每条附**命中证据**与置信度 |
| **像素** | 追踪像素，区分「广告像素 / 分析 / 营销自动化」 |
| **产品** | 产品库，支持搜索与 5 种排序（爆款/最新/价格↑↓/折扣） |
| **选品** | 店铺自认的爆款榜 + 五维加权的高潜力选品打分（可展开看得分构成） |
| **审计** | Shopify 判定投票明细、主题资产清单、原始信号（脚本/全局变量/meta/Cookie 名） |
| **,** | 产品库/应用/像素/合集/店铺变化 CSV + 完整报告 JSON；扫描设置；收藏与历史 |

### 三个「和它不一样」的地方

**1. 爆款榜是事实，不是估算。**
选品页的爆款排名取自店铺自己的 collection 页面 `sort_by=best-selling`，
这是 Shopify 官方接口返回、商家后台认可的销量排序。Koala 那类工具给的是流量估算，
本版把两者严格分开标注。

**2. 「店铺变化」把数据来源摊开说。**
见下节。

**3. 每条结论都能点开看证据。**
每个应用/像素命中都附上触发它的原文片段（如 `widget.trustpilot.com`），
并标注置信度（高/中/低）。没有「AI 说的」这种不可验证的结论。

**4. 营收估算是可反推的。**
```
月订单量 ≈ 产品数^0.42 × 6 × 规模系数 × 上新系数
月营收   ≈ 月订单量 × 客单价      客单价 ≈ 价格中位数 × 1.25
```
公式、每个输入的实际取值、置信度等级全部在界面上展开可见。它是**量级判断**，
不是财报——用来横向比较店铺，不要用来做财务测算。

---

## 三、「店铺变化」到底是什么

（原来叫「最近订单」，但那个名字会误导 —— 它给的不是订单。）

**先说结论：任何浏览器扩展都拿不到别人店铺的订单。** 实测确认：

| 候选数据源 | 实测结果 |
|---|---|
| `/orders.json` | HTTP 404（需鉴权） |
| 变体的 `inventory_quantity` | **0/238、0/419、0/2525 个变体带该字段** —— 三家店全部不暴露 |
| 变体的 `updated_at` | 每家店所有变体时间戳**完全相同**（= 最后一次全量同步）—— 零信息量 |
| `/checkouts.json`、`/recommendations/products.json` | HTTP 404 |

Koala Inspector 自己的文档也承认它做的是变更检测，不是订单：
*"re-checks that store for you and logs what moved ... new or dropped products, price changes"*。

所以本版把「店铺变化」实现为**四层成交线索**，每层都标注证据强度：

| 层 | 数据源 | 强度 | 需要历史？ |
|---|---|---|---|
| 变动事件流 | 前后两次快照差分（售罄/补货/上架/下架/改价） | 强 | ✅ |
| 爆款榜位次变化 | 两次扫描的 best-selling 排名对比 | 中 | ✅ |
| 最近上架 / 断货分析 | `published_at`、`availableVariants` | 强 | ❌ |
| 上新节奏曲线 | `published_at` 按月聚合 | 中 | ❌ |
| 应用增减 / 主题更换 | 快照差分 | 参考 | ✅ |

- **首次扫描就有内容**（上架/断货/节奏/爆款榜），第二次起出现变动事件
- 界面顶部有一块**必读说明**，写明这些是线索不是订单
- 售罄不等于卖出、排名上升不等于一定成交，都在界面上写清楚了
- 快照存在 `chrome.storage.local`，每店最多 12 份，可在界面上清空

---

## 四、权限说明

| 权限 | 用途 | 说明 |
|---|---|---|
| `activeTab` | 读取你主动点击图标时所在的那一个标签页 | **不用** `<all_urls>`，不读你没点的标签页 |
| `scripting` | 向该页面注入采集脚本 | 采集函数见 `lib/injected.js`，可自行审计 |
| `storage` | 保存设置、收藏、扫描历史 | 全部在 `chrome.storage.local`，不出本机 |
| `sidePanel` | 显示右侧面板 | — |
| `downloads` | , CSV/JSON | — |

**不会发生的事**：不记录浏览历史；不向任何服务器发送数据；Cookie 只读名字不读值
（值里可能有购物车令牌）；`rel=canonical/next/prev/alternate/shortlink/amphtml`
这类暴露「你在看哪一页」的链接一律不采集。

---

## 五、开发

零依赖，装好 Node 20+ 即可。

```bash
node --test test/run-tests.mjs    # 68 个单测：指纹库、匹配引擎、估算、导出、快照差分、误报回归
node tools/verify.mjs             # 打包门禁：manifest/引用/无远程代码/模块解析/图标/SW API 白名单/语法/BOM
node tools/dry-run.mjs https://store.example   # 真实站点干跑（不开浏览器跑通整条管线）
node tools/browser-test.mjs https://store.example --host-perm   # 真实浏览器端到端（Chrome + CDP）
node tools/probe-fetch.mjs https://store.example   # 页面内 fetch 诊断（排查接口为什么读不到）
node tools/recon-orders.mjs https://store.example  # 订单数据源侦察（有哪些公开接口可用）
node tools/make-icons.mjs         # 重新生成图标 PNG（纯 Node，无图形库）
```

改完代码**不需要重新构建**，直接在 `chrome://extensions` 点该扩展的刷新按钮即可。

### 为什么要有 browser-test

单测和干跑器都在 Node 里，测不出「浏览器到底认不认这个 manifest」和「MV3 的 API 边界」。
`tools/browser-test.mjs` 用 CDP 驱动 **Chrome**，把扩展真加载起来，再从侧边栏页面发真实消息触发扫描。
它已经抓到过两个 Node 层根本看不见的问题：

- **MV3 Service Worker 里没有 `URL.createObjectURL`** —— 导出功能在真浏览器里 100% 失败
- **`--load-extension` 已被 Chrome 137+ 移除** —— 装载改用 CDP 的 `Extensions.loadUnpacked`

`--host-perm` 会在临时副本的 manifest 里补上目标站点的 host 权限，因为 `activeTab`
必须由真人点击工具栏授予，自动化给不了。这个差异会在输出里明确标注。

### 加一条应用指纹

编辑 `lib/signatures.js`，往 `APP_SIGNATURES` 加一条即可：

```js
{ id: 'myapp', name: '某应用', vendor: '厂商', category: '评论与UGC', confidence: 'high',
  patterns: ['myapp\\.com/embed'], globals: ['MyApp'], url: 'https://myapp.com' },
```

`patterns` 是正则源码串，会依次匹配 6 个证据面（外链脚本、资源链接、内联脚本、
页面 HTML、meta、Cookie 名）；`globals` 命中优先级最高，因为它证明脚本真的执行过。

> ⚠️ 加指纹的铁律：**不要用两三个字母的前缀**（`aw-`、`ea-`、`om-`）。
> 实测这类前缀会在几乎每个店铺上乱命中，把噪声伪装成结论。
> 项目里已有 6 条此类误报的回归测试（见 `test/run-tests.mjs` 的「误报回归」段）。

---

## 六、目录结构

```
shopify-scout-cn/
  manifest.json            MV3 清单
  background.js            Service Worker：扫描编排、缓存、导出下载、消息路由
  lib/
    signatures.js          本地指纹库（100+ 应用 / 22 像素 / 70+ 主题）← 核心资产
    detect.js              匹配引擎：证据面组装、应用/像素匹配、主题解析
    timeline.js            店铺动态引擎：快照、差分、上新节奏（「店铺变化」）
    estimate.js            统计与营收估算模型（公式全外显）
    export.js              CSV/JSON 生成与格式化
    injected.js            MAIN world 注入的采集函数（必须自包含）
  sidepanel/               侧边栏 UI（原生 DOM，8 个视图）
  icons/                   图标 PNG
  test/run-tests.mjs       68 个单测
  tools/                   门禁、干跑、浏览器端到端、页面探针、图标生成
  docs/                    拆解报告与架构说明
```

---

## 七、已知边界

- **不做流量估算。** 月访问量需要第三方数据源，本地没有，不编。
- **不做后台自动重扫。** 「店铺变化」的变动事件靠你每次扫描累积快照；Koala 的后台
  持续重扫是它的服务优势，本版不常驻后台。
- **销量是量级估算。** 见上文公式，置信度明示。
- **指纹库静态。** 新应用要手动加规则，不会自动更新。
- **部分店铺读不到产品库。** 若店铺关闭了 `/products.json` 或有人机校验，
  产品库与选品不可用；**主题、应用、像素检测不受影响**（这三项不发网络请求）。
- **Headless 店铺拿不到主题。** Hydrogen/自建前端不渲染 Liquid 主题层，属正常现象，
  扩展会明确标注为「Headless 无头店面」而不是报错。

---

## 八、与 App Store 版本的差异

本版是本地复刻，未发布到 Chrome 应用商店，因此：

- 没有云端账号体系、没有跨设备同步、没有店铺数据库索引
- 没有 AliExpress 图片找同款（需要图像检索服务）
- 没有主题文件批量下载

用一句话概括取舍：**它把数据放在云上卖订阅，本版把数据放在你本机给你改。**
