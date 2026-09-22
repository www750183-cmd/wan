// 固定流程编排：抓取 → 点赞 → 评论 → 写日志
//
// 每条作品的执行顺序是固定的：
//   1. 打开作品页，一次性抓「内容 + 评论区 + 视频数据」
//   2. 调模型：生成视频梗概、评论区关注点、评论草稿
//   3. 点赞（如已勾选；已是点赞态就跳过）
//   4. 评论（如已勾选；发布后校验）
//   5. 写一条日志
//
// 任何一步失败都不影响后面能补救的部分，最终在日志的「执行结果」里体现，
// 例如「点赞✅评论✅」「点赞✅评论❌」「点赞⏭评论✅」。

import { PLATFORMS, detectPlatform, workIdFromUrl, isWorkUrl, resolveSelectors, resolveState } from './platforms.js';
import { withPage, resolveShortUrl, inject } from './tab.js';
import { injectHarvest, injectInteract } from '../injected.js';
import { buildInsightPrompt, parseInsight, validateDrafts, pickDraft, fallbackDraft } from './insight.js';
import { callLLM } from './llm.js';
import { appendLog, markDone, getDone } from './store.js';
import { sleep, uid, truncate } from './util.js';

const MARK = { ok: '✅', fail: '❌', skip: '⏭', warn: '⚠' };

/**
 * 点赞这一步的标记。
 * 关键：**试跑（dryRun）成功了也要给 ✅**——试跑验证的是「这条路走不走得通」，
 * 走通了就该显示 ✅。之前试跑一律给 ⏭，用户看到的结果栏像是啥也没干成。
 */
export function markForLike(result) {
  if (!result || !result.ok) return MARK.fail;
  return result.alreadyInTarget ? MARK.skip : MARK.ok;
}

/** 评论这一步的标记。试跑成功同样给 ✅；已提交但未能确证给 ⚠。 */
export function markForComment(result) {
  if (!result || !result.ok) return MARK.fail;
  if (result.dryRun) return MARK.ok;
  return result.verified === false ? MARK.warn : MARK.ok;
}

function rand(min, max) {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return Math.round(lo + Math.random() * (hi - lo));
}

function selectorCfg(settings, platform) {
  const ov = settings.selectorOverrides?.[platform];
  const p = PLATFORMS[platform];
  return {
    selectors: resolveSelectors(platform, ov),
    likeState: resolveState(platform, 'likeState', ov),
    collectState: resolveState(platform, 'collectState', ov),
    // ★ 平台级字段也要带过去：抖音的 commentTrigger（必须先点，编辑器才渲染）
    commentTrigger: p?.commentTrigger || [],
    openCommentsBy: p?.openCommentsBy || [],
  };
}

/** 把三步的结果拼成一行「执行结果」，例如 点赞✅评论✅ */
export function buildResultText(steps) {
  const parts = [];
  if (steps.doLike) parts.push(`点赞${steps.like}`);
  if (steps.doComment) parts.push(`评论${steps.comment}`);
  return parts.join('') || '未执行';
}

/** 根据各步结果推出整体状态 */
export function overallStatus(steps, dryRun) {
  const marks = [];
  if (steps.doLike) marks.push(steps.like);
  if (steps.doComment) marks.push(steps.comment);
  if (marks.length === 0) return 'failed';
  if (dryRun) return 'dry-run';
  if (marks.every((m) => m === MARK.ok || m === MARK.skip)) return 'ok';
  if (marks.some((m) => m === MARK.ok)) return 'partial';
  return 'failed';
}

/**
 * 跑完整流程，返回一条日志记录（无论成功失败都会返回，不抛异常）
 * @param item {url, platform?, title?, workId?}
 * @param settings
 * @param hooks {onProgress}
 */
async function runOne(item, settings, hooks) {
  const report = hooks.onProgress || (() => {});
  const platform = item.platform || detectPlatform(item.url);
  const p = PLATFORMS[platform];
  const s = selectorCfg(settings, platform);
  const a = settings.auto;

  const log = {
    id: uid('log'),
    at: new Date().toISOString(),
    platform,
    platformName: p?.name || platform,
    workId: item.workId || workIdFromUrl(platform, item.url),
    // —— 用户要求的 8 个字段 ——
    title: item.title || '',
    url: item.url,
    likeCount: null,
    commentCount: null,
    favoriteCount: null,
    commentFocus: '',
    comment: '',
    result: '',
    // —— 诊断用 ——
    status: 'failed',
    dryRun: !!settings.dryRun,
    steps: {},
    summary: '',
    message: '',
  };

  const stepState = { doLike: !!a.doLike, doComment: !!a.doComment, like: MARK.fail, comment: MARK.fail };
  const notes = [];

  try {
    // ---------- 1 + 2 + 3 + 4 在同一次开页里完成 ----------
    await withPage(item.url, settings, async ({ tabId, url }) => {
      log.url = url;

      // ===== 第一步：抓取 =====
      report(`${p?.name || platform} · 抓取内容与评论区`);
      const harvestCfg = {
        ...s,
        commentMax: a.commentSampleCount,
        commentScrolls: a.commentScrolls,
        commentScrollDelayMs: a.commentScrollDelayMs,
        // 抖音这类平台评论区默认收起，需要先点评论图标展开
        openCommentsBy: p?.openCommentsBy || [],
        // ★ 抖音页面在冷启动时加载极慢（实测：无头环境下 60 秒后才有正文与评论）。
        //   readyTimeoutMs 等的是「页面骨架出现」，commentReadyTimeoutMs 等的是「评论真有内容」。
        //   两者都是独立预算，用 pageTimeoutMs 兜底（默认 45s，可调）。
        readyTimeoutMs: Math.min(25000, settings.pageTimeoutMs || 45000),
        commentReadyTimeoutMs: Math.min(60000, settings.pageTimeoutMs || 60000),
      };
      const h = await inject(tabId, injectHarvest, [harvestCfg]);
      if (h.loggedOut) throw new Error('页面显示未登录，请先在浏览器里登录该平台');

      const c = h.content || {};
      log.title = c.title || log.title;
      log.likeCount = c.likeCount ?? null;
      log.commentCount = c.commentCount ?? null;
      log.favoriteCount = c.favoriteCount ?? null;
      log.steps.harvest = { ok: true, comments: h.comments?.length || 0, scrolls: h.scrolls, isLiked: c.isLiked };

      // ===== 生成评论（内部步骤，不单独出现在日志里） =====
      if (stepState.doComment) {
        report(`${p?.name || platform} · 生成评论（${h.comments.length} 条评论样本）`);
        const prompt = buildInsightPrompt(settings, c, h.comments);
        const { text } = await callLLM(settings, prompt);
        const insight = parseInsight(text);
        log.commentFocus = insight.commentFocus || '';
        log.summary = insight.summary || '';
        log.steps.insight = { ok: insight.ok, drafts: insight.drafts.length, summary: insight.summary };

        const { valid, rejected } = validateDrafts(insight.drafts, settings, h.comments);
        log.steps.validation = { valid: valid.length, rejected: rejected.length };

        let chosen = pickDraft(valid, settings);
        if (!chosen && a.useFallback) {
          const fb = fallbackDraft(settings, c, insight);
          if (fb) {
            const re = validateDrafts([{ text: fb, reason: '兜底' }], settings, h.comments);
            if (re.valid.length) { chosen = re.valid[0]; log.steps.usedFallback = true; }
          }
        }
        if (chosen) log.comment = chosen.text;
        else {
          stepState.comment = MARK.fail;
          notes.push(`评论草稿未通过校验${rejected[0] ? `（${rejected[0].reason}）` : ''}`);
        }
      } else {
        stepState.comment = MARK.skip;
      }

      // ===== 第三步：点赞 =====
      if (stepState.doLike) {
        report(`${p?.name || platform} · ${settings.dryRun ? '检查点赞' : '点赞'}`);
        const r = await inject(tabId, injectInteract, [{
          ...s, action: 'like', dryRun: !!settings.dryRun,
          readyTimeoutMs: 12000, actionTimeoutMs: 8000,
        }]);
        if (r.needLogin) throw new Error('点赞时检测到未登录');
        stepState.like = markForLike(r);
        if (stepState.like === MARK.skip) {
          log.steps.like = { already: true };
        } else if (stepState.like === MARK.ok) {
          log.steps.like = { ok: true, dryRun: !!settings.dryRun };
        } else {
          log.steps.like = { error: r.error || r.message };
          notes.push(`点赞失败：${r.error || r.message || '未知'}`);
        }
      } else {
        stepState.like = MARK.skip;
      }

      // ===== 第四步：评论 =====
      if (stepState.doComment && log.comment) {
        report(`${p?.name || platform} · ${settings.dryRun ? '检查评论' : '发布评论'}`);
        const r = await inject(tabId, injectInteract, [{
          ...s, action: 'comment', content: log.comment, dryRun: !!settings.dryRun,
          readyTimeoutMs: 12000, actionTimeoutMs: 10000,
        }]);
        if (r.needLogin) throw new Error('评论时检测到未登录');
        stepState.comment = markForComment(r);
        if (stepState.comment === MARK.ok) {
          log.steps.comment = settings.dryRun ? { dryRun: true, checked: true } : { ok: true, verified: true };
        } else if (stepState.comment === MARK.warn) {
          log.steps.comment = { submitted: true, verified: false };
          notes.push('评论已提交但未能确证，建议人工抽查');
        } else {
          log.steps.comment = { error: r.error || r.message };
          notes.push(`评论失败：${r.error || r.message || '未知'}`);
        }
      } else if (stepState.doComment && !log.comment) {
        // 上面已经记过原因
      }
    });
  } catch (e) {
    log.message = e?.message || String(e);
    notes.push(log.message);
    // 抓取阶段就挂了：点赞/评论都没跑
    if (!log.steps.harvest) {
      if (stepState.doLike) stepState.like = MARK.fail;
      if (stepState.doComment) stepState.comment = MARK.fail;
    }
  }

  log.result = buildResultText(stepState);
  log.status = overallStatus(stepState, settings.dryRun);
  if (!log.message) log.message = notes.join('；');
  log.steps.marks = { like: stepState.like, comment: stepState.comment };
  return log;
}

/**
 * 批量跑固定流程
 * @param items 作品列表
 * @param settings
 * @param hooks {onProgress, shouldStop}
 */
export async function runFixedFlow(items, settings, hooks = {}) {
  const report = hooks.onProgress || (() => {});
  const shouldStop = hooks.shouldStop || (() => false);

  const enabled = settings.enabledPlatforms || {};
  const usable = [];
  const problems = [];
  for (const it of items) {
    const platform = it.platform || detectPlatform(it.url);
    if (!platform || !PLATFORMS[platform]) { problems.push({ item: it, reason: '无法识别平台' }); continue; }
    if (!enabled[platform]) { problems.push({ item: it, reason: `${PLATFORMS[platform].name} 已在设置里关闭` }); continue; }
    if (settings.auto.doComment && !PLATFORMS[platform].supports.comment) {
      problems.push({ item: it, reason: `${PLATFORMS[platform].name} 不支持评论，已跳过` });
      continue;
    }
    usable.push({ ...it, platform });
  }

  const logs = [];
  let consecutiveFailures = 0;
  let stopped = false, aborted = false, abortReason = '';
  let okCount = 0, partialCount = 0, failCount = 0, dryCount = 0;

  const done = settings.skipAlreadyDone ? await getDone() : {};

  for (let i = 0; i < usable.length; i++) {
    const item = usable[i];
    if (shouldStop()) { stopped = true; report(`已停止（完成 ${i}/${usable.length}）`); break; }

    const platform = item.platform;
    const workId = item.workId || workIdFromUrl(platform, item.url);
    const doneKey = `${platform}:${workId || item.url}:flow`;

    if (settings.skipAlreadyDone && done[doneKey]) {
      logs.push({
        id: uid('log'), at: new Date().toISOString(),
        platform, platformName: PLATFORMS[platform].name, workId,
        title: item.title || '', url: item.url,
        likeCount: null, commentCount: null, favoriteCount: null,
        commentFocus: '', comment: '', result: '已做过，跳过',
        status: 'skipped', dryRun: !!settings.dryRun, steps: {}, summary: '', message: '历史记录里已处理过',
      });
      report(`[${i + 1}/${usable.length}] 已处理过，跳过`);
      continue;
    }

    if (i > 0) {
      const waitMs = rand(settings.commentGapMs[0], settings.commentGapMs[1]);
      report(`[${i + 1}/${usable.length}] 限速等待 ${(waitMs / 1000).toFixed(1)}s`);
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        if (shouldStop()) break;
        await sleep(500);
      }
      if (shouldStop()) { stopped = true; break; }
    }

    report(`[${i + 1}/${usable.length}] ${PLATFORMS[platform].name} · 开始`);

    let target = item.url;
    if (!isWorkUrl(platform, target)) {
      const finalUrl = await resolveShortUrl(target, settings);
      if (detectPlatform(finalUrl) === platform) target = finalUrl;
    }

    const log = await runOne({ ...item, url: target }, settings, hooks);
    logs.push(log);
    await appendLog(log);

    if (log.status === 'ok') { okCount++; consecutiveFailures = 0; await markDone(doneKey, { platform, url: log.url }); done[doneKey] = { at: Date.now() }; }
    else if (log.status === 'partial') { partialCount++; consecutiveFailures = 0; await markDone(doneKey, { platform, url: log.url }); done[doneKey] = { at: Date.now() }; }
    else if (log.status === 'dry-run') { dryCount++; consecutiveFailures = 0; }
    else if (log.status === 'skipped') { /* 不计数 */ }
    else { failCount++; consecutiveFailures++; }

    if (consecutiveFailures >= settings.maxConsecutiveFailures) {
      aborted = true;
      abortReason = `连续 ${consecutiveFailures} 条失败，已熔断（多半是选择器失效或未登录，请到设置里的自检面板校准）`;
      break;
    }
  }

  return {
    logs,
    summary: {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      dryRun: !!settings.dryRun,
      doLike: !!settings.auto.doLike,
      doComment: !!settings.auto.doComment,
      total: usable.length,
      ok: okCount, partial: partialCount, failed: failCount, dryRunCount: dryCount,
      skipped: logs.filter((l) => l.status === 'skipped').length,
      stopped, aborted, abortReason,
      preflightProblems: problems.slice(0, 30),
    },
  };
}

export { MARK };
