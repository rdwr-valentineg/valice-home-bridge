import { EventEmitter } from 'events';
import type { Adapter, Device, DeviceCommand, DeviceState } from '../../core/device.js';

export interface FakeDeviceConfig {
  id: string;
  label: string;
  room?: string;
}

export class FakeAdapter implements Adapter {
  readonly id = 'fake';
  private readonly emitter = new EventEmitter();
  private readonly _devices: Device[];

  constructor(configs: FakeDeviceConfig[]) {
    this._devices = configs.map(c => ({
      id: c.id,
      type: 'light' as const,
      label: c.label,
      room: c.room,
      state: { reachable: true, on: false },
    }));
  }

  async start(): Promise<void> {
    console.log(`[fake] started with ${this._devices.length} device(s):`, this._devices.map(d => d.id));
  }

  async stop(): Promise<void> {
    console.log('[fake] stopped');
  }

  devices(): Device[] {
    return this._devices;
  }

  on(event: 'state', cb: (deviceId: string, state: Partial<DeviceState>) => void): void {
    this.emitter.on(event, cb);
  }

  async command(deviceId: string, cmd: DeviceCommand): Promise<void> {
    const device = this._devices.find(d => d.id === deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);

    if (cmd.type === 'setOn') {
      device.state.on = cmd.value;
      console.log(`[fake] ${deviceId} → ${cmd.value ? 'ON' : 'OFF'}`);
      this.emitter.emit('state', deviceId, { on: cmd.value });
    } else if (cmd.type === 'toggle') {
      device.state.on = !device.state.on;
      console.log(`[fake] ${deviceId} toggled → ${device.state.on ? 'ON' : 'OFF'}`);
      this.emitter.emit('state', deviceId, { on: device.state.on });
    }
  }
}
