declare module "*.css";
declare module "*.less";
declare module "*.js";
declare module "*.svg";
declare module "*.png";
declare module "@*";

interface IWebMenus {
  title: string;
  path?: string;
  key?: string;
  children?: IWebMenus[];
}

interface Window {
  IsYdBrowser: boolean;
  /**
   * 客户端brige绑定对象
   */
  javascriptBinding?: Object;
  /**
   * 客户端注入通信对象
   */
  CefSharp?: Object;
}
