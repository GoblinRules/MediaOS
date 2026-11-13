/** Map insertion order supplies both the bounded storage and least-recently-used eviction. */
export class Lru<T> {
  private values = new Map<string, T>()
  constructor(private limit: number) {}
  get(id: string): T | undefined {
    const value = this.values.get(id)
    if (value !== undefined) { this.values.delete(id); this.values.set(id, value) }
    return value
  }
  set(id: string, value: T): void {
    this.values.delete(id); this.values.set(id, value)
    if (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!)
  }
  clear(): void { this.values.clear() }
}
