/** A barrier the test opens to decide exactly when an awaited step continues. */
export class Gate {
  private isOpen = false;
  private readonly waiters: (() => void)[] = [];

  get waiting(): number {
    return this.waiters.length;
  }

  wait(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  open(): void {
    this.isOpen = true;
    for (const release of this.waiters.splice(0)) release();
  }
}
