import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
import QRCode from 'qrcode';
import type { MatterBridge } from '../core/matter/server.js';
import type { DeviceRegistry } from '../core/registry.js';
import type { SwitcherAdapter } from '../adapters/switcher/index.js';
import type { MqttAdapter } from '../adapters/mqtt/index.js';
import type { AppConfig, DeviceConfig } from '../main.js';

const MAX_LOG_LINES = 200;
const logBuffer: string[] = [];

export function patchConsoleToBuffer(): void {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const push = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level}] ${args.join(' ')}`;
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  };
  console.log = (...a) => { push('info', a); original.log(...a); };
  console.error = (...a) => { push('error', a); original.error(...a); };
  console.warn = (...a) => { push('warn', a); original.warn(...a); };
}

class PayloadTooLargeError extends Error {
  constructor() { super('payload too large'); }
}

// Buffers the body as bytes up to maxBytes. Past the limit it stops buffering, rejects with
// PayloadTooLargeError and discards the rest of the stream so the socket can answer 413.
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendPayloadTooLarge(res: ServerResponse): void {
  res.writeHead(413, {'Content-Type':'application/json', 'Connection':'close'})
    .end(JSON.stringify({ error: 'payload too large' }));
}

function readConfig(configPath: string): AppConfig {
  return yaml.load(readFileSync(configPath, 'utf8')) as AppConfig;
}

function writeConfig(configPath: string, cfg: AppConfig): void {
  writeFileSync(configPath, yaml.dump(cfg, { lineWidth: 120, quotingType: '"' }));
}

function adapterTag(adapter: string): string {
  if (adapter === 'switcher') return '<span class="tag tag-switcher">switcher</span>';
  if (adapter === 'mqtt') return '<span class="tag tag-z2m">mqtt</span>';
  return `<span class="tag">${adapter}</span>`;
}

function html(content: string): string {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; margin-bottom: .5rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #e5e5e5; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; }
  th, td { text-align: left; padding: .35rem .75rem; border-bottom: 1px solid #e5e5e5; }
  th { font-weight: 600; background: #f9f9f9; font-size: .85rem; }
  .on { color: #16a34a; font-weight: 600; }
  .off { color: #6b7280; }
  .unreachable { color: #dc2626; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: .78rem; max-height: 400px; overflow-y: scroll; }
  code { background: #f5f5f5; padding: .1rem .3rem; border-radius: 3px; font-size: .82rem; }
  img { display: block; margin: 1rem 0; }
  button { padding: .3rem .8rem; border: 1px solid #d1d5db; background: #fff; color: #1a1a1a; border-radius: 4px; cursor: pointer; margin-right: .3rem; font-size: .82rem; }
  button:hover { background: #f3f4f6; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.primary:hover { background: #1d4ed8; }
  button.danger { background: #dc2626; color: #fff; border-color: #dc2626; }
  button.danger:hover { background: #b91c1c; }
  button:disabled { opacity: .5; cursor: default; }
  .commissioned { background: #dcfce7; padding: .5rem 1rem; border-radius: 4px; color: #166534; display: inline-block; margin: .5rem 0; }
  .pairing { background: #fef9c3; padding: .5rem 1rem; border-radius: 4px; display: inline-block; margin: .5rem 0; }
  .hint { color: #6b7280; font-size: .82rem; }
  .banner { background: #fef3c7; border: 1px solid #f59e0b; padding: .6rem 1rem; border-radius: 4px; margin: .8rem 0; display: flex; align-items: center; gap: 1rem; }
  .banner.hidden { display: none; }
  .top-bar { display: flex; align-items: center; gap: .6rem; margin-bottom: 1rem; }
  input[type=text], select { padding: .28rem .55rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: .82rem; }
  .edit-row td { background: #f8fafc; }
  .edit-form { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .4rem 0; }
  .edit-form label { font-size: .8rem; color: #6b7280; }
  .tag { display: inline-block; padding: .1rem .4rem; border-radius: 3px; font-size: .75rem; font-weight: 600; }
  .tag-z2m { background: #dbeafe; color: #1e40af; }
  .tag-tasmota { background: #fce7f3; color: #9d174d; }
  .tag-switcher { background: #d1fae5; color: #065f46; }
  .add-form-z2m { background: #f8fafc; }
</style></head><body>${content}
<script>
// ── Pending-changes state persisted across reloads ─────────────────
function markPending() { localStorage.setItem('pendingReload', '1'); }
function clearPending() { localStorage.removeItem('pendingReload'); }

window.addEventListener('load', () => {
  if (localStorage.getItem('pendingReload')) {
    document.getElementById('restart-banner').classList.remove('hidden');
  }
  if (document.getElementById('z2m-discovered')) loadMqttDevices();
});

// ── Restart / commissioning ──────────────────────────────────────────
async function restartBridge() {
  const btn = document.getElementById('restart-btn-top');
  btn.disabled = true; btn.textContent = 'Restarting…';
  await fetch('/api/restart', { method: 'POST' });
  clearPending();
  btn.textContent = 'Waiting…';
  setTimeout(() => location.reload(), 4000);
}

async function openCommissionWindow(btn) {
  const out = document.getElementById('commission-result');
  btn.disabled = true; btn.textContent = 'Opening…';
  out.innerHTML = '';
  try {
    const r = await fetch('/api/commission', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) { out.innerHTML = '<p class="unreachable">Failed: ' + (data.error ?? r.status) + '</p>'; return; }
    let h = '<p class="commissioned">Commissioning window open for 3 minutes.</p>';
    if (data.manualPairingCode) h += '<p>Manual code: <strong>' + data.manualPairingCode + '</strong></p>';
    if (data.qrDataUrl) h += '<img src="' + data.qrDataUrl + '" width="200" height="200" alt="QR code">';
    out.innerHTML = h;
  } catch(e) { out.innerHTML = '<p class="unreachable">Request failed: ' + e + '</p>'; }
  finally { btn.disabled = false; btn.textContent = 'Open commissioning window'; }
}

// ── Generic device edit/remove (works for all adapters) ────────────
function toggleEditRow(id) {
  const row = document.getElementById('edit-row-' + id);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

async function saveEdit(id) {
  const label = document.getElementById('edit-lbl-' + id)?.value.trim();
  const room  = document.getElementById('edit-room-' + id)?.value.trim();
  const r = await fetch('/api/config/devices/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ label, room: room || undefined }),
  });
  if (r.ok) { markPending(); location.reload(); }
  else alert('Save failed: ' + (await r.text()));
}

async function removeDevice(id) {
  if (!confirm('Remove "' + id + '" from config?')) return;
  const r = await fetch('/api/config/devices/' + encodeURIComponent(id), { method: 'DELETE' });
  if (r.ok) { markPending(); location.reload(); }
  else alert('Remove failed: ' + (await r.text()));
}

// ── Switcher discover ────────────────────────────────────────────────
async function discover() {
  const btn = document.getElementById('discover-btn');
  const out = document.getElementById('discover-results');
  btn.disabled = true; btn.textContent = 'Scanning…';
  out.innerHTML = '';
  try {
    const devices = await (await fetch('/api/discover')).json();
    if (!devices.length) { out.innerHTML = '<p class="hint">No Switcher devices found on LAN.</p>'; return; }
    const rows = devices.map(d => \`<tr>
      <td><code>\${d.device_id}</code></td><td>\${d.name}</td><td>\${d.type}</td>
      <td>\${d.ip}</td><td>\${d.suggestedMatterType}</td>
      <td><code>\${JSON.stringify(d.state)}</code></td>
    </tr>\`).join('');
    const cfgYaml = devices.map(d =>
      \`  - id: "\${d.device_id}"\\n    adapter: switcher\\n    type: \${d.suggestedMatterType}\\n    label: "\${d.name}"\\n    room: ""\`
    ).join('\\n\\n');
    out.innerHTML = \`<table><tr><th>device_id</th><th>Name</th><th>Type</th><th>IP</th><th>Matter type</th><th>State</th></tr>\${rows}</table>
      <p class="hint">Add to <code>config/config.yaml</code>:</p><pre>\${cfgYaml}</pre>\`;
  } catch(e) { out.innerHTML = '<p class="unreachable">Discover failed: ' + e + '</p>'; }
  finally { btn.disabled = false; btn.textContent = 'Refresh Switcher devices'; }
}

// ── MQTT / Z2M ───────────────────────────────────────────────────────
let mqttConfigured = [];

async function loadMqttDevices() {
  const [discR, cfgR] = await Promise.all([fetch('/api/mqtt/discovered'), fetch('/api/config/devices')]);
  const discovered = await discR.json();
  const allCfg = await cfgR.json();
  mqttConfigured = allCfg.filter(d => d.adapter === 'mqtt');
  renderZ2mDiscovered(discovered);
}

function alreadyAdded(ieee, friendlyName) {
  return mqttConfigured.some(d => d.mqttName === friendlyName || d.mqttName === ieee || d.id === ieee.replace(/^0x/,''));
}

function renderZ2mDiscovered(devices) {
  const out = document.getElementById('z2m-discovered');
  if (!devices.length) {
    out.innerHTML = '<p class="hint">No Z2M devices yet — waiting for zigbee2mqtt/bridge/devices.</p>';
    return;
  }
  const typeOpts = t => ['light','thermostat','windowCovering','contactSensor']
    .map(v => \`<option value="\${v}" \${v===t?'selected':''}>\${v}</option>\`).join('');

  const rows = devices.map(d => {
    const added = alreadyAdded(d.ieee_address, d.friendly_name);
    const defId = d.ieee_address.replace(/^0x/,'');
    const rowKey = defId;
    return \`<tr>
      <td><code style="font-size:.75rem">\${d.ieee_address}</code></td>
      <td>\${d.friendly_name}</td>
      <td>\${d.model ?? '—'}<br><span class="hint">\${d.vendor ?? ''}</span></td>
      <td>\${d.suggestedType ?? '<span class="hint">?</span>'}</td>
      <td>\${added
        ? '<span style="color:#6b7280;font-size:.8rem">✓ in config</span>'
        : \`<button onclick="toggleZ2mForm('\${rowKey}')">Add to bridge</button>\`}
      </td>
    </tr>
    \${added ? '' : \`<tr id="z2m-form-\${rowKey}" style="display:none" class="add-form-z2m">
      <td colspan="5" style="padding:.6rem 1rem">
        <div class="edit-form">
          <label>ID</label><input id="zid-\${rowKey}" value="\${defId}" style="width:150px">
          <label>Label</label><input id="zlbl-\${rowKey}" value="\${d.friendly_name}" style="width:180px">
          <label>Room</label><input id="zroom-\${rowKey}" placeholder="e.g. Kitchen" style="width:120px">
          <label>Type</label><select id="ztype-\${rowKey}">\${typeOpts(d.suggestedType)}</select>
          <button class="primary" onclick="addZ2mDevice('\${rowKey}', '\${d.friendly_name}')">Save to config</button>
          <button onclick="toggleZ2mForm('\${rowKey}')">Cancel</button>
        </div>
      </td>
    </tr>\`}\`;
  }).join('');

  out.innerHTML = \`<table>
    <tr><th>IEEE</th><th>Friendly name</th><th>Model / Vendor</th><th>Type</th><th></th></tr>
    \${rows}
  </table>\`;
}

function toggleZ2mForm(key) {
  const row = document.getElementById('z2m-form-' + key);
  if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

async function addZ2mDevice(key, friendlyName) {
  const id      = document.getElementById('zid-'   + key)?.value.trim();
  const label   = document.getElementById('zlbl-'  + key)?.value.trim();
  const room    = document.getElementById('zroom-' + key)?.value.trim();
  const type    = document.getElementById('ztype-' + key)?.value;
  if (!id || !label) { alert('ID and Label are required'); return; }
  const r = await fetch('/api/config/devices', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id, adapter:'mqtt', type, label, room: room||undefined, protocol:'z2m', mqttName: friendlyName }),
  });
  if (r.ok) { markPending(); location.reload(); }
  else alert('Failed: ' + (await r.text()));
}

async function addTasmotaDevice() {
  const id       = document.getElementById('tas-id')?.value.trim();
  const label    = document.getElementById('tas-label')?.value.trim();
  const room     = document.getElementById('tas-room')?.value.trim();
  const mqttName = document.getElementById('tas-topic')?.value.trim();
  const type     = document.getElementById('tas-type')?.value;
  if (!id || !label || !mqttName) { alert('ID, Label and MQTT name are required'); return; }
  const r = await fetch('/api/config/devices', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id, adapter:'mqtt', type, label, room: room||undefined, protocol:'tasmota', mqttName }),
  });
  if (r.ok) { markPending(); location.reload(); }
  else alert('Failed: ' + (await r.text()));
}

// ── Logs toggle ──────────────────────────────────────────────────────
function toggleLogs() {
  const pre = document.getElementById('log-pre');
  pre.style.display = pre.style.display === 'none' ? '' : 'none';
}
</script>
</body></html>`;
}

export function startAdminServer(
  port: number,
  host: string | undefined,
  maxBodyBytes: number,
  bridge: MatterBridge,
  registry: DeviceRegistry,
  configPath: string,
  switcherAdapter?: SwitcherAdapter,
  mqttAdapter?: MqttAdapter,
): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const urlObj = new URL(req.url ?? '/', 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/healthz') { res.writeHead(200).end('ok'); return; }

    if (pathname === '/api/commission' && req.method === 'POST') {
      try {
        await bridge.openCommissioningWindow();
        const codes = bridge.pairingCodes();
        const qrDataUrl = codes.qrPairingCode
          ? await QRCode.toDataURL(codes.qrPairingCode, { width: 200 }).catch(() => '') : '';
        res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({
          ok: true, manualPairingCode: codes.manualPairingCode, qrDataUrl,
        }));
      } catch (e) {
        res.writeHead(500, {'Content-Type':'application/json'}).end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (pathname === '/api/discover' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(switcherAdapter?.getSeenDevices() ?? []));
      return;
    }

    if (pathname === '/api/mqtt/discovered' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(mqttAdapter?.getZ2mDiscoveredDevices() ?? []));
      return;
    }

    if (pathname === '/api/config/devices' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(readConfig(configPath).devices));
      return;
    }

    if (pathname === '/api/config/devices' && req.method === 'POST') {
      try {
        const device = JSON.parse(await readBody(req, maxBodyBytes)) as DeviceConfig;
        const cfg = readConfig(configPath);
        if (cfg.devices.some(d => d.id === device.id)) {
          res.writeHead(409, {'Content-Type':'application/json'}).end(JSON.stringify({ error: `id "${device.id}" already exists` }));
          return;
        }
        cfg.devices.push(device);
        writeConfig(configPath, cfg);
        res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({ ok: true }));
      } catch (e) {
        if (e instanceof PayloadTooLargeError) { sendPayloadTooLarge(res); return; }
        res.writeHead(500, {'Content-Type':'application/json'}).end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (pathname.startsWith('/api/config/devices/') && req.method === 'PATCH') {
      try {
        const id = decodeURIComponent(pathname.slice('/api/config/devices/'.length));
        const patch = JSON.parse(await readBody(req, maxBodyBytes)) as Partial<DeviceConfig>;
        const cfg = readConfig(configPath);
        const dev = cfg.devices.find(d => d.id === id);
        if (!dev) { res.writeHead(404).end('not found'); return; }
        Object.assign(dev, patch);
        writeConfig(configPath, cfg);
        res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({ ok: true }));
      } catch (e) {
        if (e instanceof PayloadTooLargeError) { sendPayloadTooLarge(res); return; }
        res.writeHead(500, {'Content-Type':'application/json'}).end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (pathname.startsWith('/api/config/devices/') && req.method === 'DELETE') {
      try {
        const id = decodeURIComponent(pathname.slice('/api/config/devices/'.length));
        const cfg = readConfig(configPath);
        cfg.devices = cfg.devices.filter(d => d.id !== id);
        writeConfig(configPath, cfg);
        res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, {'Content-Type':'application/json'}).end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (pathname === '/api/restart' && req.method === 'POST') {
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 500);
      return;
    }

    if (pathname === '/') {
      const commissioned = bridge.isCommissioned();
      const codes = bridge.pairingCodes();
      const devices = registry.allDevices();
      const cfgDevices = readConfig(configPath).devices;

      let qrImg = '';
      if (!commissioned && codes.qrPairingCode) {
        qrImg = await QRCode.toDataURL(codes.qrPairingCode, { width: 200 }).catch(() => '');
      }

      const pairingSection = commissioned
        ? `<p class="commissioned">✓ Commissioned</p>
           <div id="commission-result"></div>`
        : `<p class="pairing">Not commissioned — scan in Apple Home or Google Home:</p>
           ${qrImg ? `<img src="${qrImg}" width="200" height="200" alt="QR code">` : ''}
           <p>Manual code: <strong>${codes.manualPairingCode ?? '—'}</strong></p>
           <div id="commission-result"></div>`;

      const stateLabel = (d: ReturnType<typeof registry.allDevices>[number]) => {
        const s = d.state;
        if (!s.reachable) return { cls: 'unreachable', text: 'unreachable' };
        if (d.type === 'thermostat') return { cls: 'on', text: `${s.mode ?? '—'} ${s.currentTemp ?? '—'}°C → ${s.setpoint ?? '—'}°C` };
        if (d.type === 'windowCovering') return { cls: 'on', text: `${s.position ?? '—'}%` };
        return { cls: s.on ? 'on' : 'off', text: s.on ? 'on' : 'off' };
      };

      const deviceRows = devices.map(d => {
        const { cls, text } = stateLabel(d);
        const cfgDev = cfgDevices.find(c => c.id === d.id);
        return `<tr>
          <td><code>${d.id}</code></td>
          <td>${d.label}</td>
          <td>${d.room ?? '—'}</td>
          <td>${d.type}</td>
          <td>${adapterTag(cfgDev?.adapter ?? '')}</td>
          <td class="${cls}">${text}</td>
          <td>
            <button onclick="toggleEditRow('${d.id}')">Edit</button>
            <button class="danger" onclick="removeDevice('${d.id}')">Remove</button>
          </td>
        </tr>
        <tr id="edit-row-${d.id}" style="display:none" class="edit-row">
          <td colspan="7">
            <div class="edit-form" style="padding:.4rem .75rem">
              <label>Label</label>
              <input id="edit-lbl-${d.id}" value="${d.label.replace(/"/g, '&quot;')}" style="width:200px">
              <label>Room</label>
              <input id="edit-room-${d.id}" value="${(d.room ?? '').replace(/"/g, '&quot;')}" style="width:140px">
              <button class="primary" onclick="saveEdit('${d.id}')">Save</button>
              <button onclick="toggleEditRow('${d.id}')">Cancel</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      const mqttSection = mqttAdapter ? `
        <h2>Zigbee2MQTT devices</h2>
        <p class="hint">Auto-loaded from <code>zigbee2mqtt/bridge/devices</code>.</p>
        <div id="z2m-discovered"><p class="hint">Loading…</p></div>

        <h2>Add Tasmota device</h2>
        <form onsubmit="event.preventDefault(); addTasmotaDevice()">
          <div class="edit-form" style="flex-wrap:wrap;gap:.5rem">
            <label>ID</label><input id="tas-id" placeholder="warehouse-light" style="width:140px">
            <label>Label</label><input id="tas-label" placeholder="Warehouse Light" style="width:160px">
            <label>Room</label><input id="tas-room" placeholder="Warehouse" style="width:120px">
            <label>MQTT name</label><input id="tas-topic" placeholder="tasmota_kitchen" style="width:160px">
            <label>Type</label>
            <select id="tas-type">
              <option value="light">light</option>
              <option value="windowCovering">windowCovering</option>
              <option value="thermostat">thermostat</option>
              <option value="contactSensor">contactSensor</option>
            </select>
            <button type="submit" class="primary">Add</button>
          </div>
        </form>` : '';

      const body = `
        <h1>Home Bridge</h1>
        <div class="top-bar">
          <button id="restart-btn-top" class="primary" onclick="restartBridge()">Restart</button>
          <button onclick="openCommissionWindow(this)">Open commissioning window</button>
          ${switcherAdapter ? '<button id="discover-btn" onclick="discover()">Discover Switcher devices</button>' : ''}
          <button onclick="toggleLogs()">Show logs</button>
        </div>
        <div id="restart-banner" class="banner hidden">
          ⚠ Config changed — restart to apply.
          <button onclick="restartBridge()">Restart now</button>
        </div>
        ${pairingSection}
        <h2>Devices (${devices.length})</h2>
        <table>
          <tr><th>ID</th><th>Label</th><th>Room</th><th>Type</th><th>Adapter</th><th>State</th><th></th></tr>
          ${deviceRows || '<tr><td colspan="7" class="hint">No devices configured</td></tr>'}
        </table>
        ${switcherAdapter ? '<div id="discover-results"></div>' : ''}
        ${mqttSection}
        <h2>Logs</h2>
        <pre id="log-pre" style="display:none">${logBuffer.slice().reverse().join('\n')}</pre>
      `;

      res.writeHead(200, {'Content-Type':'text/html'}).end(html(body));
      return;
    }

    res.writeHead(404).end('not found');
  });

  const onListening = () => {
    console.log(`[admin] http://${host ?? 'localhost'}:${port}`);
  };
  if (host) {
    server.listen(port, host, onListening);
  } else {
    server.listen(port, onListening);
  }
}
