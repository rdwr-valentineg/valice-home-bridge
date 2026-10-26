import EventEmitter from 'events';
import mqtt from 'mqtt';
import type { Adapter, Device, DeviceState, DeviceCommand, DeviceType } from '../../core/device.js';

export interface MqttDeviceConfig {
  id: string;
  type: DeviceType;
  label: string;
  room?: string;
  protocol: 'z2m' | 'tasmota';
  mqttName: string;
}

interface Z2MExpose {
  type: string;
  name?: string;
  features?: Z2MExpose[];
}

export interface Z2MDiscoveredDevice {
  ieee_address: string;
  friendly_name: string;
  deviceType: string;   // Router, EndDevice, etc.
  supported: boolean;
  disabled: boolean;
  suggestedType: DeviceType | null;
  vendor?: string;
  model?: string;
  description?: string;
}

const log = (...args: unknown[]) => console.log('[mqtt]', ...args);

// Mask the password in a broker URL so credentials never reach logs.
const redactBrokerUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/([^:/]*):[^/]*@/, '//$1:***@');
  }
};

export class MqttAdapter extends EventEmitter implements Adapter {
  readonly id = 'mqtt';
  private devices_: Map<string, Device> = new Map();
  private client: mqtt.MqttClient | null = null;
  private z2mDiscovered: Map<string, Z2MDiscoveredDevice> = new Map();
  private readyResolve!: () => void;
  private readyPromise: Promise<void> = new Promise(r => { this.readyResolve = r; });

  constructor(
    private readonly brokerUrl: string,
    private readonly configs: MqttDeviceConfig[],
  ) {
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
    this.client = mqtt.connect(this.brokerUrl);

    this.client.on('connect', () => {
      log(`connected to ${redactBrokerUrl(this.brokerUrl)}`);
      this.client!.subscribe('zigbee2mqtt/bridge/devices', err => {
        if (err) log('subscribe error zigbee2mqtt/bridge/devices:', err.message);
      });
      for (const cfg of this.configs) {
        for (const topic of stateTopics(cfg)) {
          this.client!.subscribe(topic, err => {
            if (err) log(`subscribe error ${topic}:`, err.message);
          });
        }
      }
      // Request current state from all devices so we don't wait for a spontaneous update.
      // Resolve readyPromise after the requests go out so callers can await initialization.
      setTimeout(() => {
        this.requestInitialStates();
        this.readyResolve();
      }, 1500);
    });

    this.client.on('error', (err) => log('error:', err.message));
    this.client.on('message', (topic, payload) => this.handleMessage(topic, payload.toString()));

    log(`starting with ${this.configs.length} device(s):`, this.configs.map(c => c.id).join(', '));
  }

  async stop(): Promise<void> {
    if (this.client) {
      await new Promise<void>((resolve, reject) => this.client!.end(false, {}, (err?: Error) => err ? reject(err) : resolve()));
      this.client = null;
    }
  }

  devices(): Device[] {
    return Array.from(this.devices_.values());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: any, cb: (...args: any[]) => void): this {
    return super.on(event, cb);
  }

  getZ2mDiscoveredDevices(): Z2MDiscoveredDevice[] {
    return Array.from(this.z2mDiscovered.values());
  }

  waitForReady(timeoutMs = 6000): Promise<void> {
    return Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('mqtt ready timeout')), timeoutMs)),
    ]);
  }

  private requestInitialStates(): void {
    for (const cfg of this.configs) {
      if (cfg.protocol === 'z2m') {
        // Z2M responds to an empty get request with full current state
        this.client!.publish(`zigbee2mqtt/${cfg.mqttName}/get`, '{}');
      } else {
        // Tasmota: empty POWER command acts as a GET and returns current state
        this.client!.publish(`cmnd/${cfg.mqttName}/POWER`, '');
      }
    }
    log(`requested initial state for ${this.configs.length} device(s)`);
  }

  async command(deviceId: string, cmd: DeviceCommand): Promise<void> {
    if (!this.client) throw new Error('[mqtt] not connected');
    const cfg = this.configs.find(c => c.id === deviceId);
    if (!cfg) throw new Error(`[mqtt] unknown device ${deviceId}`);

    const dev = this.devices_.get(deviceId)!;

    if (cfg.protocol === 'z2m') {
      await this.z2mCommand(cfg, dev, cmd);
    } else {
      await this.tasmotaCommand(cfg, dev, cmd);
    }
  }

  private publish(topic: string, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payload, err => err ? reject(err) : resolve());
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async z2mCommand(cfg: MqttDeviceConfig, _dev: Device, cmd: DeviceCommand): Promise<void> {
    const topic = `zigbee2mqtt/${cfg.mqttName}/set`;
    switch (cmd.type) {
      case 'setOn':
        await this.publish(topic, JSON.stringify({ state: cmd.value ? 'ON' : 'OFF' }));
        break;
      case 'toggle':
        await this.publish(topic, JSON.stringify({ state: 'TOGGLE' }));
        break;
      case 'setBrightness':
        await this.publish(topic, JSON.stringify({ brightness: Math.round(cmd.value * 2.54) }));
        break;
      case 'setMode':
        await this.publish(topic, JSON.stringify({ system_mode: cmd.value === 'off' ? 'off' : cmd.value }));
        break;
      case 'setSetpoint':
        await this.publish(topic, JSON.stringify({ occupied_heating_setpoint: cmd.value }));
        break;
      case 'setPosition':
        await this.publish(topic, JSON.stringify({ position: cmd.value }));
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async tasmotaCommand(cfg: MqttDeviceConfig, _dev: Device, cmd: DeviceCommand): Promise<void> {
    switch (cmd.type) {
      case 'setOn':
        await this.publish(`cmnd/${cfg.mqttName}/POWER`, cmd.value ? 'ON' : 'OFF');
        break;
      case 'toggle':
        await this.publish(`cmnd/${cfg.mqttName}/POWER`, 'TOGGLE');
        break;
      case 'setBrightness':
        await this.publish(`cmnd/${cfg.mqttName}/Dimmer`, String(cmd.value));
        break;
      case 'setPosition':
        await this.publish(`cmnd/${cfg.mqttName}/ShutterPosition1`, String(cmd.value));
        break;
      default:
        log(`unhandled command type for tasmota: ${cmd.type}`);
    }
  }

  private handleMessage(topic: string, payload: string): void {
    if (topic === 'zigbee2mqtt/bridge/devices') {
      this.handleZ2mBridgeDevices(payload);
      return;
    }
    for (const cfg of this.configs) {
      if (cfg.protocol === 'z2m') {
        this.handleZ2mMessage(cfg, topic, payload);
      } else {
        this.handleTasmotaMessage(cfg, topic, payload);
      }
    }
  }

  private handleZ2mBridgeDevices(payload: string): void {
    let devices: unknown[];
    try { devices = JSON.parse(payload); } catch { return; }
    if (!Array.isArray(devices)) return;

    for (const d of devices as Record<string, unknown>[]) {
      if (d.type === 'Coordinator') continue;
      const exposes = ((d.definition as Record<string, unknown>)?.exposes ?? []) as Z2MExpose[];
      this.z2mDiscovered.set(d.ieee_address as string, {
        ieee_address: d.ieee_address as string,
        friendly_name: d.friendly_name as string,
        deviceType: d.type as string,
        supported: (d.supported as boolean) ?? false,
        disabled: (d.disabled as boolean) ?? false,
        suggestedType: guessDeviceType(exposes),
        vendor: (d.definition as Record<string, unknown>)?.vendor as string | undefined,
        model: (d.definition as Record<string, unknown>)?.model as string | undefined,
        description: (d.definition as Record<string, unknown>)?.description as string | undefined,
      });
    }
    log(`discovered ${this.z2mDiscovered.size} z2m device(s) from bridge`);
  }

  private handleZ2mMessage(cfg: MqttDeviceConfig, topic: string, payload: string): void {
    if (topic === `zigbee2mqtt/${cfg.mqttName}/availability`) {
      let online = false;
      try { online = (JSON.parse(payload) as Record<string, unknown>).state === 'online'; }
      catch { online = payload.trim() === 'online'; }  // legacy plain-text format
      const dev = this.devices_.get(cfg.id)!;
      const partial: Partial<DeviceState> = { reachable: online };
      Object.assign(dev.state, partial);
      this.emit('state', cfg.id, partial);
      return;
    }
    if (topic !== `zigbee2mqtt/${cfg.mqttName}`) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(payload); } catch { return; }

    const dev = this.devices_.get(cfg.id)!;
    const partial: Partial<DeviceState> = { reachable: true };

    if ('state' in msg) partial.on = msg.state === 'ON';
    if ('brightness' in msg) partial.brightness = Math.round((msg.brightness as number) / 2.54);
    if ('position' in msg) partial.position = msg.position as number;
    if ('local_temperature' in msg) partial.currentTemp = msg.local_temperature as number;
    if ('occupied_heating_setpoint' in msg) partial.setpoint = msg.occupied_heating_setpoint as number;
    if ('system_mode' in msg) partial.mode = (msg.system_mode === 'off' ? 'off' : msg.system_mode) as DeviceState['mode'];
    if ('contact' in msg) partial.contact = msg.contact as boolean;

    Object.assign(dev.state, partial);
    this.emit('state', cfg.id, partial);
  }

  private handleTasmotaMessage(cfg: MqttDeviceConfig, topic: string, payload: string): void {
    if (topic === `tele/${cfg.mqttName}/LWT`) {
      const online = payload.trim() === 'Online';
      const dev = this.devices_.get(cfg.id)!;
      const partial: Partial<DeviceState> = { reachable: online };
      Object.assign(dev.state, partial);
      this.emit('state', cfg.id, partial);
      return;
    }
    const powerTopic = `stat/${cfg.mqttName}/POWER`;
    const resultTopic = `stat/${cfg.mqttName}/RESULT`;
    if (topic !== powerTopic && topic !== resultTopic) return;

    const dev = this.devices_.get(cfg.id)!;
    const partial: Partial<DeviceState> = { reachable: true };

    if (topic === powerTopic) {
      partial.on = payload.trim() === 'ON';
    } else {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(payload); } catch { return; }
      const power = (msg.POWER ?? msg.POWER1) as string | undefined;
      if (power !== undefined) partial.on = power === 'ON';
      if (msg.Dimmer !== undefined) partial.brightness = msg.Dimmer as number;
      if (msg.Shutter1 && typeof msg.Shutter1 === 'object') {
        partial.position = (msg.Shutter1 as Record<string, unknown>).Position as number;
      }
    }

    Object.assign(dev.state, partial);
    this.emit('state', cfg.id, partial);
  }
}

function stateTopics(cfg: MqttDeviceConfig): string[] {
  if (cfg.protocol === 'z2m') {
    return [
      `zigbee2mqtt/${cfg.mqttName}`,
      `zigbee2mqtt/${cfg.mqttName}/availability`,  // Z2M publishes online/offline on broker connect
    ];
  }
  return [
    `stat/${cfg.mqttName}/POWER`,
    `stat/${cfg.mqttName}/RESULT`,
    `tele/${cfg.mqttName}/LWT`,  // Tasmota last-will: "Online" / "Offline"
  ];
}

function guessDeviceType(exposes: Z2MExpose[]): DeviceType | null {
  for (const e of exposes) {
    if (e.type === 'light') return 'light';
    if (e.type === 'switch') return 'light';
    if (e.type === 'cover') return 'windowCovering';
    if (e.type === 'climate') return 'thermostat';
    if (e.type === 'binary_sensor' && e.name === 'contact') return 'contactSensor';
  }
  return null;
}
