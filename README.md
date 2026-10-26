# home-bridge

A custom Matter bridge that exposes home devices to Apple Home and Google Home.
It is built on [matter.js](https://github.com/project-chip/matter.js) (`@matter/main` v0.12) and written in TypeScript.

Supported integrations:

- **Switcher** (Wi-Fi/UDP devices): Breeze AC units as thermostats, Runner motorised blinds as window coverings, V4/Touch power switches as lights
- **Zigbee2MQTT** devices over MQTT
- **Tasmota** devices over MQTT
- Bosch **Home Connect**: planned, not implemented yet

## Features

- Matter bridge with an aggregator endpoint, one bridged endpoint per configured device
- Device IDs come from config, so Matter endpoint numbers stay stable across restarts
- Switcher devices are picked up from continuous UDP broadcasts, with no polling
- Discovery in the admin UI: Switcher devices seen on the network (with their IDs), and Zigbee2MQTT devices reported by the MQTT broker, which can be added from the UI
- Pairing via a commissioning window opened from the admin UI (manual code and QR code)
- Web admin UI to add, edit, and remove devices, view status and logs, and restart the bridge

## Requirements

- Node.js 22 or newer
- An MQTT broker (for example Mosquitto), optional and only needed for the MQTT adapter
- Network access that allows UDP discovery (Switcher) and mDNS (Matter). Docker Compose uses host networking for this.

## Quick start

### Run locally

```bash
npm ci
cp config/config.example.yaml config/config.yaml
# edit config/config.yaml: set matter.storage to a writable directory, add devices
npm run dev            # or: npm start
```

Then open the admin UI at `http://localhost:8081`.

### Run with Docker Compose

```bash
cp .env.example .env
# edit .env: NFS server address and export paths used by docker-compose.yaml
docker compose up -d --build
```

The compose file mounts two volumes, one for `/app/config` and one for `/data/matter`, and passes `CONFIG_PATH=/app/config/config.yaml`.

## Configuration

Configuration lives in a YAML file. The path comes from `CONFIG_PATH` and defaults to `config/config.yaml`. If that file does not exist, the example config is copied to it on startup.

| Key | Type | Default | Env override | Description |
|---|---|---|---|---|
| `matter.storage` | path | (required) | — | Directory for Matter identity, fabric keys, and endpoint numbers. Must persist. |
| `matter.port` | int | `5540` | `MATTER_PORT` | Matter UDP port. |
| `admin.port` | int | `8081` | `ADMIN_PORT` | Admin UI and API HTTP port. |
| `admin.host` | string | unset (all interfaces) | `ADMIN_HOST` | Address to bind the admin server to. Use `127.0.0.1` to keep it local. |
| `admin.maxBodyBytes` | int | `65536` (64 KiB) | `ADMIN_MAX_BODY_BYTES` | Maximum request body size accepted by the admin API. Larger bodies get `413`. |
| `mqtt.broker` | URL | unset (MQTT disabled) | — | MQTT broker URL, for example `mqtt://user:password@host:1883`. |
| `devices` | list | `[]` | — | Device entries (see below). |

Environment variables override config values. An empty or invalid value (not an integer in range) is ignored with a warning, and the config value or default is used.

Ports must be integers from 1 to 65535. The `ADMIN_MAX_BODY_BYTES` value must be a positive integer.

### Device examples

Every device needs `id`, `adapter`, `type`, and `label`. `room` is optional.

Switcher (Breeze AC as a thermostat, Runner blinds as a window covering, V4/Touch switch as a light):

```yaml
devices:
  # Switcher Breeze (AC unit). Find the device_id with the Discover button in the admin UI.
  - id: "aabb01"
    adapter: switcher
    type: thermostat
    label: "Living Room AC"
    room: "Living Room"

  # Switcher Runner (motorised blinds)
  - id: "aabb02"
    adapter: switcher
    type: windowCovering
    label: "Living Room Blinds"
    room: "Living Room"

  # Switcher V4 / Touch (power switch)
  - id: "aabb03"
    adapter: switcher
    type: light
    label: "Bedroom Light"
    room: "Bedroom"
```

Zigbee2MQTT and Tasmota (both need `mqtt.broker`):

```yaml
mqtt:
  broker: "mqtt://user:password@192.0.2.10:1883"

devices:
  # Zigbee2MQTT: subscribes zigbee2mqtt/<mqttName>, publishes zigbee2mqtt/<mqttName>/set
  - id: office-light
    adapter: mqtt
    type: light
    label: "Office Light"
    room: "Office"
    protocol: z2m
    mqttName: "office_light"   # friendly name in Zigbee2MQTT

  # Tasmota: subscribes stat/<mqttName>/RESULT and tele/<mqttName>/STATE
  - id: kitchen-plug
    adapter: mqtt
    type: light
    label: "Kitchen Plug"
    room: "Kitchen"
    protocol: tasmota
    mqttName: "tasmota_kitchen"  # Tasmota device topic name
```

Supported device `type` values: `light`, `thermostat`, `windowCovering`. `contactSensor` is listed in the config types but has no Matter mapping yet.

### Switcher token

Some Switcher models need a token: sl01, sl02, sl03, s11, s12, and heater. Get the Base64 token from the Switcher GetKey page (`switcher.co.il/GetKey`) and set it as `token` on the device. Without a token, commands to those devices fail with an error that names the device.

## Admin UI

The admin UI is served on `admin.port`. It shows:

- Pairing status, with a button that opens a Matter commissioning window and displays the manual code and QR code
- The list of configured devices, with edit and remove actions
- Switcher devices seen on the network, and Zigbee2MQTT devices reported by the broker that can be added to the config
- A form to add a Tasmota device
- A log viewer for the most recent console output
- A restart button for the bridge

Admin API routes: `GET /healthz`, `POST /api/commission`, `GET /api/discover`, `GET /api/mqtt/discovered`, `GET|POST /api/config/devices`, `PATCH|DELETE /api/config/devices/:id`, `POST /api/restart`.

Changes made in the admin UI are written back to the config file.

## Data and storage

`matter.storage` (`/data/matter` in the Docker setup) holds:

- `credentials.json`: the commissioning passcode and discriminator, generated once
- `home-bridge/`: matter.js storage with fabric keys, endpoint numbers, and subscriptions

Keep this directory persistent. Losing it means the bridge gets a new identity and every device must be paired again. Treat it as secret: anyone with the fabric keys can control the bridge's fabrics. Do not commit it or share it, and restrict its file permissions.

The config file can contain MQTT credentials and Switcher tokens, so it is also sensitive.

## Security

**The admin UI and API have no authentication.** Anyone who can reach the admin port can read the device list, add, edit, or remove devices, open a Matter commissioning window, and restart the bridge.

- Only expose the admin port on a trusted network.
- Bind it to a local address with `admin.host` (or `ADMIN_HOST`), for example `127.0.0.1`, and reach it through an SSH tunnel or a trusted reverse proxy if you need remote access.
- Do not forward the admin port through a router or publish it to the internet.
- Request bodies are capped by `admin.maxBodyBytes` (64 KiB by default) to limit memory use. This is not an access control.

## Development

```bash
npm run build          # tsc
npx tsc --noEmit       # typecheck only
npm run dev            # run with tsx in watch mode
```

## License

MIT. See [LICENSE](LICENSE).
