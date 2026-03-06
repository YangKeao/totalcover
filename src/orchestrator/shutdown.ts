export class ShutdownController {
  private requested = false;
  private readonly listeners: Array<() => void> = [];

  constructor() {
    const handler = () => {
      this.requested = true;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // best effort
        }
      }
    };

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }

  isRequested(): boolean {
    return this.requested;
  }

  onRequest(listener: () => void): void {
    this.listeners.push(listener);
  }
}
