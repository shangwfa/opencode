/**
 * 环境变量工具函数
 * 统一处理服务端和客户端的环境变量获取
 *
 * 服务端：直接从 process.env 读取（开发时从 .env.local，生产时从 k8s）
 * 客户端：从 window.__ENV__ 对象读取（由服务端注入）
 */

/**
 * 环境变量键名常量
 * 使用常量可以避免 Next.js 构建时静态替换 process.env.NEXT_PUBLIC_* 的问题
 * 在需要动态读取环境变量的地方使用 process.env[ENV_KEYS.XXX]
 */
export const ENV_KEYS = {
  NEXT_PUBLIC_ENV: "NEXT_PUBLIC_ENV",
  NEXT_PUBLIC_BASE_URL: "NEXT_PUBLIC_BASE_URL",
  NEXT_PUBLIC_COLLEGE_BASE_URL: "NEXT_PUBLIC_COLLEGE_BASE_URL",
  NEXT_PUBLIC_BOSS_URL: "NEXT_PUBLIC_BOSS_URL",
  NEXT_PUBLIC_YDDOC_API_URL: "NEXT_PUBLIC_YDDOC_API_URL",
  NEXT_PUBLIC_AI_SEARCH_SOURCE: "NEXT_PUBLIC_AI_SEARCH_SOURCE",
  NEXT_PUBLIC_SERVER_URL: "NEXT_PUBLIC_SERVER_URL",
  NEXT_PUBLIC_BOARD_URL: "NEXT_PUBLIC_BOARD_URL",
  NEXT_PUBLIC_HOME_URL: "NEXT_PUBLIC_HOME_URL",
  NEXT_PUBLIC_AI_ASSISTANT_HIDDEN_BRANDS:
    "NEXT_PUBLIC_AI_ASSISTANT_HIDDEN_BRANDS",
} as const;

// 环境变量键名数组（用于批量读取）
export const ENV_KEY_LIST = Object.values(ENV_KEYS);

// 定义环境变量类型
declare global {
  interface Window {
    __ENV__?: {
      NEXT_PUBLIC_ENV?: string;
      NEXT_PUBLIC_BASE_URL?: string;
      NEXT_PUBLIC_COLLEGE_BASE_URL?: string;
      NEXT_PUBLIC_BOSS_URL?: string;
      NEXT_PUBLIC_YDDOC_API_URL?: string;
      NEXT_PUBLIC_AI_SEARCH_SOURCE?: string;
      NEXT_PUBLIC_SERVER_URL?: string;
      NEXT_PUBLIC_BOARD_URL?: string;
      NEXT_PUBLIC_AI_ASSISTANT_HIDDEN_BRANDS?: string;
    };
  }
}

/**
 * 获取环境变量
 * @param key 环境变量键名（不需要 NEXT_PUBLIC_ 前缀）
 * @param defaultValue 默认值
 * @returns 环境变量值
 */
export function getEnv(key: string, defaultValue?: string): string | undefined {
  // 服务端：直接从 process.env 读取
  if (typeof window === "undefined") {
    const fullKey = key.startsWith("NEXT_PUBLIC_") ? key : `NEXT_PUBLIC_${key}`;
    return process.env[fullKey] || defaultValue;
  }

  // 客户端：从 window.__ENV__ 读取
  const fullKey = key.startsWith("NEXT_PUBLIC_") ? key : `NEXT_PUBLIC_${key}`;
  // window.__ENV__ 中的键名是完整的（带 NEXT_PUBLIC_ 前缀）
  const envKey = fullKey as keyof NonNullable<Window["__ENV__"]>;

  if (window.__ENV__ && window.__ENV__[envKey]) {
    const value = window.__ENV__[envKey];
    // 去除首尾空格（环境变量值可能包含空格）
    return typeof value === "string" ? value.trim() : value;
  }

  return defaultValue;
}

/**
 * 获取环境变量（必需）
 * @param key 环境变量键名（不需要 NEXT_PUBLIC_ 前缀）
 * @returns 环境变量值
 * @throws 如果环境变量不存在则抛出错误
 */
export function getEnvRequired(key: string): string {
  const value = getEnv(key);
  if (!value) {
    const fullKey = key.startsWith("NEXT_PUBLIC_") ? key : `NEXT_PUBLIC_${key}`;
    throw new Error(`Environment variable ${fullKey} is required but not set`);
  }
  return value;
}

/**
 * 获取 basePath 路径前缀
 * 根据环境变量 NEXT_PUBLIC_ENV 动态返回路径前缀
 * - international 环境：返回空字符串
 * - 其他环境：返回 "/yddoc"
 * @returns 路径前缀
 */
export function getBasePath(): string {
  const envValue = getEnv("NEXT_PUBLIC_ENV");
  return envValue === "international" ? "" : "/yddoc";
}

// 便捷方法：获取常用的环境变量
export const env = {
  get ENV() {
    return getEnv("NEXT_PUBLIC_ENV");
  },
  get BASE_URL() {
    return getEnv("NEXT_PUBLIC_BASE_URL");
  },
  get COLLEGE_BASE_URL() {
    return getEnv("NEXT_PUBLIC_COLLEGE_BASE_URL");
  },
  get BOSS_URL() {
    return getEnv("NEXT_PUBLIC_BOSS_URL");
  },
  get YDDOC_API_URL() {
    return getEnv("NEXT_PUBLIC_YDDOC_API_URL");
  },
  get AI_SEARCH_SOURCE() {
    return getEnv("NEXT_PUBLIC_AI_SEARCH_SOURCE");
  },
  get SERVER_URL() {
    return getEnv("NEXT_PUBLIC_SERVER_URL");
  },
  get BOARD_URL() {
    return getEnv("NEXT_PUBLIC_BOARD_URL");
  },
  get HOME_URL() {
    return getEnv("NEXT_PUBLIC_HOME_URL");
  },
  /**
   * 获取不展示 AI 助手组件的 brandCode 列表（逗号分隔）
   */
  get AI_ASSISTANT_HIDDEN_BRANDS() {
    return getEnv("NEXT_PUBLIC_AI_ASSISTANT_HIDDEN_BRANDS");
  },
  /**
   * 获取路径前缀（basePath）
   * 运行时根据 NEXT_PUBLIC_ENV 动态返回
   */
  get BASE_PATH() {
    return getBasePath();
  },
};
