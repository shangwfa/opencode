"use client";

import Script from "next/script";
import { env } from "@/utils/env";

const YDScript = (props) => {
  return (
    <>
      {/* {env.ENV !== "private" && (
        <Script id="assistant-script" strategy="beforeInteractive">
          {`
                if (window && window.innerWidth > 800 && location.pathname.includes('yddoc/rpa')) {
                    window.$$aaConfig = {
                      url: "https://assistant.yingdao.com/assistant/df0ad624-ba9e-466c-afdf-4bb510535880/sdk",
                      launcher:
                        "https://xybot-oss-1302949341.cos.ap-shanghai.myqcloud.com/ai_assistant/1721040169602/1bca9be3-2267-4bfb-80d6-c4aed68cc1ed",
                    };
                  }
              `}
        </Script>
      )}
      {env.ENV !== "private" && (
        <Script id="assistant-script" strategy="beforeInteractive">
          {`
                if (window && window.innerWidth > 800 && location.pathname.includes('yddoc/ap')) {
                    window.$$aaConfig = {
                      uuid: "ccc2cd3c-fc6a-426b-b4e1-996107dd5c90",
                      url: "https://power.yingdao.com/assistant/ccc2cd3c-fc6a-426b-b4e1-996107dd5c90/share",
                      apiUrl: "https://power-api.yingdao.com",
                    };
                  }
              `}
        </Script>
      )}

      {env.ENV !== "private" && (
        <script src="https://assistant.yingdao.com/embed.min.js"></script>
      )} */}
      {/* 微软可视化埋点工具——Clarity */}
      {env.ENV !== "private" && (
        <Script id="clarity-script" strategy="beforeInteractive">
          {`
                (function (c, l, a, r, i, t, y) {
              c[a] =
                c[a] ||
                function () {
                  (c[a].q = c[a].q || []).push(arguments);
                };
              t = l.createElement(r);
              t.async = 1;
              t.src = 'https://www.clarity.ms/tag/' + i;
              y = l.getElementsByTagName(r)[0];
              y.parentNode.insertBefore(t, y);
            })(window, document, 'clarity', 'script', 'ch8uihcm3i');
        `}
        </Script>
      )}
    </>
  );
};

export default YDScript;
