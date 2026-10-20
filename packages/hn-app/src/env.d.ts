declare global {
  interface Window {
    YD?: {
      ENV?: string
      API_URL?: string
      HOME_URL?: string
      CONSOLE_URL?: string
      BOSS_API_URL?: string
      SERVER_API?: string
      REQUIREMENTS_URL?: string
      FIGMA2CODE_HUB_URL?: string
      SSO_URL?: string
      OPENCODE_DIRECTORY?: string
      REQUIREMENT_API_USE_LOCAL?: boolean
      PREVIEW_USE_IP_HOST?: boolean
      ENABLE_DEBUG?: boolean | string
      __PROJECT_APP_BASE_ROUTE__?: string
    }
  }
}

interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST?: string
  readonly VITE_OPENCODE_SERVER_PORT?: string
  readonly VITE_ROUTER_BASE?: string
  readonly VITE_LOGIN_REDIRECT_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** CSS 副作用导入（fontsource / openuidev 等） */
declare module "*.css"
declare module "@fontsource-variable/inter"

export {}
