FROM opensandbox/chrome:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        websockify \
        socat \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 cloud-browser-entrypoint.sh /cloud-browser-entrypoint.sh

# /entrypoint 调用 /usr/bin/Xtigervnc 时写死 -geometry 1280x1024；
# 备份原二进制并用包装脚本替换，将分辨率提升到 1920x1080。
RUN mv /usr/bin/Xtigervnc /usr/bin/Xtigervnc.real
COPY --chmod=755 Xtigervnc /usr/bin/Xtigervnc

USER chrome

ENTRYPOINT ["/cloud-browser-entrypoint.sh"]
