/**
 * SSO 中转页 HTML：自原网关 src/utils/sso.ts 原样搬运（SSO_HTML_CONTENT），勿改内部逻辑。
 */
export const SSO_HTML_CONTENT = `
    <!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SSOLogin</title>
</head>

<body>
  <script>
    "use strict";
    var ssoIns = (() => {
      var __defProp = Object.defineProperty;
      var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
      var __getOwnPropNames = Object.getOwnPropertyNames;
      var __hasOwnProp = Object.prototype.hasOwnProperty;
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, { get: all[name], enumerable: true });
      };
      var __copyProps = (to, from, except, desc) => {
        if (from && typeof from === "object" || typeof from === "function") {
          for (let key of __getOwnPropNames(from))
            if (!__hasOwnProp.call(to, key) && key !== except)
              __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        }
        return to;
      };
      var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

      // middlePage.ts
      var middlePage_exports = {};
      __export(middlePage_exports, {
        middlePageInjectPrimaryDomainSSO: () => middlePageInjectPrimaryDomainSSO,
        middlePageReceiveFromPrimaryDomainSSO: () => middlePageReceiveFromPrimaryDomainSSO
      });

      // core/contanst.ts
      var isInIframe = window.self !== window.top;
      var ssoDomain = {
        // test: 'https://ff25-183-156-215-194.ngrok-free.app/ssoLogin.html',
        test: "https://test-sso.yingdao.com/exchange/sso/token",
        staging: "https://staging-sso.yingdao.com/exchange/sso/token",
        prod: "https://sso.yingdao.com/exchange/sso/token"
      };
      var asOriginsuffix = ".yingdaoapps.com";
      var whiteNameAsOriginReg = (env2) => env2 === "prod" ? "" : env2 + ".yingdaoapps.com";
      var COMMUNICATION_EVENT_NAME = "GET_ACCESS_TOKEN";

      // utils/domain.ts
      function getDomainByEnv(env2 = "prod" /* PROD */) {
        var _a, _b;
        return (_b = new URL((_a = ssoDomain) == null ? void 0 : _a[env2])) == null ? void 0 : _b.origin;
      }
      function checkWhiteOrigin(orogin, env2) {
        const domain = ssoDomain[env2];
        if (!domain) return false;
        return domain.startsWith(orogin);
      }

      // utils/getAccessToken.ts
      function getAccessToken() {
        return {
          accessToken: window.localStorage.getItem("accessToken"),
          refreshToken: window.localStorage.getItem("refreshToken"),
          expiredTime: window.localStorage.getItem("expiredTime"),
          refreshTime: window.localStorage.getItem("refreshTime")
        };
      }

      // utils/pushAccessToken.ts
      function pushAccessToken(ssoInfo) {
        const localStorage = window.localStorage;
        for (const [key, value] of Object.entries(ssoInfo)) {
          localStorage.setItem(key, value);
        }
      }

      // utils/communication.ts
      var Communication = class {
        /** 环境 */
        env;
        /** 通信广播的数据, 可以接受定制 */
        message;
        /** 记录配置 */
        options;
        constructor(env2, message, options) {
          this.env = env2;
          this.message = message;
          this.options = options;
        }
        aborter = new AbortController();
        /** 发送消息 */
        catchError(message) {
          var _a, _b;
          this.destroy();
          (_b = (_a = this.options) == null ? void 0 : _a.ssoLoginError) == null ? void 0 : _b.call(_a, message);
        }
        /** 订阅ssoInfo通信 */
        subscribe(resolve) {
          const { source } = this.options || {};
          window.addEventListener(
            "message",
            (event) => {
              var _a, _b, _c;
              try {
                const { origin, data } = event;
                if (source === "self") {
                  if (!checkWhiteOrigin(origin, this.env)) {
                    return;
                  }
                } else {
                  if (origin.includes(asOriginsuffix) && !origin.includes(whiteNameAsOriginReg(this.env))) {
                    return;
                  } else if (!origin.includes(asOriginsuffix)) {
                    if (getDomainByEnv(this.env) !== origin) {
                      return;
                    }
                  }
                }
                if (Object.prototype.toString.call(data) !== "[object Object]")
                  return;
                const { eventName, code, data: ssoInfo } = data || {};
                if (eventName !== COMMUNICATION_EVENT_NAME) return;
                if (code !== 200) return this.destroy(resolve);
                if (!ssoInfo) return this.destroy(resolve);
                if (!(ssoInfo == null ? void 0 : ssoInfo.accessToken)) return this.destroy(resolve);
                if ((_a = this.options) == null ? void 0 : _a.ssoLoginSuccess) {
                  (_c = (_b = this.options).ssoLoginSuccess) == null ? void 0 : _c.call(_b, ssoInfo);
                } else {
                  pushAccessToken(ssoInfo);
                }
                resolve(ssoInfo);
                this.destroy();
              } catch (error) {
                this.catchError(error);
              }
            },
            {
              signal: this.aborter.signal
            }
          );
        }
        /** 广播token */
        async broadcast(sendMessageIns, domain) {
          const targetWindow = sendMessageIns || window.parent;
          const { checkTokenValid } = this.options || {};
          const ssoInfo = this.message || getAccessToken();
          targetWindow.postMessage(
            {
              eventName: COMMUNICATION_EVENT_NAME,
              data: ssoInfo,
              code: checkTokenValid && !await checkTokenValid(ssoInfo) ? 500 : 200
            },
            isInIframe ? new URL(document.referrer).origin : domain || "*"
          );
        }
        /** 销毁message */
        destroy(resolve) {
          var _a, _b;
          this.aborter.abort();
          (_b = (_a = this.options) == null ? void 0 : _a.clearEffect) == null ? void 0 : _b.call(_a);
          resolve == null ? void 0 : resolve();
        }
      };

      // core/broadCast.ts
      function broadCastSSO(env2 = "prod" /* PROD */, options, sendMessageIns) {
        const communication = new Communication(
          ...[env2, options == null ? void 0 : options.ssoInfo, options]
        );
        communication.broadcast(sendMessageIns);
      }

      // core/subscribe.ts
      function subscribeSSO(env2 = "prod" /* PROD */, options) {
        const communication = new Communication(...[env2, void 0, options]);
        communication.subscribe(options == null ? void 0 : options.resolve);
      }

      // middlePage.ts
      var { hostname } = window.location;
      var env = function () {
        switch (true) {
          case hostname.startsWith("test"):
            return "test" /* TEST */;
          case hostname.startsWith("staging"):
            return "staging" /* STAGING */;
          default:
            return "prod" /* PROD */;
        }
      }();
      function middlePageReceiveFromPrimaryDomainSSO(options) {
        return new Promise((resolve) => {
          subscribeSSO(env, {
            ...options,
            resolve,
            source: "middlePage"
          });
        });
      }
      function middlePageInjectPrimaryDomainSSO(options) {
        return broadCastSSO(env, {
          ...options,
          source: "middlePage"
        });
      }
      middlePageInjectPrimaryDomainSSO();
      middlePageReceiveFromPrimaryDomainSSO();
      return __toCommonJS(middlePage_exports);
    })();

  </script>
</body>

</html>
`;
