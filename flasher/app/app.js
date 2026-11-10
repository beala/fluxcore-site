// fluxcore app: talks to a MeshCore companion radio over Bluetooth (the Nordic UART service the
// MeshCore apps use), one companion-protocol frame per write or notification. fluxcore features are
// reached through the protocol's "run a CLI command" frame (66), whose reply is frame 29.
// Works in Chrome/Edge (desktop, Android) and Bluefy (iPhone, iPad): only the basic Web Bluetooth calls.
'use strict';

const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // we write commands here
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // the radio notifies replies here
// fluxcore firmware also has its own service with the same frames, so this page and the MeshCore app
// can share one connection (on an iPhone, both apps at once) without seeing each other's traffic
const FLUX = 'f1c00001-8a5d-4c75-b0c2-666c7578636f';
const FLUX_RX = 'f1c00002-8a5d-4c75-b0c2-666c7578636f';
const FLUX_TX = 'f1c00003-8a5d-4c75-b0c2-666c7578636f';

const CMD = { APP_START: 1, DEVICE_QUERY: 22, BATT: 20, CLI: 66 };
const RESP = { OK: 0, ERR: 1, SELF_INFO: 5, BATT: 12, DEVICE_INFO: 13, CLI_REPLY: 29 };

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the radio link
class Radio {
  constructor() { this.device = null; this.rx = null; this.chain = Promise.resolve(); this.lastWrite = Promise.resolve(); this.waiting = null; this.onclose = null; }

  async pick() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS] }, { namePrefix: 'MeshCore' }],
      optionalServices: [NUS, FLUX],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.rx = null;
      if (this.waiting) { this.waiting.reject(new Error('disconnected')); this.waiting = null; }
      if (this.onclose) this.onclose();
    });
  }

  async open() {
    this.linked = false;
    const server = await this.device.gatt.connect();
    this.linked = true;   // connected; anything that fails from here on, the radio may have cut
    let svc, rx, tx;
    try {
      svc = await server.getPrimaryService(FLUX);
      rx = await svc.getCharacteristic(FLUX_RX);
      tx = await svc.getCharacteristic(FLUX_TX);
      this.shared = true;
    } catch (e) {   // firmware from before the fluxcore service: the MeshCore app's channel
      console.log('no fluxcore service (' + e.message + '), using the MeshCore app\'s');
      svc = await server.getPrimaryService(NUS);
      rx = await svc.getCharacteristic(NUS_RX);
      tx = await svc.getCharacteristic(NUS_TX);
      this.shared = false;
    }
    tx.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      this.frame(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await tx.startNotifications();
    this.rx = rx;
  }

  get connected() { return !!(this.rx && this.device && this.device.gatt.connected); }

  close() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }

  frame(f) {
    const w = this.waiting;
    if (!w || f.length === 0) return;   // pushes (new messages, adverts, raw packets) aren't used here
    if (w.codes.includes(f[0])) { this.waiting = null; w.resolve(f); }
    else if (f[0] === RESP.ERR && !w.codes.includes(RESP.ERR)) { this.waiting = null; w.reject(new Error('the radio said error ' + (f[1] ?? ''))); }
  }

  // Writes a frame. Without a response when the radio allows it (fewer round trips on a busy link);
  // Bluefy has only writeValue, which picks by itself. The browser takes one write at a time on a
  // characteristic, so a write still in flight (eg. after a timeout) is waited for first.
  async write(data) {
    await this.lastWrite;
    const rx = this.rx;
    if (!rx) throw new Error('not connected');
    const p = rx.properties && rx.properties.writeWithoutResponse && rx.writeValueWithoutResponse ? rx.writeValueWithoutResponse(data)
      : rx.writeValueWithResponse ? rx.writeValueWithResponse(data) : rx.writeValue(data);
    this.lastWrite = p.catch(() => {});
    return p;
  }

  // One request at a time: send a frame, wait for a reply with one of these codes.
  request(bytes, codes, timeout = 5000) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('not connected')); return; }
      const t = setTimeout(() => { if (this.waiting && this.waiting.resolve === done) this.waiting = null; reject(new Error('no answer')); }, timeout);
      const done = (f) => { clearTimeout(t); resolve(f); };
      this.waiting = { codes, resolve: done, reject: (e) => { clearTimeout(t); reject(e); } };
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.write(data).catch((e) => { if (this.waiting && this.waiting.resolve === done) this.waiting = null; clearTimeout(t); reject(e); });
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async cli(text) {
    const f = await this.request([CMD.CLI, ...enc.encode(text)], [RESP.CLI_REPLY], 8000);
    return dec.decode(f.subarray(1));
  }

  async hello() {
    const d = await this.request([CMD.DEVICE_QUERY, 3], [RESP.DEVICE_INFO]);
    const str = (a, b) => dec.decode(d.subarray(a, b)).replace(/\0.*$/s, '');
    const info = { proto: d[1], build: str(8, 20), board: str(20, 60), version: str(60, 80) };
    const s = await this.request([CMD.APP_START, 3, 0, 0, 0, 0, 0, 0, ...enc.encode('fluxcore app')], [RESP.SELF_INFO]);
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    info.lat = dv.getInt32(36, true) / 1e6;
    info.lon = dv.getInt32(40, true) / 1e6;
    info.freq = dv.getUint32(48, true) / 1000;
    info.bw = dv.getUint32(52, true) / 1000;
    info.sf = s[56]; info.cr = s[57];
    info.name = dec.decode(s.subarray(58));
    try {
      const b = await this.request([CMD.BATT], [RESP.BATT]);
      info.mv = b[1] | (b[2] << 8);
    } catch (e) { /* older firmware */ }
    return info;
  }
}

// ---------------------------------------------------------------- page state
const radio = new Radio();
let info = null;
let tab = 'air';

function setNode(text, on) {
  $('nodetext').innerHTML = text;
  $('dot').className = on ? 'dot on' : 'dot';
}

function showTab(name) {
  tab = name;
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === name);
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', b.dataset.tab === name);
  if (name === 'air') { map.invalidateSize(); pollAir(true); }
  if (name === 'rad') pollRadios(true);
  if (name === 'sen') { drawSensors(); pollSensors(true); }
  if (name === 'con') $('cmd').focus();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function connect() {
  $('support').textContent = '';
  try {
    if (!radio.device) await radio.pick();
    setNode('Connecting to ' + esc(radio.device.name || 'radio') + '…', false);
    await radio.open();
    info = await radio.hello();
    const batt = info.mv ? ` · ${(info.mv / 1000).toFixed(2)} V` : '';
    setNode(`<b>${esc(info.name)}</b> <span class="wide">· ${esc(info.board)} </span>· ${esc(info.version)} · ${info.freq.toFixed(3)} MHz${batt}`, true);
    $('connect').textContent = 'Disconnect';
    $('tabs').hidden = false;
    placeMe();
    senView = null;
    showTab(tab === 'start' ? 'air' : tab);
    pollSensors(true);
    log('note', `Connected to ${info.name}.` + (radio.shared ? ' The MeshCore app can stay connected too.'
      : ' Close the MeshCore app while this is connected. To use both at once: forget the radio in Bluetooth settings, then pair it again.'));
  } catch (e) {
    if (e.name === 'NotFoundError') { setNode('Not connected', false); return; }   // closed the picker
    setNode('Not connected', false);
    // Dropped while connecting: the radio takes one phone or computer at a time and turns away the
    // rest (apps on the same phone share its link)
    const dropped = radio.linked && radio.device && !radio.device.gatt.connected;
    $('support').innerHTML = dropped
      ? '<span class="err">The radio dropped the connection. It takes one phone or computer at a time: if the MeshCore app is connected on another phone or computer, use this page on that one (Bluefy on an iPhone, Chrome on Android), or close the MeshCore app there first.</span>'
      : `<span class="err">${esc(e.message || e)}</span>`;
    radio.close();
  }
}

radio.onclose = () => {
  setNode(`<b>${esc(info ? info.name : 'Radio')}</b> disconnected`, false);
  $('connect').textContent = 'Reconnect';
  log('err', 'Disconnected.');
};

$('connect').onclick = $('connect2').onclick = () => {
  if (radio.connected) { radio.close(); return; }
  connect();
};

for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);

if (!navigator.bluetooth) {
  $('connect').disabled = $('connect2').disabled = true;
  $('support').innerHTML = 'This browser can’t use Bluetooth. Use Chrome or Edge on a computer or Android, or <a href="https://apps.apple.com/app/id1492822055">Bluefy</a> on an iPhone or iPad.' +
    (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent) ? ' On Linux, Chrome may need chrome://flags/#enable-web-bluetooth (or experimental web platform features) turned on.' : '');
}
tab = 'start';

// ---------------------------------------------------------------- aircraft
const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([39.5, -98.35], 4);
// OpenStreetMap's own tiles, darkened by CSS (.tiles) to match the page
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

let meMark = null, fitted = false, selected = null;
const planes = new Map();   // address -> { rec, trail: [[lat,lon]], marker, line, iconKey, seen }

function placeMe() {
  if (meMark) { meMark.remove(); meMark = null; }
  if (!info || (info.lat === 0 && info.lon === 0)) return;
  meMark = L.marker([info.lat, info.lon], {
    icon: L.divIcon({ className: 'me', iconSize: [14, 14], iconAnchor: [7, 7],
      html: '<svg width="14" height="14"><rect x="2" y="2" width="10" height="10" fill="#050805" stroke="#3dff6e" stroke-width="2"/></svg>' }),
    title: info.name, zIndexOffset: -100,
  }).addTo(map).bindPopup(`<b>${esc(info.name)}</b><br>this radio`);
  map.setView([info.lat, info.lon], 9);
  fitted = true;
}

// address,callsign,lat_e5,lon_e5,alt_ft,kt,track,vs_fpm,age_s,rssi,flags (empty = not known)
function parseRec(s) {
  const f = s.split(',');
  if (f.length < 11) return null;
  const num = (x) => (x === '' ? null : Number(x));
  return {
    addr: f[0], cs: f[1], lat: f[2] === '' ? null : f[2] / 1e5, lon: f[3] === '' ? null : f[3] / 1e5,
    ground: f[4] === 'G', alt: f[4] === 'G' ? null : num(f[4]), kt: num(f[5]), trk: num(f[6]), vs: num(f[7]),
    age: Number(f[8]), rssi: Number(f[9]), flags: Number(f[10]),
  };
}

function altColor(r) {
  if (r.ground) return '#8fbd87';
  if (r.alt == null) return '#b4eeac';
  if (r.alt < 3000) return '#3dff6e';
  if (r.alt < 10000) return '#c8ff3d';
  if (r.alt < 20000) return '#ffd25a';
  return '#5ad2ff';
}

const fmtFt = (r) => (r.ground ? 'on the ground' : r.alt == null ? '' : r.alt.toLocaleString('en-US') + ' ft');
const label = (r) => r.cs || r.addr.toUpperCase();
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function fromMe(r) {
  if (!info || (info.lat === 0 && info.lon === 0) || r.lat == null) return null;
  const R = 3958.8, rad = Math.PI / 180;
  const p1 = info.lat * rad, p2 = r.lat * rad, dl = (r.lon - info.lon) * rad;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const mi = 2 * R * Math.asin(Math.sqrt(a));
  const brg = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / rad + 360) % 360;
  return { mi, dir: COMPASS[Math.round(brg / 22.5) % 16] };
}

function planeIcon(r) {
  const c = altColor(r);
  const rot = r.trk == null ? 0 : r.trk;
  const vs = r.vs == null ? '' : r.vs >= 300 ? ' ↑' : r.vs <= -300 ? ' ↓' : '';
  const alt = r.ground ? 'GND' : r.alt == null ? '' : (r.alt >= 18000 ? 'FL' + Math.round(r.alt / 100) : r.alt.toLocaleString('en-US'));
  const html = `<svg width="24" height="24" viewBox="0 0 24 24" style="transform:rotate(${rot}deg);opacity:${r.age > 60 ? 0.45 : 1}">` +
    `<path d="M12 1.5 13.6 9 21.5 13.2v1.6l-7.9-2.2-.5 5.6 2.6 2v1.2L12 20.4l-3.8 1V20.2l2.6-2-.5-5.6-7.9 2.2v-1.6L10.4 9z" fill="${c}"/></svg>` +
    `<span class="tag">${esc(label(r))} <i>${esc(alt)}${vs}</i></span>`;
  return { key: html, icon: L.divIcon({ className: 'plane', iconSize: [24, 24], iconAnchor: [12, 12], html }) };
}

function popupHtml(r) {
  const d = fromMe(r);
  const band = [r.flags & 1 ? '978 MHz UAT' : '', r.flags & 2 ? '1090 MHz' : ''].filter(Boolean).join(' + ');
  const rows = [
    fmtFt(r),
    r.kt != null && !r.ground ? `${r.kt} kt, heading ${r.trk}°` : '',
    r.vs != null && Math.abs(r.vs) >= 300 ? (r.vs > 0 ? 'climbing ' : 'descending ') + Math.abs(r.vs) + ' ft/min' : '',
    d ? `${d.mi.toFixed(1)} mi ${d.dir} of ${esc(info.name)}` : '',
    `${band}${r.flags & 4 ? ', via radar (TIS-B)' : ''}, ${r.rssi} dBm, ${r.age}s ago`,
    `<a href="https://globe.adsbexchange.com/?icao=${esc(r.addr)}" target="_blank" rel="noopener">${esc(r.addr.toUpperCase())} on ADS-B Exchange ↗</a>`,
  ].filter(Boolean);
  return `<b>${esc(label(r))}</b><br>${rows.join('<br>')}`;
}

function update(recs) {
  const seen = new Set();
  for (const r of recs) {
    seen.add(r.addr);
    let p = planes.get(r.addr);
    if (!p) { p = { trail: [] }; planes.set(r.addr, p); }
    p.rec = r;
    p.missing = 0;
    if (r.lat != null) {
      const ll = [r.lat, r.lon];
      const last = p.trail[p.trail.length - 1];
      if (!last || last[0] !== ll[0] || last[1] !== ll[1]) { p.trail.push(ll); if (p.trail.length > 60) p.trail.shift(); }
      const ic = planeIcon(r);
      if (!p.marker) {
        p.marker = L.marker(ll, { icon: ic.icon }).addTo(map).bindPopup('');
        p.marker.on('popupopen', () => { selected = r.addr; p.marker.setPopupContent(popupHtml(planes.get(r.addr).rec)); drawList(); });
        p.marker.on('popupclose', () => { if (selected === r.addr) selected = null; drawList(); });
        p.line = L.polyline(p.trail, { color: altColor(r), weight: 2, opacity: 0.45, interactive: false }).addTo(map);
        p.iconKey = ic.key;
      } else {
        p.marker.setLatLng(ll);
        if (p.iconKey !== ic.key) { p.marker.setIcon(ic.icon); p.iconKey = ic.key; }
        p.line.setLatLngs(p.trail);
        p.line.setStyle({ color: altColor(r) });
        if (p.marker.isPopupOpen()) p.marker.setPopupContent(popupHtml(r));
      }
    }
  }
  // the radio forgets aircraft after 5 minutes: so do we. One missing from a single read (the list
  // shifts while it's read a page at a time, or a full list made room) stays a while before it goes.
  const now = Date.now();
  for (const [addr, p] of planes) {
    if (seen.has(addr)) continue;
    if (!p.missing) p.missing = now;
    if (now - p.missing < 30000) continue;
    if (p.marker) { p.marker.remove(); p.line.remove(); }
    planes.delete(addr);
  }
  if (!fitted) fitAll();
  drawList();
}

function fitAll() {
  const pts = [...planes.values()].filter((p) => p.rec.lat != null).map((p) => [p.rec.lat, p.rec.lon]);
  if (meMark) pts.push(meMark.getLatLng());
  if (pts.length === 0) return;
  fitted = true;
  if (pts.length === 1) map.setView(pts[0], 9);
  else map.fitBounds(pts, { padding: [40, 40], maxZoom: 11 });
}
$('fit').onclick = fitAll;

function drawList() {
  const all = [...planes.values()].map((p) => p.rec);
  all.sort((a, b) => {
    const da = fromMe(a), db = fromMe(b);
    if (da && db) return da.mi - db.mi;
    if ((a.lat == null) !== (b.lat == null)) return a.lat == null ? 1 : -1;
    return (a.alt ?? 1e9) - (b.alt ?? 1e9);
  });
  const ul = $('planes');
  if (all.length === 0) { ul.innerHTML = `<li class="empty">No aircraft heard in the last 5 minutes.</li>`; return; }
  ul.innerHTML = all.map((r) => {
    const d = fromMe(r);
    const bits = [fmtFt(r), r.kt != null && !r.ground ? r.kt + ' kt' : '', d ? `${d.mi.toFixed(1)} mi ${d.dir}` : r.lat == null ? 'no position yet' : ''].filter(Boolean);
    return `<li data-a="${esc(r.addr)}" class="${r.addr === selected ? 'sel' : ''} ${r.age > 60 ? 'old' : ''}">` +
      `<span class="cs" style="color:${altColor(r)}">${esc(label(r))}</span> <span class="meta">${r.age}s · ${r.rssi} dBm</span><br>` +
      `<span class="meta">${esc(bits.join(' · '))}</span></li>`;
  }).join('');
  for (const li of ul.querySelectorAll('li[data-a]')) {
    li.onclick = () => {
      const p = planes.get(li.dataset.a);
      if (p && p.marker) { map.panTo(p.marker.getLatLng()); p.marker.openPopup(); }
    };
  }
}

let airOn = null, airAt = 0, polling = false;

async function airState() {
  const s = await radio.cli('air');
  airOn = /^> Aircraft on/.test(s);
  const always = /all the time/.test(s);
  $('airtoggle').textContent = airOn ? 'Turn off' : 'Turn aircraft on';
  $('airscan').hidden = !airOn;
  $('airscan').textContent = always ? 'Share the radio' : 'Listen all the time';
  $('airscan').dataset.on = always ? '1' : '';
  let line;
  if (!airOn) line = 'Aircraft is off. Turning it on turns off Meshtastic, weather or meters, if one is on.';
  else {
    const st = await radio.cli('get air.stats');
    const listen = (/listening ([^,]+)/.exec(s) || [])[1] || '';
    const msgs = (/^> (\d+) messages/.exec(st) || [])[1];
    const bands = /UAT \+ 1090/.test(s) ? '978 + 1090 MHz' : /1090 MHz ADS-B/.test(s) ? '1090 MHz' : '978 MHz';
    line = `Listening on ${bands}, ${listen}` + (msgs != null ? ` · ${msgs} messages heard` : '');
  }
  if (info && info.lat === 0 && info.lon === 0) line += ' · This radio has no location set, so distances aren’t shown.';
  $('airstate').textContent = line;
}

async function pollAir(force) {
  if (polling || !radio.connected || tab !== 'air') return;
  polling = true;
  try {
    if (force || Date.now() - airAt > 10000) { await airState(); airAt = Date.now(); }
    const recs = await readList('get air.list', parseRec, 20);
    if (recs == null) throw new Error('this radio’s firmware doesn’t have get air.list: update it at fluxcore.party/flash');
    const byAddr = new Map(recs.map((r) => [r.addr, r]));   // the list can shift between pages
    update([...byAddr.values()]);
  } catch (e) {
    if (radio.connected) $('airstate').textContent = e.message;
  } finally {
    polling = false;
  }
}
setInterval(() => pollAir(false), 2000);

$('airtoggle').onclick = async () => {
  const r = await radio.cli(airOn ? 'air off' : 'air on');
  log('note', r);
  $('airstate').textContent = r;
  airAt = 0;
  pollAir(true);
};
$('airscan').onclick = async () => {
  const r = await radio.cli($('airscan').dataset.on ? 'air scan off' : 'air scan on');
  $('airstate').textContent = r;
  airAt = 0;
};

// ---------------------------------------------------------------- radios (frequency fingerprints)
// Every radio's crystal is a little off frequency, by its own steady amount: the radio (LR2021) keeps a
// table of the radios it hears with that error ('get nodes.list'). Drawn here on one axis, so radios
// close together and radios sharing an ID stand out, with each one's drift since this page connected.
const radios = [];   // { rec, hist: [[ms, hz]], seen }
let radPolling = false, radAt = 0;
const BAND_MIN = 40;   // Hz: as the firmware's freqprint::MIN_BAND_HZ

function parseRadio(s) {
  const f = s.split(',');
  if (f.length < 8) return null;
  return { id: f[0], named: f[1] === '1', name: f[2], hz: Number(f[3]), dev: Number(f[4]),
           learned: Number(f[5]), matched: Number(f[6]), age: Number(f[7]) };
}
const bandOf = (r) => Math.max(BAND_MIN, 3 * r.dev);
const idShort = (r) => r.named ? r.id.slice(0, 6) : r.id;   // up to 3 bytes, as the radio shows

async function pollRadios(force) {
  if (radPolling || !radio.connected || tab !== 'rad') return;
  if (!force && Date.now() - radAt < 5000) return;
  radPolling = true;
  try {
    const recs = await readList('get nodes.list', parseRadio, 10);
    if (recs == null) throw new Error('this radio’s firmware doesn’t have get nodes.list: update it at fluxcore.party/flash');
    radAt = Date.now();
    // match each row to the one seen before: same ID (or the same first byte, once it's named) and
    // the nearest frequency, since two radios can share a 1-byte ID
    const now = Date.now();
    for (const r of recs) {
      let best = null;
      for (const e of radios) {
        if (e.seen === now) continue;
        const same = e.rec.id === r.id || (r.named && !e.rec.named && r.id.startsWith(e.rec.id));
        if (!same || Math.abs(e.rec.hz - r.hz) > 200) continue;
        if (!best || Math.abs(e.rec.hz - r.hz) < Math.abs(best.rec.hz - r.hz)) best = e;
      }
      if (!best) radios.push(best = { hist: [] });
      best.rec = r;
      best.seen = now;
      best.hist.push([now, r.hz]);
      if (best.hist.length > 720) best.hist.shift();   // an hour at one reading every 5 s
    }
    for (let i = radios.length - 1; i >= 0; i--) if (radios[i].seen !== now) radios.splice(i, 1);
    radios.sort((a, b) => (b.rec.learned + b.rec.matched) - (a.rec.learned + a.rec.matched));
    drawRadios();
  } catch (e) {
    if (radio.connected) $('radstate').textContent = e.message;
  } finally {
    radPolling = false;
  }
}
setInterval(() => pollRadios(false), 1000);

// The other radios whose ID starts with the same byte as this one's (a 1-byte ID fits each of them)
function siblings(r) { return radios.filter((e) => e.rec !== r && e.rec.id.slice(0, 2) === r.id.slice(0, 2)).map((e) => e.rec); }
// Unconfirmed radios that look like another one by ID but not by frequency
function lookalikes() { return new Set(radios.filter((e) => !e.rec.named && siblings(e.rec).length).map((e) => e.rec)); }

function drawRadios() {
  const n = radios.length;
  const look = lookalikes();
  $('radstate').textContent = n === 0 ? 'No radios heard yet.' :
    `${n} radio${n === 1 ? '' : 's'} · frequency error as this radio hears it`;
  drawAxis(look);
  const ul = $('radios');
  if (n === 0) {
    ul.innerHTML = '<li class="empty">Every packet heard adds to this. Only radios with an LR2021 measure it; with other radios this stays empty.</li>';
    return;
  }
  ul.innerHTML = radios.map((e) => {
    const r = e.rec;
    // same first ID byte as another radio, but a different frequency: say so, and how far apart
    const sib = look.has(r) ? siblings(r) : [];
    const apart = sib.map((o) => `${o.named ? idShort(o) + ' ' + o.name : o.id} (${Math.abs(o.hz - r.hz).toLocaleString()} Hz apart)`);
    const title = r.named ? `${idShort(r)} ${r.name}` : `${r.id}`;
    const note = r.named ? '' : ' · not confirmed yet (1-byte ID)';
    const ago = r.age < 60 ? r.age + 's' : r.age < 3600 ? Math.round(r.age / 60) + 'm' : Math.round(r.age / 3600) + 'h';
    const drift = e.hist.length > 1 ? e.hist[e.hist.length - 1][1] - e.hist[0][1] : 0;
    const mins = e.hist.length > 1 ? Math.max(1, Math.round((e.hist[e.hist.length - 1][0] - e.hist[0][0]) / 60000)) : 0;
    const lit = flash.id === r.id && Date.now() < flash.until ? ' flash' : '';
    return `<li data-i="${radios.indexOf(e)}" class="${r.named ? '' : 'anon'} ${r.age > 600 ? 'old' : ''}${lit}"><div>` +
      `<span class="cs">${esc(title)}</span> <span class="meta">${r.hz > 0 ? '+' : ''}${r.hz} Hz ±${r.dev}</span><br>` +
      `<span class="meta">${r.learned + r.matched} packets · ${ago} ago` +
      (Math.abs(drift) >= 10 ? ` · moved ${drift > 0 ? '+' : ''}${drift} Hz in ${mins} min` : '') + `${esc(note)}</span>` +
      (sib.length ? ` <span class="warn">· a different radio from ${esc(apart.join(', '))}</span>` : '') +
      `</div>${spark(e.hist)}</li>`;
  }).join('');
}

// Tapping a radio in the chart scrolls to its row and lights it up for a moment (kept through redraws)
let flash = { id: null, until: 0 };
$('axis').addEventListener('click', (ev) => {
  const g = ev.target.closest('g[data-i]');
  if (!g) return;
  const li = $('radios').querySelector(`li[data-i="${g.dataset.i}"]`);
  if (!li) return;
  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash = { id: radios[g.dataset.i] && radios[g.dataset.i].rec.id, until: Date.now() + 1500 };
  li.classList.add('flash');
});

// A radio's drift since the page connected
function spark(hist) {
  const W = 110, H = 28;
  if (hist.length < 2) return `<svg width="${W}" height="${H}"></svg>`;
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0];
  let lo = Math.min(...hist.map((h) => h[1])), hi = Math.max(...hist.map((h) => h[1]));
  if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
  const pts = hist.map(([t, v]) => `${((t - t0) / Math.max(1, t1 - t0) * (W - 2) + 1).toFixed(1)},${(H - 2 - (v - lo) / (hi - lo) * (H - 4)).toFixed(1)}`);
  return `<svg width="${W}" height="${H}"><title>${Math.round(hi - lo)} Hz range over ${Math.round((t1 - t0) / 60000)} min</title><polyline points="${pts.join(' ')}"/></svg>`;
}

// All radios on one frequency axis: each a band (where its packets land), stacked so labels don't collide
function drawAxis(shared) {
  const svg = $('axis');
  const W = svg.clientWidth || 600;
  if (radios.length === 0) { svg.setAttribute('height', 0); svg.innerHTML = ''; return; }
  let lo = Math.min(...radios.map((e) => e.rec.hz - bandOf(e.rec)));
  let hi = Math.max(...radios.map((e) => e.rec.hz + bandOf(e.rec)));
  if (hi - lo < 300) { const m = (hi + lo) / 2; lo = m - 150; hi = m + 150; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = (hz) => (hz - lo) / (hi - lo) * W;
  // lanes: a band and its label go in the first lane where they don't overlap another
  // labels: to the right of the band, or ending at it near the right edge; never wider than the chart
  const CW = 6.8;   // a character's width at 11px
  const lanes = [];
  const placed = [...radios].sort((a, b) => a.rec.hz - b.rec.hz).map((e) => {
    const r = e.rec;
    let label = r.named ? `${idShort(r)} ${r.name}`.trim() : r.id;
    const fit = Math.max(4, Math.floor(W / CW) - 1);
    if (label.length > fit) label = label.slice(0, fit - 1) + '…';
    const x0 = x(r.hz - bandOf(r)), x1 = x(r.hz + bandOf(r));
    const lw = label.length * CW;
    const toRight = x0 + lw <= W;
    const lx = toRight ? x0 : Math.max(0, x1 - lw);
    const left = Math.min(x0, lx), right = Math.max(x1, lx + lw) + 4;
    let lane = lanes.findIndex((end) => end < left - 4);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = right;
    return { r, i: radios.indexOf(e), label, x0, x1, lx, left, right, lane };
  });
  const LH = 30, top = 4, H = top + lanes.length * LH + 22;
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let out = '';
  // ticks every 50/100/200/500 Hz
  const step = [50, 100, 200, 500, 1000, 2000].find((s) => (hi - lo) / s <= 8) || 5000;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
    const tx = x(t).toFixed(1);
    out += `<line class="tick" x1="${tx}" x2="${tx}" y1="${top}" y2="${H - 16}"/><text x="${tx}" y="${H - 4}" text-anchor="middle">${t > 0 ? '+' : ''}${t}</text>`;
  }
  for (const p of placed) {
    const y = top + p.lane * LH;
    const cls = 'band' + (p.r.named ? '' : ' anon') + (shared.has(p.r) ? ' shared' : '');
    const mx = x(p.r.hz).toFixed(1);
    // a group per radio: tapping it (its label, band or the space between) goes to its row
    out += `<g data-i="${p.i}"><rect class="hit" x="${p.left.toFixed(1)}" y="${y}" width="${(p.right - p.left).toFixed(1)}" height="${LH}"/>` +
      `<rect class="${cls}" x="${p.x0.toFixed(1)}" y="${y + 13}" width="${Math.max(2, p.x1 - p.x0).toFixed(1)}" height="12"><title>${esc(p.label)}: ${p.r.hz} Hz ±${p.r.dev}</title></rect>` +
      `<line class="mid" x1="${mx}" x2="${mx}" y1="${y + 13}" y2="${y + 25}"/>` +
      `<text class="lbl" x="${p.lx.toFixed(1)}" y="${y + 10}">${esc(p.label)}</text></g>`;
  }
  out += `<text x="${W}" y="${H - 4}" text-anchor="end">Hz</text>`;
  svg.innerHTML = out;
}
window.addEventListener('resize', () => { if (tab === 'rad') drawAxis(lookalikes()); });

$('radreset').onclick = async () => {
  if (!confirm('Forget the radios heard so far? The radio starts learning them again.')) return;
  await radio.cli('nodes.freq reset');
  radios.length = 0;
  pollRadios(true);
};

// ---------------------------------------------------------------- console
const hist = [];
let hpos = 0;
function log(cls, text) {
  const out = $('out');
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}
$('cli').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('cmd').value.trim();
  if (!text) return;
  $('cmd').value = '';
  hist.push(text); hpos = hist.length;
  log('cmd', '> ' + text);
  try { log('rep', (await radio.cli(text)).replace(/^> /, '')); } catch (err) { log('err', err.message); }
};
$('cmd').onkeydown = (e) => {
  if (e.key === 'ArrowUp' && hpos > 0) { $('cmd').value = hist[--hpos]; e.preventDefault(); }
  if (e.key === 'ArrowDown') { hpos = Math.min(hist.length, hpos + 1); $('cmd').value = hist[hpos] || ''; e.preventDefault(); }
};

// ---------------------------------------------------------------- sensors: weather, meters
// The radio listens for one kind at a time ('wx on', 'meter on'; each turns the other off) and keeps
// a table of everything it hears ('get wx.list', 'get meter.list').
// The page reads the table, keeps each one's readings over time (in this browser), lets you name,
// star (post to the app's channel), hide and filter them.
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('flux.' + k)); return v ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('flux.' + k, JSON.stringify(v)); } catch (e) { /* full or private mode */ } },
};
const names = store.get('names', {});     // 'wx:1a2b' -> 'Back yard'
const hidden = store.get('hidden', {});   // 'meter:R900:1234' -> 1
const senHist = store.get('hist', {});    // id -> [[ms, {series: value}]]
const HIST_MAX = 300;
let histSavedAt = 0;
function saveHist(force) {
  if (!force && Date.now() - histSavedAt < 60000) return;
  histSavedAt = Date.now();
  const cut = Date.now() - 7 * 86400000;   // a week
  for (const k of Object.keys(senHist)) {
    senHist[k] = senHist[k].filter((p) => p[0] > cut);
    if (!senHist[k].length) delete senHist[k];
  }
  store.set('hist', senHist);
}
window.addEventListener('pagehide', () => saveHist(true));

const SEN = {
  wx: { name: 'Weather', what: 'weather sensors', state: 'wx', list: 'get wx.list', stats: 'get wx.stats',
    about: 'Weather stations and sensors on 915 MHz: Ecowitt, Ambient and other Fine Offset models, La Crosse, ThermoPro.' },
  meter: { name: 'Meters', what: 'meters', state: 'meter', list: 'get meter.list', stats: 'get meter.stats',
    about: 'Water, gas and electric meters on 915 MHz: Neptune R900 and Itron ERT. Finding a meter the first time can take an hour or more at the default search time.' },
};
const senState = {};     // mode -> parsed state line
let senView = null;      // the kind shown
let senRecs = [];        // its table, as last read
let senPolling = false, senListAt = 0, senStateAt = 0;
const senOpen = new Set();   // ids of the cards opened
const senFilter = { q: '', group: '', only: '', sort: 'signal', showHidden: false };

// '> <total> <from> rec;rec...' a page at a time (a reply holds about 150 characters)
async function readList(cmd, parse, maxPages = 30) {
  const recs = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const s = await radio.cli(cmd + ' ' + start);
    const m = /^> (\d+) (\d+)(?: (.*))?$/.exec(s);
    if (!m) return null;   // firmware without this list
    const items = m[3] ? m[3].split(';') : [];
    recs.push(...items.map(parse).filter(Boolean));
    start += items.length;
    if (items.length === 0 || start >= Number(m[1])) break;
  }
  return recs;
}

const ago = (s) => (s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 172800 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd');
const commas = (n) => Number(n).toLocaleString('en-US');
const idList = (s) => s.split(/[ ,]+/).filter(Boolean);

function parseSenState(mode, s) {
  if (mode === 'wx') {
    const only = ((/sensors (.*)$/.exec(s) || [])[1] || 'all').trim();
    return { on: /^> Weather on/.test(s) && !/can't/.test(s), cant: /can't/.test(s), always: /scanning all the time/.test(s),
      kind: /: Ecowitt \+ La Crosse,/.test(s) ? 'both' : /: La Crosse,/.test(s) ? 'lacrosse' : 'ecowitt',
      metric: /, metric,/.test(s), every: Number((/every (\d+) min/.exec(s) || [])[1] || 30),
      ids: only === 'all' ? [] : idList(only), line: s };
  }
  const m = /^> Meters (on|off): (.*?), listening (?:all the time|(\d+)% of the time), a post every (\d+) min/.exec(s) || [];
  const ids = !m[2] || /^none chosen/.test(m[2]) ? '' : m[2];
  return { on: m[1] === 'on' && !/needs an LR2021/.test(s), cant: /needs an LR2021/.test(s), all: ids === 'all',
    ids: ids === 'all' ? [] : idList(ids), duty: m[3] ? Number(m[3]) : 100, every: Number(m[4] || 60), line: s };
}

// key hex,model,label,format,packets,every s,dBm,age s,flags,readings (letter+number, space-separated)
function parseWx(s) {
  const f = s.split(',');
  if (f.length < 10) return null;
  const v = {};
  for (const t of f[9].split(' ')) { const m = /^([a-zA-Z])(-?\d+)$/.exec(t); if (m) v[m[1]] = Number(m[2]); }
  return { mode: 'wx', id: 'wx:' + f[0], key: f[0], model: f[1], label: f[2], count: Number(f[4]), period: Number(f[5]),
    rssi: Number(f[6]), age: Number(f[7]), batt: !!(f[8] & 1), posted: !!(f[8] & 2), v, group: f[1], postKey: f[2] };
}
// starred: picked by ID (weather with no 'wx.only' posts every sensor, but none is picked)
function starred(r) {
  return r.mode === 'wx' ? !!(senState.wx && senState.wx.ids.length) && r.posted : r.posted;
}
// kind,utility,id,reading,dBm,age s,frames,period ms,leak now,backflow,leak days,posted
function parseMeter(s) {
  const f = s.split(',');
  if (f.length < 12) return null;
  const util = f[1] === 'meter' ? 'Meter' : f[1][0].toUpperCase() + f[1].slice(1);
  return { mode: 'meter', id: `meter:${f[0]}:${f[2]}`, key: f[2], kind: f[0], util, label: f[2], total: Number(f[3]),
    rssi: Number(f[4]), age: Number(f[5]), count: Number(f[6]), period: Number(f[7]) / 1000, leak: Number(f[8]),
    back: Number(f[9]), leakDays: Number(f[10]), posted: f[11] === '1', v: { n: Number(f[3]) }, group: util, postKey: f[2] };
}
const PARSE = { wx: parseWx, meter: parseMeter };

// ---- what each reading says, in the radio's units ('set wx.units')
const metric = () => !!(senState.wx && senState.wx.metric);
const tempTxt = (c10) => (metric() ? (c10 / 10).toFixed(1) + '°C' : (c10 / 10 * 9 / 5 + 32).toFixed(1) + '°F');
const speedTxt = (dms) => (metric() ? (dms / 10).toFixed(1) + ' m/s' : (dms / 10 * 2.23694).toFixed(1) + ' mph');
const rainTxt = (um) => (metric() ? (um / 1000).toFixed(1) + ' mm' : (um / 25400).toFixed(2) + ' in');
const LEAK = ['', 'on and off', 'continuous'];
const LEAK_DAYS = ['', '1-2 days', '3-7 days', '8-14 days', '15-21 days', '22-34 days', '35+ days', '35+ days'];

// series kept over time: [key, label, format, counter (show the change, not the value)]
const SERIES = {
  t: ['Temperature', tempTxt], h: ['Humidity', (x) => x + '%'], w: ['Wind', speedTxt], g: ['Gust', speedTxt],
  r: ['Rain', rainTxt, true], u: ['UV index', (x) => (x / 10).toFixed(1)], l: ['Light', (x) => commas(x) + ' lux'],
  p: ['Pressure', (x) => (metric() ? (x / 10).toFixed(1) + ' hPa' : (x / 10 * 0.02953).toFixed(2) + ' inHg')],
  m: ['Soil moisture', (x) => x + '%'], a: ['PM2.5', (x) => (x / 10).toFixed(1) + ' µg/m³'], b: ['PM10', (x) => (x / 10).toFixed(1) + ' µg/m³'],
  c: ['PM1', (x) => (x / 10).toFixed(1) + ' µg/m³'], o: ['CO₂', (x) => x + ' ppm'], e: ['Conductivity', (x) => x + ' µS/cm'],
  k: ['Lightning strikes', (x) => String(x), true],
};
function seriesOf(r) {
  if (r.mode === 'meter') return [['n', 'Reading', commas, true]];
  return Object.keys(SERIES).filter((k) => k in r.v).map((k) => [k, ...SERIES[k]]);
}

function senTitle(r) {
  const nick = names[r.id];
  const base = r.mode === 'wx' ? `${r.model} ${r.label}` : `${r.util} ${r.key}`;
  return nick ? { main: nick, sub: base } : { main: base, sub: '' };
}

// the line of readings on a card, and its warnings
function senLine(r) {
  const v = r.v, out = [], warn = [];
  if (r.mode === 'wx') {
    if ('t' in v) out.push(tempTxt(v.t));
    if ('h' in v) out.push(v.h + '%');
    if ('w' in v || 'g' in v) out.push('wind ' + ('w' in v ? speedTxt(v.w) : '') + ('g' in v ? ', gust ' + speedTxt(v.g) : '') + ('d' in v ? ' from ' + COMPASS[Math.round(v.d / 22.5) % 16] : ''));
    if ('r' in v) out.push('rain ' + rainTxt(v.r) + ' total');
    if (v.x) out.push('raining');
    if ('u' in v) out.push('UV ' + (v.u / 10).toFixed(1));
    if ('l' in v) out.push(commas(v.l) + ' lux');
    if ('p' in v) out.push(SERIES.p[1](v.p));
    if ('m' in v) out.push('soil ' + v.m + '%');
    if ('e' in v) out.push(v.e + ' µS/cm');
    if ('a' in v) out.push('PM2.5 ' + (v.a / 10).toFixed(1));
    if ('b' in v) out.push('PM10 ' + (v.b / 10).toFixed(1));
    if ('c' in v) out.push('PM1 ' + (v.c / 10).toFixed(1));
    if ('o' in v) out.push('CO₂ ' + v.o + ' ppm');
    if ('k' in v) out.push(v.k + ' strikes' + (v.K ? `, storm ${metric() ? v.K + ' km' : Math.round(v.K * 0.621) + ' mi'} away` : ''));
    if (v.L) warn.push('WATER LEAK');
    else if ('L' in v) out.push('dry');
    if (r.batt) warn.push('battery low');
  } else {
    out.push(commas(r.total));
    if (r.leak) warn.push('leak: ' + LEAK[r.leak] + (r.leakDays ? ', for ' + LEAK_DAYS[r.leakDays] : ''));
    if (r.back) warn.push('backflow: ' + (r.back >= 2 ? 'high' : 'low'));
  }
  // how much a counter went up while this browser watched (meters, rain)
  for (const [k, , fmt, counter] of seriesOf(r)) {
    if (!counter) continue;
    const h = (senHist[r.id] || []).filter((p) => k in p[1]);
    if (h.length < 2) continue;
    const d = h[h.length - 1][1][k] - h[0][1][k];
    const mins = (h[h.length - 1][0] - h[0][0]) / 60000;
    if (d > 0 && mins >= 1) out.push(`+${k === 'r' ? rainTxt(d) : fmt(d)} over ${mins < 120 ? Math.round(mins) + ' min' : (mins / 60).toFixed(1) + ' h'}`);
  }
  return { out, warn };
}

// a new packet since the last read: add its readings to the history
function senRecord(r) {
  const at = Date.now() - r.age * 1000;
  const h = senHist[r.id] || (senHist[r.id] = []);
  const last = h[h.length - 1];
  if (last && Math.abs(last[0] - at) < 3000) return;
  const v = {};
  for (const [k] of seriesOf(r)) v[k] = r.v[k];
  h.push([at, v]);
  if (h.length > HIST_MAX) h.splice(0, h.length - HIST_MAX);
}

function sparkSeries(pts, W, H) {
  if (pts.length < 2) return `<svg width="${W}" height="${H}"></svg>`;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const xy = pts.map(([t, v]) => `${((t - t0) / Math.max(1, t1 - t0) * (W - 2) + 1).toFixed(1)},${(H - 2 - (v - lo) / (hi - lo) * (H - 4)).toFixed(1)}`);
  return `<svg width="${W}" height="${H}"><polyline points="${xy.join(' ')}"/></svg>`;
}
const histOf = (r, k) => (senHist[r.id] || []).filter((p) => k in p[1] && p[1][k] != null).map((p) => [p[0], p[1][k]]);

// ---- reading the radio
async function senStates() {
  for (const mode of Object.keys(SEN)) senState[mode] = parseSenState(mode, await radio.cli(SEN[mode].state));
  senStateAt = Date.now();
  const on = Object.keys(SEN).find((m) => senState[m].on);
  if (!senView) senView = on || 'wx';
}

let senAgain = false;   // a forced read asked for while one was running: done when it ends
async function pollSensors(force) {
  if (senPolling) { if (force) senAgain = true; return; }
  if (!radio.connected) return;
  const showing = tab === 'sen';
  const live = senView && senState[senView] && senState[senView].on;
  // on this tab: the list every 8 s; elsewhere, every minute so the history keeps filling
  const every = showing ? 8000 : 60000;
  if (!force && !(Date.now() - senListAt > every && (live || showing))) return;
  senPolling = true;
  try {
    if (force || !senView || Date.now() - senStateAt > 30000) await senStates();
    const mode = senView;
    if (senState[mode].on || showing) {
      const recs = await readList(SEN[mode].list, PARSE[mode]);
      if (recs == null) throw new Error(`this radio’s firmware doesn’t have ${SEN[mode].list}: update it at fluxcore.party/flash`);
      if (mode === senView) senRecs = recs;
      for (const r of recs) senRecord(r);
      saveHist();
      if (showing && senState[mode].on) {
        const st = await radio.cli(SEN[mode].stats);
        senState[mode].stats = st.replace(/^> /, '');
        if (mode === 'wx') await readUnknown();
      }
    }
    senListAt = Date.now();
    if (showing) drawSensors();
  } catch (e) {
    if (radio.connected && tab === 'sen') $('senstate').textContent = e.message;
  } finally {
    senPolling = false;
    if (senAgain) { senAgain = false; setTimeout(() => pollSensors(true), 0); }
  }
}
setInterval(() => pollSensors(false), 2000);

// 'get wx.unknown': packets that check out the way sensors' do but no model here reads
let unknown = [];
async function readUnknown() {
  const s = await radio.cli('get wx.unknown');
  unknown = /^> none/.test(s) ? [] : s.replace(/^> /, '').split(';').map((x) => x.trim()).filter(Boolean);
}

// ---- drawing
function senVisible() {
  const q = senFilter.q.trim().toLowerCase();
  let list = senRecs.filter((r) => {
    if (!senFilter.showHidden && hidden[r.id]) return false;
    if (senFilter.group && r.group !== senFilter.group) return false;
    if (senFilter.only === 'posted' && !starred(r)) return false;
    if (senFilter.only === 'named' && !names[r.id]) return false;
    if (senFilter.only === 'alert' && !senLine(r).warn.length) return false;
    if (senFilter.only === 'recent' && r.age > 600) return false;
    if (q) {
      const t = senTitle(r);
      if (![t.main, t.sub, r.key, r.label, r.group].join(' ').toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const by = {
    signal: (a, b) => b.rssi - a.rssi,
    recent: (a, b) => a.age - b.age,
    name: (a, b) => senTitle(a).main.localeCompare(senTitle(b).main, undefined, { numeric: true }),
    count: (a, b) => b.count - a.count,
  }[senFilter.sort];
  // starred and named ones first, then the chosen order
  list.sort((a, b) => (starred(b) - starred(a)) || (!!names[b.id] - !!names[a.id]) || by(a, b));
  return list;
}

function senModeBar() {
  return Object.entries(SEN).map(([m, d]) => {
    const st = senState[m];
    return `<button data-mode="${m}" aria-selected="${m === senView}">${st && st.on ? '<span class="dot on"></span>' : ''}${d.name}</button>`;
  }).join('');
}

function drawSensors() {
  if (!senView || !senState[senView]) return;
  const mode = senView, st = senState[mode], d = SEN[mode];
  $('senmodes').innerHTML = senModeBar();
  for (const b of $('senmodes').querySelectorAll('button')) b.onclick = () => { senView = b.dataset.mode; senRecs = []; senFilter.group = ''; senOpen.clear(); drawSensors(); pollSensors(true); };
  // the state line, and what's on
  const other = Object.keys(SEN).find((m) => m !== mode && senState[m] && senState[m].on);
  let line;
  if (st.cant) line = `This radio can’t listen for ${d.what}: it needs an LR2021.`;
  else if (!st.on) line = `${d.name} is off. ${d.about}` + (other ? ` Turning it on turns ${SEN[other].name.toLowerCase()} off.` : ' Turning it on turns off Meshtastic, aircraft or airport weather, if one is on.');
  else line = `${d.name} on` + (st.stats ? ' · ' + st.stats : '') + ' · ' + postingText(mode, st);
  $('senstate').textContent = line;
  $('sentoggle').textContent = st.on ? 'Turn off' : `Turn ${d.name.toLowerCase()} on`;
  $('sentoggle').disabled = !!st.cant;
  $('senscan').hidden = !(st.on && mode === 'wx');
  $('senscan').textContent = st.always ? 'Share the radio' : 'Listen all the time';
  drawSenSettings();
  // filter chips: the kinds heard
  const groups = [...new Set(senRecs.map((r) => r.group))].sort();
  $('sengroup').innerHTML = `<option value="">Every ${mode === 'wx' ? 'model' : 'type'}</option>` +
    groups.map((g) => `<option${g === senFilter.group ? ' selected' : ''}>${esc(g)}</option>`).join('');
  const list = senVisible();
  const nh = senRecs.filter((r) => hidden[r.id]).length;
  $('sencount').textContent = `${list.length} of ${senRecs.length}` + (nh && !senFilter.showHidden ? ` · ${nh} hidden` : '');
  const ul = $('senlist');
  if (!senRecs.length) {
    ul.innerHTML = `<li class="empty">${st.on ? `No ${d.what} heard yet.` + (mode === 'wx' ? ' The first scan listens for about 6 minutes.' : '') : `Turn ${d.name.toLowerCase()} on to hear the ${d.what} around.`}</li>`;
  } else if (!list.length) {
    ul.innerHTML = '<li class="empty">None match the filter.</li>';
  } else {
    ul.innerHTML = list.map(senCard).join('');
  }
  for (const li of ul.querySelectorAll('li[data-id]')) {
    const r = senRecs.find((x) => x.id === li.dataset.id);
    li.querySelector('.hd').onclick = (e) => {
      if (e.target.closest('button')) return;
      if (senOpen.has(r.id)) senOpen.delete(r.id); else senOpen.add(r.id);
      drawSensors();
    };
    li.querySelector('.star').onclick = () => senStar(r);
    for (const b of li.querySelectorAll('[data-act]')) b.onclick = () => senAct(r, b.dataset.act);
  }
  drawUnknown();
}

function postingText(mode, st) {
  if (mode === 'wx') return st.ids.length ? `following and posting ${st.ids.join(', ')} only` : 'posting every sensor';
  return st.all ? 'posting every meter' : st.ids.length ? `posting ${st.ids.length} meter${st.ids.length > 1 ? 's' : ''}` : 'posting none: star yours';
}

function senCard(r) {
  const t = senTitle(r), { out, warn } = senLine(r);
  const main = seriesOf(r)[0];
  const open = senOpen.has(r.id), star = starred(r);
  const old = r.age > 900;
  let html = `<li data-id="${esc(r.id)}" class="${old ? 'old' : ''} ${hidden[r.id] ? 'hid' : ''} ${open ? 'open' : ''}">` +
    `<div class="hd"><button class="star${star ? ' on' : ''}" title="${star ? 'Posted to the app’s channel: tap to stop' : 'Post this one to the app’s channel'}">${star ? '★' : '☆'}</button>` +
    `<div class="txt"><span class="cs">${esc(t.main)}</span>${t.sub ? ` <span class="meta">${esc(t.sub)}</span>` : ''}` +
    `<br><span class="val">${esc(out.join(' · '))}</span>${warn.length ? ` <span class="warn">${esc(warn.join(' · '))}</span>` : ''}` +
    `<br><span class="meta">${r.rssi} dBm · ${ago(r.age)} ago · heard ${commas(r.count)}×${r.period ? ` · every ${Math.round(r.period)} s` : ''}</span></div>` +
    (main ? sparkSeries(histOf(r, main[0]), 90, 30) : '') + '</div>';
  if (open) {
    const rows = seriesOf(r).map(([k, label, fmt]) => {
      const h = histOf(r, k);
      if (!h.length) return '';
      const lo = Math.min(...h.map((p) => p[1])), hi = Math.max(...h.map((p) => p[1]));
      const span = (h[h.length - 1][0] - h[0][0]) / 3600000;
      return `<div class="ser"><span>${esc(label)}<br><span class="meta">${esc(fmt(h[h.length - 1][1]))}${lo !== hi ? ` · ${esc(fmt(lo))} to ${esc(fmt(hi))} over ${span < 1 ? Math.round(span * 60) + ' min' : span.toFixed(1) + ' h'}` : ''}</span></span>${sparkSeries(h, 220, 44)}</div>`;
    }).join('');
    const facts = [r.mode === 'wx' ? `label ${r.label} (as in its posts and wx.only)` : `ID ${r.key}`, r.mode === 'meter' ? r.kind : '',
      `${(senHist[r.id] || []).length} readings kept in this browser`].filter(Boolean);
    html += `<div class="more">${rows}<p class="meta">${esc(facts.join(' · '))}</p>` +
      `<div class="acts"><button class="quiet" data-act="name">${names[r.id] ? 'Rename' : 'Name it'}</button>` +
      `<button class="quiet" data-act="hide">${hidden[r.id] ? 'Unhide' : 'Hide'}</button>` +
      `<button class="quiet" data-act="copy">Copy ${r.mode === 'wx' ? 'label' : 'ID'}</button>` +
      `<button class="quiet" data-act="forget">Forget history</button></div></div>`;
  }
  return html + '</li>';
}

async function senAct(r, act) {
  if (act === 'name') {
    const n = prompt(`A name for ${senTitle(r).sub || senTitle(r).main} (kept in this browser; empty to clear)`, names[r.id] || '');
    if (n == null) return;
    if (n.trim()) names[r.id] = n.trim(); else delete names[r.id];
    store.set('names', names);
  } else if (act === 'hide') {
    if (hidden[r.id]) delete hidden[r.id]; else hidden[r.id] = 1;
    store.set('hidden', hidden);
  } else if (act === 'copy') {
    try { await navigator.clipboard.writeText(r.postKey); } catch (e) { prompt('Copy:', r.postKey); }
  } else if (act === 'forget') {
    delete senHist[r.id];
    saveHist(true);
  }
  drawSensors();
}

// Starring: the radio's list of the ones to post ('set wx.only', 'set meter.ids')
async function senStar(r) {
  const mode = r.mode, st = senState[mode];
  if (mode === 'meter' && st.all) {   // every meter is posted: switch to a list, starting with this one
    if (!confirm(`Post only ${r.postKey}? This turns off "post every meter"; star more to add them.`)) return;
    await senCommand(`set meter.ids ${r.postKey}`);
    return;
  }
  let ids = [...st.ids];
  const has = ids.some((x) => x.toLowerCase() === r.postKey.toLowerCase());
  if (mode === 'wx' && !st.ids.length && !confirm(`Post and follow only ${r.label}? The radio stops following the other sensors (they stay in the list, but their readings stop updating). Star more to add them.`)) return;
  if (mode === 'wx' && !st.ids.length) ids = [r.postKey];
  else ids = has ? ids.filter((x) => x.toLowerCase() !== r.postKey.toLowerCase()) : [...ids, r.postKey];
  const cmd = mode === 'wx' ? `set wx.only ${ids.length ? ids.join(',') : 'all'}` : `set ${mode}.ids ${ids.length ? ids.join(',') : 'none'}`;
  await senCommand(cmd);
}

let senSaved = { cmd: '', until: 0 };   // the setting just saved, marked for a moment
async function senCommand(cmd) {
  const r = await radio.cli(cmd);
  log('cmd', '> ' + cmd);
  log(/^Error/.test(r) ? 'err' : 'note', r);
  if (/^Error/.test(r)) alert(r.replace(/^Error: /, ''));
  await pollSensors(true);
  return r;
}

function drawSenSettings() {
  const mode = senView, st = senState[mode];
  const sel = (cmd, cur, opts) => `<select data-cmd="${cmd}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  // a number box and its Set button (a phone's number pad has no Enter key); "saved" for a moment after
  const num = (cmd, cur, min, max, unit) => `<span class="numset"><input type="number" data-num="${cmd}" data-cur="${cur}" value="${cur}" min="${min}" max="${max}" inputmode="numeric"> ${unit}` +
    `<button class="quiet" data-set="${cmd}" disabled>Set</button>${senSaved.cmd === cmd && Date.now() < senSaved.until ? '<span class="saved">✓ saved</span>' : ''}</span>`;
  let h = '';
  if (mode === 'wx') {
    h = `<label>Listen for ${sel('set wx.kind', st.kind, [['both', 'Ecowitt + La Crosse'], ['ecowitt', 'Ecowitt only'], ['lacrosse', 'La Crosse only']])}</label>` +
      `<label>Units ${sel('set wx.units', st.metric ? 'metric' : 'us', [['us', 'US'], ['metric', 'Metric']])}</label>` +
      `<label>Post each every ${num('set wx.every', st.every, 0, 1440, 'min')}</label>` +
      `<button class="quiet" data-run="wx scan"${st.on ? '' : ' disabled'}>Scan for sensors now</button>` +
      (st.ids.length ? '<button class="quiet" data-run="set wx.only all">Follow every sensor</button>' : '');
  } else {
    h = `<label>Post each every ${num('set meter.every', st.every, 1, 1440, 'min')}</label>` +
      `<label>Search ${num('set meter.duty', st.duty, 1, 100, '% of the time')}</label>` +
      `<button class="quiet" data-run="set meter.ids ${st.all ? 'none' : 'all'}">${st.all ? 'Stop posting every meter' : 'Post every meter'}</button>`;
  }
  const box = $('sensettings');
  if (box.dataset.mode === mode && box.dataset.html === h) return;   // don't redraw under a finger
  box.dataset.mode = mode; box.dataset.html = h;
  box.innerHTML = h;
  for (const el of box.querySelectorAll('select[data-cmd]')) el.onchange = () => senCommand(`${el.dataset.cmd} ${el.value}`);
  for (const el of box.querySelectorAll('input[data-num]')) {
    const btn = el.parentElement.querySelector('button[data-set]');
    const set = async () => {
      if (el.value.trim() === '' || el.value === el.dataset.cur) return;
      btn.disabled = true;
      btn.textContent = '…';
      const r = await senCommand(`${el.dataset.num} ${el.value}`);
      if (!/^Error/.test(r)) { senSaved = { cmd: el.dataset.num, until: Date.now() + 4000 }; setTimeout(drawSenSettings, 4100); }
      box.dataset.html = '';   // redraw with the radio's value (or the old one, after an error)
      drawSenSettings();
    };
    el.oninput = () => { btn.disabled = el.value.trim() === '' || el.value === el.dataset.cur; };
    el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); set(); } };
    btn.onclick = set;
  }
  for (const b of box.querySelectorAll('[data-run]')) b.onclick = () => senCommand(b.dataset.run);
}

function drawUnknown() {
  const box = $('senunknown');
  if (senView !== 'wx' || !unknown.length) { box.hidden = true; return; }
  box.hidden = false;
  const key = unknown.join(';');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '<b>Sensors this firmware can’t read yet</b><p class="meta">Packets that check out the way a sensor’s do, but match no model it knows. Their bytes help add the model.</p>' +
    unknown.map((u, i) => `<div class="unk"><span>${esc(u)}</span> <button class="quiet" data-n="${i + 1}">Bytes</button><pre hidden></pre></div>`).join('');
  for (const b of box.querySelectorAll('button[data-n]')) {
    b.onclick = async () => {
      const pre = b.nextElementSibling;
      pre.textContent = (await radio.cli('get wx.unknown ' + b.dataset.n)).replace(/^> /, '');
      pre.hidden = false;
    };
  }
}

// CSV of the readings kept for the ones listed
function senExport() {
  const rows = [['time', 'kind', 'id', 'name', 'reading', 'value']];
  for (const r of senVisible()) {
    for (const [at, v] of senHist[r.id] || []) {
      for (const [k, label, fmt] of seriesOf(r)) if (k in v && v[k] != null) rows.push([new Date(at).toISOString(), SEN[r.mode].name, r.postKey, names[r.id] || '', label, fmt(v[k])]);
    }
  }
  const csv = rows.map((row) => row.map((c) => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `fluxcore-${senView}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('sentoggle').onclick = async () => {
  const st = senState[senView];
  await senCommand(`${senView} ${st.on ? 'off' : 'on'}`);
};
$('senscan').onclick = () => senCommand(senState.wx.always ? 'wx scan off' : 'wx scan on');
$('senq').oninput = () => { senFilter.q = $('senq').value; drawSensors(); };
$('sengroup').onchange = () => { senFilter.group = $('sengroup').value; drawSensors(); };
$('senonly').onchange = () => { senFilter.only = $('senonly').value; drawSensors(); };
$('sensort').onchange = () => { senFilter.sort = $('sensort').value; drawSensors(); };
$('senhidden').onchange = () => { senFilter.showHidden = $('senhidden').checked; drawSensors(); };
$('senexport').onclick = senExport;
