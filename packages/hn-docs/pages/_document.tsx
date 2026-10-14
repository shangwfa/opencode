import { Html, Head, Main, NextScript } from "next/document";
import type { DocumentContext, DocumentInitialProps } from "next/document";
import { ENV_KEY_LIST } from "@/utils/env";

interface DocumentProps extends DocumentInitialProps {
  env?: Record<string, string | undefined>;
}

export default function Document({ env }: DocumentProps) {
  // 使用传入的 env，如果没有则从 process.env 读取（作为后备）
  const envVars = env || {};

  return (
    <Html>
      <Head>
        {/* 在 Head 中注入环境变量，使用 dangerouslySetInnerHTML */}
        <script
          id="__NEXT_ENV__"
          dangerouslySetInnerHTML={{
            __html: `window.__ENV__=${JSON.stringify(envVars)};`,
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

Document.getInitialProps = async (ctx: DocumentContext) => {
  const initialProps = await ctx.defaultGetInitialProps(ctx);
  // 运行时从 k8s 环境变量读取所有 NEXT_PUBLIC_* 环境变量
  // 使用 ENV_KEY_LIST 常量和动态属性访问 process.env[key]，避免 Next.js 构建时静态替换
  const envVars: Record<string, string | undefined> = {};
  ENV_KEY_LIST.forEach((key) => {
    envVars[key] = process.env[key];
  });

  // 过滤掉 undefined 和 null 值，但保留空字符串（因为空字符串也是有效值）
  const filteredEnvVars: Record<string, string> = {};
  Object.keys(envVars).forEach((key) => {
    const value = envVars[key];
    if (value !== undefined && value !== null) {
      filteredEnvVars[key] = value;
    }
  });

  console.log("[_document.getInitialProps] env--->>>", filteredEnvVars);

  return {
    ...initialProps,
    env: filteredEnvVars,
  };
};
