export type DeviceType = 'light' | 'thermostat' | 'windowCovering' | 'contactSensor';

export type FanLevel = 'auto' | 'low' | 'medium' | 'high';

export interface DeviceState {
  reachable: boolean;
  // light
  on?: boolean;
  brightness?: number;      // 0–100
  // thermostat
  mode?: 'cool' | 'heat' | 'fan' | 'off';
  setpoint?: number;        // °C
  currentTemp?: number;     // °C
  // Breeze AC fan/swing, as reported by the device
  fan?: FanLevel;
  swing?: boolean;
  // windowCovering
  position?: number;        // 0=closed, 100=open
  // contactSensor
  contact?: boolean;        // true=closed/normal, false=open/triggered
}

export type DeviceCommand =
  | { type: 'setOn'; value: boolean }
  | { type: 'toggle' }
  | { type: 'setBrightness'; value: number }      // 0–100
  | { type: 'setMode'; value: DeviceState['mode'] }
  | { type: 'setSetpoint'; value: number }
  | { type: 'setPosition'; value: number };       // 0–100

export interface Device {
  readonly id: string;
  readonly type: DeviceType;
  readonly label: string;
  readonly room?: string;
  state: DeviceState;
}

export interface Adapter {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  devices(): Device[];
  on(event: 'state', cb: (deviceId: string, state: Partial<DeviceState>) => void): void;
  command(deviceId: string, cmd: DeviceCommand): Promise<void>;
}
