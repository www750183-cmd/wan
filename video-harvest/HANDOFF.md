# 交接文档 · 视频点赞评论助手

> 写给接手的人（或 AI）。看完这份就能继续，不需要翻聊天记录。
> 最后更新：2026-09-22

---

## 一、这是什么

一个 Chrome 扩展（MV3，**无构建步骤**，源码即产物），给不懂技术的人用的：

**粘贴一个视频链接 → 自动抓数据 → 点赞 → 用 AI 生成评论并发布 → 写一条日志**

固定流程，一条路，没有分支：

```
① 抓取   打开作品页，一次拿全：标题、链接、点赞数、评论数、收藏数、评论区全部评论
② 点赞   已是点赞态就跳过；状态读不出来也跳过（不猜）
③ 评论   文案+评论区喂模型 → 生成 → 五道校验 → 发布
④ 日志   一条记录，8 个字段
```

**日志 8 字段（用户指定顺序）**：视频标题 · 视频链接 · 点赞数 · 评论数 · 收藏数 · 评论区关注点 · 评论内容 · 执行结果

**执行结果**：`点赞✅评论✅` / `点赞✅评论⚠` / `点赞⏭评论✅` / `点赞❌评论❌`

---

## 二、文件在哪

```
E:\20260904\output\video-harvest\          ← 扩展本体（24 个文件 / 182 KB）
├─ manifest.json
├─ README.md                               ← 完整用户手册
├─ HANDOFF.md                              ← 本文件
├─ src\
│   ├─ config.js                           ← 分发配置（默认 API 地址、邀请链接）
│   ├─ sw.js                               Service Worker（PROTOCOL = 3）
│   ├─ injected.js                         ★ 注入页面的自包含函数（最核心）
│   └─ lib\
│       ├─ platforms.js                    ★ 平台适配表：URL 规则 + 选择器 + 状态判定
│       ├─ autoflow.js                     ★ 固定流程编排
│       ├─ probe.js                        自检判定（必需/可选/反向/列表页 四类语义）
│       ├─ insight.js                      提示词构建、输出解析、草稿五道校验
│       ├─ llm.js                          模型调用（OpenAI 兼容 / Anthropic）
│       ├─ tab.js                          标签页生命周期
│       ├─ store.js                        配置、日志、去重
│       ├─ export.js                       日志导出
│       ├─ collect.js                      批量收录（关键词搜索时用）
│       └─ util.js
├─ ui\console.html | console.js | style.css  单页控制台
├─ tests\  smoke.mjs(61) injected.mjs(51) boot.mjs(55)   ← 共 167 项，全绿
└─ tools\  verify.mjs  live-auto-test.mjs  make-icons.mjs
```

**参考资料（非常重要）**：
```
E:\20260904\tmp\aitoearn\extracted\js\background.js    ← AiToEarn 3.3.9 解包源码，单行 1.4MB 混淆
                                                          抖音/xhs 的全套 action 实现都在里面
E:\20260904\tmp\aitoearn\pretty\background.js         ← 美化版（但仍是两行超长行，搜索不便）
E:\20260904\tmp\*.cjs                                  ← 从上面文件里切片/抽取脚本的临时工具
E:\20260904\tmp\u21\                                   ← 带登录态的采样环境（puppeteer-core + CDP 9333）
```

**抖音全套 action 已抽出来存在** `E:\20260904\tmp\douyin-all-v2.txt`（getInfo / getComments / loadMoreComments / like / favorite / follow / replyComment）和 `douyin-comment.txt`（一级评论发布）。**动手前先读它。** 别再相信"没有参考实现"这种说法。

---

## 三、当前状态

| 平台 | 抓数据 | 点赞 | 评论 | 状态 |
|---|---|---|---|---|
| **小红书** | ✅ | ✅ | ✅ | **跑通了**。用户实测试跑结果 `点赞✅评论✅`，点赞数 114 / 收藏数 202 / 评论区关注点 / 评论内容全部有值 |
| **抖音** | ✅ | ✅ | ✅ | **评论区已修好**（2026-09-22，CDP 连真实详情页实测，含「加载慢 + 占位符」两个坑的修复）。见下方第四节 |

测试：`node tests/smoke.mjs && node tests/injected.mjs && node tests/boot.mjs` → **167 项全绿**（61 + 51 + 55）；`node tools/verify.mjs` 静态自检通过。

---

## 四、抖音的当前状态（已修好，2026-09-22）

**这一节替换了原来的「阻塞点」。** 修好靠的是两件事：发现 AiToEarn 其实有完整的抖音抓评论实现，以及用 CDP 连真实详情页实测。

### 4.1 ⭐ 最重要的更正：AiToEarn **有**抖音抓评论的实现

原来说「AiToEarn 只发评论不抓评论，没有参考实现」——**这是错的**，代码一直在 `tmp\aitoearn\extracted\js\background.js` 里（单行 1.4MB 混淆，要靠字符串切片读）：

```js
// douyin work.getComments（验证过的完整实现）
const items = document.querySelectorAll('[data-e2e="comment-list"] > div > [data-e2e="comment-item"]');
const contentElement = element.querySelector('.comment-item-info-wrap + div span');
const clonedContent = contentElement?.cloneNode(true);
clonedContent?.querySelectorAll?.('img').forEach((img) => img.replaceWith(img.alt || ''));
// content = clonedContent.textContent，author = element.querySelector('.comment-item-info-wrap div')
// likeCount = element.querySelector('.comment-item-stats-container div p span')

// douyin work.loadMoreComments —— ★ 滚动的是 comment-list 的「父级」
const commentList = document.querySelector('[data-e2e="comment-list"]');
const scrollTarget = commentList?.parentElement || document.scrollingElement;
scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
```

全套 action 表（getInfo / getComments / loadMoreComments / like / favorite / follow / replyComment / 一级评论）都抽出来了，临时工具在 `E:\20260904\tmp\` 下：`extract-douyin-v2.cjs`、`extract-douyin-all.cjs`、`find-douyin-comment.cjs`。

### 4.2 真实详情页实测结果

用 `tmp\u21` 那套带登录态的采样环境（puppeteer-core + CDP 9333）跑的：

| 项 | 实测值 | 选择器 |
|---|---|---|
| 标题 | 粉丝定制：舒心即是家#书法… | `[data-e2e="detail-video-info"] h1` |
| 点赞数 | 694 | `[data-e2e="video-player-digg"]`（按钮自身 innerText） |
| 评论数 | 6 | `[data-e2e="feed-comment-icon"]` |
| 收藏数 | 23 | `[data-e2e="video-player-collect"]` |
| 评论条目 | 5-6 条 | `[data-e2e="comment-list"] > div > [data-e2e="comment-item"]` |
| 正文 | 含 `[比心][比心]` 完整 | `.comment-item-info-wrap + div span`（克隆 + img→alt） |
| 作者 | ℳ๓陈ꩵི⁵²⁰ | `.comment-item-info-wrap div` |
| 评论点赞 | 1 | `.comment-item-stats-container div p span` |

**端到端复现（fresh tab，完整模拟扩展路径 `withPage → injectHarvest`）**：67.3 秒跑完，标题/三个计数/5 条真实评论全有值，`discovered` 全 false（全部走的配置选择器，没走兜底）。

**踩到的四个坑（已修）**：
1. **`detail-video-desc` 在详情页不存在**，标题在 `detail-video-info` 里的 `h1`。原来的 title/desc 选择器首选就是它，所以一直取不到。
2. **probe 的可见性判定过严**：抖音互动按钮在 CDP 渲染下 `getBoundingClientRect()` 返回 0×0（父级容器折叠），但 `display/visibility/opacity` 全正常、文本也在。`probe.js` 的 `visible()` 已改为「有文本内容时放宽尺寸要求」。
3. **★ 评论区加载极慢，且占位符会被当成真评论**。这是「评论区读取不到」的真正原因：
   - 冷启动时页面要 **60 秒以上**才有正文和评论（无头环境实测；热访问快得多）
   - 加载完成前，DOM 里是「加载中」「服务异常，刷新拉取数据」占位，**它们也带 `data-e2e="comment-item"`**，会被当成评论收进来
   - 修复：① `injectHarvest` 新增 `commentReady()` —— 等「正文非空且不是占位」的条目出现，独立的 `commentReadyTimeoutMs` 预算（默认 60s）；② `grab()` 和 `discoverComments()` 都用 `isPlaceholder()` 过滤掉加载占位；③ 页面就绪判定退一步用「有正文/有 10 个以上 e2e 元素」（`pageAlive()`），不再只死等 readyFlag
4. **★ `selectorCfg` 漏带平台级字段，导致评论必失败**。用户实测报「找不到评论输入框（配置选择器、点击展开、自动查找都试过了）」，根因是 `autoflow.js` 的 `selectorCfg()` 只返回 selectors/likeState/collectState，**没带 `commentTrigger`**——所以「点击展开」那一步根本没执行（`cfg.commentTrigger` 是 undefined，整个 if 被跳过）。修：`selectorCfg()` 补上 `commentTrigger` 和 `openCommentsBy`；`injectInteract` 里 trigger 后改为分段等待（编辑器渲染要 1~2 秒）。

### 4.3 平板布局方案：实测结论是「不需要做」

用户提的「F12 模拟平板/手机，布局变大变固定」——三种布局全测了：

| 布局 | innerWidth | 结果 |
|---|---|---|
| 桌面 1440×950 | 1440 | DOM 正常，评论 6 条 |
| iPad 834×1112 | **1669** | **与桌面完全相同的 DOM**（抖音按 UA 判断而非宽度，iPad UA 仍返回桌面站，且会自动放大视口） |
| iPhone 390×844 | 390 | 重定向到 `m.douyin.com` —— 完全不同的站点，`data-e2e` 一个都没有，现有选择器全废 |

**结论**：iPad 模拟零收益（DOM 一模一样），手机模拟会跳 m 站反而需要一整套新选择器。**之前评论区红是选择器写错了，不是布局问题**——桌面布局下本来就抓得到。`tabMode: 'current'` 和「自检自动找已打开标签页」那套配套代码保留（别删，在别的场景仍有用），但不是抖音的必需路径。

### 4.4 评论提交链路：逐环实测到「只差按发送」

`injectInteract` 的提交链路在真实详情页上一环一环测过了（每环都验证，**没有真发评论**）：

| 环节 | 结果 |
|---|---|
| 登录判定 / 就绪等待 | ✅ loggedOut=false，waitReady 通过 |
| 评论区域触发点击 | ✅ `trigger` 步骤成功（修好 `selectorCfg` 漏带 `commentTrigger` 的 bug 之后） |
| 编辑器渲染 | ✅ `.richtext-container [contenteditable]` 757×22 可见 |
| **粘贴写入 Draft.js** | ✅ `ClipboardEvent('paste')` **直接生效**，不需要 execCommand 兜底 |
| 发送按钮定位 | ✅ `.commentInput-right-ct > div > span:last-child` 命中（纯图标 svg，无文字，故 `discoverSubmit` 找不到 → 走回车提交，符合设计） |
| 清空编辑器 | ✅ 测试后已清空，页面无残留 |

**用户实际报过的问题与复现**（2026-09-22 晚）：
> 用户跑了 `https://www.douyin.com/video/7687629652382289152`（270亿参数那条），结果 `点赞✅评论❌`，报「找不到评论输入框」。

用同一个视频、fresh tab、完整扩展路径复现并修复后：
- 抓取：标题 / 156 / 6 / 5 条真实评论全有值
- 评论 dryRun：`ok: true`，trigger 步骤成功，编辑器渲染、写入校验都过
- 点赞 dryRun：`ok: true`，状态读取成功
- 52 秒跑完

**唯一没测的一环**：点发送后比对评论列表第一条（会真发评论出去）。时序和选择器全照搬 AiToEarn，dryRun 挡着，用户确认后可以直接试跑。

---

## 五、用户提过的平板布局方案（已验证，结论见 4.3）

用户原话：

> 「通过谷歌的 F12 模拟收集或者平板界面会变大，会返回到手机端的操作，就会变成固定的位置」

**这个思路本身是合理的**（移动布局通常 DOM 更简单），但实测下来抖音不按这个套路：iPad UA 仍返回桌面 DOM，手机 UA 跳到完全不同的 m 站。详见 4.3。

当时实现的配套改动仍然保留，因为思路本身可复用到别的平台：

1. **`tabMode: 'current'`（我当前的标签页）** —— 设备模拟是**按标签页**生效的。扩展另开新标签一定是桌面布局，模拟白开。现在可以选在用户当前标签页里跑（`openPage` 返回 `reuse: true`，`closePage` 跳过，不关用户的标签页）。
2. **自检自动找已打开的标签页** —— `PROBE` 不带 tabId 时扫描所有标签页、挑最近访问的那个该平台页面直接注入。

---

## 六、关键技术决策（别改坏）

| 决策 | 原因 |
|---|---|
| **不申请 `cookies` / `debugger` 权限** | 所有操作在平台页面自身上下文完成。页面自带登录态，所以不需要读 Cookie；用 DOM 操作，所以不用接管调试协议。只有 5 项权限，`host_permissions` 只声明三个平台域 |
| **默认试跑（dryRun = true）** | 首次使用的心理门槛。**试跑也显示 ✅**——试跑验证的是"这条路走不走得通"，走通了就是 ✅，不是"跳过" |
| **选择器是数据不是代码** | 全在 `platforms.js`，可在控制台覆盖，存在 `chrome.storage.local`，能用拾取器可视化修改 |
| **多层兜底** | 配置选择器 → 自动发现（Draft.js/通用 contenteditable）→ 按钮文字匹配 → 结构兜底 → 回车提交。**每一层都不"失败"，全部走完才报错** |
| **自检区分四类语义** | required（红点，真需要修）/ optional（灰点，只影响日志几列）/ reverse（loginFlag 反向）/ listOnly（collectLinks 只在列表页用）。把所有未命中都报成故障会让用户以为插件坏了 |
| **故障必须可见** | `load()` 分段 try/catch + `window.onerror` + `unhandledrejection`，**不允许停在「加载中…」**。还有 PROTOCOL 握手，版本不匹配时明确提示重新加载扩展 |

---

## 七、踩过的坑（别重犯）

1. **跨项目复制代码没核对导出名** → 整个 Service Worker 加载失败，插件表现为"装了但完全不工作"。`node --check` 查不出来（语法合法）。已加**静态导入一致性检查**（boot.mjs）。
2. **渲染函数写死目标容器** → 记录页永远空白。
3. **评论填充被站点静默丢弃时仍判定成功** → 成功判定只看"输入框是否为空"，而它本来就是空的。已改为先校验文本真的写进 DOM。
4. **登录弹窗留在 DOM 里但隐藏** → 只判"存在"会误报未登录。所有登录判定必须带**可见性判断**。
5. **深合并无法表达"删除"** → 选择器"复位"按钮删不掉。传了就整体替换，没传就保持原样。
6. **把内部参数全做成表单** → 用户要的是"给一句话就自动跑"。现在首屏只有一个输入框 + 开始按钮，其余全在右上角折叠面板。
7. **⭐ 交接信息会骗人。** 原交接写「AiToEarn 只发评论不抓评论，没有参考实现」，接手的人信了就去自己猜选择器。**实际上完整实现在 `tmp\aitoearn\` 里躺得好好的**。动手前先把参考源码搜一遍（即使它是单行 1.4MB 混淆，也能用字符串切片读出来）。
8. **⭐ 「猜 DOM」永远不如「测 DOM」。** 用户给的四轮 DevTools 截图 + 手动截图定位，都不如直接 CDP 连上去跑一次 `injectHarvest` 看输出。`tmp\u21` 那套采样环境（puppeteer-core + 带登录态 profile + 9333 端口）是这次修好的关键，**别让它失效**。
9. **可见性判定不能只看尺寸。** 抖音互动按钮在无头渲染下 rect 是 0×0（父级折叠），但样式和文本都正常。`visible()` 改成「有文本就放宽尺寸」。
10. **⭐ 「等元素出现」不等于「等它加载完」。** 抖音评论列表刚出现时是「加载中」「服务异常」占位，**占位元素也带 `data-e2e="comment-item"`**。用户报「评论区读取不到」，真相是：抓到了占位而不是评论（或者页面还没渲染就抓了）。修复=等「有真内容的条目」+ 过滤占位文本 + 页面就绪判定放宽到「页面活了」。**所有「抓不到」的问题，先打时间线快照，看 DOM 在什么时间点变成什么样。**
11. **⭐ 配置向下传递要传全。** `selectorCfg()` 只传了 selectors/likeState/collectState，漏了平台级 `commentTrigger`——结果「点击展开」那一步**整个 if 被跳过**，报错信息却写着「配置选择器、点击展开、自动查找都试过了」。**报错文案会撒谎：它列的是「代码里写了哪些路径」，不是「实际跑了哪些路径」。** 排查这类问题要看 steps 里有没有 `trigger` 这一步，而不是只看错误文案。
12. **⭐ 「找不到输入框」先确认点击有没有生效。** 抖音的编辑器不在 DOM 里，必须点 `.comment-input-inner-container` 才渲染。诊断方法：在页面上手动 `el.click()` 看编辑器是否出现——如果出现，问题 100% 在扩展没点到（配置没传到 / 等待不够），不在选择器。
13. **⭐ 等待要分段。** 「点完立刻找」在真实网络上经常找不到：编辑器渲染是异步的。改成「点 → 分段等几次 → 再兜底等一次」，比一次性 `sleep(600)` 可靠得多。

---

## 八、抖音评论的完整时序（从 AiToEarn 源码读出来的，已实现）

```js
// 1. 点评论区域          ← ★ 关键，之前一直漏
document.querySelector('.comment-input-inner-container').click();
await wait(500);         // 等编辑器渲染出来

// 2. 找编辑器并粘贴输入（不是 execCommand，Draft.js 对 execCommand 支持差）
const el = document.querySelector('.richtext-container [contenteditable="true"]');
el.focus();
const dt = new DataTransfer();
dt.setData('text/plain', text);
el.dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData: dt }));
await wait(300);

// 3. 点发送
document.querySelector('.commentInput-right-ct > div > span:last-child').click();

// 4. 轮询 10×500ms 验证
if (document.querySelector('.uc-ui-input_content')) return { needHumanAssist: true };   // 短信验证
const first = document.querySelectorAll('[data-e2e="comment-list"] .comment-item-info-wrap + div')[0];
if (first && first.innerText === text) return { COMMENT_SUCCESS };
return { COMMENT_SUBMITTED_UNVERIFIED };
```

对应到代码：`injected.js` 里 `injectInteract` 的 comment 分支，搜 `commentTrigger`。

---

## 九、下一步具体动作

**优先级 1：端到端真跑（抖音）**
- 评论区**抓取**已端到端实测通过（fresh tab，67 秒，5 条真实评论全有值）
- 评论区**提交**（点输入区 → 粘贴 → 点发送 → 比对第一条）逐环验证过，只剩「点发送后比对」——会真发评论，需要用户确认
- 建议路径：`chrome://extensions` 重新加载扩展 → 粘贴抖音视频链接 → **勾上「只预览（强制演练）」**跑一遍 → 看 `点赞✅评论✅` 是否出现 → 满意了关掉演练真发一条
- **第一次打开抖音页会很慢**（冷启动 60 秒级），扩展现在会等，别以为它卡死了

**优先级 2：小红书真跑**
- 小红书试跑已通（用户实测 `点赞✅评论✅`）
- 下一步：关掉试跑真发一条，确认真的发出去了

**优先级 3：如果以后抖音选择器又失效**
- 先别猜。用 `tmp\u21\` 那套 CDP 环境（`start-chrome.cjs` 拉起 9333，连 `repro-fresh2.mjs` 的写法）在真实页面上跑一次 `injectHarvest`，看哪一项空了再修
- 或者直接在控制台里用「自检当前页」+ 拾取器校准（不需要写代码）

**注意：短时间频繁重载抖音详情页会触发验证码中间页**（实测遇到过一次，标题变成"验证码中间页"）。采样时复用已打开的标签页，不要反复 goto。

---

## 十、怎么验证改动

```bash
cd E:\20260904\output\video-harvest
node tests/smoke.mjs      # 61 项：URL解析、结果标记、日志导出、草稿校验、抖音选择器
node tests/injected.mjs   # 48 项：注入逻辑全分支（DOM 桩）+ 真实抖音评论条目形状
node tests/boot.mjs       # 55 项：导入一致性、SW路由、渲染、故障可见性、零配置、版本漂移
node tools/verify.mjs     # 静态自检：manifest、资源引用、无 eval、无远程脚本

# 真实模型跑一遍「梗概→生成评论」（Key 走环境变量，不落盘）
$env:AID_API_KEY="sk-..."; node tools/live-auto-test.mjs

# 真实页面上跑抓取（需要 tmp\u21 那套 CDP 环境）
cd E:\20260904\tmp\u21
node start-chrome.cjs          # 拉起带登录态的 Chrome（9333 端口）
node e2e-harvest2.mjs          # 复用已打开的抖音页跑 injectHarvest
node e2e-probe.mjs             # 跑自检，看哪些项红
node e2e-interact.mjs          # dryRun 跑 like / comment（不真操作）
node check-paste.mjs           # 只验证粘贴写入，不发送（不真发评论）
```

**改完必须跑全绿再交给用户。** 用户已经重新加载扩展十几次了。

用户端验证：`chrome://extensions` → 点「重新加载」→ 刷新控制台页。**改了代码不重新加载，看到的还是旧版。**

---

## 十一、沟通上的注意事项

- 用户是**非技术用户**，界面不要出现要他自己理解的参数。首屏只留「输入框 + 开始」。
- 每次改动后给**可操作的下一步**，不要给一堆技术解释。
- **改完自己先跑测试**，别让用户当第一道测试。
- 不确定的地方直说，不要猜着装懂——用户已经被"一会一变"折腾得很累了。

---

## 十二、2026-09-23 复核（DeepSeek Harness）：点赞状态选择器修复 + 评论真发已跑通

> 本轮是**在真实 Chrome 里加载扩展本体**跑的（CDP `Extensions.loadUnpacked`，Chrome 153），不是只看单测。

### 12.1 修掉一个真 bug：抖音「已赞」状态属性写错了

| | 值 |
|---|---|
| 抖音已赞的**真实**属性 | `data-e2e-state="video-player-is-digged"` |
| 插件原来的写法 | `data-e2e-state="video-player-digged"`（少 `is-`，永远匹配不到） |

- **现象**：对**已经点过赞**的视频跑流程 → 点赞那步报「无法判定当前状态（状态选择器失效）」，日志 `点赞❌`。
- **为什么之前没发现**：原来只把「已赞 = digged」写成了实测，实际是从未赞值 `no-digged` 推的；未赞视频上 off 选择器能命中，所以从未暴露。
- **为什么 167 项测试没拦住**：`smoke.mjs` 的断言引用的是代码里同一个错值（自证）。**以后写选择器断言，要注明这个值的来源（哪次真机实测）。**
- **已修**：`src/lib/platforms.js` 四处（`likeState.onSelector`、`likeButton[0]`、`collectSign`、`likeCount` 兜底）+ `tests/smoke.mjs` 两处断言。
- **修复后**：167 项全绿；真机 E2E 日志由 `点赞❌` → `点赞⏭`（正确识别已赞并跳过）。
- 安全性：`stateOf()` 读不出来时是**直接跳过、不点击**，所以这个 bug 只会漏点赞，不会把已赞点成取消赞。这条设计别改。

### 12.2 抖音评论区读取：✅ 已复核

真机（登录态 profile + 真实详情页）实测：扩展自检 `commentItem / commentText / commentAuthor / commentLike / commentScroll` 全部命中，流程日志抓到 5–6 条评论，与独立读 DOM 的条数一致；标题与 157（赞）/ 7（评）/ 110（藏）三项计数全有值。

### 12.3 评论**真实发布**：已跑通（原先"唯一没测的一环"）

用插件自己的评论链路（`injectInteract`，`action=comment`，`dryRun=false`，文案取插件默认 `commentTemplate`）：

- 返回 `ok: true, verified: true, needHumanAssist: false`，steps：`waitReady → trigger → fill(paste) → submit → verify(输入框已清空)`。
- 独立复核：评论区条数 5 → 8，发布内容位于**第 1 条**；截图 `tmp/u21/comment-posted.png`。
- 没有触发短信验证（`.uc-ui-input_content` 未出现）。
- 注意：发送按钮是纯图标 SVG，`discoverSubmit` 命中不了是**预期行为**，代码会回退「回车提交」，实测回车可用。

### 12.4 仍未验证的

- **AI 生成评论 + 日志字段「评论区关注点」**：需要用户自己的 API Key，本轮没有可用 Key（也没有去读用户浏览器里已存的 Key），这条链路未跑。
- **未赞视频分支**的 off 选择器 `video-player-no-digged`：本轮第二次采样被抖音返回空页，未重新复核；依据是作者记录 + 与 `video-player-no-collect` 的命名对称。
- 长任务（100 条以上）稳定性、小红书真发评论未复测。

### 12.5 复核用脚本（可复用，在 `E:\20260904\tmp\u21\`）

```bash
node verify-vh-e2e.mjs [扩展目录]   # 真机加载扩展 → PROBE + 跑固定流程 → 打印 8 字段日志（默认跑 output/video-harvest）
node diag-like-attrs.mjs            # 打印点赞按钮真实的 data-e2e-state
node verify-like-state-fix.mjs      # 只换 likeState 的前后对照实验（dryRun，不真点）
node post-real-comment.mjs          # 真发一条评论（会真的发出去，谨慎）
```

