declare module '@novnc/novnc' {
  export interface RFBDisconnectEvent extends Event {
    detail: { clean: boolean }
  }

  export interface RFBSecurityFailureEvent extends Event {
    detail: { reason: string }
  }

  export default class RFB extends EventTarget {
    constructor(target: Element, url: string, options?: Record<string, unknown>)
    scaleViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    background: string
    connect(): void
    disconnect(): void
    addEventListener(
      type: 'connect',
      callback: () => void,
      options?: boolean | AddEventListenerOptions,
    ): void
    addEventListener(
      type: 'disconnect',
      callback: (event: RFBDisconnectEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void
    addEventListener(
      type: 'securityfailure',
      callback: (event: RFBSecurityFailureEvent) => void,
      options?: boolean | AddEventListenerOptions,
    ): void
    addEventListener(type: string, callback: (event: Event) => void, options?: boolean | AddEventListenerOptions): void
    removeEventListener(
      type: 'connect',
      callback: () => void,
      options?: boolean | EventListenerOptions,
    ): void
    removeEventListener(
      type: 'disconnect',
      callback: (event: RFBDisconnectEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void
    removeEventListener(
      type: 'securityfailure',
      callback: (event: RFBSecurityFailureEvent) => void,
      options?: boolean | EventListenerOptions,
    ): void
    removeEventListener(type: string, callback: (event: Event) => void, options?: boolean | EventListenerOptions): void
  }
}
