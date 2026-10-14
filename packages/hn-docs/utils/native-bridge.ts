interface TCefSharp {
  BindObjectAsync: Function;
}

interface TJavascriptBinding {
  isFromClient: Function;
  close: Function;
  switchToMarket: Function;
  watchAppDetail: Function;
  watchWorkOrder: Function;
  showRenewalDialog: Function;
  clearUnreadMessage: Function;
  showUserApprovalDialog: Function;
  switchToDevelopAppList: Function;
  /* 5.5.7新增 */
  getClientCode: Function;
  /* 5.5.7新增 */
  getAppOfficalGroupUUID: Function;
  // 工单学习中心未读消息数获取
  getUnreadMessageCount: Function;
  getToken?: Function;
  showFeedback?: Function;
  goToCommunity?: Function;
  openOnlineSupport?: Function;
  watchVideo?: Function;
  isHybridCloud?: Function;
  clientVersion?: Function;
  getFileKey?: Function;
  getUnreadTicketMessageCount?: Function;
}

interface JavascriptBoundObject {
  getVersion: Function;
}

declare global {
  interface Window {
    CefSharp: TCefSharp;
    javascriptBinding: TJavascriptBinding;
    JavascriptBoundObject: JavascriptBoundObject;
  }
}

let nativeBridge: TJavascriptBinding;

export async function init() {
  if (nativeBridge) return { success: true, javascriptBinding: nativeBridge };
  if (window.CefSharp) {
    await window.CefSharp.BindObjectAsync("javascriptBinding");
    nativeBridge = window.javascriptBinding;
    return { success: !!nativeBridge, javascriptBinding: nativeBridge };
  }
  return { success: false };
}

export async function getUnreadMessageCount() {
  if (nativeBridge && nativeBridge.getUnreadMessageCount) {
    return await nativeBridge.getUnreadMessageCount();
  }
}

export async function isHybridCloud() {
  if (nativeBridge && nativeBridge.isHybridCloud) {
    return await nativeBridge.isHybridCloud();
  }
}

export async function clientVersion() {
  if (nativeBridge && nativeBridge.clientVersion) {
    return await nativeBridge.clientVersion();
  }
}

