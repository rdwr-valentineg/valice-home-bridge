# home-bridge

Custom Matter bridge exposing home devices to Apple Home and Google Home.
See the private deployment plan (not in this repo) for the full implementation plan.

## Stack

Node 22 + TypeScript + matter.js (`@matter/main` v0.12)

## Run

```bash
npm start              # run with tsx (dev)
npm run dev            # tsx watch mode (auto-restart on changes)
```

## Key patterns

- **Adapter interface** (`src/core/device.ts`): each integration implements `start/stop/devices/on/command`
- **DeviceRegistry** (`src/core/registry.ts`): holds adapters, forwards state changes, finds devices by ID
- **MatterBridge** (`src/core/matter/server.ts`): creates ServerNode, adds AggregatorEndpoint, maps devices to Matter endpoints
- **Device IDs are stable and config-driven** — never based on discovery order. Matter endpoint numbers persist across restarts.

## Adding a new adapter

1. Create `src/adapters/<name>/index.ts` implementing `Adapter`
2. Add `adapter: '<name>'` to device entries in `config/config.yaml`
3. Instantiate and `registry.register()` in `src/main.ts`

## Switcher adapter notes

- Uses `Switcher.listen(log)` (static factory) for continuous UDP state broadcasts — no polling needed
- Device `id` in config must match the 6-hex Switcher `device_id` seen in UDP broadcasts (find it by running the bridge with a log line added, or via the homebridge-switcher-platform logs)
- Commands create short-lived TCP connections — no persistent socket per device
- Breeze (AC) → `type: thermostat`, Runner (blinds) → `type: windowCovering`, V4/Touch (switch) → `type: light`
- `new Switcher(id, ip, log, listen, type, remote, token, key)`: `token` = Base64 GetKey token (sl0x/s11/s12/heater only; library converts via `he()`), `key` = UDP `device_key` (needed by old-protocol `_login()` for power_plug/v2/v3/v4/mini). Don't swap them.
- `openBasicCommissioningWindow` is the correct matter.js v0.12 API (not `openEnhancedCommissioningWindow`)

## Phases

- Phase 1 ✅ Skeleton + fake device → pairs to Apple Home
- Phase 2 MQTT adapter (Zigbee2MQTT devices via Mosquitto)
- Phase 3 ✅ Switcher adapter (AC thermostat + blinds windowCovering + V4 switch/light)
- Phase 4 Bosch Home Connect adapter
- Phase 5 Deploy: Docker Compose + keepalived on two Raspberry Pis

## Matter device mapping

| Our type | Matter device type |
|---|---|
| light | OnOffLight (0x100) |
| thermostat | Thermostat (to add) |
| windowCovering | WindowCovering (to add) |
| contactSensor | ContactSensor (to add) |

## Data directory (`/data/matter/`)

- `credentials.json` — passcode + discriminator (generated once)
- `home-bridge/` — matter.js storage (fabric keys, endpoint numbers, subscriptions)

All state under `/data/` is synced to the standby Pi every 2 minutes by keepalived sync script.
