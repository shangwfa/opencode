export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private maxSize: number

  /**
   * @param maxSize Maximum queued items before discarding the oldest.
   *                0 = unbounded (never discard). Default 1000.
   */
  constructor(maxSize = 1000) {
    this.maxSize = maxSize
  }

  push(item: T) {
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve(item)
      return
    }
    if (this.maxSize > 0 && this.queue.length >= this.maxSize) {
      this.queue.shift()
    }
    this.queue.push(item)
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = pending.pop()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}
