import type { EventApi } from "@ocv1/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}
