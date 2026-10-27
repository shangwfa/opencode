// Reuse the API/SSE/PG snapshot acceptance, with E2B's probed base-template resources.
process.env.EXPECT_PROVIDER = "e2b"
process.env.VERIFY_GATEWAY = "1"
process.env.SESSION_SANDBOX ??= JSON.stringify({ persistMode: "snapshot", cpu: "2", memory: "512Mi", image: "base" })
await import("./aliyun-snapshot-api.mjs")
