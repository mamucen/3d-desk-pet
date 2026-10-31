/**
 * 云服务客户端初始化（全局唯一实例）。
 * Auth / Database / LLM 共用同一个 cloud 实例，登录后会话会被自动附加到数据库请求上。
 */
(function () {
  'use strict';

  if (window.__sdkLoadError || !window.WorkBuddyCloud ||
      typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
    window.__cloudInitError = '云服务组件加载失败，请检查网络连接后刷新页面重试。';
    return;
  }

  var cfg = window.PUBLIC_CONFIG || {};

  window.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
    publishableKey: cfg.publishableKey
  });
})();
