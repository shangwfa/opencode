import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { addClickEventListener, setGlobalBuryConfig, usePv } from "@xybot/bury";
import App from "next/app";
import type { AppContext } from "next/app";

import "@/styles/globals.css";
import "@/styles/prosemirror.css"; // 导入布局组件

import Header from "@/components/Header";
import BookAiAssistant from "@/components/BookAiAssistant";
import YDScript from "@/components/YDScript";

import { usePcMobile, useIsYdBrowser, useClientVersion } from "@/hooks";
import { useIframeHeight } from "@/hooks/use-iframe-height";
import { setCookie } from "@/utils/cookie";
import { SharedDataProvider, useSharedData } from "@/context/SharedDataContext";
import { getUserInfo } from "@/api/account";
import { queryDocEnvConfig } from "@/api/customer";
import { useAuthComponents, DOC_COMPONENTS, AuthForm } from "@/hooks/auth";
import { env } from "@/utils/env";
import { ensureMicroAppRuntime } from "@/utils/micro-app-runtime";

// Establish the shared initialization promise before React renders SDK
// consumers. A failure only disables micro-app features; normal documents keep
// rendering and each SDK may retry through the same runtime manager.
if (typeof window !== "undefined") {
  void ensureMicroAppRuntime().catch((error) => {
    console.error("[book] Failed to initialize micro-app runtime:", error);
  });
}

const AppContent = (props) => {
  const { Component, pageProps } = props;
  const isYd = useIsYdBrowser();
  const { version } = useClientVersion();
  const [mounted, setMounted] = useState(false);

  const router = useRouter();
  const { access_token, id, brandCode, languageCode, link_source } =
    router.query;
  const { updateSharedData } = useSharedData();
  const authComponents = useAuthComponents();

  // 环境变量已通过 script 标签在 HTML 中注入，无需在 useEffect 中读取

  // 使用 iframe 高度管理 hook
  useIframeHeight({
    bufferHeight: 50,
  });

  usePv();

  useEffect(() => {
    if (isYd && link_source !== AuthForm.INSTRUCTIONS) {
      getUserInfo().then((res) => {
        if (res.code === 200) {
          const currentUser = res.data;
          localStorage.setItem("user", JSON.stringify(currentUser));
          localStorage.setItem("uuid", currentUser?.uuid);
          localStorage.setItem("userName", currentUser?.name);
          localStorage.setItem(
            "enterpriseName",
            currentUser?.enterprise?.name || "",
          );
          updateSharedData({ userGrade: currentUser?.grade });
        }
      });
    }
  }, [isYd, link_source]);

  useEffect(() => {
    setGlobalBuryConfig({
      useConsoleUrl: true,
      enableReport: env.ENV === "private" ? false : true,
      env: env.ENV as any,
      beforeReport: (data: any) => {
        if (data?.body) {
          (data.body as any).referrer = (window as any).CefSharp
            ? "yd-client"
            : "web";
        }
        return data;
      },
    });
    addClickEventListener();
    setMounted(true);
  }, []);

  useEffect(() => {
    if (brandCode) {
      getProductInfo();
    }
  }, [brandCode]);

  const getProductInfo = () => {
    queryDocEnvConfig({
      brandCode: brandCode as string,
      languageCode: languageCode as string,
    }).then((res) => {
      if (res.code === 200) {
        const {
          docEnvConfigExtraInfo,
          envCode,
          docEnvConfigReference,
          defaultLanguageCode,
          languageBOList,
          docBrandId,
        } = res.data;

        let languages = {};
        let oemInfo = {
          title: "",
          iconUrl: "",
        };
        if (docEnvConfigExtraInfo) {
          const extraInfo = JSON.parse(docEnvConfigExtraInfo);
          languages = extraInfo.languages;
          oemInfo = {
            title: extraInfo.title || "",
            iconUrl: extraInfo.logo || "",
          };
        }
        updateSharedData({
          envCode,
          docEnvConfigReference,
          defaultLanguageCode,
          languageCodeList: languageBOList || [],
          languages,
          oemInfo,
          docBrandId: docBrandId ?? "",
        });
      }
    });
  };

  useEffect(() => {
    if (access_token) {
      setCookie("token", access_token);
      // 重写url，去除 access_token 参数
      const { pathname, query } = router;
      const newQuery = { ...query };
      delete newQuery.access_token;
      router.replace({ pathname, query: newQuery }, undefined, {
        shallow: true,
      });
    }
  }, [access_token]);

  return (
    <div className="relative">
      {!(isYd && id) &&
        !version &&
        authComponents.includes(DOC_COMPONENTS.HEADER) && <Header />}
      <div
        className="flex space-between"
        style={{
          visibility: !mounted ? "hidden" : "visible",
          minHeight: authComponents.includes(DOC_COMPONENTS.FULL_SCREEN)
            ? "100vh"
            : "100%",
        }}
      >
        <Component {...pageProps} />
        <YDScript />
      </div>
      <BookAiAssistant />
    </div>
  );
};

const DocApp = (props) => {
  const { Component, pageProps } = props;

  return (
    <ConfigProvider locale={zhCN}>
      <SharedDataProvider>
        <AppContent Component={Component} pageProps={pageProps} />
      </SharedDataProvider>
    </ConfigProvider>
  );
};

DocApp.getInitialProps = async (ctx: AppContext) => {
  // 这行如果出现在服务端日志里，说明这次请求确实走了 _app 的 SSR
  console.log("[_app.getInitialProps] server?", typeof window === "undefined");
  const appProps = await App.getInitialProps(ctx);
  return {
    ...appProps,
    // 如需额外传东西，只加到 pageProps 里
    pageProps: {
      ...appProps.pageProps,
      __gipProbe: Date.now(),
    },
  };
};

export default DocApp;
