// Run this standalone (bridge must be STOPPED first — it holds the UDP ports).
// Waits for a UDP broadcast from any sl-type device and prints the raw packet.
// Usage: node scripts/capture-sl01.mjs
import { createSocket } from 'dgram';

const SL_TYPES = { '0f04':'sl01','0f05':'sl02','0f06':'sl03','0f07':'slmini01','0f08':'slmini02' };
const PORTS = [20002, 20003, 10002, 10003];
const seen = new Set();

const sockets = PORTS.map(port => {
  const s = createSocket('udp4');
  s.on('message', (buf, rinfo) => {
    const hex = buf.toString('hex');
    if (!hex.startsWith('fef0')) return;
    const typeHex = hex.substr(148, 4);
    const typeName = SL_TYPES[typeHex];
    if (!typeName) return;
    const deviceId = hex.substr(36, 6);
    if (seen.has(deviceId)) return;
    seen.add(deviceId);

    console.log(`\n=== ${typeName} device ${deviceId} on port ${port} from ${rinfo.address} ===`);
    console.log('Total bytes:', buf.length);
    console.log('Full hex:\n', hex);
    console.log('\nKey offsets (hex byte offset → hex chars):');
    for (let i = 0; i < Math.min(hex.length, 200); i += 8) {
      const byteOff = i / 2;
      console.log(`  byte ${String(byteOff).padStart(3)}: ${hex.substr(i, 8)}`);
    }
    console.log('...');
    for (let i = 200; i < hex.length; i += 8) {
      const byteOff = i / 2;
      console.log(`  byte ${String(byteOff).padStart(3)}: ${hex.substr(i, 8)}`);
    }
  });
  s.on('error', e => console.error(`Port ${port}:`, e.message));
  s.bind(port, '0.0.0.0', () => console.log(`Listening on UDP ${port}`));
  return s;
});

console.log('Waiting for sl01/sl02/sl03 broadcast (make sure bridge is stopped)...');
setTimeout(() => {
  if (seen.size === 0) console.log('No sl-type device seen after 30s');
  sockets.forEach(s => s.close());
  process.exit(0);
}, 30_000);
