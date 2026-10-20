# Isolated API verification image. Reuses dependencies; does not modify the running service.
FROM opencode-saas:shell-sandbox-20261019c
COPY packages/connector/src /app/packages/connector/src
COPY packages/core/src /app/packages/core/src
COPY packages/schema/src /app/packages/schema/src
COPY packages/protocol/src /app/packages/protocol/src
COPY packages/server/src /app/packages/server/src
