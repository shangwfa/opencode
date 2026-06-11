import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"

const SANDBOX_ID = process.argv[2] ?? "a38ac656-05fe-4fe5-9426-782df3ee8a14"
const DOMAIN = process.argv[3] ?? "localhost:30040"
const API_KEY = process.env.OPENCODE_SANDBOX_API_KEY ?? "H68idVYzjadx"

const cfg = new ConnectionConfig({
  domain: DOMAIN,
  protocol: "http",
  apiKey: API_KEY,
  useServerProxy: false,
  requestTimeoutSeconds: 10,
})

const sb = await Sandbox.connect({ connectionConfig: cfg, sandboxId: SANDBOX_ID })
console.log("connected to sandbox", sb.id)
await sb.kill()
console.log("sandbox killed")
await sb.close()
console.log("done")
