#!/usr/bin/env node
/**
 * 免费大模型额度雷达 · 最简同步脚本（零依赖）
 *
 * 做什么：
 *   1. 拉上游 DaBinBinah/free-LLM 的两个 JSON（MIT）
 *   2. 归档原始上游数据到 data/upstream/YYYY-MM-DD/
 *   3. 归一化成 data/offers.json
 *   4. 生成人类可读的「免费额度清单.md」
 *
 * 不做什么（有意为之）：
 *   - 不爬各厂商官网（上游已做完，不自建采集层）
 *   - 不查余额（需要用户自己的 API Key，属插件层的事）
 *   - 不调任何 LLM（成本 = 0）
 *
 * 用法： node sync.mjs
 *
 * 上游来源：https://github.com/DaBinBinah/free-LLM  (MIT)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import net from "node:net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA = join(__dirname, "data");

const UPSTREAM = {
  repo: "DaBinBinah/free-LLM",
  raw: "https://raw.githubusercontent.com/DaBinBinah/free-LLM/main",
  files: ["data/providers.json", "data/models.json"],
};

// ── 免费状态的中文标签 ──────────────────────────────────────────
const TYPE_LABEL = {
  permanent_free: "🟢 长期免费",
  permanent_free_and_trial: "🟢🟡 长期免费+新用户额度",
  quota_with_expiry: "🟡 有免费额度（会过期）",
  new_user_trial: "🟠 新用户一次性",
  limited_time_free: "🔥 限时免费",
  free_points: "🎫 积分制",
  free_tier: "🟢 有免费档",
  stopped: "🔴 已停止",
  unknown: "⚪ 待确认",
};

// ════════════════════════════════════════════════════════════════
//  网络引导：Node 的 fetch 默认不读系统代理，需要手动处理
// ════════════════════════════════════════════════════════════════

/** 从 Windows 注册表读系统代理；非 Windows 返回 null */
function readSystemProxy() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return null;
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    if (!m) return null;
    let s = m[1].trim();
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    return s;
  } catch {
    return null;
  }
}

/** 探测代理端口是否真的在监听（配置了但没开的情况很常见） */
function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

/**
 * 若检测到可用的系统代理，带着代理环境变量重新执行自己。
 * 之所以要重新执行：NODE_USE_ENV_PROXY 必须在进程启动时读取。
 */
async function bootstrapProxy() {
  if (process.env.FREETOKEN_BOOTSTRAPPED === "1") return;
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return;

  const proxy = readSystemProxy();
  if (!proxy) return;

  let hostname, port;
  try {
    ({ hostname, port } = new URL(proxy));
  } catch {
    return;
  }

  if (!(await probeTcp(hostname, Number(port)))) {
    console.log(`ℹ️  检测到系统代理 ${proxy}，但端口未监听，改用直连`);
    return;
  }

  console.log(`ℹ️  检测到系统代理 ${proxy}，改走代理（Node fetch 默认不读系统代理）`);
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      NODE_USE_ENV_PROXY: "1",
      FREETOKEN_BOOTSTRAPPED: "1",
    },
  });
  process.exit(r.status ?? 0);
}

// ── 新鲜度：>14 天算陈旧 ────────────────────────────────────────
function freshness(lastVerified) {
  if (!lastVerified) return "unknown";
  const days = daysAgo(lastVerified);
  if (days <= 7) return "fresh";
  if (days <= 14) return "aging";
  return "stale";
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// ── 拉取 ────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "freetoken-radar/0.1.0 (+local script)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
  await bootstrapProxy();

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n免费额度雷达 · 同步 ${today}\n${"=".repeat(46)}`);

  // 1. 拉上游
  const raw = {};
  for (const f of UPSTREAM.files) {
    const name = f.split("/").pop();
    process.stdout.write(`拉取 ${name} ... `);
    raw[name] = await fetchJSON(`${UPSTREAM.raw}/${f}`);
    console.log("OK");
  }

  const providers = raw["providers.json"]?.providers ?? [];
  const models = raw["models.json"]?.models ?? [];
  const upVersion = raw["providers.json"]?.version ?? "?";
  const upUpdated = raw["providers.json"]?.last_updated ?? "?";

  console.log(`\n上游版本 ${upVersion}，数据日期 ${upUpdated}`);
  console.log(`厂商 ${providers.length} 家，模型 ${models.length} 个`);

  // 2. 归档原始上游（防上游停更/删库）
  const archDir = join(DATA, "upstream", today);
  if (!existsSync(archDir)) mkdirSync(archDir, { recursive: true });
  for (const [name, obj] of Object.entries(raw)) {
    writeFileSync(join(archDir, name), JSON.stringify(obj, null, 2), "utf8");
  }
  console.log(`已归档上游原始数据 → data/upstream/${today}/`);

  // 3. 归一化
  const offers = providers.map((p) => {
    const ar = p.auth_requirements ?? {};
    const myModels = models.filter((m) => m.provider_id === p.id);
    return {
      id: p.id,
      name: p.name,
      company: p.company ?? null,
      free_tier_type: p.free_tier_type ?? "unknown",
      quota_value: p.free_tier_desc ?? null,
      auth: {
        phone_required: !!ar.phone_required,
        real_name_required: !!ar.real_name_required,
        credit_card_required: !!ar.credit_card_required,
        recharge_required: !!ar.recharge_required,
      },
      onboarding: {
        console_url: p.console_url ?? null,
        base_url: p.base_url ?? null,
        doc_url: p.api_doc_url ?? null,
        openai_compatible: !!p.openai_compatible,
      },
      models: myModels.map((m) => ({
        model_id: m.model_id,
        model_name: m.model_name,
        status: m.status,
        quota_desc: m.quota_desc,
        context_window: m.context_window,
        rpm: m.rpm,
        rpd: m.rpd,
      })),
      last_verified_upstream: p.last_verified ?? null,
      days_since_verified: daysAgo(p.last_verified),
      freshness: freshness(p.last_verified),
      note: p.note ?? null,
      sources: [`https://github.com/${UPSTREAM.repo}/blob/main/data/providers.json`],
    };
  });

  // 4. 写 offers.json
  const byType = {};
  const byFresh = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const o of offers) {
    byType[o.free_tier_type] = (byType[o.free_tier_type] ?? 0) + 1;
    byFresh[o.freshness] = (byFresh[o.freshness] ?? 0) + 1;
  }

  const snapshot = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    upstream: {
      repo: UPSTREAM.repo,
      version: upVersion,
      last_updated: upUpdated,
      license: "MIT",
      fetched_ok: true,
    },
    stats: {
      total: offers.length,
      models: models.length,
      by_freshness: byFresh,
      by_type: byType,
      no_card: offers.filter((o) => !o.auth.credit_card_required).length,
      no_realname: offers.filter((o) => !o.auth.real_name_required).length,
    },
    offers,
  };

  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "offers.json"), JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`已写出 → data/offers.json`);

  // 5. 生成 Markdown 清单
  const md = renderMarkdown(snapshot);
  writeFileSync(join(__dirname, "免费额度清单.md"), md, "utf8");
  console.log(`已写出 → 免费额度清单.md`);

  // 6. 控制台摘要
  console.log(`\n${"=".repeat(46)}`);
  console.log("摘要");
  console.log(`  厂商总数        ${offers.length}`);
  console.log(`  不需绑卡        ${snapshot.stats.no_card}`);
  console.log(`  不需实名        ${snapshot.stats.no_realname}`);
  console.log(
    `  数据新鲜度      fresh ${byFresh.fresh} / aging ${byFresh.aging} / stale ${byFresh.stale}`
  );
  console.log(`\n  按免费类型：`);
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(TYPE_LABEL[k] ?? k).padEnd(24)} ${v}`);
  }
  if (byFresh.stale > 0) {
    console.log(
      `\n  ⚠️  ${byFresh.stale} 家上游数据超过 14 天未复核，额度可能已变化，请看清单里的「陈旧」标记。`
    );
  }
  console.log();
}

// ── Markdown 渲染 ───────────────────────────────────────────────
function renderMarkdown(snap) {
  const d = new Date(snap.generated_at);
  const ts = d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const L = [];

  L.push("# 免费大模型额度清单");
  L.push("");
  L.push(
    `> 生成时间：${ts}　·　共 **${snap.stats.total}** 家厂商 / **${snap.stats.models}** 个模型`
  );
  L.push(`>`);
  L.push(
    `> 数据来源：[${snap.upstream.repo}](https://github.com/${snap.upstream.repo})（MIT）v${snap.upstream.version}，上游数据日期 ${snap.upstream.last_updated}`
  );
  L.push("");
  L.push("---");
  L.push("");

  // 新鲜度警告置顶
  if (snap.stats.by_freshness.stale > 0) {
    L.push(`## ⚠️ 数据新鲜度提示`);
    L.push("");
    L.push(
      `上游是**人工维护**的，当前 **${snap.stats.by_freshness.stale} 家**的数据超过 14 天未复核。`
    );
    L.push(
      `额度类信息变化快（尤其"新用户注册送"这种），**建议先到官方页面确认再注册**。`
    );
    L.push("");
    L.push(`| 新鲜度 | 家数 | 含义 |`);
    L.push(`|---|---|---|`);
    L.push(`| 🟢 fresh | ${snap.stats.by_freshness.fresh} | 7 天内复核过 |`);
    L.push(`| 🟡 aging | ${snap.stats.by_freshness.aging} | 8~14 天 |`);
    L.push(
      `| 🔴 stale | ${snap.stats.by_freshness.stale} | 超过 14 天，可能已变 |`
    );
    L.push("");
    L.push("---");
    L.push("");
  }

  // 速查
  L.push("## 🎯 怎么快速挑一个");
  L.push("");
  L.push(`- **不想实名** → ${snap.stats.no_realname} 家可选，见下方「免实名」小节`);
  L.push(
    `- **不想绑卡** → **全部 ${snap.stats.no_card} 家都不用绑卡**（这是国内厂商的普遍情况）`
  );
  L.push(`- **想要稳定长期用** → 挑「🟢 长期免费」的，不会过期`);
  L.push(`- **想一次性薅一大笔** → 挑「🟠 新用户一次性」的，但要注意有效期`);
  L.push("");
  L.push("---");
  L.push("");

  // 主表
  L.push("## 📋 全部厂商");
  L.push("");

  const groups = [
    ["permanent_free", "🟢 长期免费（不会过期，最稳）"],
    ["permanent_free_and_trial", "🟢🟡 长期免费 + 新用户额度"],
    ["quota_with_expiry", "🟡 有免费额度（会过期，注意有效期）"],
    ["new_user_trial", "🟠 新用户一次性（薅完即止）"],
    ["limited_time_free", "🔥 限时免费（随时结束）"],
    ["free_points", "🎫 积分制"],
    ["free_tier", "🟢 有免费档"],
  ];

  for (const [type, title] of groups) {
    const list = snap.offers.filter((o) => o.free_tier_type === type);
    if (!list.length) continue;
    L.push(`### ${title}`);
    L.push("");
    for (const o of list) L.push(renderCard(o));
  }

  const grouped = new Set(groups.map((g) => g[0]));
  const rest = snap.offers.filter((o) => !grouped.has(o.free_tier_type));
  if (rest.length) {
    L.push(`### ⚪ 其他 / 待确认`);
    L.push("");
    for (const o of rest) L.push(renderCard(o));
  }

  L.push("---");
  L.push("");
  L.push("## 🚫 免实名清单（注册门槛最低）");
  L.push("");
  const noRn = snap.offers.filter((o) => !o.auth.real_name_required);
  L.push(`共 ${noRn.length} 家：` + noRn.map((o) => o.name).join("、"));
  L.push("");
  L.push("---");
  L.push("");
  L.push("## 关于这份清单");
  L.push("");
  L.push("- 由本地脚本 `sync.mjs` 从上游自动生成，**零成本**（不调用任何大模型）");
  L.push("- 上游 `last_verified` 字段决定新鲜度，**本脚本不伪造新鲜度**，陈旧就标陈旧");
  L.push("- 额度数字**照抄上游原文**，未做任何改写或推算");
  L.push("- 想看还剩多少额度，需要另做余额查询（要你自己的 API Key），本脚本不含此功能");
  L.push("");

  return L.join("\n");
}

function renderCard(o) {
  const L = [];
  const fresh = { fresh: "🟢", aging: "🟡", stale: "🔴", unknown: "⚪" }[o.freshness] ?? "⚪";
  const freshTxt =
    o.days_since_verified != null ? `${o.days_since_verified} 天前复核` : "未复核";

  L.push(`#### ${o.name}`);
  L.push("");
  L.push(`- **额度**：${o.quota_value ?? "（上游未注明）"}`);
  L.push(`- **门槛**：${authLine(o.auth)}`);
  L.push(`- **数据新鲜度**：${fresh} ${freshTxt}`);
  if (o.onboarding.base_url) {
    L.push(
      `- **Base URL**：\`${o.onboarding.base_url}\`${o.onboarding.openai_compatible ? "（[OI] 兼容）" : ""}`
    );
  }
  if (o.onboarding.console_url) L.push(`- **领取入口**：${o.onboarding.console_url}`);
  if (o.onboarding.doc_url) L.push(`- **文档**：${o.onboarding.doc_url}`);
  if (o.models.length) {
    L.push(
      `- **可用模型**（${o.models.length} 个）：` +
        o.models.map((m) => `\`${m.model_id}\``).join("、")
    );
  }
  if (o.note) L.push(`- **备注**：${o.note}`);
  L.push("");
  return L.join("\n");
}

function authLine(a) {
  const parts = [];
  parts.push(a.phone_required ? "需手机号" : "免手机号");
  parts.push(a.real_name_required ? "需实名" : "**免实名**");
  parts.push(a.credit_card_required ? "需绑卡" : "**免绑卡**");
  if (a.recharge_required) parts.push("需充值");
  return parts.join(" · ");
}

main().catch((err) => {
  console.error("\n❌ 失败：", err.message);
  if (/fetch failed|ECONN|ENOTFOUND|timeout/i.test(err.message)) {
    console.error("   网络不通。若本机需要代理，请先启动代理再运行；");
    console.error("   或手动指定：HTTPS_PROXY=http://127.0.0.1:7890 node sync.mjs");
  }
  process.exit(1);
});
