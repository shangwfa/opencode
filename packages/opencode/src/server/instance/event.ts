import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { PgNotify } from "@/bus/pg-notify"
import { Flag } from "@/flag/flag"
import { AsyncQueue } from "../../util/queue"

const log = Log.create({ service: "server" })

const DISPOSED_TYPE = "server.instance.disposed"

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events. Use ?sessionID= to filter events for a specific session.",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const filterSessionID = c.req.query("sessionID")
      const usePgBus = Flag.OPENCODE_EVENT_BUS === "pg"
      log.info("event connected", { filterSessionID, bus: usePgBus ? "pg" : "local" })
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>()
        let done = false
        let unsub = () => {}

        q.push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        )

        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          q.push(null)
          log.info("event disconnected")
        }

        const matches = (event: any) => {
          if (!filterSessionID) return true
          if (event.type === DISPOSED_TYPE) return true
          return event.properties?.sessionID === filterSessionID
        }

        if (usePgBus) {
          const unsubscribe = PgNotify.subscribe((event) => {
            if (event.type === DISPOSED_TYPE) {
              q.push(JSON.stringify(event))
              stop()
              return
            }
            if (matches(event)) {
              q.push(JSON.stringify(event))
            }
          })
          unsub = unsubscribe
        } else {
          const busUnsub = Bus.subscribeAll((event) => {
            if (event.type === DISPOSED_TYPE) {
              q.push(JSON.stringify(event))
              stop()
              return
            }
            if (matches(event)) {
              q.push(JSON.stringify(event))
            }
          })
          unsub = busUnsub
        }

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
