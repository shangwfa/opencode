import { fetchEventSource } from "@microsoft/fetch-event-source";

interface IOptions {
  method: string;
  headers: Record<string, string> | undefined;
  body?: any;
}
const decoder = new TextDecoder("utf-8");

export class StreamService {
  url: string;
  private messageCallback: Function = () => {};
  private closeCallback: Function = () => {};
  private errorCallback: Function = () => {};
  private stopCallback: Function = () => {};
  private controller: AbortController | null = null;
  constructor(url: string, options: IOptions) {
    this.url = url;
    this.start(options);
  }

  async start(options: IOptions) {
    try {
      const controller = new AbortController();
      const signal = controller.signal;
      this.controller = controller;
      const that = this;
      fetchEventSource(this.url, {
        ...options,
        openWhenHidden: true,
        signal,
        async onopen(response) {
          // 跳过 content-type 验证，允许 text/plain 等其他类型
          if (response.ok) {
            return;
          }
          throw new Error(`Failed to open SSE connection: ${response.status}`);
        },
        onmessage(msg) {
          that.messageCallback(msg.data);
        },
        onclose() {
          that.closeCallback();
        },
        onerror(err) {
          that.errorCallback(err);
          throw err;
        },
      });
      return;
    } catch (e) {
      this.errorCallback(e);
    }
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
    this.stopCallback && this.stopCallback();
  }

  onstop(callBack: Function) {
    this.stopCallback = callBack;
  }

  onmessage(callback: Function) {
    this.messageCallback = callback;
  }

  onclose(callback: Function) {
    this.closeCallback = callback;
  }

  onerror(callback: Function) {
    this.errorCallback = callback;
  }
}
