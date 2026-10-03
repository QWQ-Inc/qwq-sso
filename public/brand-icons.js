/**
 * 三方登录平台品牌图标（全彩 SVG，设计为放在白色/浅色圆角底片上）。
 * login.html 与 dashboard.html 共用这一份，避免两处图标不一致。
 * 用法：BRAND_ICONS[key] 返回一段 <svg> 字符串。
 * 说明：这些是可辨识的品牌重绘版；如需完全一致的官方矢量，替换对应键的 SVG 即可。
 */
(function (g) {
  const I = {
    // 微信：绿色双气泡
    wechat: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="微信">
      <path d="M9.4 3C5.1 3 1.6 5.98 1.6 9.66c0 2.1 1.17 3.97 3 5.2l-.62 2.02 2.36-1.24c.86.28 1.72.42 2.5.42.2 0 .4-.01.6-.02a5.6 5.6 0 0 1-.22-1.55c0-3.4 3.28-6.06 7.06-6.06.28 0 .55.02.82.05C16.63 5.35 13.4 3 9.4 3z" fill="#1AAD19"/>
      <circle cx="6.5" cy="8.3" r=".98" fill="#fff"/><circle cx="11.2" cy="8.3" r=".98" fill="#fff"/>
      <path d="M22.4 15.06c0-2.86-2.78-5.18-6.2-5.18s-6.2 2.32-6.2 5.18 2.78 5.18 6.2 5.18c.78 0 1.52-.12 2.2-.34l2.06 1.06-.58-1.9c1.6-.99 2.52-2.43 2.52-4z" fill="#1AAD19"/>
      <circle cx="14.1" cy="14.3" r=".82" fill="#fff"/><circle cx="18.2" cy="14.3" r=".82" fill="#fff"/>
    </svg>`,

    // 企业微信：蓝色圆角 + 白色双人（企业/通讯录）
    wecom: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="企业微信">
      <rect x="2" y="2.5" width="20" height="19" rx="6.5" fill="#2E77F0"/>
      <circle cx="9" cy="9.3" r="2.1" fill="#fff"/>
      <circle cx="15.4" cy="10.2" r="1.7" fill="#fff" opacity=".92"/>
      <path d="M4.7 17.2c0-2.4 1.9-3.9 4.3-3.9s4.3 1.5 4.3 3.9v.6H4.7v-.6z" fill="#fff"/>
      <path d="M14 13.6c2 0 3.7 1.2 3.7 3.2v1h-3.2v-1.6c0-1-.4-1.9-1.1-2.5.2-.06.4-.1.6-.1z" fill="#fff" opacity=".92"/>
    </svg>`,

    // 飞书 / Lark：蓝青渐变圆角 + 白色纸飞机
    feishu: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="飞书">
      <defs><linearGradient id="fs-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3370FF"/><stop offset="1" stop-color="#00D6B9"/></linearGradient></defs>
      <rect x="2" y="2.5" width="20" height="19" rx="6.5" fill="url(#fs-g)"/>
      <path d="M18 6.5 6 11.2l3.5 1.4 1.2 3.9 2-2.8 3.4 2.3z" fill="#fff"/>
      <path d="m9.5 12.6 6.3-4.2-4.5 5.1z" fill="#D6E6FF"/>
    </svg>`,

    // 钉钉：蓝色圆角 + 白色微笑聊天脸
    dingtalk: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="钉钉">
      <rect x="2" y="2.5" width="20" height="19" rx="6.5" fill="#1584F2"/>
      <path d="M12 6.2c3.5 0 6.2 2.2 6.2 5 0 2.3-1.8 4.2-4.4 4.8.15.5.5 1.3.9 1.9-1.5-.4-2.5-1-3-1.4-3.6-.15-6-2.3-6-5.3 0-2.8 2.8-5 6.3-5z" fill="#fff"/>
      <circle cx="9.7" cy="11" r=".95" fill="#1584F2"/><circle cx="14.3" cy="11" r=".95" fill="#1584F2"/>
      <path d="M9.6 13.1c.6.7 1.4 1.05 2.4 1.05s1.8-.35 2.4-1.05" fill="none" stroke="#1584F2" stroke-width="1.1" stroke-linecap="round"/>
    </svg>`,

    // 抖音：黑色音符 + 青/红偏移
    douyin: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="抖音">
      <g>
        <path d="M14.6 3h2.5c.2 1.9 1.6 3.5 3.5 3.7v2.6c-1.25 0-2.45-.4-3.4-1.05V15a4.9 4.9 0 1 1-2.9-4.48V3z" fill="#25F4EE" transform="translate(-1,-1)"/>
        <path d="M14.6 3h2.5c.2 1.9 1.6 3.5 3.5 3.7v2.6c-1.25 0-2.45-.4-3.4-1.05V15a4.9 4.9 0 1 1-2.9-4.48V3z" fill="#FE2C55" transform="translate(1,1)"/>
        <path d="M14.6 3h2.5c.2 1.9 1.6 3.5 3.5 3.7v2.6c-1.25 0-2.45-.4-3.4-1.05V15a4.9 4.9 0 1 1-2.9-4.48V3z" fill="#111"/>
      </g>
    </svg>`,

    // QQ：企鹅
    qq: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="QQ">
      <ellipse cx="12" cy="12.6" rx="7" ry="8" fill="#111"/>
      <ellipse cx="12" cy="14" rx="4.3" ry="5.6" fill="#fff"/>
      <circle cx="9.3" cy="9" r="1.9" fill="#fff"/><circle cx="14.7" cy="9" r="1.9" fill="#fff"/>
      <circle cx="9.6" cy="9.2" r=".78" fill="#111"/><circle cx="14.4" cy="9.2" r=".78" fill="#111"/>
      <path d="M10.6 11.2h2.8L12 12.8z" fill="#F5A623"/>
      <path d="M6.6 15.6c1.6 1.2 9.2 1.2 10.8 0 .55 1.7-.2 2.85-1 3.05-2.9.6-5.9.6-8.8 0-.8-.2-1.55-1.35-1-3.05z" fill="#E63A2E"/>
      <ellipse cx="9.5" cy="20.2" rx="1.6" ry=".8" fill="#F5A623"/><ellipse cx="14.5" cy="20.2" rx="1.6" ry=".8" fill="#F5A623"/>
    </svg>`,

    // Google：四色 G
    google: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="Google">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>`,

    // Apple：黑色苹果
    apple: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" fill="#111" aria-label="Apple">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
    </svg>`,

    // Microsoft：四色方块
    microsoft: `<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg" aria-label="Microsoft">
      <rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
    </svg>`,

    // GitHub：黑色 Octocat
    github: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" fill="#181717" aria-label="GitHub">
      <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.49.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.8c.85.004 1.7.115 2.5.337 1.9-1.29 2.74-1.02 2.74-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10.01 10.01 0 0 0 22 12c0-5.52-4.48-10-10-10z"/>
    </svg>`,

    // 快手：橙色
    kuaishou: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="快手">
      <rect x="2" y="3" width="20" height="18" rx="6" fill="#FF6A00"/>
      <circle cx="9" cy="12" r="3.4" fill="#fff"/>
      <path d="M14 8.6l4.4 3.4-4.4 3.4z" fill="#fff"/>
    </svg>`,

    // 小红书：红色
    xiaohongshu: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="小红书">
      <rect x="2" y="3" width="20" height="18" rx="6" fill="#FF2442"/>
      <text x="12" y="16.5" text-anchor="middle" font-size="11" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-weight="800" fill="#fff">书</text>
    </svg>`,

    // Bilibili：粉蓝电视
    bilibili: `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-label="Bilibili">
      <path d="M7.5 4.2l1.6 1.6h5.8l1.6-1.6c.4-.4 1-.4 1.4 0 .4.4.4 1 0 1.4l-.2.2H19a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8.8a3 3 0 0 1 3-3h.3l-.2-.2c-.4-.4-.4-1 0-1.4.4-.4 1-.4 1.4 0z" fill="#00AEEC"/>
      <circle cx="8.5" cy="12" r="1.1" fill="#fff"/><circle cx="15.5" cy="12" r="1.1" fill="#fff"/>
    </svg>`,
  };
  g.BRAND_ICONS = I;
})(typeof window !== 'undefined' ? window : this);
