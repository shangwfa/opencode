import type { SandboxConfig } from "../config.js"
import type { Api } from "../e2b-shared/client.js"
import { make as shared } from "../e2b-shared/provider.js"

export const make = (config: SandboxConfig.Config, supplied?: Api) => shared(config, "aliyun", supplied)
