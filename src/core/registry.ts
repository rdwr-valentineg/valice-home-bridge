import type { Adapter, Device } from './device.js';

export class DeviceRegistry {
  private readonly adapters = new Map<string, Adapter>();
  private readonly stateCallbacks: Array<(deviceId: string, adapterId: string) => void> = [];

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter ${adapter.id} already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    adapter.on('state', (deviceId, patch) => {
      const device = this.findDevice(deviceId);
      if (device) {
        Object.assign(device.state, patch);
        this.stateCallbacks.forEach(cb => cb(deviceId, adapter.id));
      }
    });
  }

  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.adapters.values()).map(a =>
      a.stop().catch(err => console.error(`[registry] error stopping ${a.id}:`, err))
    );
    await Promise.all(stops);
  }

  allDevices(): Device[] {
    return Array.from(this.adapters.values()).flatMap(a => a.devices());
  }

  findDevice(deviceId: string): Device | undefined {
    for (const adapter of this.adapters.values()) {
      const device = adapter.devices().find(d => d.id === deviceId);
      if (device) return device;
    }
    return undefined;
  }

  findAdapter(deviceId: string): Adapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.devices().some(d => d.id === deviceId)) return adapter;
    }
    return undefined;
  }

  onStateChange(cb: (deviceId: string, adapterId: string) => void): void {
    this.stateCallbacks.push(cb);
  }
}
