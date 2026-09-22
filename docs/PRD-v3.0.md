# 免费大模型试用额度雷达 · 产品需求文档（PRD）

| 项目 | 内容 |
|---|---|
| 文档版本 | **v3.0**（信源定版：以 free-LLM 为主源） |
| 创建日期 | 2026-09-22 |
| 状态 | 待落地执行 |
| 交付形态 | Chrome MV3 浏览器插件 + GitHub Actions 云端流水线 |
| 目标读者 | 负责落地执行的模型/开发者（含低成本模型） |
| 主信源 | [DaBinBinah/free-LLM](https://github.com/DaBinBinah/free-LLM)（MIT） |
| 汇率口径 | 1 USD = 6.6954 CNY（frankfurter.app，2026-09-21，**内置参考值 / 非实时**；发卡行实际扣款通常高 1%~2%） |

---

## 0. 一句话定义

每天自动同步各厂商**发放的免费 Token 额度 / 试用 credit**，把「哪家送多少、要不要实名、怎么领、怎么调 API、**我还剩多少、哪天到期**」整理成结构化清单，推送到浏览器插件。

**核心对象是「额度发放」（quota/grant），不是「模型价格」。**

---

## 1. 版本演进：为什么会有 v3.0

| 版本 | 定位 | 结论 |
|---|---|---|
| v1.0 | 找「哪些模型的 API 标价是 0」 | ❌ **方向错误**。围绕 `model_id` / `pricing` 建模，抓 OpenRouter `/models`。用户要的是"白嫖"，不是"标价 0"。 |
| v2.0 | 改为「厂商赠送额度」，自建抓取 10+ 官方入口 | ⚠️ **方向对了，但重复造轮子**。自建采集层没必要。 |
| **v3.0** | **以 `DaBinBinah/free-LLM` 为主信源，只补它缺的两件事** | ✅ 本版 |

### 1.1 关键转折

用户在 v2.0 交付后提供了 [`DaBinBinah/free-LLM`](https://github.com/DaBinBinah/free-LLM)，实测后确认：**该项目已经把我原本打算自建的采集层做完了**，而且是中文原生、专做中国厂商、带结构化 JSON、MIT 许可。

自建采集层从 9.5 人天压到 **5～6 人天**。

---

## 2. 主信源评估：free-LLM 命中了什么、缺什么

### 2.1 基本信息（2026-09-22 实测）

| 项 | 值 |
|---|---|
| Stars / Forks | 57 / 2 |
| 创建 / 最后推送 | 2026-09-02 / 2026-09-19 |
| 许可证 | **MIT**（可商用、可改造、可分发） |
| 版本 | v1.1.4 |
| 数据文件 | `data/providers.json`（13,145 B）、`data/models.json`（19,893 B） |
| 数据版本 | 两份均 `version: 1.1.3`、`last_updated: 2026-09-07` |
| 覆盖 | **17 家厂商 / 26 个模型** |
| 文档 | `docs/openai-compatible.md`、`docs/coding-tools.md` |

### 2.2 命中的部分（可直接用）

**① 免费状态分类，与用户需求完全一致。** README 原文定义：

> 🟢 **长期免费**：官方明确长期/永久免费商用，或每日/每月固定重置免费调用额度（无过期作废限制）。
> 🟡 **有免费额度**：开通赠送固定额度包或按模型赠送免费调用量（通常有 30~90 天有效期）。
> 🟠 **新用户免费**：新注册或首次实名认证赠送一次性体验代金券/Token 额度包。
> 🔴 **已停止**：此前提供过免费 API，当前已下线或转为全付费。
> ⚪ **待确认**：官方政策处于过渡期或暂无法从官方渠道明确确认。

这五档正好覆盖"额度会过期、要领取、一次性"这些 v1.0 完全没建模的属性。

**② 数据契约已经够用。** `providers.json` 单条实测（硅基流动）：

```json
{
  "id": "siliconflow",
  "name": "硅基流动 (SiliconCloud)",
  "company": "硅基流动",
  "website": "https://cloud.siliconflow.cn",
  "console_url": "https://cloud.siliconflow.cn/account/ak",
  "api_doc_url": "https://docs.siliconflow.cn/",
  "base_url": "https://api.siliconflow.cn/v1",
  "openai_compatible": true,
  "free_tier_type": "permanent_free_and_trial",
  "free_tier_desc": "永久免费模型子集无限调用（受 RPM 限制）+ 新用户注册/实名赠送 14 元代金券（约 2000 万 Tokens）",
  "auth_requirements": {
    "phone_required": true,
    "real_name_required": true,
    "credit_card_required": false,
    "recharge_required": false
  },
  "last_verified": "2026-09-02",
  "note": "免费模型包括 DeepSeek-R1 蒸馏版 (7B/1.5B/8B)、Qwen2.5-7B、GLM-4-9B-Chat、InternLM2.5 等"
}
```

`auth_requirements` 四个布尔值（手机/实名/绑卡/充值）就是"领取门槛"，正是用户要的"使用办法"核心。

`models.json` 字段：`provider_id, provider_name, model_name, model_id, status, status_label, quota_desc, context_window, modalities, rpm, rpd, openai_compatible, base_url, key_url, doc_url, real_name, phone, recharge, last_verified, note`

**③ 统计口径可用。** 厂商级 `free_tier_type` 分布（17 家）：

| free_tier_type | 家数 |
|---|---|
| `new_user_trial`（新用户试用） | 4 |
| `permanent_free`（长期免费） | 4 |
| `limited_time_free`（限时免费） | 3 |
| `quota_with_expiry`（有额度会过期） | 3 |
| `free_tier_trial` | 1 |
| `permanent_free_and_trial` | 1 |
| `free_points`（积分制） | 1 |

认证门槛统计（17 家）：

| 门槛 | 家数 |
|---|---|
| 需要手机号 | **16 / 17** |
| 需要实名认证 | **7 / 17** |
| 需要绑卡 | **0 / 17** |
| 需要充值 | **0 / 17** |

> 这组数字本身就有产品价值：**中国厂商的免费额度基本都要手机号，全部不用绑卡**——这正是"白嫖"可行的原因。

### 2.3 两个硬缺口（**本项目要补的全部内容**）

**缺口一：没有自动更新，数据在腐坏。**

实测三个可能的 workflow 路径**全部 404**：

```
无  .github/workflows/update.yml
无  .github/workflows/update.yaml
无  .github/workflows/main.yml
```

它是**纯人工维护**（CHANGELOG 手写，靠 PR 更新）。数据新鲜度实测：

| `last_verified` | 厂商数 |
|---|---|
| 2026-09-02 | 14 |
| 2026-09-03 | 2 |
| 2026-09-07 | 1 |

**最旧的数据距今天（2026-09-22）已 20 天**；且 README 徽章写 `Last Verified 2026-09-19`，而 JSON 停在 `2026-09-07`——**文档与数据已漂移 12 天**。对"送 500 万 Tokens"这类变动快的福利，20 天足已失效。

**缺口二：没有余额跟踪。**

它告诉你"注册送 15 元额度包""开通赠送 100 万 Tokens（90 天）"，但**不告诉你用户自己还剩多少、哪天到期**。而这恰恰是白嫖场景最容易亏的地方——额度静默过期。

### 2.4 复用判断

| 项 | 决定 |
|---|---|
| `data/providers.json`、`data/models.json` | ✅ **作为主信源 L1 直接消费**（只读，不 fork） |
| `docs/openai-compatible.md`、`docs/coding-tools.md` | ✅ 作为使用办法的 `doc_url` 候选 |
| 仓库本身 | ❌ 不 fork、不提 PR（除非发现错误，届时时另议） |
| 许可证 | MIT，注明来源即可 |

---

## 3. 系统分层

```
┌─ L1 信源层（免费，公开）───────────────────────────┐
│  DaBinBinah/free-LLM 的 providers.json + models.json │
│  + 各厂商官方页探针（补它没跟上的）                  │
└──────────────────┬───────────────────────────────┘
                   │ GitHub Actions 每日
                   ▼
┌─ L2 刷新层（云端，无凭据）────────────────────────┐
│  归一化 → 契约校验 → 新鲜度评级 → 探针复核          │
│  输出 data/offers.json（公开，不含任何 Key）        │
└──────────────────┬───────────────────────────────┘
                   │ raw.githubusercontent.com
                   ▼
┌─ L3 插件层（本地，只读）───────────────────────────┐
│  展示 + 筛选 + 今日变更高亮                         │
│  ┌─ L4 余额层（本地，用用户自己的 Key）──────────┐ │
│  │  查询余额 API → 剩余额度 + 到期倒计时          │ │
│  │  ⚠️ Key 只存 chrome.storage.local，绝不上传    │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**关键架构决策：L2 云端 与 L4 余额 必须物理分离。**

理由：

1. 云端产物 `offers.json` 是**公开数据**（谁在送额度），可以进 Git、可以分发。
2. 余额数据需要**用户自己的 API Key**，属于隐私，**绝不能进仓库、绝不能上云**。
3. 两者混在一起的结果就是有人把 Key 提交进公开仓库。

---

## 4. 数据契约（**先冻结，再写代码**）

### 4.1 归一化后的单条记录

上游字段名要**映射**到本契约，不要直接透传（上游改字段名时只改映射层）。

```jsonc
{
  // ── 身份 ──
  "id": "siliconflow",                    // 主键，取上游 provider.id
  "name": "硅基流动 (SiliconCloud)",
  "company": "硅基流动",

  // ── 额度（核心）──
  "free_tier_type": "permanent_free_and_trial",   // 枚举见 §4.2
  "quota_value": "14 元代金券 + 免费子集无限",     // 人类可读，原文照抄
  "quota_tokens": null,                   // 可折算成 tokens 时填数字，否则 null
  "quota_cny": 14,                        // 可折算成人民币时填，否则 null
  "expiry_days": null,                    // 有效天数；recurring 填 "recurring"
  "expiry_policy": "unknown",             // fixed_days | recurring | once | no_expiry | unknown

  // ── 领取门槛 ──
  "auth": {
    "phone_required": true,
    "real_name_required": true,
    "credit_card_required": false,
    "recharge_required": false
  },

  // ── 使用办法（onboarding）──
  "onboarding": {
    "steps": [ /* §5 生成规则 */ ],
    "console_url": "https://cloud.siliconflow.cn/account/ak",
    "base_url": "https://api.siliconflow.cn/v1",
    "openai_compatible": true,
    "curl_example": "curl https://api.siliconflow.cn/v1/chat/completions -H \"Authorization: Bearer $KEY\" ...",
    "env_example": "export SILICONFLOW_API_KEY=sk-xxx",
    "doc_url": "https://docs.siliconflow.cn/",
    "generated_by": "rule",               // rule | llm | upstream
    "generated_at": "2026-09-22T00:00:00Z",
    "verified_doc_url": true              // doc_url 实测 200
  },

  // ── 余额跟踪能力（§6）──
  "balance_adapter": {
    "supported": true,
    "endpoint": "https://api.siliconflow.cn/v1/user/info",
    "method": "GET",
    "auth_style": "bearer",
    "parse": { "remaining": "data.totalBalance", "currency": "data.currency" }
  },

  // ── 可靠性 ──
  "sources": ["https://github.com/DaBinBinah/free-LLM/blob/main/data/providers.json"],
  "last_verified_upstream": "2026-09-02",   // 上游标的验证日期
  "last_checked_by_us": "2026-09-22",       // 我们实际探测的日期
  "freshness": "stale",                     // fresh | aging | stale（§4.3）
  "confidence": 0.7,
  "tier": "L1",

  // ── 风险 ──
  "risk": { "level": "low", "tags": [] }
}
```

### 4.2 枚举（不许自由发挥）

```jsonc
"free_tier_type": [
  "permanent_free",           // 长期/永久免费
  "permanent_free_and_trial", // 既有永久免费子集，也有新用户赠送
  "quota_with_expiry",        // 开通赠送额度包，有有效期
  "new_user_trial",           // 新用户一次性赠送
  "limited_time_free",        // 限时活动
  "free_points",              // 积分制
  "stopped",                  // 已停止
  "unknown"                   // 待确认
]

"freshness": ["fresh", "aging", "stale"]
  // fresh : last_verified 距今 ≤ 7 天
  // aging : 8~14 天
  // stale : > 14 天（实测当前 17 家里 16 家属此档）

"risk.level": ["low", "medium", "high"]
"tier": ["L1", "L2", "L3"]
```

### 4.3 顶层产物

```jsonc
{
  "schema_version": "1.0",
  "generated_at": "2026-09-22T04:00:00Z",
  "upstream": {
    "repo": "DaBinBinah/free-LLM",
    "version": "1.1.3",
    "last_updated": "2026-09-07",
    "fetched_ok": true
  },
  "stats": { "total": 17, "fresh": 0, "aging": 1, "stale": 16 },
  "offers": [ /* §4.1 数组 */ ],
  "changes": { "added": [], "removed": [], "modified": [] }
}
```

---

## 5. 使用办法（onboarding）生成规则

### 5.1 三档生成，优先级从高到低

| 档 | `generated_by` | 来源 | 可靠性 |
|---|---|---|---|
| 1 | `upstream` | 上游 `console_url` / `key_url` / `base_url` / `doc_url` 直接映射 | 最高 |
| 2 | `rule` | 有 `base_url` + `openai_compatible: true` 时，**模板化拼装** curl 与环境变量 | 高 |
| 3 | `llm` | 前两档凑不出完整步骤时，调 LLM 生成 | 需过硬校验 |

**大部分厂商能走第 2 档**：因为 free-LLM 数据里几乎都带 `base_url` 且 `openai_compatible: true`，curl 可以直接套模板，**不需要调 LLM**——这同时把成本压到接近 0。

### 5.2 模板示例（rule 档）

```bash
# 1. 注册并领取额度（需手机号=是，需实名=是，需绑卡=否）
open https://cloud.siliconflow.cn/account/ak

# 2. 创建 API Key，然后验证连通
export SILICONFLOW_API_KEY="sk-你的key"
curl -s https://api.siliconflow.cn/v1/chat/completions \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"hi"}]}'
```

### 5.3 反幻觉红线（**不可省略**）

| 红线 | 实现 |
|---|---|
| `doc_url` 必须实测可达 | GET 返回 200，否则该条 `onboarding.steps` 置空、`verified_doc_url=false` |
| 禁止编造额度数字 | `quota_value` 只允许来自上游原文**照抄**，不得改写 |
| 算不出的就留空 | `quota_tokens` / `quota_cny` 算不出填 `null`，**不猜** |
| LLM 生成必须挂溯源 | `generated_by: "llm"` 的记录必须带 `sources[]` |
| 生成失败降级 | LLM 输出非法 JSON → 重试 1 次 → 仍失败则降为 `rule`，步骤留空 |

> **宁可少给步骤，也不给错步骤。**

---

## 6. 余额跟踪层（**本项目唯一的核心增量**）

### 6.1 为什么它是刚需

上游只回答"送多少"，不回答"还剩多少、哪天到期"。$5 的试用额度静默过期是纯损失；百炼的额度**用不用都在计时**（官方明示：额度有效期内是否使用均不会暂停计时）。

### 6.2 已核实的余额接口

| 厂商 | 端点 | 方法 | 鉴权 | 实测（无 Key） |
|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/user/balance` | GET | Bearer | 401（接口存在） |
| 硅基流动 | `https://api.siliconflow.cn/v1/user/info` | GET | Bearer | 401（接口存在） |
| Moonshot/Kimi | `https://api.moonshot.cn/v1/users/me/balance` | GET | Bearer | 401（接口存在） |
| OpenRouter | `https://openrouter.ai/api/v1/credits` | GET | Bearer | 401（接口存在） |

**DeepSeek 返回结构（已从官方文档核实）**：

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",     // ← 赠送额度的剩余，正是"白嫖"那部分
      "topped_up_balance": "100.00"   // ← 自己充的部分
    }
  ]
}
```

`granted_balance` 与 `topped_up_balance` 分开返回——**可以直接算出"白嫖的那部分还剩多少"**，这是本功能的关键字段。

### 6.3 适配器设计

```jsonc
// adapters/balance.json —— 契约，实现见各 adapter
{
  "deepseek": {
    "endpoint": "https://api.deepseek.com/user/balance",
    "auth_style": "bearer",
    "parse": {
      "remaining": "balance_infos[0].granted_balance",
      "total": "balance_infos[0].total_balance",
      "currency": "balance_infos[0].currency",
      "available": "is_available"
    }
  }
}
```

**未列入表的厂商**：不提供余额查询的（多数国内厂商），降级为「手动记账」——插件里让用户手填剩余额度，或直接标 `balance_adapter.supported: false`。**不要为了凑数去爬控制台页面**（需登录态，脆弱且违规）。

### 6.4 到期提醒

```
剩余额度 < 20%  或  距 expiry 剩 ≤ 7 天  →  插件角标提醒
已过期（余额查询返回 0 或 available=false） →  标记 stopped，归入历史
```

### 6.5 凭据安全（**硬约束**）

| 约束 | 实现 |
|---|---|
| Key 只存本机 | `chrome.storage.local`，**不申请 `cookies`，不读登录态** |
| Key 不上云 | 余额查询**只在插件内发起**，云端流水线永不接触 Key |
| Key 不进仓库 | 提交前扫描 `sk-`、`Bearer ` 等模式 |
| 权限最小化 | `host_permissions` 只列实际要查的域名，不用 `<all_urls>` |

---

## 7. 每日刷新层设计

### 7.1 主流程

```
每天 04:00 UTC (12:00 CST)
  │
  ├─ 1. 拉上游 providers.json / models.json
  │     失败 → 保留上日快照，标 upstream.fetched_ok=false，不提交
  │
  ├─ 2. 归一化 → 契约校验（schema/offers.schema.json）
  │
  ├─ 3. 新鲜度评级：按 last_verified 算 fresh / aging / stale
  │
  ├─ 4. 探针复核（只打公开页面，无 Key）
  │     · 官方站/帮助页 GET 是否 200
  │     · 活动类条目是否仍在有效期内
  │     · 单条失败不删数据，只降 confidence + 标 probe_failed
  │
  ├─ 5. 变更检测（按 id 做内容哈希）
  │     产出 changes.added / removed / modified
  │
  ├─ 6. 写 data/offers.json + data/history/YYYY-MM-DD.json
  │
  └─ 7. git diff 有变化才提交
```

### 7.2 「上游没跟上」如何处理

上游 20 天没更新，但厂商政策可能已经变了。本层的策略：

| 情况 | 处理 |
|---|---|
| 上游 `last_updated` 变了 | 同步，`tier: "L1"` |
| 上游没变，探针显示官方页 200 且内容无异常 | 保留，`freshness` 按 `last_verified` 算，**不伪造新鲜度** |
| 上游没变，但探针发现活动已过期/页面 404 | 标 `stopped` 或降 `confidence`，`verified_by: "self"` |
| 上游缺失某厂商，但官方确实在送 | 允许**手工补录**进 `data/manual-overrides.json`，标 `tier: "L2"`、`sources: [官方URL]` |

> 注意：**「上游没更新」和「额度还有效」是两件事**。不能因为上游日期旧就判定失效，也不能因为上游说有效就判定有效——**以探针实测为准**。

### 7.3 探针边界

- ✅ 允许：GET 公开页面、检查状态码、检查活动日期字段
- ❌ 禁止：模拟登录、绕验证码、爬需登录态的控制台

---

## 8. 插件功能需求

| ID | 功能 | 优先级 |
|---|---|---|
| F1 | 展示额度清单（按 `free_tier_type` / 门槛分组） | P0 |
| F2 | 今日变更高亮（新增/失效/额度变化） | P0 |
| F3 | 筛选：只要免实名的 / 只要长期免费的 / 只要不过期的 | P0 |
| F4 | 每条的「怎么领 + curl」一键复制 | P0 |
| F5 | **余额查询 + 剩余额度 + 到期倒计时** | P0 |
| F6 | 新鲜度标识（fresh/aging/stale，防止误信旧数据） | P0 |
| F7 | 导出 JSON / CSV / MD | P1 |
| F8 | 到期提醒（角标 / 通知） | P1 |
| F9 | 手动记账（无余额接口的厂商） | P2 |
| F10 | L3 第三方中转——**仅收录链接，物理分表** | P2 |

### 8.1 UI 结构（3 个区块）

```
┌─ 免费额度雷达 ─────────────────────────────┐
│ [今日新增 2] [今日失效 1] [我的余额]         │
├────────────────────────────────────────────┤
│ ▸ 我的余额（本地，用自己的 Key）             │
│   硅基流动   ¥11.20 剩 ¥8.40  ↑ 无到期      │
│   DeepSeek   granted ¥0.00   ⚠️ 已用完      │
│   百炼       100万 tokens    ⏰ 剩 43 天    │
├────────────────────────────────────────────┤
│ ▸ 可领额度（17 家）      [筛选▾] [刷新]      │
│   🟢 智谱 GLM-4-Flash   永久免费  免实名     │
│   🟡 阿里云百炼         100万/90天 需实名   │
│   🟠 DeepSeek           500万/1月 免实名    │
│      ↳ 怎么领 / curl   [复制]               │
└────────────────────────────────────────────┘
```

**「我的余额」放最上面**——用户每天打开最想看的是"我还剩多少"，不是"还有哪些能领"。

---

## 9. 成本（人民币优先）

汇率 1 USD = 6.6954 CNY（frankfurter.app，2026-09-21，**内置参考值 / 非实时**）。

| 项 | 金额 | 说明 |
|---|---|---|
| 每日抓取上游 | **¥0** | 静态 JSON，不走 LLM |
| 每日探针 | **¥0** | 普通 HTTP GET |
| 每日 onboarding 生成 | **≈¥0** | 大部分走 `rule` 模板，不调 LLM |
| 需 LLM 兜底的条目（估 20%） | **≈¥0.002/天** | |
| **每日合计** | **≈¥0.002（$0.0003）** | |
| **每月合计** | **≈¥0.06（$0.009）** | |
| GitHub Actions / 分发 | **¥0** | 公开仓库免费 |
| 余额查询 | **¥0** | 余额接口不计费 |
| **一次性建造** | **≈¥9.4（$1.4）** | 含开发期调试 |

> v3.0 因复用上游数据，成本比 v2.0（¥0.0053/天）再降一个量级。

---

## 10. 里程碑与任务包

**总计约 5～6 人天**（v2.0 为 8.5 人天，复用上游省掉采集层）。

| ID | 里程碑 | 人天 | 验收方式 |
|---|---|---|---|
| **M0** | 仓库骨架 + 冻结数据契约 | 0.5 | `schema/offers.schema.json` 存在且能校验一份手写样例 |
| **M1** | 拉取并归一化 free-LLM 两个 JSON | 1 | `node scripts/sync.js` 输出 17 家厂商、26 个模型，字段映射正确 |
| **M2** | 新鲜度评级 + 探针复核 | 1 | 17 家被正确分为 fresh/aging/stale；探针失败不删数据 |
| **M3** | 变更检测 + 历史快照 | 0.5 | 连跑两次，第二次 `git diff` 为空 |
| **M4** | onboarding 生成（rule 优先） | 1 | 每条都有可复制的 curl；`doc_url` 不可达的步骤置空 |
| **M5** | **余额适配器（核心）** | 1 | 用真实 Key 跑通 DeepSeek + 硅基流动余额查询 |
| **M6** | 插件（改造 `ai-daily-intel`） | 1 | Chrome 加载后能拉到 `offers.json` 并显示 |
| **M7** | 端到端 + README | 0.5 | 用插件里复制的 curl 真调通一次 |

---

## 11. 验收标准（Definition of Done）

| # | 标准 | 判定 |
|---|---|---|
| 1 | 每天自动更新 | Actions 连续 3 天有提交或明确记录"无变化" |
| 2 | 上游数据完整消费 | 17 家厂商全部进 `offers.json`，无静默丢失 |
| 3 | 数据契约可校验 | 产物过 `offers.schema.json`，0 错误 |
| 4 | 新鲜度不造假 | `freshness` 由 `last_verified` 算出，实测 16 家应标 `stale` |
| 5 | **每条都有使用办法** | 100% 条目有 `console_url`；有 `base_url` 的必须有可复制 curl |
| 6 | 反幻觉红线生效 | 人为造一个 404 的 `doc_url`，该条步骤必须被置空 |
| 7 | **余额查询可用** | DeepSeek 返回的 `granted_balance` 能正确显示 |
| 8 | 凭据零泄漏 | 仓库全文扫描 `sk-` / `Bearer ` 无命中 |
| 9 | 插件可加载 | Chrome 开发者模式加载无报错，Service Worker 正常 |
| 10 | 成本达标 | 单日 LLM 消耗 ≤ ¥0.01 |

---

## 12. 风险与应对

| 风险 | 等级 | 应对 |
|---|---|---|
| **上游停更/删库** | 高 | 每日把上游原始 JSON 一起归档进 `data/upstream/`，保留可自愈能力 |
| 上游数据本身过时（当前 20 天） | 高 | 探针复核 + 手工补录层 + UI 显著标注新鲜度 |
| 厂商政策突变（额度取消/改条件） | 中 | 探针 + 人工复核；`stopped` 状态保留历史 |
| 余额接口变更 | 中 | 适配器独立文件，单条失败不影响其他厂商 |
| 用户 Key 泄漏 | **高** | Key 只存本地、不上云、不进仓库；提交前扫描 |
| 被当爬虫封禁 | 低 | 只打公开页面，限速（每域名 ≥2s），带正常 UA |
| 上游许可证变更 | 低 | 当前 MIT；把上游 archive 一并存证 |

---

## 13. 附录

### 13.1 上游 17 家厂商全表（2026-09-22 实测）

| id | 名称 | free_tier_type | 手机 | 实名 | last_verified |
|---|---|---|---|---|---|
| modelscope | 魔搭社区 (ModelScope) | permanent_free | ✓ | ✗ | 2026-09-02 |
| siliconflow | 硅基流动 (SiliconCloud) | permanent_free_and_trial | ✓ | ✓ | 2026-09-02 |
| bigmodel | 智谱 AI 开放平台 | permanent_free | ✓ | ✗ | 2026-09-02 |
| baidu-qianfan | 百度千帆 | permanent_free | ✓ | ✓ | 2026-09-02 |
| xfyun-spark | 讯飞星火 | permanent_free | ✓ | ✓ | 2026-09-02 |
| aliyun-bailian | 阿里云百炼 (DashScope) | quota_with_expiry | ✓ | ✓ | 2026-09-02 |
| deepseek | DeepSeek (深度求索) | new_user_trial | ✓ | ✗ | 2026-09-02 |
| volcengine-ark | 火山引擎 (豆包) | quota_with_expiry | ✓ | ✓ | 2026-09-02 |
| moonshot | Moonshot (Kimi) | new_user_trial | ✓ | ✗ | 2026-09-02 |
| minimax | MiniMax (海螺 AI) | new_user_trial | ✓ | ✗ | 2026-09-02 |
| infini-ai | 无问芯穹 | quota_with_expiry | ✓ | ✗ | 2026-09-02 |
| lingyiwanwu | 零一万物 (01.AI) | new_user_trial | ✓ | ✗ | 2026-09-02 |
| sensenova | 商汤日日新 | free_points | ✓ | ✗ | 2026-09-07 |
| amd-developer | AMD 开发者平台 | limited_time_free | ✓ | ✗ | 2026-09-02 |
| huaweicloud-codearts | 华为云 CodeArts | limited_time_free | ✓ | ✓ | 2026-09-02 |
| z_ai | Z.ai / ZCode | limited_time_free | ✗ | ✗ | 2026-09-03 |
| chinamobile-ecloud | 中国移动 移动云 MaaS | free_quota_trial | ✓ | ✓ | 2026-09-03 |

### 13.2 额度规则样例（阿里云百炼，已从官方帮助页实测核实）

| 规则项 | 实测内容 |
|---|---|
| 发放方式 | 首次开通百炼时**自动发放**各模型新人专属额度 |
| 额度粒度 | **每模型独立**，不同模型（含同模型不同快照）**不互通、不共享** |
| 有效期 | **90 天**，从「开通百炼 / 模型发布 / 模型申请通过」**较晚者**起算 |
| 到期处理 | 到期或耗尽后**自动失效，不补发、不延期、不重置**；用不用都在计时 |
| 未认证用户 | 额度用完**无法继续调用**，需完成认证 |
| 已认证用户 | 额度用完**自动转按量付费**（有意外扣费风险，可开"免费额度用完即停"） |
| 抵扣范围 | **仅抵扣模型推理**；存储与请求费用不可抵扣 |
| 重复领取 | **同一实名主体下重新注册账号，无法再次领取** |
| 子账号 | 子账号共享免费额度 |

> 这张表是**字段设计基准**：其他厂商的 `expiry_policy` / `quota_granularity` / `real_name_required` 都应能对到这九项。

### 13.3 给执行模型的一句话交接

> **主键是「额度发放」不是「模型」。**
> 先读 §2.3（上游缺什么，你只需要补这些），再读 §4（冻结契约）。
> **§6 余额跟踪和 §5.3 反幻觉红线是核心，不可省略。**
> 不要自建采集层——上游已经有了。

---

*文档结束 · v3.0 · 2026-09-22*
