import { readFileSync, existsSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { DeviceRegistry } from './core/registry.js';
import { MatterBridge } from './core/matter/server.js';
import { FakeAdapter } from './adapters/fake/index.js';
import { SwitcherAdapter } from './adapters/switcher/index.js';
import { MqttAdapter } from './adapters/mqtt/index.js';
import { startAdminServer, patchConsoleToBuffer } from './admin/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DeviceConfig {
  id: string;
  adapter: 'fake' | 'mqtt' | 'switcher' | 'homeconnect';
  type: 'light' | 'thermostat' | 'windowCovering' | 'contactSensor';
  label: string;
  room?: string;
  // switcher-specific
  token?: string;
  // mqtt-specific
  protocol?: 'z2m' | 'tasmota';
  mqttName?: string;
}

export interface AppConfig {
  matter: { storage: string; port?: number };
  admin: { port?: number; host?: string; maxBodyBytes?: number };
  mqtt?: { broker: string };
  devices: DeviceConfig[];
}

// Single source of truth for optional port/limit defaults.
export const DEFAULTS = {
  matterPort: 5540,
  adminPort: 8081,
  adminMaxBodyBytes: 64 * 1024,
} as const;

const MAX_PORT = 65535;

// Env var wins over config value; invalid or empty env values are ignored with a warning.
function resolveInt(envName: string, configValue: number | undefined, fallback: number, max: number): number {
  const raw = process.env[envName];
  if (raw !== undefined) {
    const n = Number(raw.trim());
    if (raw.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= max) return n;
    console.warn(`[main] ignoring ${envName}="${raw}" (expected integer 1-${max})`);
  }
  return configValue ?? fallback;
}

function loadConfig(configPath: string): AppConfig {
  const fallback = resolve(__dirname, '../config/config.example.yaml');

  if (!existsSync(configPath) && existsSync(fallback)) {
    console.warn(`[main] ${configPath} not found, using example config`);
    copyFileSync(fallback, configPath);
    return yaml.load(readFileSync(fallback, 'utf8')) as AppConfig;
  }

  return yaml.load(readFileSync(configPath, 'utf8')) as AppConfig;
}

async function main(): Promise<void> {
  patchConsoleToBuffer();

  const configPath = process.env.CONFIG_PATH ?? resolve(__dirname, '../config/config.yaml');
  const config = loadConfig(configPath);
  const registry = new DeviceRegistry();

  const fakeDevices = config.devices.filter(d => d.adapter === 'fake');
  if (fakeDevices.length > 0) {
    registry.register(new FakeAdapter(fakeDevices.map(d => ({
      id: d.id,
      label: d.label,
      room: d.room,
    }))));
  }

  let switcherAdapter: SwitcherAdapter | undefined;
  const switcherDevices = config.devices.filter(d => d.adapter === 'switcher');
  if (switcherDevices.length > 0) {
    switcherAdapter = new SwitcherAdapter(switcherDevices.map(d => ({
      id: d.id,
      type: d.type,
      label: d.label,
      room: d.room,
      token: d.token,
    })));
    registry.register(switcherAdapter);
  }

  // Create MQTT adapter if broker is configured (even with no devices — enables discovery)
  let mqttAdapter: MqttAdapter | undefined;
  if (config.mqtt?.broker) {
    const mqttDevices = config.devices.filter(d => d.adapter === 'mqtt');
    mqttAdapter = new MqttAdapter(config.mqtt.broker, mqttDevices.map(d => ({
      id: d.id,
      type: d.type,
      label: d.label,
      room: d.room,
      protocol: d.protocol ?? 'z2m',
      mqttName: d.mqttName ?? d.id,
    })));
    registry.register(mqttAdapter);
  }

  // TODO Phase 4: homeconnect adapter

  await registry.startAll();

  // Wait for MQTT to connect and fire initial state requests before creating Matter
  // endpoints — retained messages update device.state.reachable so endpoints start
  // with the correct reachable=true, avoiding the "unreachable after restart" race.
  if (mqttAdapter) {
    await mqttAdapter.waitForReady().catch(e => console.warn('[main] MQTT ready timeout:', e.message));
  }

  const matterPort = resolveInt('MATTER_PORT', config.matter.port, DEFAULTS.matterPort, MAX_PORT);
  const adminPort = resolveInt('ADMIN_PORT', config.admin.port, DEFAULTS.adminPort, MAX_PORT);
  const adminHost = process.env.ADMIN_HOST?.trim() || config.admin.host || undefined;
  const adminMaxBodyBytes = resolveInt(
    'ADMIN_MAX_BODY_BYTES', config.admin.maxBodyBytes, DEFAULTS.adminMaxBodyBytes, Number.MAX_SAFE_INTEGER,
  );

  const bridge = new MatterBridge(
    { storage: config.matter.storage, port: matterPort },
    registry,
  );
  await bridge.start();

  startAdminServer(adminPort, adminHost, adminMaxBodyBytes, bridge, registry, configPath, switcherAdapter, mqttAdapter);

  console.log(`[main] bridge running — admin at http://localhost:${adminPort}`);

  const shutdown = async () => {
    console.log('[main] shutting down');
    await bridge.stop();
    await registry.stopAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
