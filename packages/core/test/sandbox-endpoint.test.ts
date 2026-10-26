import { expect, test } from "bun:test"
import { httpUrl, wsUrl } from "../src/sandbox/endpoint"

test("endpoint URL helpers keep embedded schemes and default scheme-less hosts", () => {
  expect(httpUrl("gateway:9911")).toBe("http://gateway:9911")
  expect(httpUrl("gateway:9911", "https")).toBe("https://gateway:9911")
  expect(httpUrl("https://x.vercel.run/t/abc")).toBe("https://x.vercel.run/t/abc")
  expect(httpUrl("http://x/t/abc", "https")).toBe("http://x/t/abc")
  expect(wsUrl("gateway:9911")).toBe("ws://gateway:9911")
  expect(wsUrl("http://gateway:9911")).toBe("ws://gateway:9911")
  expect(wsUrl("https://x.vercel.run/t/abc")).toBe("wss://x.vercel.run/t/abc")
  expect(wsUrl("wss://x/t/abc")).toBe("wss://x/t/abc")
})
