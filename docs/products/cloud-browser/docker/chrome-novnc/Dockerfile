FROM opensandbox/chrome:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        websockify \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 cloud-browser-entrypoint.sh /cloud-browser-entrypoint.sh
COPY --chmod=755 Xtigervnc /usr/local/bin/Xtigervnc

USER chrome

ENTRYPOINT ["/cloud-browser-entrypoint.sh"]
