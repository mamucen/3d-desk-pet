/**
 * 云服务公开配置。
 * 这里只包含面向前端的公开标识（endpoint / publishableKey / oauthRelayBaseUrl），
 * 全部来自云服务开通时返回的 publicConfig，不含任何服务端密钥。
 */
window.PUBLIC_CONFIG = {
  endpoint: 'https://info-keeper-21227.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_1d469n3KspVeYoD34ciZis_UoQw0aJ0fPo6SWqnD3mDhEWcAz1t0Rpa',
  // 发布地址（含分享码）。微信登录只允许从这里发起；本地预览时页面会给出指引。
  publishedUrl: 'https://info-keeper-21227.app.workbuddy.host/?sharecode=BRPXR3GO4G'
};
