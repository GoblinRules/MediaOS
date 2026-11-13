/** Serialises network writes; a rejected job never poisons the next job. */
export class NetQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job)
    this.tail = result.catch(() => undefined)
    return result
  }
}
