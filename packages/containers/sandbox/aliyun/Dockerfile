FROM fc-e2b-registry.cn-hangzhou.cr.aliyuncs.com/runtime-v2/base:v0.0.53

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates curl git unzip zip bash \
      ripgrep util-linux \
      fonts-liberation fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/chromium /usr/local/bin/chromium

RUN npm config set registry https://registry.npmmirror.com --global \
    && npm install -g agent-browser@0.39.4 \
    && npm cache clean --force

COPY cdp-browser /opt/cdp-browser
RUN chmod +x /opt/cdp-browser/cdp-gateway.mjs /opt/cdp-browser/cdp-browser.sh

ENV CHROME_PATH=/usr/local/bin/chromium \
    CDP_GATEWAY_PORT=9222 \
    CDP_UPSTREAM_PORT=9221 \
    CDP_WINDOW_SIZE=1440,900

WORKDIR /workspace
