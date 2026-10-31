import { requestKeyboard, reconnectKnown, KeyboardError, WIDTH, HEIGHT } from './protocol.js';
import { decodeFile, pickFrames, drawFrame, renderForKeyboard } from './frames.js';

const SECONDS_PER_FRAME = 3.5; // measured: 25 frames took ~85 s including the erase
const DEFAULT_CAP = 60;
const $ = (sel, root = document) => root.querySelector(sel);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = {
  keyboard: null,
  busy: false,
  slots: [0, 1].map(() => ({
    source: null, fit: store.get('fit') || 'fill', panX: 0.5, panY: 0.5,
    bg: '#000000', cap: DEFAULT_CAP, every: 1, adv: false, same: false,
  })),
};

// ---------- log and status ----------
const logEl = $('#log');
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('ok', kind === 'ok' || kind === true);
  el.classList.toggle('err', kind === 'err');
}

// ---------- connection ----------
if (!('hid' in navigator)) $('#nohid').hidden = false;

function renderConnection() {
  const kb = state.keyboard;
  $('#kb-name').textContent = kb ? kb.name : 'No keyboard connected';
  const st = $('#kb-status');
  const needsRestart = !$('#restart').hidden;
  st.textContent = kb ? 'Connected over USB' : (needsRestart ? 'Needs restart' : 'Not connected');
  st.classList.toggle('ok', !!kb);
  st.classList.toggle('err', !kb && needsRestart);
  $('#connect').textContent = kb ? 'Disconnect' : ($('#restart').hidden ? 'Connect' : 'Reconnect');
  renderSummary();
}

async function connect() {
  try {
    const kb = await requestKeyboard();
    if (!kb) return;
    await kb.open();
    kb.log = log;
    state.keyboard = kb;
    $('#restart').hidden = true;
    log(`connected: ${kb.name}`);
    setStatus('');
  } catch (e) {
    showError(e);
  }
  renderConnection();
}

async function disconnect() {
  try { await state.keyboard?.close(); } catch { /* already gone */ }
  state.keyboard = null;
  renderConnection();
}

$('#connect').addEventListener('click', () => (state.keyboard ? disconnect() : connect()));

if ('hid' in navigator) {
  navigator.hid.addEventListener('disconnect', (e) => {
    if (state.keyboard && e.device === state.keyboard.device) {
      log('keyboard disconnected');
      state.keyboard = null;
      renderConnection();
    }
  });
  // Reuse a keyboard this site was already allowed to use.
  reconnectKnown().then(async (kb) => {
    if (!kb) return;
    await kb.open();
    kb.log = log;
    state.keyboard = kb;
    log(`reconnected: ${kb.name}`);
    renderConnection();
  }).catch(() => {});
}

// ---------- slots ----------
const slotEls = [...document.querySelectorAll('.slot')];

slotEls.forEach((el, i) => {
  const slot = state.slots[i];
  const drop = $('.drop', el);
  const input = $('input[type=file]', drop);

  input.addEventListener('change', () => input.files[0] && loadFile(i, input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(i, file);
  });

  // Once an image is loaded, clicks pan the crop instead of opening the picker.
  drop.addEventListener('click', (e) => { if (slot.source) e.preventDefault(); });
  let pan = null;
  drop.addEventListener('pointerdown', (e) => {
    if (!slot.source || slot.fit !== 'fill' || state.busy) return;
    pan = { x: e.clientX, y: e.clientY, panX: slot.panX, panY: slot.panY };
    drop.setPointerCapture(e.pointerId);
    drop.classList.add('panning');
  });
  drop.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const f = slot.source.frames[0].bitmap;
    const scale = Math.max(WIDTH / f.width, HEIGHT / f.height);
    const px = drop.clientWidth / WIDTH; // screen pixels per keyboard pixel
    const overX = f.width * scale - WIDTH, overY = f.height * scale - HEIGHT;
    if (overX > 0.5) slot.panX = clamp(pan.panX - (e.clientX - pan.x) / px / overX);
    if (overY > 0.5) slot.panY = clamp(pan.panY - (e.clientY - pan.y) / px / overY);
  });
  const endPan = () => { pan = null; drop.classList.remove('panning'); };
  drop.addEventListener('pointerup', endPan);
  drop.addEventListener('pointercancel', endPan);

  if (i === 1) {
    $('.same-box', el).addEventListener('change', (e) => {
      slot.same = e.target.checked;
      renderSlot(1);
    });
  }
});

const clamp = (v) => Math.min(1, Math.max(0, v));

async function loadFile(i, file) {
  if (state.busy) return;
  if (!file.type.startsWith('image/')) {
    setStatus(`${file.name} isn't an image. Choose a PNG, JPG, GIF, or WebP.`);
    return;
  }
  const meta = $('.meta', slotEls[i]);
  meta.textContent = 'Loading…';
  try {
    const src = await decodeFile(file);
    const slot = state.slots[i];
    slot.source = src;
    slot.panX = slot.panY = 0.5;
    slot.cap = Math.min(src.frames.length, slot.adv ? 255 : DEFAULT_CAP);
    slot.every = 1;
    log(`slot ${i + 1}: ${src.name}, ${src.frames.length} frame(s)`);
  } catch (e) {
    setStatus(`Couldn't open ${file.name}. Try a different file.`, 'err');
    log(`decode failed: ${e}`);
  }
  renderSlot(i);
  if (i === 0 && state.slots[1].same) renderSlot(1);
}

function buildControls(i) {
  const el = slotEls[i];
  const box = $('.controls', el);
  box.replaceChildren($('#controls-tpl').content.cloneNode(true));
  const slot = state.slots[i];

  box.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    slot.fit = b.dataset.fit;
    store.set('fit', slot.fit);
    renderSlot(i);
  }));
  $('.bg', box).addEventListener('input', (e) => { slot.bg = e.target.value; });
  $('.cap', box).addEventListener('input', (e) => { slot.cap = +e.target.value; renderSlot(i); });
  $('.every', box).addEventListener('change', (e) => { slot.every = +e.target.value; renderSlot(i); });
  $('.adv-box', box).addEventListener('change', (e) => {
    slot.adv = e.target.checked;
    if (!slot.adv) slot.cap = Math.min(slot.cap, DEFAULT_CAP);
    renderSlot(i);
  });
  $('.remove', box).addEventListener('click', () => {
    slot.source = null;
    $('input[type=file]', el).value = '';
    renderSlot(i);
    if (i === 0 && state.slots[1].same) renderSlot(1);
  });
}

// The frames a slot will send, after "same as slot 1".
function effective(i) {
  const slot = state.slots[i];
  if (i === 1 && slot.same) {
    const s0 = state.slots[0];
    if (!s0.source) return null;
    return { slot: s0, picked: pickFrames(s0.source, s0).slice(0, 1) };
  }
  if (!slot.source) return null;
  return { slot, picked: pickFrames(slot.source, slot) };
}

function renderSlot(i) {
  const el = slotEls[i];
  const slot = state.slots[i];
  const eff = effective(i);
  const drop = $('.drop', el);
  const usingSame = i === 1 && slot.same;

  drop.classList.toggle('has', !!eff);
  drop.style.pointerEvents = usingSame ? 'none' : '';
  $('.meta', el).textContent = eff
    ? (usingSame ? 'Copy of slot 1' : `${slot.source.name} · ${eff.picked.length} of ${slot.source.frames.length} frame(s)`)
    : 'Empty';

  const box = $('.controls', el);
  if (!slot.source || usingSame) {
    box.replaceChildren();
  } else {
    if (!box.firstChild) buildControls(i);
    const n = slot.source.frames.length;
    box.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.fit === slot.fit));
    $('.pan-hint', box).hidden = slot.fit !== 'fill';
    $('.bg-row', box).hidden = slot.fit !== 'fit';
    $('.bg', box).value = slot.bg;
    const multi = n > 1;
    $('.frames-row', box).hidden = !multi;
    $('.every-row', box).hidden = !multi;
    $('.adv', box).hidden = !multi || n <= DEFAULT_CAP;
    const cap = $('.cap', box);
    cap.max = Math.min(n, slot.adv ? 255 : DEFAULT_CAP);
    cap.value = Math.min(slot.cap, +cap.max);
    slot.cap = +cap.value;
    $('.cap-out', box).textContent = cap.value;
    $('.every', box).value = slot.every;
    $('.adv-box', box).checked = slot.adv;
  }
  previews[i].set(eff);
  renderSummary();
}

// ---------- animated previews ----------
class Preview {
  constructor(canvas) {
    this.ctx = canvas.getContext('2d');
    this.eff = null;
    this.index = 0;
    this.next = 0;
  }
  set(eff) { this.eff = eff; this.index = 0; this.next = 0; }
  tick(now) {
    if (!this.eff || !this.eff.picked.length) return;
    const frames = this.eff.picked;
    if (now >= this.next) {
      this.index = (this.index + 1) % frames.length;
      this.next = now + frames[this.index].ms;
    }
    drawFrame(this.ctx, frames[this.index].bitmap, this.eff.slot);
  }
}
const previews = slotEls.map((el) => new Preview($('.preview', el)));
(function loop(now) {
  previews.forEach((p) => p.tick(now));
  requestAnimationFrame(loop);
})(performance.now());

// ---------- upload ----------
function renderSummary() {
  const e0 = effective(0), e1 = effective(1);
  const btn = $('#upload');
  if (!e0 && !e1) {
    $('#summary').textContent = 'Add an image to slot 1 to start.';
  } else {
    const n = (e0 ? e0.picked.length : 1) + (e1 ? e1.picked.length : 1);
    const secs = Math.round(n * SECONDS_PER_FRAME);
    const time = secs >= 90 ? `about ${Math.round(secs / 60)} min` : `about ${secs} s`;
    $('#summary').textContent = `${n} frame${n === 1 ? '' : 's'} · ${time}` +
      (n > 90 ? ' · more than the 90 frames the factory animations used, untested' : '');
  }
  btn.textContent = state.keyboard ? 'Upload to keyboard' : 'Connect and upload';
  btn.disabled = state.busy;
  $('#sync').disabled = state.busy;
  $('#connect').disabled = state.busy;
}

function lock(on) {
  state.busy = on;
  document.querySelectorAll('.slot button, .slot input, .slot select').forEach((c) => { c.disabled = on; });
  renderSummary();
}

const warnLeave = (e) => { e.preventDefault(); e.returnValue = ''; };

function showError(e) {
  log(`error: ${e.message || e}`);
  if (e instanceof KeyboardError) {
    setStatus(e.message, 'err');
  } else if (e?.name === 'NotAllowedError' || e?.name === 'NotFoundError') {
    setStatus('No keyboard was chosen.');
  } else {
    setStatus('Something went wrong talking to the keyboard.', 'err');
  }
}

async function withKeyboard(task) {
  if (!state.keyboard) await connect();
  if (!state.keyboard) return;
  lock(true);
  window.addEventListener('beforeunload', warnLeave);
  try {
    await task(state.keyboard);
  } catch (e) {
    showError(e);
    // A timeout or failed write mid-transfer usually means the keyboard needs a restart.
    $('#restart').hidden = false;
    await disconnect();
  } finally {
    window.removeEventListener('beforeunload', warnLeave);
    $('#progress').hidden = true;
    lock(false);
  }
}

$('#upload').addEventListener('click', () => {
  const e0 = effective(0), e1 = effective(1);
  if (!e0) { setStatus('Add an image to slot 1 first.'); return; }
  const frames1 = renderForKeyboard(e0.picked, e0.slot);
  const frames2 = e1 ? renderForKeyboard(e1.picked, e1.slot) : frames1.slice(0, 1);
  withKeyboard(async (kb) => {
    const t0 = performance.now();
    const bar = $('#progress .bar');
    $('#progress').hidden = false;
    bar.style.width = '0';
    setStatus('Erasing the keyboard\'s picture memory…');
    await kb.setSlots(frames1, frames2, (p) => {
      if (p.stage === 'upload') {
        bar.style.width = `${Math.round(p.fraction * 100)}%`;
        const left = Math.max(0, Math.round((p.frames - p.frame) * SECONDS_PER_FRAME));
        setStatus(`Uploading frame ${p.frame} of ${p.frames} (about ${left} s left). Don't unplug the keyboard.`);
      }
    });
    const secs = Math.round((performance.now() - t0) / 1000);
    setStatus(`Uploaded in ${secs} s. Press the TV button on the keyboard to see it.`, 'ok');
  });
});

$('#sync').addEventListener('click', () => withKeyboard(async (kb) => {
  setStatus('Setting the keyboard clock…');
  await kb.syncClock();
  setStatus(`Clock set to ${new Date().toLocaleTimeString()}.`, 'ok');
}));

slotEls.forEach((_, i) => renderSlot(i));
renderConnection();
