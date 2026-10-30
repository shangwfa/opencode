FROM vcr.vercel.com/vercel/sandbox/universal:latest

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Ubuntu 仓库不再提供可用的 chromium（snap 占位），按官方「自定义镜像」路线预装 Playwright Chromium。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g playwright agent-browser@0.39.4 --no-audit --no-fund \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright playwright install --with-deps chromium \
    && CHROME="$(ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)" \
    && test -n "$CHROME" \
    && ln -sf "$CHROME" /usr/local/bin/chromium \
    && chromium --version

COPY cdp-browser /opt/cdp-browser
RUN chmod +x /opt/cdp-browser/cdp-gateway.mjs /opt/cdp-browser/cdp-browser.sh

ENV CHROME_PATH=/usr/local/bin/chromium \
    CDP_GATEWAY_PORT=9222 \
    CDP_UPSTREAM_PORT=9221 \
    CDP_WINDOW_SIZE=1440,900

WORKDIR /workspace
