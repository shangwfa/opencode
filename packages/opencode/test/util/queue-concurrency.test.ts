import { describe, expect, test } from "bun:test"
import { AsyncQueue } from "../../src/util/queue"

describe("AsyncQueue backpressure", () => {
  test("bounded queue drops oldest when full", async () => {
    const q = new AsyncQueue<number>(3)
    q.push(1)
    q.push(2)
    q.push(3)
    q.push(4)

    const items: number[] = []
    for await (const item of q) {
      items.push(item)
      if (items.length === 3) break
    }

    expect(items).toEqual([2, 3, 4])
  })

  test("unbounded queue grows without limit", async () => {
    const q = new AsyncQueue<number>()
    for (let i = 0; i < 1000; i++) {
      q.push(i)
    }

    const items: number[] = []
    for await (const item of q) {
      items.push(item)
      if (items.length === 1000) break
    }

    expect(items.length).toBe(1000)
    expect(items[0]).toBe(0)
    expect(items[999]).toBe(999)
  })

  test("maxSize=0 is unbounded", async () => {
    const q = new AsyncQueue<number>(0)
    for (let i = 0; i < 100; i++) {
      q.push(i)
    }

    const items: number[] = []
    for await (const item of q) {
      items.push(item)
      if (items.length === 100) break
    }

    expect(items.length).toBe(100)
  })
})

describe("AsyncQueue concurrent access", () => {
  test("multiple producers single consumer", async () => {
    const q = new AsyncQueue<number>(0)
    const N = 100

    const producers = Array.from({ length: 5 }, (_, pid) =>
      Promise.resolve().then(async () => {
        for (let i = 0; i < N; i++) {
          q.push(pid * N + i)
          await new Promise((r) => setTimeout(r, 0))
        }
      }),
    )

    const collected: number[] = []
    const consumer = (async () => {
      for (let i = 0; i < 5 * N; i++) {
        collected.push(await q.next())
      }
    })()

    await Promise.all([...producers, consumer])
    expect(collected.length).toBe(5 * N)
    const set = new Set(collected)
    expect(set.size).toBe(5 * N)
  })

  test("single producer multiple consumers get all items", async () => {
    const q = new AsyncQueue<number>(0)
    const N = 50

    const produced: number[] = []
    const producer = (async () => {
      for (let i = 0; i < N; i++) {
        q.push(i)
        produced.push(i)
      }
    })()

    const consumed: number[] = []
    const consumers = Array.from({ length: 3 }, async () => {
      while (consumed.length < N) {
        const val = await Promise.race([q.next(), new Promise<null>((r) => setTimeout(() => r(null), 10))])
        if (val !== null && !consumed.includes(val)) {
          consumed.push(val)
        }
      }
    })

    await producer
    await Promise.race([
      Promise.all(consumers),
      new Promise((r) => setTimeout(r, 2000)),
    ])

    expect(produced.sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i),
    )
  })
})
