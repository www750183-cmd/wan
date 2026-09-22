/**
 * 本地指纹库 —— 本扩展的核心资产。
 *
 * 与 Stackpeek / Koala Inspector 等「客户端采集 + 服务端匹配」架构不同，
 * 本扩展把签名库完整内置，扫描时不请求任何第三方服务器，断网也能出结果。
 *
 * 匹配面（haystack）由 lib/detect.js 组装，包含：
 *   script   —— <script src> 的完整 URL
 *   link     —— <link href> 的完整 URL
 *   inline   —— 内联 <script> 文本（截断采样）
 *   html     —— 页面 HTML（截断采样）
 *   global   —— window 上的全局变量名
 *   meta     —— <meta> 的 name/content/property/值
 *   cookie   —— document.cookie 的 name 列表
 *
 * 每条签名的 patterns 为正则源码串，任一命中即判定该应用「已安装」。
 * confidence: high = 特征专属于该应用；medium = 较强但可能共用；low = 弱信号，仅供参考。
 */

/** @typedef {'评论与UGC'|'弹窗与邮件'|'会员与积分'|'订阅复购'|'搜索筛选'|'页面搭建'|'加购追加'|'紧迫感'|'客服聊天'|'物流追踪'|'代发供应链'|'支付分期'|'合规Cookie'|'分析回放'|'转化优化'|'多语言货币'|'尺码个性化'|'按需打印'|'预约到店'|'批发B2B'|'反欺诈风控'} AppCategory */

export const APP_CATEGORIES = [
  '评论与UGC', '弹窗与邮件', '会员与积分', '订阅复购', '搜索筛选', '页面搭建',
  '加购追加', '紧迫感', '客服聊天', '物流追踪', '代发供应链', '支付分期',
  '合规Cookie', '分析回放', '转化优化', '多语言货币', '尺码个性化', '按需打印',
  '预约到店', '批发B2B', '反欺诈风控'
];

export const APP_SIGNATURES = [
  /* ── 评论与 UGC ───────────────────────────────────────── */
  { id: 'judgeme', name: 'Judge.me 评论', vendor: 'Judge.me', category: '评论与UGC', confidence: 'high',
    patterns: ['judge\\.me', 'cdn\\.judge\\.me', 'jdgm-'], url: 'https://judge.me' },
  { id: 'loox', name: 'Loox 图片评论', vendor: 'Loox', category: '评论与UGC', confidence: 'high',
    patterns: ['loox\\.io', 'loox-rating', 'looxReviews'], url: 'https://loox.io' },
  { id: 'yotpo', name: 'Yotpo 评论', vendor: 'Yotpo', category: '评论与UGC', confidence: 'high',
    patterns: ['yotpo\\.com', 'staticw2\\.yotpo\\.com', 'yotpo-widget'], url: 'https://yotpo.com' },
  { id: 'stamped', name: 'Stamped.io 评论', vendor: 'Stamped.io', category: '评论与UGC', confidence: 'high',
    patterns: ['stamped\\.io', 'stamped-badge'], url: 'https://stamped.io' },
  { id: 'okendo', name: 'Okendo 评论', vendor: 'Okendo', category: '评论与UGC', confidence: 'high',
    patterns: ['okendo\\.io', 'okendo-reviews'], url: 'https://okendo.io' },
  { id: 'junip', name: 'Junip 评论', vendor: 'Junip', category: '评论与UGC', confidence: 'high',
    patterns: ['junip\\.co', 'junip-store'], url: 'https://junip.co' },
  { id: 'ryviu', name: 'Ryviu 评论', vendor: 'Ryviu', category: '评论与UGC', confidence: 'high',
    patterns: ['ryviu\\.com', 'ryviu-widget'], url: 'https://ryviu.com' },
  { id: 'lai', name: 'Lai Reviews 评论', vendor: 'Lai Apps', category: '评论与UGC', confidence: 'high',
    patterns: ['lai-app\\.', 'lai-reviews', 'reviews\\.lai'], url: 'https://lai-app.com' },
  { id: 'alireviews', name: 'Ali Reviews', vendor: 'FireApps', category: '评论与UGC', confidence: 'high',
    patterns: ['ali-?reviews', 'fireapps\\.io', '/widget/review-widget'], url: 'https://fireapps.io' },
  { id: 'growave', name: 'Growave 评论+积分', vendor: 'Growave', category: '评论与UGC', confidence: 'high',
    patterns: ['growave\\.io', 'growave-'], url: 'https://growave.io' },
  { id: 'trustpilot', name: 'Trustpilot 评分', vendor: 'Trustpilot', category: '评论与UGC', confidence: 'high',
    patterns: ['trustpilot\\.com', 'widget\\.trustpilot'], url: 'https://trustpilot.com' },
  { id: 'trustspot', name: 'TrustSpot 评论', vendor: 'TrustSpot', category: '评论与UGC', confidence: 'medium',
    patterns: ['trustspot\\.io'], url: 'https://trustspot.io' },
  { id: 'reviewsio', name: 'Reviews.io', vendor: 'Reviews.io', category: '评论与UGC', confidence: 'medium',
    patterns: ['reviews\\.io', 'widget\\.reviews\\.io'], url: 'https://reviews.io' },
  { id: 'fera', name: 'Fera 评论', vendor: 'Fera', category: '评论与UGC', confidence: 'medium',
    patterns: ['fera\\.ai', 'fera-reviews'], url: 'https://fera.ai' },
  { id: 'opinew', name: 'Opinew 评论', vendor: 'Opinew', category: '评论与UGC', confidence: 'medium',
    patterns: ['opinew\\.com', 'opinew-'], url: 'https://opinew.com' },

  /* ── 弹窗与邮件营销 ───────────────────────────────────── */
  { id: 'klaviyo', name: 'Klaviyo 邮件+短信', vendor: 'Klaviyo', category: '弹窗与邮件', confidence: 'high',
    patterns: ['klaviyo\\.com', 'static\\.klaviyo\\.com', '_learnq'], url: 'https://klaviyo.com', globals: ['_learnq'] },
  { id: 'omnisend', name: 'Omnisend 邮件', vendor: 'Omnisend', category: '弹窗与邮件', confidence: 'high',
    patterns: ['omnisend\\.com', 'omnisend-'], url: 'https://omnisend.com' },
  { id: 'privy', name: 'Privy 弹窗', vendor: 'Privy', category: '弹窗与邮件', confidence: 'high',
    patterns: ['privy\\.com', 'privy-'], url: 'https://privy.com' },
  { id: 'justuno', name: 'Justuno 弹窗', vendor: 'Justuno', category: '弹窗与邮件', confidence: 'high',
    patterns: ['justuno\\.com', 'juapp'], url: 'https://justuno.com' },
  { id: 'wisepops', name: 'Wisepops 弹窗', vendor: 'Wisepops', category: '弹窗与邮件', confidence: 'high',
    patterns: ['wisepops\\.com', 'wisepops\\.net'], url: 'https://wisepops.com' },
  { id: 'sleeknote', name: 'Sleeknote 弹窗', vendor: 'Sleeknote', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['sleeknote\\.com'], url: 'https://sleeknote.com' },
  { id: 'poptin', name: 'Poptin 弹窗', vendor: 'Poptin', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['poptin\\.com'], url: 'https://poptin.com' },
  { id: 'optinmonster', name: 'OptinMonster', vendor: 'OptinMonster', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['optinmonster\\.com'], url: 'https://optinmonster.com' },
  { id: 'attentive', name: 'Attentive 短信', vendor: 'Attentive', category: '弹窗与邮件', confidence: 'high',
    patterns: ['attn\\.tv', 'attentivemobile'], url: 'https://attentive.com' },
  { id: 'postscript', name: 'Postscript 短信', vendor: 'Postscript', category: '弹窗与邮件', confidence: 'high',
    patterns: ['postscript\\.com', 'postscript-'], url: 'https://postscript.io' },
  { id: 'smsbump', name: 'SMSBump 短信', vendor: 'Yotpo', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['smsbump\\.com', 'smsbump'], url: 'https://smsbump.com' },
  { id: 'mailchimp', name: 'Mailchimp', vendor: 'Intuit', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['chimpstatic\\.com', 'mailchimp\\.com'], url: 'https://mailchimp.com' },
  { id: 'sendinblue', name: 'Brevo (Sendinblue)', vendor: 'Brevo', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['sendinblue\\.com', 'brevo\\.com', 'sibautomation'], url: 'https://brevo.com' },
  { id: 'getelevar', name: 'Elevar 数据层', vendor: 'Elevar', category: '弹窗与邮件', confidence: 'medium',
    patterns: ['getelevar\\.com', 'elevar-'], url: 'https://getelevar.com' },

  /* ── 会员与积分 ───────────────────────────────────────── */
  { id: 'smile', name: 'Smile.io 积分', vendor: 'Smile.io', category: '会员与积分', confidence: 'high',
    patterns: ['smile\\.io', 'smile-ui', 'smile-ui-lite'], url: 'https://smile.io' },
  { id: 'swell', name: 'Swell 积分', vendor: 'Swell', category: '会员与积分', confidence: 'high',
    patterns: ['swellrewards\\.com', 'swell\\.is'], url: 'https://swell.is' },
  { id: 'loyaltylion', name: 'LoyaltyLion', vendor: 'LoyaltyLion', category: '会员与积分', confidence: 'high',
    patterns: ['loyaltylion\\.com', 'loyaltylion\\.net'], url: 'https://loyaltylion.com' },
  { id: 'yotpo_loyalty', name: 'Yotpo 积分', vendor: 'Yotpo', category: '会员与积分', confidence: 'medium',
    patterns: ['yotpo.*loyalty', 'yotpo.*swell'], url: 'https://yotpo.com' },
  { id: 'rivo', name: 'Rivo 会员', vendor: 'Rivo', category: '会员与积分', confidence: 'medium',
    patterns: ['rivo\\.io/apps/'], url: 'https://rivo.io' },

  /* ── 订阅复购 ─────────────────────────────────────────── */
  { id: 'recharge', name: 'Recharge 订阅', vendor: 'Recharge', category: '订阅复购', confidence: 'high',
    patterns: ['rechargepayments\\.com', 'recharge-'], url: 'https://rechargepayments.com' },
  { id: 'bold', name: 'Bold Commerce', vendor: 'Bold', category: '订阅复购', confidence: 'high',
    patterns: ['boldapps\\.net', 'boldcommerce'], url: 'https://boldcommerce.com' },
  { id: 'appstle', name: 'Appstle 订阅', vendor: 'Appstle', category: '订阅复购', confidence: 'high',
    patterns: ['appstle\\.com', 'appstle-'], url: 'https://appstle.com' },
  { id: 'smartrr', name: 'Smartrr 订阅', vendor: 'Smartrr', category: '订阅复购', confidence: 'medium',
    patterns: ['smartrr\\.com', 'smartrr-'], url: 'https://smartrr.com' },
  { id: 'sealsubscriptions', name: 'Seal Subscriptions', vendor: 'Seal', category: '订阅复购', confidence: 'medium',
    patterns: ['sealsubscriptions\\.com'], url: 'https://sealsubscriptions.com' },
  { id: 'loop', name: 'Loop 订阅', vendor: 'Loop', category: '订阅复购', confidence: 'medium',
    patterns: ['loopwork\\.co', 'loopsubscriptions'], url: 'https://loopwork.co' },

  /* ── 搜索筛选 ─────────────────────────────────────────── */
  { id: 'algolia', name: 'Algolia 搜索', vendor: 'Algolia', category: '搜索筛选', confidence: 'high',
    patterns: ['algolia\\.net', 'algolianet\\.com', 'algoliasearch'], url: 'https://algolia.com' },
  { id: 'klevu', name: 'Klevu 搜索', vendor: 'Klevu', category: '搜索筛选', confidence: 'high',
    patterns: ['klevu\\.com', 'klevu-'], url: 'https://klevu.com' },
  { id: 'searchanise', name: 'Searchanise 搜索', vendor: 'Searchanise', category: '搜索筛选', confidence: 'high',
    patterns: ['searchanise\\.com', 'searchanise-'], url: 'https://searchanise.com' },
  { id: 'boost', name: 'Boost Commerce 筛选', vendor: 'Boost', category: '搜索筛选', confidence: 'high',
    patterns: ['boostcommerce\\.net', 'boost-pfs', 'bc-sf-filter'], url: 'https://boostcommerce.net' },
  { id: 'nosto', name: 'Nosto 个性化', vendor: 'Nosto', category: '搜索筛选', confidence: 'high',
    patterns: ['nosto\\.com', 'nostojs'], url: 'https://nosto.com' },
  { id: 'globo', name: 'Globo 系列应用', vendor: 'Globo', category: '搜索筛选', confidence: 'high',
    patterns: ['globo\\.io', 'globo-'], url: 'https://globo.io' },
  { id: 'fastserp', name: 'Fast Simon 搜索', vendor: 'Fast Simon', category: '搜索筛选', confidence: 'medium',
    patterns: ['fastsimon\\.com', 'fast-serp'], url: 'https://fastsimon.com' },
  { id: 'instantsearch', name: 'Instant Search+', vendor: 'Instant Search', category: '搜索筛选', confidence: 'medium',
    patterns: ['instantsearchplus\\.com'], url: 'https://instantsearchplus.com' },

  /* ── 页面搭建 ─────────────────────────────────────────── */
  { id: 'pagefly', name: 'PageFly 落地页', vendor: 'PageFly', category: '页面搭建', confidence: 'high',
    patterns: ['pagefly\\.io', 'pagefly-'], url: 'https://pagefly.io' },
  { id: 'gempages', name: 'GemPages 落地页', vendor: 'GemPages', category: '页面搭建', confidence: 'high',
    patterns: ['gempages\\.net', 'gempages-'], url: 'https://gempages.net' },
  { id: 'shogun', name: 'Shogun 落地页', vendor: 'Shogun', category: '页面搭建', confidence: 'high',
    patterns: ['getshogun\\.com', 'shogun-'], url: 'https://getshogun.com' },
  { id: 'replo', name: 'Replo 落地页', vendor: 'Replo', category: '页面搭建', confidence: 'high',
    patterns: ['replo\\.io', 'replo-'], url: 'https://replo.io' },
  { id: 'zipify', name: 'Zipify Pages / OCU', vendor: 'Zipify', category: '页面搭建', confidence: 'medium',
    patterns: ['zipify\\.com', 'zipify-'], url: 'https://zipify.com' },

  /* ── 加购追加 ─────────────────────────────────────────── */
  { id: 'rebuy', name: 'Rebuy 个性化推荐', vendor: 'Rebuy', category: '加购追加', confidence: 'high',
    patterns: ['rebuyengine\\.com', 'rebuy-'], url: 'https://rebuyengine.com' },
  { id: 'reconvert', name: 'ReConvert 加购页', vendor: 'ReConvert', category: '加购追加', confidence: 'high',
    patterns: ['reconvert\\.io', 'reconvert-'], url: 'https://reconvert.io' },
  { id: 'essentialapps', name: 'Essential Apps 追加销售', vendor: 'Essential Apps', category: '加购追加', confidence: 'medium',
    patterns: ['essential-apps\\.com', 'essentialapps'], url: 'https://essential-apps.com' },
  { id: 'vitals', name: 'Vitals 42合1', vendor: 'Vitals', category: '加购追加', confidence: 'high',
    patterns: ['vitals\\.co', 'vitals-'], url: 'https://vitals.co' },
  { id: 'frequentlybought', name: '常一起买 Bundle', vendor: 'FBT', category: '加购追加', confidence: 'medium',
    patterns: ['frequently-bought-together', 'fbt-widget'], url: '' },
  { id: 'kaching', name: 'Kaching 捆绑', vendor: 'Kaching', category: '加购追加', confidence: 'medium',
    patterns: ['kachingbundles', 'kaching-'], url: 'https://kachingappz.com' },

  /* ── 紧迫感 ───────────────────────────────────────────── */
  { id: 'hurrify', name: 'Hurrify 倒计时', vendor: 'Hurrify', category: '紧迫感', confidence: 'high',
    patterns: ['hurrify\\.com', 'hurrify-'], url: 'https://hurrify.com' },
  { id: 'salespop', name: 'Sales Pop 实时成交', vendor: 'Sales Pop', category: '紧迫感', confidence: 'high',
    patterns: ['salespop', 'sales-pop'], url: '' },
  { id: 'nudgify', name: 'Nudgify 社交证明', vendor: 'Nudgify', category: '紧迫感', confidence: 'medium',
    patterns: ['nudgify\\.com', 'nudgify-'], url: 'https://nudgify.com' },
  { id: 'fomo', name: 'Fomo 社交证明', vendor: 'Fomo', category: '紧迫感', confidence: 'medium',
    patterns: ['fomo\\.com', 'fomo-'], url: 'https://fomo.com' },
  { id: 'provesource', name: 'ProveSource', vendor: 'ProveSource', category: '紧迫感', confidence: 'medium',
    patterns: ['provesrc\\.com', 'provesource'], url: 'https://provesource.com' },
  { id: 'scarcity', name: '库存紧迫感组件', vendor: '—', category: '紧迫感', confidence: 'low',
    patterns: ['scarcity', 'stock-?countdown', 'low-?stock'], url: '' },

  /* ── 客服聊天 ─────────────────────────────────────────── */
  { id: 'gorgias', name: 'Gorgias 客服', vendor: 'Gorgias', category: '客服聊天', confidence: 'high',
    patterns: ['gorgias\\.(chat|com)', 'gorgias-'], url: 'https://gorgias.com' },
  { id: 'tidio', name: 'Tidio 在线客服', vendor: 'Tidio', category: '客服聊天', confidence: 'high',
    patterns: ['tidio\\.co', 'tidio-'], url: 'https://tidio.com' },
  { id: 'zendesk', name: 'Zendesk 客服', vendor: 'Zendesk', category: '客服聊天', confidence: 'high',
    // 不要用 `zE\(`：压缩后的 JS 里任何函数调用都可能撞上它。实测在 kuura.co 上
    // 命中了 `Object.freeze(w[L][y]),function(t,e,n,w,h` 这种无关片段。
    // Zendesk Widget 一定会定义 window.zE，用全局变量判定才可靠。
    patterns: ['zdassets\\.com', 'zendesk\\.com', 'zEmbed'], globals: ['zE'], url: 'https://zendesk.com' },
  { id: 'intercom', name: 'Intercom', vendor: 'Intercom', category: '客服聊天', confidence: 'high',
    patterns: ['intercom\\.(io|com)', 'intercomSettings'], url: 'https://intercom.com' },
  { id: 'tawk', name: 'Tawk.to 免费客服', vendor: 'Tawk.to', category: '客服聊天', confidence: 'high',
    patterns: ['tawk\\.to', 'tawkto'], url: 'https://tawk.to' },
  { id: 'crisp', name: 'Crisp 客服', vendor: 'Crisp', category: '客服聊天', confidence: 'medium',
    patterns: ['crisp\\.chat', 'CRISP_WEBSITE_ID'], url: 'https://crisp.chat' },
  { id: 'shopify_inbox', name: 'Shopify Inbox', vendor: 'Shopify', category: '客服聊天', confidence: 'high',
    patterns: ['shopify-chat', 'shopifyChat', 'inbox\\.shopify'], url: 'https://shopify.com' },
  { id: 'limechat', name: 'LimeChat', vendor: 'LimeChat', category: '客服聊天', confidence: 'medium',
    patterns: ['limechat\\.ai', 'limechat-'], url: 'https://limechat.ai' },

  /* ── 物流追踪 ─────────────────────────────────────────── */
  { id: 'aftership', name: 'AfterShip 物流', vendor: 'AfterShip', category: '物流追踪', confidence: 'high',
    patterns: ['aftership\\.com', 'aftership-'], url: 'https://aftership.com' },
  { id: '17track', name: '17TRACK 追踪', vendor: '17TRACK', category: '物流追踪', confidence: 'high',
    patterns: ['17track\\.net', '17track-'], url: 'https://17track.net' },
  { id: 'route', name: 'Route 运费险', vendor: 'Route', category: '物流追踪', confidence: 'high',
    patterns: ['\\broute\\.com', 'route-insurance'], url: 'https://route.com' },
  { id: 'parcellab', name: 'parcelLab', vendor: 'parcelLab', category: '物流追踪', confidence: 'medium',
    patterns: ['parcellab\\.com', 'parcellab-'], url: 'https://parcellab.com' },
  { id: 'shippo', name: 'Shippo 运费', vendor: 'Shippo', category: '物流追踪', confidence: 'medium',
    patterns: ['goshippo\\.com'], url: 'https://goshippo.com' },

  /* ── 代发供应链 ───────────────────────────────────────── */
  { id: 'dsers', name: 'DSers 代发', vendor: 'DSers', category: '代发供应链', confidence: 'high',
    patterns: ['dsers\\.com', 'dsers-'], url: 'https://dsers.com' },
  { id: 'zendrop', name: 'Zendrop 代发', vendor: 'Zendrop', category: '代发供应链', confidence: 'high',
    patterns: ['zendrop\\.com', 'zendrop-'], url: 'https://zendrop.com' },
  { id: 'spocket', name: 'Spocket 代发', vendor: 'Spocket', category: '代发供应链', confidence: 'medium',
    patterns: ['spocket\\.co', 'spocket-'], url: 'https://spocket.co' },
  { id: 'cjdropshipping', name: 'CJ Dropshipping', vendor: 'CJ', category: '代发供应链', confidence: 'high',
    patterns: ['cjdropshipping\\.com', 'cjdropshipping-'], url: 'https://cjdropshipping.com' },
  { id: 'aliexpress', name: 'AliExpress 一件代发', vendor: 'AliExpress', category: '代发供应链', confidence: 'medium',
    patterns: ['aliexpress\\.com', 'alidropship'], url: 'https://aliexpress.com' },
  { id: 'oberlo', name: 'Oberlo（已停运）', vendor: 'Shopify', category: '代发供应链', confidence: 'medium',
    patterns: ['oberlo\\.com', 'oberlo-'], url: '' },

  /* ── 按需打印 ─────────────────────────────────────────── */
  { id: 'printful', name: 'Printful 按需打印', vendor: 'Printful', category: '按需打印', confidence: 'high',
    patterns: ['printful\\.com', 'printful-'], url: 'https://printful.com' },
  { id: 'printify', name: 'Printify 按需打印', vendor: 'Printify', category: '按需打印', confidence: 'high',
    patterns: ['printify\\.com', 'printify-'], url: 'https://printify.com' },
  { id: 'gelato', name: 'Gelato 按需打印', vendor: 'Gelato', category: '按需打印', confidence: 'medium',
    patterns: ['gelato\\.com', 'gelato-'], url: 'https://gelato.com' },

  /* ── 支付分期 ─────────────────────────────────────────── */
  { id: 'klarna', name: 'Klarna 分期', vendor: 'Klarna', category: '支付分期', confidence: 'high',
    patterns: ['klarna\\.com', 'klarna-', 'KlarnaOnSiteMessaging'], url: 'https://klarna.com' },
  { id: 'afterpay', name: 'Afterpay / Clearpay', vendor: 'Block', category: '支付分期', confidence: 'high',
    patterns: ['afterpay\\.com', 'afterpay-', 'clearpay'], url: 'https://afterpay.com' },
  { id: 'affirm', name: 'Affirm 分期', vendor: 'Affirm', category: '支付分期', confidence: 'high',
    patterns: ['affirm\\.com', 'affirm-'], url: 'https://affirm.com' },
  { id: 'sezzle', name: 'Sezzle 分期', vendor: 'Sezzle', category: '支付分期', confidence: 'medium',
    patterns: ['sezzle\\.com', 'sezzle-'], url: 'https://sezzle.com' },
  { id: 'shop_pay', name: 'Shop Pay 加速结账', vendor: 'Shopify', category: '支付分期', confidence: 'high',
    patterns: ['shop\\.app', 'shop-pay', 'ShopPay'], url: 'https://shop.app' },
  { id: 'paypal', name: 'PayPal 智能按钮', vendor: 'PayPal', category: '支付分期', confidence: 'high',
    patterns: ['paypalobjects\\.com', 'paypal\\.com/sdk'], url: 'https://paypal.com' },
  { id: 'stripe', name: 'Stripe 支付', vendor: 'Stripe', category: '支付分期', confidence: 'medium',
    patterns: ['js\\.stripe\\.com'], url: 'https://stripe.com' },

  /* ── 合规 Cookie ──────────────────────────────────────── */
  { id: 'onetrust', name: 'OneTrust Cookie 同意', vendor: 'OneTrust', category: '合规Cookie', confidence: 'high',
    patterns: ['onetrust\\.com', 'OptanonConsent'], url: 'https://onetrust.com' },
  { id: 'cookieyes', name: 'CookieYes', vendor: 'CookieYes', category: '合规Cookie', confidence: 'high',
    // 不要用 `cky-`：它会命中 CSS 自定义属性 `--sticky-header-height`（"sti|cky-|header"）。
    // 实测在 kuura.co 上造成 CookieYes 假阳性。
    patterns: ['cookieyes\\.com', 'cky-consent', 'cky-btn', 'cky-banner'], url: 'https://cookieyes.com' },
  { id: 'pandectes', name: 'Pandectes GDPR', vendor: 'Pandectes', category: '合规Cookie', confidence: 'high',
    patterns: ['pandectes\\.com', 'pandectes-'], url: 'https://pandectes.com' },
  { id: 'iubenda', name: 'Iubenda 合规', vendor: 'Iubenda', category: '合规Cookie', confidence: 'medium',
    patterns: ['iubenda\\.com'], url: 'https://iubenda.com' },
  { id: 'termly', name: 'Termly 合规', vendor: 'Termly', category: '合规Cookie', confidence: 'medium',
    patterns: ['termly\\.io'], url: 'https://termly.io' },

  /* ── 分析回放 ─────────────────────────────────────────── */
  { id: 'hotjar', name: 'Hotjar 会话回放', vendor: 'Hotjar', category: '分析回放', confidence: 'high',
    patterns: ['static\\.hotjar\\.com', 'hotjar\\.com/settings'], url: 'https://hotjar.com' },
  { id: 'clarity', name: 'Microsoft Clarity', vendor: 'Microsoft', category: '分析回放', confidence: 'high',
    patterns: ['clarity\\.ms/tag', 'clarity\\.ms/s/'], url: 'https://clarity.microsoft.com' },
  { id: 'luckyorange', name: 'Lucky Orange 回放', vendor: 'Lucky Orange', category: '分析回放', confidence: 'medium',
    patterns: ['luckyorange\\.com', 'luckyorange\\.net'], url: 'https://luckyorange.com' },
  { id: 'mouseflow', name: 'Mouseflow 回放', vendor: 'Mouseflow', category: '分析回放', confidence: 'medium',
    patterns: ['mouseflow\\.com'], url: 'https://mouseflow.com' },
  { id: 'triplewhale', name: 'Triple Whale 归因', vendor: 'Triple Whale', category: '分析回放', confidence: 'high',
    patterns: ['triplewhale\\.com', 'triple-whale'], url: 'https://triplewhale.com' },
  { id: 'segment', name: 'Segment 数据管道', vendor: 'Twilio', category: '分析回放', confidence: 'medium',
    patterns: ['cdn\\.segment\\.com/analytics'], url: 'https://segment.com' },
  { id: 'lifetimely', name: 'Lifetimely 利润分析', vendor: 'Lifetimely', category: '分析回放', confidence: 'medium',
    patterns: ['lifetimely\\.io', 'lifetimely-'], url: 'https://lifetimely.io' },
  { id: 'beprofit', name: 'BeProfit 利润分析', vendor: 'BeProfit', category: '分析回放', confidence: 'medium',
    patterns: ['beprofit\\.co', 'beprofit-'], url: 'https://beprofit.co' },

  /* ── 转化优化 ─────────────────────────────────────────── */
  { id: 'shopify_web_pixels', name: 'Shopify 自定义像素', vendor: 'Shopify', category: '转化优化', confidence: 'high',
    patterns: ['web-pixels-manager', 'webPixelsManager', 'shopifycloud/web-pixels'], url: 'https://shopify.com' },
  { id: 'vwo', name: 'VWO A/B 测试', vendor: 'Wingify', category: '转化优化', confidence: 'medium',
    patterns: ['visualwebsiteoptimizer\\.com', 'vwo\\.com'], url: 'https://vwo.com' },
  { id: 'optimizely', name: 'Optimizely 实验', vendor: 'Optimizely', category: '转化优化', confidence: 'medium',
    patterns: ['optimizely\\.com'], url: 'https://optimizely.com' },
  { id: 'convert', name: 'Convert.com 实验', vendor: 'Convert', category: '转化优化', confidence: 'low',
    patterns: ['convertexperiments\\.com'], url: 'https://convert.com' },

  /* ── 多语言货币 ───────────────────────────────────────── */
  { id: 'weglot', name: 'Weglot 多语言', vendor: 'Weglot', category: '多语言货币', confidence: 'high',
    patterns: ['weglot\\.com', 'weglot-'], url: 'https://weglot.com' },
  { id: 'langify', name: 'Langify 多语言', vendor: 'Langify', category: '多语言货币', confidence: 'medium',
    patterns: ['langify\\.(com|app)', 'langify-'], url: 'https://langify.com' },
  { id: 'transcy', name: 'Transcy 多语言', vendor: 'Transcy', category: '多语言货币', confidence: 'medium',
    patterns: ['transcy\\.io', 'transcy-'], url: 'https://transcy.io' },
  { id: 'shopify_markets', name: 'Shopify Markets 多市场', vendor: 'Shopify', category: '多语言货币', confidence: 'high',
    patterns: ['shopify-market', 'market-selector', 'shopify-section-localization'], url: 'https://shopify.com' },

  /* ── 尺码个性化 ───────────────────────────────────────── */
  { id: 'kiwi', name: 'Kiwi Size Chart 尺码表', vendor: 'Kiwi', category: '尺码个性化', confidence: 'high',
    patterns: ['kiwisizing', 'kiwi-size'], url: 'https://kiwisizing.com' },
  { id: 'sizely', name: 'Sizely 尺码推荐', vendor: 'Sizely', category: '尺码个性化', confidence: 'medium',
    patterns: ['sizely\\.com', 'sizely-'], url: 'https://sizely.com' },
  { id: 'productpersonalizer', name: '产品定制器', vendor: '—', category: '尺码个性化', confidence: 'medium',
    patterns: ['product-personalizer', 'productpersonalizer'], url: '' },

  /* ── 预约到店 ─────────────────────────────────────────── */
  { id: 'zapiet', name: 'Zapiet 到店自提', vendor: 'Zapiet', category: '预约到店', confidence: 'medium',
    patterns: ['zapiet\\.com', 'zapiet-'], url: 'https://zapiet.com' },
  { id: 'booking', name: '预约排程组件', vendor: '—', category: '预约到店', confidence: 'low',
    patterns: ['booking-?widget', 'appointment-?scheduling'], url: '' },

  /* ── 批发 B2B ─────────────────────────────────────────── */
  { id: 'wholesale', name: 'B2B 批发定价', vendor: '—', category: '批发B2B', confidence: 'low',
    patterns: ['wholesale-?pricing', 'b2b-?wholesale', 'wholesaleclub'], url: '' },
  { id: 'sparklayer', name: 'SparkLayer B2B', vendor: 'SparkLayer', category: '批发B2B', confidence: 'medium',
    patterns: ['sparklayer\\.io', 'sparklayer-'], url: 'https://sparklayer.io' },

  /* ── 反欺诈风控 ───────────────────────────────────────── */
  { id: 'signifyd', name: 'Signifyd 反欺诈', vendor: 'Signifyd', category: '反欺诈风控', confidence: 'medium',
    patterns: ['signifyd\\.com', 'signifyd-'], url: 'https://signifyd.com' },
  { id: 'nocaptcha', name: '验证码 / 人机校验', vendor: '—', category: '反欺诈风控', confidence: 'medium',
    patterns: ['hcaptcha\\.com', 'recaptcha/api\\.js', 'turnstile'], url: '' }
];

/**
 * 追踪像素指纹。
 * kind 区分「广告像素 / 分析 / 营销自动化」，因为三者对选品的含义不同。
 */
export const PIXEL_SIGNATURES = [
  { id: 'meta_pixel', name: 'Meta 像素 (Facebook/Instagram)', kind: '广告像素', platform: 'Meta',
    patterns: ['connect\\.facebook\\.net', 'fbevents\\.js'], globals: ['fbq', '_fbq'], confidence: 'high' },
  { id: 'tiktok_pixel', name: 'TikTok 像素', kind: '广告像素', platform: 'TikTok',
    patterns: ['analytics\\.tiktok\\.com', 'tiktok.*pixel'], globals: ['ttq'], confidence: 'high' },
  { id: 'google_ga4', name: 'Google Analytics 4', kind: '分析', platform: 'Google',
    patterns: ['googletagmanager\\.com/gtag/js', 'google-analytics\\.com'], globals: ['gtag'], confidence: 'high' },
  { id: 'google_gtm', name: 'Google Tag Manager', kind: '分析', platform: 'Google',
    patterns: ['googletagmanager\\.com/gtm\\.js'], globals: [], confidence: 'high' },
  { id: 'google_ads', name: 'Google Ads 转化', kind: '广告像素', platform: 'Google',
    patterns: ['googleadservices\\.com', 'google_conversion_id', 'googleadservices'], confidence: 'medium' },
  { id: 'snap_pixel', name: 'Snapchat 像素', kind: '广告像素', platform: 'Snapchat',
    patterns: ['sc-static\\.net/scevent', 'snaptr'], globals: ['snaptr'], confidence: 'high' },
  { id: 'pinterest_tag', name: 'Pinterest Tag', kind: '广告像素', platform: 'Pinterest',
    patterns: ['ct\\.pinterest\\.com', 'pinimg\\.com/ct'], globals: ['pintrk'], confidence: 'high' },
  { id: 'twitter_pixel', name: 'X / Twitter 像素', kind: '广告像素', platform: 'X',
    patterns: ['static\\.ads-twitter\\.com', 'twq'], globals: ['twq'], confidence: 'high' },
  { id: 'reddit_pixel', name: 'Reddit 像素', kind: '广告像素', platform: 'Reddit',
    patterns: ['redditstatic\\.com/ads/pixel', 'rdt\\('], globals: ['rdt'], confidence: 'high' },
  { id: 'bing_uet', name: 'Microsoft Ads (Bing UET)', kind: '广告像素', platform: 'Microsoft',
    patterns: ['bat\\.bing\\.com', 'uetq'], globals: ['uetq'], confidence: 'high' },
  { id: 'linkedin_insight', name: 'LinkedIn Insight Tag', kind: '广告像素', platform: 'LinkedIn',
    patterns: ['snap\\.licdn\\.com', '_linkedin_partner_id'], confidence: 'high' },
  { id: 'klaviyo_pixel', name: 'Klaviyo 追踪', kind: '营销自动化', platform: 'Klaviyo',
    patterns: ['static\\.klaviyo\\.com/onsite'], globals: ['_learnq'], confidence: 'high' },
  { id: 'yandex_metrica', name: 'Yandex Metrica', kind: '分析', platform: 'Yandex',
    patterns: ['mc\\.yandex\\.ru/metrika', 'ym\\('], confidence: 'high' },
  { id: 'hotjar_pixel', name: 'Hotjar 追踪', kind: '分析', platform: 'Hotjar',
    patterns: ['static\\.hotjar\\.com'], globals: ['hj'], confidence: 'high' },
  { id: 'clarity_pixel', name: 'Microsoft Clarity', kind: '分析', platform: 'Microsoft',
    patterns: ['clarity\\.ms/tag'], globals: ['clarity'], confidence: 'high' },
  { id: 'segment_pixel', name: 'Segment', kind: '分析', platform: 'Twilio',
    patterns: ['cdn\\.segment\\.com/analytics'], globals: ['analytics'], confidence: 'medium' },
  { id: 'triplewhale_pixel', name: 'Triple Whale', kind: '分析', platform: 'Triple Whale',
    patterns: ['triplewhale'], globals: ['twq'], confidence: 'medium' },
  { id: 'posthog', name: 'PostHog', kind: '分析', platform: 'PostHog',
    patterns: ['posthog\\.com', 'posthog\\.init'], globals: ['posthog'], confidence: 'medium' },
  { id: 'mixpanel', name: 'Mixpanel', kind: '分析', platform: 'Mixpanel',
    patterns: ['cdn\\.mxpnl\\.com', 'mixpanel'], globals: ['mixpanel'], confidence: 'medium' },
  { id: 'amplitude', name: 'Amplitude', kind: '分析', platform: 'Amplitude',
    patterns: ['cdn\\.amplitude\\.com'], globals: ['amplitude'], confidence: 'medium' },
  { id: 'shopify_pixel', name: 'Shopify 原生 Web Pixels', kind: '分析', platform: 'Shopify',
    patterns: ['web-pixels-manager'], globals: ['Shopify'], confidence: 'high' },
  { id: 'pinterest_capi', name: '服务端转化 API 迹象', kind: '广告像素', platform: '—',
    // 不要用 `capi-`：实测命中了 `data-facebook-capi-enabled="false"` —— 属性字面
    // 意思是「未启用」，却被判成已启用。凡是指纹可能出现在「=false」这种否定语境里的，
    // 都不能用短前缀匹配。
    patterns: ['conversions-?api', 'server-?side-?tracking'], confidence: 'low' }
];

/**
 * 主题参考库。
 * 官方主题（Shopify 免费）与主流第三方付费主题，用于把 Shopify.theme.name
 * 映射成「厂商 / 免费付费 / 类型」，并判断是否属于官方目录主题。
 * 注意：这是内置参考数据（非实时），仅用于归类，不联网校验。
 */
export const THEME_CATALOG = [
  // Shopify 官方免费主题
  { name: 'Dawn', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Refresh', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Craft', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Sense', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Taste', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Studio', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Colorblock', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Ride', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Publisher', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Origin', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Spotlight', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Bulk', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Trade', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Vision', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Crave', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Highlight', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Be Yours', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  { name: 'Essential', vendor: 'Shopify', price: '免费', kind: 'OS 2.0', official: true },
  // 经典官方主题（旧版）
  { name: 'Debut', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Minimal', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Brooklyn', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Boundless', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Supply', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Venture', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Narrative', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Simple', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Pop', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  { name: 'Jumpstart', vendor: 'Shopify', price: '免费', kind: 'Vintage', official: true },
  // 第三方付费主流
  { name: 'Impulse', vendor: 'Archetype Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Motion', vendor: 'Archetype Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Streamline', vendor: 'Archetype Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Expanse', vendor: 'Archetype Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Broadcast', vendor: 'Archetype Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Prestige', vendor: 'Maestrooo', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Impact', vendor: 'Maestrooo', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Focal', vendor: 'Maestrooo', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Flex', vendor: 'Out of the Sandbox', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Palo Alto', vendor: 'Out of the Sandbox', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Symmetry', vendor: 'Out of the Sandbox', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Empire', vendor: 'Pixel Union', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Envy', vendor: 'Pixel Union', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Local', vendor: 'Pixel Union', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Warehouse', vendor: 'Pixel Union', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Startup', vendor: 'Pixel Union', price: '付费', kind: 'Vintage', official: false },
  { name: 'Icon', vendor: 'Pixel Union', price: '付费', kind: 'Vintage', official: false },
  { name: 'Grid', vendor: 'Pixel Union', price: '付费', kind: 'Vintage', official: false },
  { name: 'Blockshop', vendor: 'Troop Themes', price: '付费', kind: 'Vintage', official: false },
  { name: 'Kingdom', vendor: 'Troop Themes', price: '付费', kind: 'Vintage', official: false },
  { name: 'Testament', vendor: 'Troop Themes', price: '付费', kind: 'Vintage', official: false },
  { name: 'District', vendor: 'Troop Themes', price: '付费', kind: 'Vintage', official: false },
  { name: 'Baseline', vendor: 'Troop Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Ella', vendor: 'Halo Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Shella', vendor: 'Halo Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Flo', vendor: 'Halo Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Unsen', vendor: 'Halo Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Porto', vendor: 'Halo Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Shoptimized', vendor: 'Shoptimized', price: '付费', kind: '转化优化', official: false },
  { name: 'Electro', vendor: 'Roar Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Digital', vendor: 'Roar Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Nova', vendor: 'Roar Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Spark', vendor: 'Roar Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Modular', vendor: 'Fuel Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Atelier', vendor: 'Fuel Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Aura', vendor: 'Fuel Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Layer', vendor: 'Fuel Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Maker', vendor: 'Fuel Themes', price: '付费', kind: 'OS 2.0', official: false },
  { name: 'Sleek', vendor: 'Fuel Themes', price: '付费', kind: 'OS 2.0', official: false }
];

/**
 * 「基于某底座主题二次开发」的资产特征。
 * 主题作者 fork 官方主题后，asset 文件名常常沿用底座主题名，可据此推测血缘。
 *
 * ⚠️ 这些正则只在 script[src] / link[href] 两类资源 URL 上匹配，不扫页面 HTML
 * （见 lib/detect.js 的 detectDerivation）。因此这里必须要求「主题名 + 资源扩展名」
 * 的组合，否则 `flex-`、`grid-`、`local-` 这类普通英文词会被 CSS 类名误命中。
 */
export const THEME_DERIVATION_HINTS = [
  { base: 'Dawn', patterns: ['/assets/dawn[.-]', 'dawn(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Debut', patterns: ['/assets/debut[.-]', 'debut(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Impulse', patterns: ['/assets/impulse[.-]', 'impulse(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Flex', patterns: ['/assets/flex[.-]', 'flex(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Empire', patterns: ['/assets/empire[.-]', 'empire(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Brooklyn', patterns: ['/assets/brooklyn[.-]', 'brooklyn(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Motion', patterns: ['/assets/motion[.-]', 'motion(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Refresh', patterns: ['/assets/refresh[.-]', 'refresh(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Craft', patterns: ['/assets/craft[.-]', 'craft(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Prestige', patterns: ['/assets/prestige[.-]', 'prestige(?:\\.min)?\\.(?:js|css)'] },
  { base: 'Expanse', patterns: ['/assets/expanse[.-]', 'expanse(?:\\.min)?\\.(?:js|css)'] }
];

/** 需要探测的 window 全局变量名（用于全局式应用/像素识别） */
export const PROBED_GLOBALS = [
  'Shopify', 'ShopifyAnalytics', 'trekkie', 'monorail',
  'fbq', '_fbq', 'ttq', 'snaptr', 'twq', 'pintrk', 'rdt', 'uetq',
  'gtag', 'dataLayer', 'ga', '_gaq', 'gaGlobal',
  '_learnq', 'klaviyo', 'omnisend', 'hj', 'clarity', 'posthog', 'mixpanel',
  'amplitude', 'analytics', 'intercomSettings', 'Intercom', 'zE', 'tawkTo',
  'Rebuy', 'Nosto', 'algoliasearch', 'Klevu', 'smile', 'swell',
  'looxReviews', 'yotpo', 'stampedFn', 'okendo', 'JudgeMe', 'jdgm',
  'recharge', 'ReCharge', 'BOLD', 'gorgias', 'tidioChatApi',
  'ShopifyChat', 'webPixelsManager', 'BOOMR', 'Sentry', 'Swiper', 'jQuery',
  'Stamped', 'growave', 'privy', 'justuno', 'wisepops'
];
