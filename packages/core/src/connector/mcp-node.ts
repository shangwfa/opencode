export * as ConnectorMcpNode from "./mcp-node.js"

import { AppMcp } from "@opencode/connector/adapter/app-mcp"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { ConnectorMcpStore } from "./mcp-store.js"
import { ConnectorStore } from "./store.js"
import { ConnectorNode } from "./node.js"

// Missing limits fail MCP creation at request time, without breaking unrelated SaaS routes.
const configured = (key: string) => Number(process.env[key] ?? 0)
export const node = makeGlobalNode({
  service: AppMcp.Service,
  layer: AppMcp.layer({
    maxDeployments: configured("OPENCODE_CONNECTOR_MCP_MAX_DEPLOYMENTS"),
    maxTools: configured("OPENCODE_CONNECTOR_MCP_MAX_TOOLS"),
    maxToolBytes: configured("OPENCODE_CONNECTOR_MCP_MAX_TOOL_BYTES"),
    maxTotalBytes: configured("OPENCODE_CONNECTOR_MCP_MAX_TOTAL_BYTES"),
  }),
  deps: [ConnectorMcpStore.node, ConnectorStore.node, ConnectorNode.engineNode],
})
