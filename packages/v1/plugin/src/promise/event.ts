import type { EventApi } from "@ocv1/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}
