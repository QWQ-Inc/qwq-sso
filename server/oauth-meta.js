/**
 * 三方登录平台元数据（oauth.js 与 api.js 共用，避免两处漂移）
 *
 *   fields   —— 该平台全部凭证字段（键名 = 对应环境变量名，也是实例 config JSON 的键名）
 *   primary  —— 判定「是否已配置」的必填字段
 *   secret   —— 敏感字段（管理端读取时打码、绝不下发给登录页）
 *   qr       —— 登录页扫码所需的「公开」字段映射（仅微信/企业微信；非敏感，可给前端）
 *   label    —— 平台中文名
 */
const PLATFORMS = {
  wechat: {
    label: '微信公众号',
    fields: ['WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'WECHAT_REDIRECT_URI'],
    primary: 'WECHAT_APP_ID', secret: ['WECHAT_APP_SECRET'],
    qr: { appid: 'WECHAT_APP_ID', redirect: 'WECHAT_REDIRECT_URI' },
  },
  wecom: {
    label: '企业微信',
    fields: ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_APP_SECRET', 'WECOM_REDIRECT_URI'],
    primary: 'WECOM_CORP_ID', secret: ['WECOM_APP_SECRET'],
    qr: { appid: 'WECOM_CORP_ID', agentid: 'WECOM_AGENT_ID', redirect: 'WECOM_REDIRECT_URI' },
  },
  feishu: {
    label: '飞书',
    fields: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_REDIRECT_URI'],
    primary: 'FEISHU_APP_ID', secret: ['FEISHU_APP_SECRET'],
  },
  dingtalk: {
    label: '钉钉',
    fields: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_REDIRECT_URI'],
    primary: 'DINGTALK_CLIENT_ID', secret: ['DINGTALK_CLIENT_SECRET'],
  },
  douyin: {
    label: '抖音',
    fields: ['DOUYIN_CLIENT_KEY', 'DOUYIN_CLIENT_SECRET', 'DOUYIN_REDIRECT_URI'],
    primary: 'DOUYIN_CLIENT_KEY', secret: ['DOUYIN_CLIENT_SECRET'],
  },
  kuaishou: {
    label: '快手',
    fields: ['KUAISHOU_APP_ID', 'KUAISHOU_APP_SECRET', 'KUAISHOU_REDIRECT_URI'],
    primary: 'KUAISHOU_APP_ID', secret: ['KUAISHOU_APP_SECRET'],
  },
  xiaohongshu: {
    label: '小红书',
    fields: ['XHS_APP_ID', 'XHS_APP_SECRET', 'XHS_REDIRECT_URI'],
    primary: 'XHS_APP_ID', secret: ['XHS_APP_SECRET'],
  },
  bilibili: {
    label: 'Bilibili',
    fields: ['BILIBILI_CLIENT_ID', 'BILIBILI_CLIENT_SECRET', 'BILIBILI_REDIRECT_URI'],
    primary: 'BILIBILI_CLIENT_ID', secret: ['BILIBILI_CLIENT_SECRET'],
  },
  google: {
    label: 'Google',
    fields: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
    primary: 'GOOGLE_CLIENT_ID', secret: ['GOOGLE_CLIENT_SECRET'],
  },
  apple: {
    label: 'Apple',
    fields: ['APPLE_CLIENT_ID', 'APPLE_REDIRECT_URI'],
    primary: 'APPLE_CLIENT_ID', secret: [],
  },
  github: {
    label: 'GitHub',
    fields: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    primary: 'GITHUB_CLIENT_ID', secret: ['GITHUB_CLIENT_SECRET'],
  },
  microsoft: {
    label: 'Microsoft',
    fields: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT'],
    primary: 'MICROSOFT_CLIENT_ID', secret: ['MICROSOFT_CLIENT_SECRET'],
  },
  qq: {
    label: 'QQ',
    fields: ['QQ_APP_ID', 'QQ_APP_SECRET'],
    primary: 'QQ_APP_ID', secret: ['QQ_APP_SECRET'],
  },
};

module.exports = { PLATFORMS };
