import { ServerNode, CommissioningServer } from '@matter/main';
import { DeviceCommissioner } from '@matter/protocol';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { ThermostatDevice } from '@matter/main/devices/thermostat';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import { ThermostatServer } from '@matter/main/behaviors/thermostat';
import { WindowCoveringServer } from '@matter/main/behaviors/window-covering';
import { Thermostat } from '@matter/main/clusters/thermostat';
import { WindowCovering } from '@matter/main/clusters/window-covering';
import { NodeJsEnvironment } from '@matter/nodejs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Device, DeviceCommand } from '../device.js';
import type { DeviceRegistry } from '../registry.js';

const BridgedLight = OnOffLightDevice.with(BridgedDeviceBasicInformationServer);

const BridgedThermostat = ThermostatDevice.with(
  BridgedDeviceBasicInformationServer,
  ThermostatServer.with(Thermostat.Feature.Cooling, Thermostat.Feature.Heating),
);

const BridgedWindowCovering = WindowCoveringDevice.with(
  BridgedDeviceBasicInformationServer,
  WindowCoveringServer.with(WindowCovering.Feature.Lift, WindowCovering.Feature.PositionAwareLift),
);

interface MatterConfig {
  storage: string;
  port: number;
}

function loadOrCreateCredentials(storagePath: string): { passcode: number; discriminator: number } {
  const credFile = join(storagePath, 'credentials.json');
  if (existsSync(credFile)) {
    return JSON.parse(readFileSync(credFile, 'utf8'));
  }
  const creds = {
    passcode: 10000000 + Math.floor(Math.random() * 89999999),
    discriminator: Math.floor(Math.random() * 4096),
  };
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(credFile, JSON.stringify(creds, null, 2));
  return creds;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEndpoint = any;

export class MatterBridge {
  private server!: ServerNode;
  private aggregator!: AnyEndpoint;
  private readonly endpointMap = new Map<string, AnyEndpoint>();

  // Prevents $Changed events from triggering commands back to devices while
  // we're pushing state changes from UDP broadcasts into Matter.
  private readonly suppressingStateSync = new Set<string>();

  constructor(
    private readonly config: MatterConfig,
    private readonly registry: DeviceRegistry,
  ) {}

  async start(): Promise<void> {
    const { passcode, discriminator } = loadOrCreateCredentials(this.config.storage);

    const env = NodeJsEnvironment();
    env.vars.set('path.root', this.config.storage);

    this.server = await ServerNode.create({
      id: 'home-bridge',
      environment: env,
      commissioning: { passcode, discriminator },
      network: { port: this.config.port },
      productDescription: { name: 'Home Bridge' },
    });

    this.aggregator = await this.server.add(AggregatorEndpoint, { id: 'aggregator' });

    for (const device of this.registry.allDevices()) {
      if (device.type === 'light') {
        await this.addLight(device);
      } else if (device.type === 'thermostat') {
        await this.addThermostat(device);
      } else if (device.type === 'windowCovering') {
        await this.addWindowCovering(device);
      }
    }

    await this.server.start();

    // Register event handlers and state-sync AFTER server.start() so that
    // $Changed events fired during endpoint initialization don't trigger
    // commands to physical devices.
    this.wireCommandHandlers();
    this.registry.onStateChange(this.handleStateChange.bind(this));
  }

  private wireCommandHandlers(): void {
    for (const [id, ep] of this.endpointMap) {
      const device = this.registry.findDevice(id);
      if (!device) continue;

      if (device.type === 'light') {
        ep.events.onOff.onOff$Changed.on(async (value: boolean) => {
          if (this.suppressingStateSync.has(id)) return;
          await this.sendCommand(id, { type: 'setOn', value });
        });

      } else if (device.type === 'thermostat') {
        ep.events.thermostat.occupiedCoolingSetpoint$Changed.on(async (value: number) => {
          if (this.suppressingStateSync.has(id)) return;
          await this.sendCommand(id, { type: 'setSetpoint', value: value / 100 });
        });
        ep.events.thermostat.occupiedHeatingSetpoint$Changed.on(async (value: number) => {
          if (this.suppressingStateSync.has(id)) return;
          await this.sendCommand(id, { type: 'setSetpoint', value: value / 100 });
        });
        ep.events.thermostat.systemMode$Changed.on(async (value: Thermostat.SystemMode) => {
          if (this.suppressingStateSync.has(id)) return;
          await this.sendCommand(id, { type: 'setMode', value: systemModeToMode(value) });
        });

      } else if (device.type === 'windowCovering') {
        ep.events.windowCovering.targetPositionLiftPercent100ths$Changed.on(async (value: number) => {
          if (this.suppressingStateSync.has(id)) return;
          await this.sendCommand(id, { type: 'setPosition', value: Math.round(value / 100) });
        });
      }
    }
  }

  private async sendCommand(deviceId: string, cmd: DeviceCommand): Promise<void> {
    const adapter = this.registry.findAdapter(deviceId);
    if (!adapter) return;
    await adapter.command(deviceId, cmd).catch(err =>
      console.error(`[matter] command to ${deviceId} failed:`, err)
    );
  }

  private async handleStateChange(deviceId: string): Promise<void> {
    const device = this.registry.findDevice(deviceId);
    const ep = this.endpointMap.get(deviceId);
    if (!device || !ep) return;

    this.suppressingStateSync.add(deviceId);
    try {
      if (device.type === 'light') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ep.act((agent: any) => {
          if (device.state.on !== undefined) agent.onOff.state.onOff = device.state.on;
          agent.bridgedDeviceBasicInformation.state.reachable = device.state.reachable;
        });

      } else if (device.type === 'thermostat') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ep.act((agent: any) => {
          const th = agent.thermostat.state;
          if (device.state.currentTemp !== undefined) {
            th.localTemperature = Math.round(device.state.currentTemp * 100);
          }
          if (device.state.setpoint !== undefined) {
            const sp = Math.round(device.state.setpoint * 100);
            th.occupiedCoolingSetpoint = sp;
            th.occupiedHeatingSetpoint = sp;
          }
          th.systemMode = modeToSystemMode(device.state.mode);
          agent.bridgedDeviceBasicInformation.state.reachable = device.state.reachable;
        });

      } else if (device.type === 'windowCovering' && device.state.position !== undefined) {
        const pos100ths = Math.round(device.state.position * 100);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ep.act((agent: any) => {
          agent.windowCovering.state.currentPositionLiftPercent100ths = pos100ths;
          agent.bridgedDeviceBasicInformation.state.reachable = device.state.reachable;
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('synchronously')) {
        console.error(`[matter] state update for ${deviceId} failed:`, msg);
      }
    } finally {
      // Flush microtask queue before clearing the flag so any synchronous
      // $Changed events fired inside ep.act() are still suppressed.
      await Promise.resolve();
      this.suppressingStateSync.delete(deviceId);
    }
  }

  private async addLight(device: Device): Promise<void> {
    const endpoint = await this.aggregator.add(BridgedLight, {
      id: device.id,
      bridgedDeviceBasicInformation: {
        nodeLabel: device.label,
        reachable: device.state.reachable,
      },
      onOff: { onOff: device.state.on ?? false },
    });
    this.endpointMap.set(device.id, endpoint);
  }

  private async addThermostat(device: Device): Promise<void> {
    const endpoint = await this.aggregator.add(BridgedThermostat, {
      id: device.id,
      bridgedDeviceBasicInformation: {
        nodeLabel: device.label,
        reachable: device.state.reachable,
      },
      thermostat: {
        localTemperature: device.state.currentTemp !== undefined
          ? Math.round(device.state.currentTemp * 100) : null,
        occupiedCoolingSetpoint: Math.round((device.state.setpoint ?? 24) * 100),
        occupiedHeatingSetpoint: Math.round((device.state.setpoint ?? 22) * 100),
        systemMode: modeToSystemMode(device.state.mode),
        controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
        minCoolSetpointLimit: 1600,
        maxCoolSetpointLimit: 3200,
        minHeatSetpointLimit: 1600,
        maxHeatSetpointLimit: 3200,
      },
    });
    this.endpointMap.set(device.id, endpoint);
  }

  private async addWindowCovering(device: Device): Promise<void> {
    const pos100ths = Math.round((device.state.position ?? 0) * 100);
    const endpoint = await this.aggregator.add(BridgedWindowCovering, {
      id: device.id,
      bridgedDeviceBasicInformation: {
        nodeLabel: device.label,
        reachable: device.state.reachable,
      },
      windowCovering: {
        currentPositionLiftPercent100ths: pos100ths,
        targetPositionLiftPercent100ths: pos100ths,
      },
    });
    this.endpointMap.set(device.id, endpoint);
  }

  pairingCodes(): { manualPairingCode: string; qrPairingCode: string } {
    return CommissioningServer.pairingCodesFor(this.server);
  }

  isCommissioned(): boolean {
    return this.server.state.commissioning.commissioned;
  }

  async openCommissioningWindow(): Promise<void> {
    // openBasicCommissioningWindow via act() requires a live Matter session (associatedFabric),
    // which we don't have when calling from the admin HTTP server. Use DeviceCommissioner directly.
    const commissioner = this.server.env.get(DeviceCommissioner);
    await commissioner.allowBasicCommissioning();
  }

  async stop(): Promise<void> {
    await this.server.cancel();
  }
}

function modeToSystemMode(mode: Device['state']['mode']): Thermostat.SystemMode {
  switch (mode) {
    case 'cool': return Thermostat.SystemMode.Cool;
    case 'heat': return Thermostat.SystemMode.Heat;
    case 'fan':  return Thermostat.SystemMode.FanOnly;
    case 'off':  return Thermostat.SystemMode.Off;
    default:     return Thermostat.SystemMode.Off;
  }
}

function systemModeToMode(mode: Thermostat.SystemMode): Device['state']['mode'] {
  switch (mode) {
    case Thermostat.SystemMode.Cool:    return 'cool';
    case Thermostat.SystemMode.Heat:    return 'heat';
    case Thermostat.SystemMode.FanOnly: return 'fan';
    default:                            return 'off';
  }
}
