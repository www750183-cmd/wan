# Shopify Spy / Koala Inspector 拆解 + 中文版交付

> 交付日期：2026-09-22
> 目标：拆解 `Shopify Spy & Dropshipping - Koala Inspector`，交付一个同等功能的中文版。

---

## 拿到什么

| 文件 | 说明 |
|---|---|
| `shopify-scout-cn/` | **可加载的 Chrome 扩展**（Manifest V3，源码即产物，无构建步骤） |
| `docs/01-拆解报告.md` | Koala Inspector 的功能面逐项拆解 + 中文版对标 + 复刻边界 |
| `docs/02-技术架构.md` | 架构、数据流、匹配引擎、误报防线、验证策略 |

**上手**：打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 →
选 `shopify-scout-cn/` → 打开任意 Shopify 店铺 → 点工具栏图标。

---

## 一句话结论

Koala Inspector 是个**采集器 + 云端数据**的组合：插件负责读页面信号，真正的价值
（应用指纹库、店铺流量销量数据、店铺索引）都在服务器上。

所以「同等功能」必须分两半回答：

- **能同等**：主题识别、应用识别、像素识别、产品库、爆款榜、CSV , —— 全部本地可算，
  本版**已实现**，并且在两处做得更实（见下）。
- **不能同等**：真实流量/销量、跨店铺索引、历史追踪 —— 这需要持续采集的**数据资产**，
  不是代码问题。本版用可解释的启发式估算替代，并把公式和置信度摊开给你看。

**本版的两处反超：**

1. **爆款榜是事实而非估算。** 取自店铺自己的 `/collections/all?sort_by=best-selling`
   —— Shopify 官方接口、商家后台认可的销量排序。Koala 给的是流量估算，本版给的是事实，
   且把二者严格分开标注。
2. **主题底座血缘是确定结论。** 用 `Shopify.theme.schema_name`（商家改主题名也改不掉的
   字段）判定是否二次开发。实测 `deathwishcoffee.com` 主题名被改成「Sept 10, 2026」，
   但 `schema_name` 明确是 `Dawn` —— 本版能给出「基于 Dawn 二次开发」的确定结论。

---

## 功能对照

| 功能 | Koala Inspector | 本中文版 |
|---|---|---|
| Shopify 店铺判定 | ✅ | ✅ 多信号投票 + **展示判定依据** |
| 主题名 / 是否官方 | ✅ | ✅ + 70 主题参考库映射厂商/免费付费 |
| 是否基于官方主题二开 | 模糊描述 | ✅ **`schema_name` 确定血缘** |
| 已装应用识别 | ✅ 云端库 | ✅ **本地 100+ 指纹**，附证据片段 + 置信度 |
| 追踪像素识别 | ✅ | ✅ 本地 22 条，按广告/分析/营销分类 |
| 产品库 | ✅ | ✅ 最多 40 页 × 250 条 |
| 爆款 / 选品 | ✅ 估算 | ✅ **店铺自认排序 + 五维选品打分（可展开）** |
| **店铺变化 / 店铺动态** | ✅ 后台持续重扫 | ✅ **本地快照差分**，四层线索 + 证据强度分级 |
| 销量 / 营收 | ✅ 第三方数据 | ⚠️ 启发式估算，**公式与输入全外显** |
| 流量估算 | ✅ | ❌ 无数据源，不编 |
| CSV / JSON 导出 | ✅ | ✅ 6 种导出，含 UTF-8 BOM |
| 收藏 / 历史 | ✅ 云端账号 | ✅ 本地存储 |
| 后台自动重扫 | ✅ 服务端 | ❌ 靠用户每次扫描累积快照 |
| AliExpress 找同款 | ✅ | ❌ 需图像检索服务 |
| 主题文件下载 | ✅ | ❌ |

---

## 验证结果

```
node --test test/run-tests.mjs                             →  68 passed / 0 failed
node tools/verify.mjs                                      →  门禁通过：0 错误 0 警告
node tools/browser-test.mjs https://kuura.co/ --host-perm  →  真实浏览器四阶段全部跑通
```

- **单元测试**：指纹库自检、匹配引擎、主题解析、估算、导出、**快照差分**、误报回归
- **静态门禁**：manifest 字段与引用完整性、无远程代码/无 `eval`（MV3 硬约束）、
  本地 ES 模块 import 全部可解析、**SW 侧 API 白名单**、图标 PNG 结构与实际内容、
  **全部 JS 语法检查**、**UTF-8 BOM 检测**、编码完整性
- **真实浏览器端到端**（**Chrome** + CDP，加载扩展后走真实消息协议，五阶段）

### 「店铺变化」差分验证（阶段四）

测试会**人为构造一份「三天前」的基线快照**，再重扫，然后核对事件是否精确命中：

| 站点 | 构造的期望事件 | 命中 | 说明 |
|---|---|---|---|
| deathwishcoffee.com | 售罄/补货/涨价/新品/下架/排名升/排名降/应用移除 | **8/8** | 含爆款榜头部换位 |
| kuura.co | 售罄/补货/涨价/新品/下架/应用移除 | **6/6** | 该店无排名数据，自动跳过排名差分 |

导出的「店铺变化 CSV」也逐行核对过：kuura.co 6 条事件 → CSV 6 行数据，列序正确
（首两列是观测时间与证据强度）。

### 真实浏览器端到端：kuura.co

| 项 | 结果 |
|---|---|
| 扩展加载 / SW 注册 | ✅ 正常 |
| 侧边栏 UI 渲染 | ✅ 8 个标签页，无控制台错误 |
| Shopify 判定 | ✅ 得分 14，7 条判定依据 |
| 主题 | `Baseline`（storeId 910，Troop Themes 付费主题），**schema_name 确认基于 Baseline 二次开发** |
| 应用 / 像素 | 3 个（Klaviyo / Hotjar / Shopify 自定义像素）、3 个 |
| 产品目录 | 111 产品 / 238 SKU / 25 合集，扫描 4.9 秒 |
| 店铺变化 | 60 天窗口内 111 款上架、72 款全部断货、上新速度加速、6/6 差分事件 |
| , | 6 种全部生成成功，Blob URL 正常 |
| 缓存 / 历史 / 收藏 / 快照 | ✅ 全部正常 |
| 真实 manifest（无 host 权限） | ✅ 正确报权限错误并给出中文指引，证明 activeTab 设计按预期工作 |

其他站点：deathwishcoffee.com（8 应用 / 5 像素 / **爆款榜 24 名 + 3 个分类榜** / 8/8 差分事件）、
allbirds.com（7 应用 / 3 像素）、chubbiesshorts.com（自定义结账域名 → Plus 迹象；products.json 未公开）。

---

## 工程上最有价值的部分

### 一、9 类指纹误报

干跑与浏览器端到端共抓到 **9 类会导致「每个店铺都误报」的指纹缺陷**，全部修复并固化为回归测试：

| 误报 | 根因 |
|---|---|
| 任何 Tailwind 店铺都被判「基于 Flex 开发」 | 主题血缘匹配扫了整页 HTML，`flex-row` 命中 |
| 每个 Dawn 店铺都「装了 Shopify Markets」 | `localization-form` 是 Dawn 默认类名 |
| GA4-only 店铺同时「装了 GTM」 | `dataLayer` 对 GTM 和 GA4 都存在 |
| 任意 `analytics.js` 都「是 Segment」 | 通用文件名被当成指纹 |
| 页面上的 CookieYes | `cky-` 命中了 CSS 变量 `--sticky-header-height` |
| 页面上的 Zendesk | `zE(` 命中了压缩 JS 里的随机函数调用 |
| 「已启用服务端转化」 | `capi-` 命中了 `data-facebook-capi-enabled="false"`（明说未启用） |
| `reroute.com` 被判「装了 Route」 | 子串匹配 |
| `aw-`/`ea-`/`om-`/`ae-`/`gem-` 乱命中 | 用了两字符前缀 |

后三类是「每条命中都必须回填证据片段」直接换来的 —— 只看「识别到 CookieYes」永远发现不了，
把触发原文摊在界面上就一眼看穿。共同教训：**误报比漏报危险得多**，漏报只少一条信息，
误报会让人拿着假结论去下单。

### 二、MV3 的 API 边界（只有真浏览器能测出来）

| 问题 | 后果 | 修法 |
|---|---|---|
| **SW 里没有 `URL.createObjectURL`** | 五种导出在生产环境 **100% 失败** | background 只生成内容，落盘交给侧边栏页面 |
| SW 不支持动态 `import()` | 测试脚本无法从 SW 加载模块 | 扩展用静态 import 本就合规；测试改走侧边栏页面 |
| 无 `tabs` 权限时 `tab.url` 为 undefined | 面板在正常店铺上显示「当前页不支持扫描」 | 区分「拿不到 url」与「页面不支持」 |
| **Chrome 137+ 移除 `--load-extension`** | 自动化加载扩展失效（**手动加载不受影响**） | 改用 CDP 的 `Extensions.loadUnpacked`，实测 Chrome 153 可用 |

### 三、一次自己造成的事故

用 PowerShell 备份还原 `background.js` 做反证测试时，中文经 ANSI 码页往返变成乱码，
字符串被截断 → SW 注册失败 → **扩展在浏览器里根本不加载**。当时门禁全绿，
因为乱码本身是合法 UTF-8。

事后补了两道门禁：**全部 JS 语法检查** + **UTF-8 BOM 检测**（无 BOM 文件被
`Set-Content -Encoding utf8` 覆写后必然带 BOM，正是该事故的指纹）。
教训：不要用 shell 做非 ASCII 文本文件的读写往返。

### 四、页面上下文的 CORS 边界

实测 `kuura.co`：**该店把所有 HTML 请求 301 到 `*.myshopify.com`，跨域 HTML 响应不带
`Access-Control-Allow-Origin`，浏览器直接拒绝** —— 同页面的 `/products.json` 却能成功，
因为 Shopify 给 JSON 端点加了 CORS 头。

可迁移的结论：**平台给哪些端点加了 CORS 头，等于划定了「页面内能读什么」的边界。**
从页面上下文抓数据要优先用 `.json` 端点；HTML 端点随时可能被判死，且失败方式是
`Failed to fetch` 而不是 404，不实测根本看不出原因。

本轮据此把爆款榜做成三层降级，并给用户输出精确到原因的诊断文案，而不是一句「读取失败」。

---

## 工程约束

- **零依赖、零构建**：源码即产物，改完刷新扩展即可生效。没有 lockfile 与构建配置的攻击面。
- **零后端、零外发**：没有任何指向第三方的请求。指纹库完整内置，断网可用。
- **权限最小化**：只用 `activeTab` + `scripting`，不用 `<all_urls>`，不读你没点的标签页。
- **Cookie 只读名字不读值**；`rel=canonical/next/prev/alternate` 一律不采集。

---

## 附：参考来源

- [Koala Inspector 使用指南](https://koala-apps.io/blog/use-the-koala-inspector/)
- [What is Koala Inspector?](https://koala-apps.io/learn-more/)
- [Koala Inspector Chrome 商店页](https://chromewebstore.google.com/detail/koala-inspector-shopify-s/hjbfbllnfhppnhjdhhbmjabikmkfekgf)
- [stackpeek-extension（MIT，同品类开源参考，仅用于架构对照，未复用其代码）](https://github.com/tonic20/stackpeek-extension)
