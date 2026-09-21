import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { context, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { currentTraceId } from "../../src/observability/otlp.js"

describe("currentTraceId", () => {
  test("returns undefined when no active OpenTelemetry span", () => {
    expect(currentTraceId()).toBeUndefined()
  })
})

describe("currentTraceId with active OTel span", () => {
  let provider: NodeTracerProvider

  beforeAll(() => {
    provider = new NodeTracerProvider()
    provider.register()
  })

  afterAll(() => {
    provider.shutdown().catch(() => {})
  })

  test("returns 32-char hex trace_id when a span is active", () => {
    const tracer = provider.getTracer("test")
    const span = tracer.startSpan("test-span")
    const result = context.with(trace.setSpan(context.active(), span), () => currentTraceId())
    span.end()
    expect(result).toMatch(/^[0-9a-f]{32}$/)
  })

  test("returns different trace_ids for different spans", () => {
    const tracer = provider.getTracer("test")
    const span1 = tracer.startSpan("span-1")
    const span2 = tracer.startSpan("span-2")

    const id1 = context.with(trace.setSpan(context.active(), span1), () => currentTraceId())
    const id2 = context.with(trace.setSpan(context.active(), span2), () => currentTraceId())

    span1.end()
    span2.end()

    expect(id1).toMatch(/^[0-9a-f]{32}$/)
    expect(id2).toMatch(/^[0-9a-f]{32}$/)
    expect(id1).not.toBe(id2)
  })

  test("returns undefined after span ends", () => {
    const tracer = provider.getTracer("test")
    const span = tracer.startSpan("test-span")
    context.with(trace.setSpan(context.active(), span), () => {
      expect(currentTraceId()).toMatch(/^[0-9a-f]{32}$/)
    })
    span.end()
    // Outside the span context, currentTraceId should return undefined
    expect(currentTraceId()).toBeUndefined()
  })
})