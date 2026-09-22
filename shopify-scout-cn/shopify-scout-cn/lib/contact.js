/**
 * 联系方式 —— 所有自研插件共用的固定信息。
 *
 * 新插件直接复制这一个文件，改掉 PRODUCT 即可；QQ 号保持不变。
 * 这样做的原因：联系方式散落在各个界面里，一旦换号就得满仓库找，
 * 集中在一处才改得动、才记得住。
 */

/** 支持与通知统一入口（所有插件共用） */
export const SUPPORT_QQ = '1611744064';

/** 这个 QQ 号是干什么的 —— 必须写清楚，否则用户不敢加 */
export const SUPPORT_ROLES = [
  '负责调整 BUG —— 用着有问题、哪里不对，直接加这个号说',
  '新版本发布的第一通知号 —— 更新了会先说一声'
];

/** 当前插件名（用于文案拼接） */
export const PRODUCT_NAME = '选品侦探 · Shopify 店铺侦察兵';

/** 一行式联系方式文本，便于日志、README、错误提示复用 */
export const SUPPORT_LINE = `QQ ${SUPPORT_QQ}（BUG 反馈 / 新版本通知）`;

/**
 * 生成「关于」区块的 HTML 片段，供各插件的设置页直接插入。
 * @param {{accent?:string}} opts
 */
export function contactCardHtml(opts = {}) {
  const accent = opts.accent || 'var(--brand)';
  return `
    <div class="card" style="border-color:${accent}">
      <h3>联系与更新</h3>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="font-size:22px;font-weight:700;letter-spacing:.5px;color:${accent};user-select:all">QQ ${SUPPORT_QQ}</div>
      </div>
      <div style="font-size:12px;line-height:1.8">
        ${SUPPORT_ROLES.map((r) => `<div>· ${r}</div>`).join('')}
      </div>
      <p class="muted" style="font-size:11px;margin:8px 0 0">
        这个号只做上面两件事，不会拉群、不会发广告。
      </p>
    </div>`;
}
