// WebHID port of gmk104_screen.py. Protocol notes: GMK104-screen-protocol.md.
//
// Rules learned the hard way on the real keyboard:
// - Never send BEGIN (0x01) before screen data (0x21): the keyboard stops
//   answering and the vendor interface stays dead until it is restarted.
// - ERASE (0x23) clears as many frames as the frame counts *already saved* on
//   the keyboard, so save the new counts before erasing.
// - Over USB the input report is 7 bytes: checksum (2), command, 4 data bytes.

export const DEVICES = [
  { vendorId: 0x320f, productId: 0x5055, name: 'ZUOYA GMK104', usagePage: 0xff1c, chunk: 0x38 },
];

export const WIDTH = 240;
export const HEIGHT = 135;
export const FRAME_BYTES = 65536; // 240*135*2 = 64800, padded to the next 32 KiB
export const SETTINGS_LEN = 48;
export const MAX_FRAMES_PER_SLOT = 255;

const REPORT_ID = 0x04;
const CMD = { BEGIN: 0x01, END: 0x02, READ: 0x05, WRITE_SETTINGS: 0x06, UPLOAD: 0x21, ERASE: 0x23 };
const SET = { FRAMES_1: 0x22, CLOCK: 0x23, FRAMES_2: 0x2e };
const REPLY_TIMEOUT_MS = 120_000;

export class KeyboardError extends Error {}

// Returns the 64-byte packet including the report ID, like build_packet().
export function buildPacket(cmd, length = 0, offset = 0, payload = new Uint8Array(0)) {
  const pkt = new Uint8Array(64);
  pkt[0] = REPORT_ID;
  pkt[3] = cmd;
  pkt[4] = length;
  pkt[5] = offset & 0xff;
  pkt[6] = (offset >> 8) & 0xff;
  pkt[7] = (offset >> 16) & 0xff;
  pkt.set(payload, 8);
  let sum = 0;
  for (let i = 3; i < 64; i++) sum += pkt[i];
  pkt[1] = sum & 0xff;
  pkt[2] = (sum >> 8) & 0xff;
  return pkt;
}

const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function deviceInfo(dev) {
  return DEVICES.find((d) => d.vendorId === dev.vendorId && d.productId === dev.productId);
}

export async function requestKeyboard() {
  if (!('hid' in navigator)) throw new KeyboardError('This browser has no WebHID. Use Chrome or Edge on a computer.');
  const filters = DEVICES.map(({ vendorId, productId, usagePage }) => ({ vendorId, productId, usagePage }));
  const picked = await navigator.hid.requestDevice({ filters });
  return picked.length ? new Keyboard(pickVendorInterface(picked)) : null;
}

export async function reconnectKnown() {
  if (!('hid' in navigator)) return null;
  const known = (await navigator.hid.getDevices()).filter((d) => deviceInfo(d));
  return known.length ? new Keyboard(pickVendorInterface(known)) : null;
}

function pickVendorInterface(devices) {
  const dev = devices.find((d) => {
    const info = deviceInfo(d);
    return info && d.collections.some((c) => c.usagePage === info.usagePage);
  });
  if (!dev) {
    const d = devices[0];
    const id = `${hex4(d.vendorId)}:${hex4(d.productId)}`;
    throw new KeyboardError(`${d.productName || 'This device'} (${id}) isn't a supported keyboard. Nothing was sent.`);
  }
  return dev;
}

const hex4 = (n) => '0x' + n.toString(16).padStart(4, '0').toUpperCase();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

export class Keyboard {
  constructor(device) {
    this.device = device;
    this.info = deviceInfo(device);
    this.replies = [];
    this.waiter = null;
    this.log = () => {};
    this.onReport = (e) => {
      if (e.reportId !== REPORT_ID) return;
      this.replies.push(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
      if (this.waiter) this.waiter();
    };
  }

  get name() { return this.info.name; }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.onReport);
  }

  async close() {
    this.device.removeEventListener('inputreport', this.onReport);
    if (this.device.opened) await this.device.close();
  }

  async drain() {
    await sleep(60);
    this.replies.length = 0;
  }

  // Send one packet and wait for the reply with the same command byte.
  async transact(pkt, timeoutMs = REPLY_TIMEOUT_MS) {
    const cmd = pkt[3];
    await this.device.sendReport(REPORT_ID, pkt.slice(1));
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const i = this.replies.findIndex((r) => r[2] === cmd);
      if (i >= 0) {
        const reply = this.replies.splice(0, i + 1).pop();
        return reply;
      }
      const left = deadline - performance.now();
      if (left <= 0) throw new KeyboardError(`The keyboard didn't answer command 0x${cmd.toString(16)}.`);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 1000));
        this.waiter = () => { clearTimeout(t); this.waiter = null; resolve(); };
      });
    }
  }

  async readSettings(length = SETTINGS_LEN, offset = 0) {
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += 4) {
      const n = Math.min(4, length - off);
      const reply = await this.transact(buildPacket(CMD.READ, n, offset + off), 5000);
      out.set(reply.slice(3, 3 + n), off);
    }
    return out;
  }

  async writeSettings(block, offset = 0) {
    await this.transact(buildPacket(CMD.BEGIN));
    for (let off = 0; off < block.length; off += this.info.chunk) {
      const chunk = block.slice(off, off + this.info.chunk);
      await this.transact(buildPacket(CMD.WRITE_SETTINGS, chunk.length, offset + off, chunk));
    }
    await this.transact(buildPacket(CMD.END));
  }

  // Read the block from the keyboard, change frame counts and clock, write it back.
  async saveCountsAndClock(n1, n2, now = new Date()) {
    const blk = await this.readSettings();
    if (blk.length !== SETTINGS_LEN) throw new KeyboardError('Couldn\'t read the keyboard settings. Nothing was written.');
    this.log('settings before: ' + hex(blk));
    if (n1 != null) blk[SET.FRAMES_1] = n1;
    if (n2 != null) blk[SET.FRAMES_2] = n2;
    // sec, min, hour, weekday (0 = Sunday), day, month, year % 100
    blk.set([bcd(now.getSeconds()), bcd(now.getMinutes()), bcd(now.getHours()), now.getDay(),
      bcd(now.getDate()), bcd(now.getMonth() + 1), bcd(now.getFullYear() % 100)], SET.CLOCK);
    await this.writeSettings(blk);
    return blk;
  }

  async syncClock() {
    await this.drain();
    await this.saveCountsAndClock(null, null);
    this.log('clock synced');
  }

  // frames: array of Uint8Array(FRAME_BYTES), slot 1's frames then slot 2's.
  async setSlots(slot1, slot2, onProgress = () => {}) {
    for (const s of [slot1, slot2]) {
      if (s.length < 1 || s.length > MAX_FRAMES_PER_SLOT) throw new KeyboardError(`Each slot needs 1–${MAX_FRAMES_PER_SLOT} frames.`);
    }
    await this.drain();
    await this.saveCountsAndClock(slot1.length, slot2.length);
    this.log(`erasing ${slot1.length + slot2.length} frames`);
    onProgress({ stage: 'erase' });
    await this.transact(buildPacket(CMD.ERASE));

    const frames = [...slot1, ...slot2];
    const total = frames.length * FRAME_BYTES;
    const chunk = this.info.chunk;
    let sent = 0;
    for (let f = 0; f < frames.length; f++) {
      const data = frames[f];
      for (let i = 0; i < FRAME_BYTES; i += chunk) {
        const off = f * FRAME_BYTES + i;
        const part = data.subarray(i, i + chunk);
        const reply = await this.transact(buildPacket(CMD.UPLOAD, part.length, off, part));
        if (reply[6] === 0xff || reply[6] === 0xfe) throw new KeyboardError(`The keyboard rejected data at offset ${off}.`);
        if (off === 0) await sleep(500); // the vendor tool waits here too
        sent += part.length;
      }
      onProgress({ stage: 'upload', frame: f + 1, frames: frames.length, fraction: sent / total });
    }
    await this.transact(buildPacket(CMD.END));
    // Save again so the clock is current after a long upload.
    await this.saveCountsAndClock(slot1.length, slot2.length);
    this.log('upload finished');
  }
}

export function toRGB565(imageData) {
  const out = new Uint8Array(FRAME_BYTES);
  const px = imageData.data;
  for (let i = 0, j = 0; i < WIDTH * HEIGHT * 4; i += 4, j += 2) {
    const v = ((px[i] >> 3) << 11) | ((px[i + 1] >> 2) << 5) | (px[i + 2] >> 3);
    out[j] = v >> 8;
    out[j + 1] = v & 0xff;
  }
  return out;
}
