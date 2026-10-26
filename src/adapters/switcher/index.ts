import EventEmitter from 'events';
import { createRequire } from 'module';
import type { Adapter, Device, DeviceState, DeviceCommand, DeviceType } from '../../core/device.js';

const require = createRequire(import.meta.url);
const Switcher = require('switcher-js2');

export interface SwitcherDeviceConfig {
  id: string;          // Switcher device_id (hex, e.g. "aabb12")
  type: DeviceType;    // 'thermostat' | 'windowCovering' | 'light'
  label: string;
  room?: string;
  token?: string;      // Base64 token from switcher.co.il/GetKey — required for sl01/sl02/sl03/s11/s12/heater
}

interface SwitcherInfo {
  deviceIp: string;
  deviceType: string;   // 'breeze' | 'runner_mini' | 'power_plug' | etc.
  remote?: string;      // Breeze IR remote ID (from UDP broadcast)
  deviceKey: string;
  mac?: string;         // 12 hex chars — MAC from sl-type UDP broadcast, used as token fallback
}

const log = (...args: unknown[]) => console.log('[switcher]', ...args);

export interface SeenDevice {
  device_id: string;
  name: string;
  type: string;
  ip: string;
  state: Record<string, unknown>;
  suggestedMatterType: string;
}

export class SwitcherAdapter extends EventEmitter implements Adapter {
  readonly id = 'switcher';

  private devices_: Map<string, Device> = new Map();
  private info: Map<string, SwitcherInfo> = new Map();
  private seen: Map<string, SeenDevice> = new Map();
  private listener: { close(): Promise<void> } | null = null;

  constructor(private readonly configs: SwitcherDeviceConfig[]) {
    super();
    for (const cfg of configs) {
      this.devices_.set(cfg.id, {
        id: cfg.id,
        type: cfg.type,
        label: cfg.label,
        room: cfg.room,
        state: { reachable: false },
      });
    }
  }

  async start(): Promise<void> {
    this.listener = Switcher.listen(log) as { close(): Promise<void> };

    (this.listener as unknown as EventEmitter).on('message', (msg: SwitcherMessage) => {
      this.handleMessage(msg);
    });

    (this.listener as unknown as EventEmitter).on('error', (err: Error) => {
      log('listener error:', err.message);
    });

    log(`listening for ${this.configs.length} device(s):`, this.configs.map(c => c.id).join(', '));
  }

  async stop(): Promise<void> {
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
    }
  }

  devices(): Device[] {
    return Array.from(this.devices_.values());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: any, cb: (...args: any[]) => void): this {
    return super.on(event, cb);
  }

  async command(deviceId: string, cmd: DeviceCommand): Promise<void> {
    const nfo = this.info.get(deviceId);
    if (!nfo) throw new Error(`[switcher] no IP known yet for ${deviceId}`);

    // Constructor signature is (id, ip, log, listen, type, remote, token, key):
    // `token` is the Base64 GetKey token (sl01/sl02/sl03/s11/s12/heater — the library
    // converts it via he()), `key` is the device_key from the UDP broadcast, used by
    // the old-protocol _login() (power_plug, v2, v3, v4, mini).
    const cfg = this.configs.find(c => c.id === deviceId);
    const needsToken = /^(sl(mini)?0\d|s1[12]|heater)$/.test(nfo.deviceType);
    if (needsToken && !cfg?.token) {
      throw new Error(`[switcher] ${deviceId} (${nfo.deviceType}) needs a token — get it from switcher.co.il/GetKey and add it to config.yaml`);
    }
    const sw = new Switcher(deviceId, nfo.deviceIp, log, false, nfo.deviceType, nfo.remote ?? null,
      needsToken ? cfg!.token : null, nfo.deviceKey);
    sw.on('error', (err: Error) => log(`device error ${deviceId}:`, err.message));

    // Breeze (AC) constructor kicks off an async local-file read to load remote
    // capabilities. Wait for that before sending any command.
    if (nfo.deviceType === 'breeze') {
      await waitForCapabilities(sw);
    }

    await this.runCommand(sw, deviceId, cmd);
    // Do NOT call sw.close() here. set_breeze_command / set_position are fire-and-forget
    // internally (they don't return a Promise). Calling close() would set _closed=true
    // before their async TCP round-trip completes, crashing _getsocket(). TCP connections
    // opened by those commands close themselves when the exchange is done.
  }

  private async runCommand(sw: SwitcherInstance, deviceId: string, cmd: DeviceCommand): Promise<void> {
    const dev = this.devices_.get(deviceId);
    if (!dev) return;
    const nfo = this.info.get(deviceId)!;
    const isBreeze = nfo.deviceType === 'breeze';
    const isLight = /^sl(mini)?0\d$/.test(nfo.deviceType);

    switch (cmd.type) {
      case 'setOn':
        if (isBreeze) {
          // Breeze devices must use set_breeze_command — turn_on/turn_off send the
          // wrong protocol and cause the device to close the TCP connection immediately.
          sw.set_breeze_command({
            power: cmd.value ? 'ON' : 'OFF',
            mode: deviceModeToSwitcher(dev.state.mode ?? 'cool'),
            fan_level: 'AUTO',
            target_temp: Math.round(dev.state.setpoint ?? 24),
          });
        } else if (isLight) {
          // Circuit index is 1-based on the wire (aioswitcher: get_light_api_packet_index);
          // index 0 makes switcher-js2 omit the circuit byte and the device ignores it.
          await sw.set_light(cmd.value, 1);
        } else {
          await (cmd.value ? sw.turn_on() : sw.turn_off());
        }
        break;

      case 'toggle':
        if (isBreeze) {
          sw.set_breeze_command({
            power: dev.state.on ? 'OFF' : 'ON',
            mode: deviceModeToSwitcher(dev.state.mode ?? 'cool'),
            fan_level: 'AUTO',
            target_temp: Math.round(dev.state.setpoint ?? 24),
          });
        } else if (isLight) {
          await sw.set_light(!dev.state.on, 1);
        } else {
          await (dev.state.on ? sw.turn_off() : sw.turn_on());
        }
        break;

      case 'setMode':
        sw.set_breeze_command({
          power: cmd.value === 'off' ? 'OFF' : 'ON',
          mode: deviceModeToSwitcher(cmd.value),
          fan_level: 'AUTO',
          target_temp: Math.round(dev.state.setpoint ?? 24),
        });
        break;

      case 'setSetpoint':
        sw.set_breeze_command({
          power: 'ON',
          mode: deviceModeToSwitcher(dev.state.mode ?? 'cool'),
          fan_level: 'AUTO',
          target_temp: Math.round(cmd.value),  // IR table has whole degrees only; Apple sends 0.5 steps
        });
        break;

      case 'setPosition':
        sw.set_position(100 - cmd.value);  // invert back to Switcher convention (0=open)
        break;

      default:
        log(`unhandled command type: ${(cmd as DeviceCommand).type}`);
    }
  }

  getSeenDevices(): SeenDevice[] {
    return Array.from(this.seen.values());
  }

  private handleMessage(msg: SwitcherMessage): void {
    if (msg.device_id) {
      this.seen.set(msg.device_id, {
        device_id: msg.device_id,
        name: msg.name ?? 'Unknown',
        type: msg.type ?? 'unknown',
        ip: msg.device_ip ?? '',
        state: (msg.state ?? {}) as Record<string, unknown>,
        suggestedMatterType: switcherTypeToMatterType(msg.type),
      });
    }

    const cfg = this.configs.find(c => c.id === msg.device_id);
    if (!cfg) return;

    this.info.set(msg.device_id, {
      deviceIp: msg.device_ip,
      deviceType: msg.type,
      remote: msg.remote,
      deviceKey: msg.device_key ?? '',
      mac: msg.device_mac,
    });

    const dev = this.devices_.get(cfg.id)!;
    const partial: Partial<DeviceState> = { reachable: true };

    if (msg.type === 'breeze' && msg.state) {
      const s = msg.state as BreezeState;
      partial.mode = s.power === 'OFF' ? 'off' : switcherModeToDevice(s.mode);
      partial.setpoint = s.target_temp;
      partial.currentTemp = s.current_temp;
    } else if (msg.type?.includes('runner') && msg.state) {
      const s = msg.state as RunnerState;
      // Switcher runner convention: 0 = fully open, 100 = fully closed.
      // DeviceState.position convention (matches Matter): 0 = closed, 100 = open.
      partial.position = 100 - s.position;
    } else if (/^sl(mini)?0\d$/.test(msg.type ?? '') && msg.state) {
      // Switcher Light (sl01, sl02, sl03, slmini01…) — state has light1_power not power
      partial.on = (msg.state as unknown as LightState).light1_power === 'ON';
    } else if (msg.state) {
      const s = msg.state as SwitchState;
      partial.on = s.power === 1;
    }

    Object.assign(dev.state, partial);
    this.emit('state', cfg.id, partial);
  }
}

// Breeze constructor starts an async local-file read for remote capabilities.
// Resolve when it emits 'capabilities', reject on error or timeout.
function waitForCapabilities(sw: SwitcherInstance): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((sw as any).remote_capabilities) { resolve(); return; }
    const ee = sw as unknown as EventEmitter;
    const t = setTimeout(() => { cleanup(); reject(new Error('capabilities timeout')); }, 5000);
    const onCaps = () => { cleanup(); resolve(); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    function cleanup() { clearTimeout(t); ee.removeListener('capabilities', onCaps); ee.removeListener('error', onErr); }
    ee.once('capabilities', onCaps);
    ee.once('error', onErr);
  });
}

function switcherTypeToMatterType(type: string): string {
  if (type === 'breeze') return 'thermostat';
  if (type?.includes('runner')) return 'windowCovering';
  return 'light';
}

function switcherModeToDevice(mode: string): DeviceState['mode'] {
  switch (mode?.toUpperCase()) {
    case 'COOL': return 'cool';
    case 'HEAT': return 'heat';
    case 'FAN':  return 'fan';
    default:     return 'cool';
  }
}

function deviceModeToSwitcher(mode: DeviceState['mode']): string {
  switch (mode) {
    case 'heat': return 'HEAT';
    case 'fan':  return 'FAN';
    default:     return 'COOL';
  }
}

// Type stubs for switcher-js2 JS objects
interface SwitcherMessage {
  device_id: string;
  device_ip: string;
  name: string;
  type: string;
  remote?: string;
  device_key?: string;
  device_mac?: string;
  state?: BreezeState | RunnerState | SwitchState;
}

interface BreezeState {
  power: 'ON' | 'OFF';
  current_temp: number;
  target_temp: number;
  mode: string;
  fan_level: string;
  swing: string;
}

interface RunnerState {
  position: number;
  direction: number;
  child_lock: boolean;
}

interface SwitchState {
  power: 0 | 1;   // extract_switch_state() / extract_heater_state() return numeric 0/1
  remaining_seconds: number;
  power_consumption: number;
}

interface LightState {
  light1_power: 'ON' | 'OFF';
  light2_power?: 'ON' | 'OFF';
  light3_power?: 'ON' | 'OFF';
}

interface SwitcherInstance {
  turn_on(): Promise<void>;
  turn_off(): Promise<void>;
  set_light(power: boolean, index: number): Promise<void>;
  set_breeze_command(state: { power: string; mode: string; fan_level: string; target_temp: number }): void;
  set_position(pos: number): void;
  close(): void;
}
