"use strict";
/* ===== storage helpers (browser only; may be unavailable) ===== */
const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch (e) { return d } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) { } } };
const $ = s => document.querySelector(s), now = () => new Date().toISOString();
const fmt = t => new Date(t).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* ===== state ===== */
const cfg = ls.get('inc_cfg', { on: 28, off: 25, buzzer: true, notif: true, admin: 'admin', pass: 'admin123', device: '', api: '' });
const S = {
    temp: null, hum: null, fan: false, mode: 'AUTO', fails: 0, lock: null, batt: null, vib: false, buzzer: false, alert: null, live: false, last: 0,
    hist: ls.get('inc_hist', []), logs: ls.get('inc_logs', []), notifs: ls.get('inc_notifs', []), alerts: ls.get('inc_alerts', []),
    users: ls.get('inc_users', [{ id: 1, name: 'Administrator', user: 'admin', uid: '', role: 'Admin', active: true, date: new Date().toISOString().slice(0, 10) }])
};
/* Remove demo data saved by the earlier simulation version, and restore an unresolved alert after a refresh */
['hist', 'logs', 'notifs', 'alerts'].forEach(k => S[k] = S[k].filter(x => !x.sim));
S.users = S.users.filter(u => !(/^Lab User (One|Two)$/.test(u.name) && /^User [12]$/.test(u.user)));
S.alert = S.alerts.slice().reverse().find(a => !a.acked) || null;
const save = () => { ls.set('inc_hist', S.hist.slice(-10080)); ls.set('inc_logs', S.logs.slice(-500)); ls.set('inc_notifs', S.notifs.slice(-200)); ls.set('inc_alerts', S.alerts); ls.set('inc_users', S.users); ls.set('inc_cfg', cfg) };
let page = 'dashboard', lf = { q: '', st: '', range: 'all', pg: 1 }, uq = '';
const num = (x, d = 0, u = '') => x == null ? '--' : x.toFixed(d) + u, uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/* ===== UI helpers ===== */
function toast(m) { const e = document.createElement('div'); e.className = 'toast'; e.textContent = m; document.body.appendChild(e); setTimeout(() => e.remove(), 2800) }
function modal(title, fields, ok, okLabel, icon) {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="glass"><div class="mi">${icon || '📝'}</div><h3>${esc(title)}</h3>${fields.map(f => f.type === 'select' ? `<label>${f.l}</label><select name="${f.k}">${f.opts.map(o => `<option ${o == f.v ? 'selected' : ''}>${o}</option>`).join('')}</select>` : f.msg ? `<p>${esc(f.msg)}</p>` : `<label>${f.l}</label><input name="${f.k}" type="${f.type || 'text'}" value="${esc(f.v || '')}">`).join('')}<div class="err"></div><div class="row" style="margin:12px 0 0"><button class="btn" id="mok">${okLabel || 'Save changes'}</button><button class="btn g" id="mno">Cancel</button></div></div>`;
    document.body.appendChild(m); m.querySelector('#mno').onclick = () => m.remove();
    m.querySelector('#mok').onclick = () => { const v = {}; m.querySelectorAll('[name]').forEach(i => v[i.name] = i.value.trim()); const r = ok(v); if (r) m.querySelector('.err').textContent = r; else m.remove() }
}
const confirmBox = (msg, fn, l, icon) => modal('Please confirm', [{ msg }], () => { fn() }, l || 'Confirm', icon || '⚠️');
/* ===== core logic ===== */
function addAccessLog(r) {
    const last = S.logs[S.logs.length - 1]; if (last && last.details === r.details && last.uid === r.uid && last.status === r.status && Date.now() - new Date(last.t) < 1500) return;
    const rec = { id: uid(), t: now(), ...r }; S.logs.push(rec); api.push('logs', rec); save(); if (page === 'logs') render()
}
function createNotification(type, msg) { if (!cfg.notif && type === 'info') return; const n = { id: uid(), type, msg, t: now(), read: false }; S.notifs.push(n); api.push('notifications', n); save(); bell() }
const bell = () => { $('#bc').textContent = S.notifs.filter(n => !n.read).length };
function tempStatus() { if (S.temp == null) return ['No data', 'i']; return S.temp >= 32 ? ['Critical', 'd'] : S.temp >= cfg.on ? ['Warning', 'w'] : ['Normal', ''] }
function humStatus() { if (S.hum == null) return ['No data', 'i']; return S.hum > 70 || S.hum < 30 ? ['Warning', 'w'] : ['Normal', ''] }
/* Hysteresis: ON at >= on, OFF at <= off, hold state in between. Never runs in MANUAL mode. */
function controlFanAutomatically() {
    if (S.mode !== 'AUTO' || !S.live || S.temp == null) return;
    if (S.temp >= cfg.on && !S.fan) { updateFanStatus(true); createNotification('warn', 'High temperature ' + S.temp.toFixed(1) + '°C – exhaust fan automatically activated') }
    else if (S.temp <= cfg.off && S.fan) { updateFanStatus(false); createNotification('info', 'Temperature returned to normal (' + S.temp.toFixed(1) + '°C) – fan turned off') }
}
function updateFanStatus(on) { if (S.fan !== on) snd.fan(on); S.fan = on; cmd('fan', { on }) }
const needDevice = () => { if (S.live) return false; toast('Device offline – command not sent'); return true };
function setManualFanControl(on) { if (needDevice()) return; S.mode = 'MANUAL'; cmd('mode', { mode: 'MANUAL' }); updateFanStatus(on); toast('Manual mode: fan ' + (on ? 'ON' : 'OFF') + ' command sent'); render() }
function enableAutomaticMode() { if (needDevice()) return; S.mode = 'AUTO'; cmd('mode', { mode: 'AUTO' }); controlFanAutomatically(); render() }
/* ===== sound (Web Audio; browsers allow it after the first click, e.g. the login click) ===== */
const snd = {
    ctx: null, iv: null,
    beep(f, d, t) { try { this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); const c = this.ctx; if (c.state === 'suspended') c.resume(); const o = c.createOscillator(), g = c.createGain(), a = c.currentTime + (t || 0); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(.12, a); g.gain.exponentialRampToValueAtTime(.001, a + d); o.connect(g); g.connect(c.destination); o.start(a); o.stop(a + d) } catch (e) { } },
    denied() { if (cfg.buzzer) [0, .25, .5].forEach(t => this.beep(900, .18, t)) }, /* unauthorized card: 3 short beeps */
    start() { if (this.iv || !cfg.buzzer) return; const p = () => { this.beep(1000, .3, 0); this.beep(700, .3, .35) }; p(); this.iv = setInterval(p, 800) }, /* siren until silenced */
    stop() { clearInterval(this.iv); this.iv = null }
};
/* UI + fan sounds (separate from the alarm; can be switched off in Settings) */
Object.assign(snd, {
    sfx() { return cfg.sfx !== false },
    tone(f1, f2, d, type, vol, t) { if (!this.sfx()) return; try { this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); const c = this.ctx; if (c.state === 'suspended') c.resume(); const o = c.createOscillator(), g = c.createGain(), a = c.currentTime + (t || 0); o.type = type; o.frequency.setValueAtTime(f1, a); o.frequency.exponentialRampToValueAtTime(f2, a + d); g.gain.setValueAtTime(vol, a); g.gain.exponentialRampToValueAtTime(.001, a + d); o.connect(g); g.connect(c.destination); o.start(a); o.stop(a + d) } catch (e) { } },
    nav() { this.tone(380, 640, .14, 'sine', .06) },
    welcome() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, .3, 'sine', .07, i * .11)) },
    fan(on) { if (on) { this.tone(120, 520, .8, 'sawtooth', .04); this.tone(100, 400, .8, 'triangle', .05) } else this.tone(480, 90, .9, 'sawtooth', .04) }
}); /* fan spin-up / spin-down, manual or automatic */
/* One alert path for vibration, forced opening attempts and 3 failed RFID scans. No duplicate while an alert is unresolved. */
function raiseAlert(title, msg, note) {
    if (S.alert && !S.alert.acked) { /* alert already open: keep ONE alert record, but log the new attempt and sound the alarm again if it was silenced */
        S.alert.count = (S.alert.count || 1) + 1; addAccessLog({ user: 'System', uid: '-', action: 'Security Alert', status: 'Alert', details: title + ' (repeat #' + S.alert.count + ')' });
        if (!S.buzzer) activateBuzzer(); save(); render(); return
    }
    const a = { id: uid(), t: now(), acked: false, title, msg }; S.alert = a; S.alerts.push(a); api.push('alerts', a); S.vib = /vibration/i.test(title);
    addAccessLog({ user: 'System', uid: '-', action: 'Security Alert', status: 'Alert', details: title + (note ? ' (' + note + ')' : '') });
    createNotification('sec', title + ' – ' + msg); activateBuzzer(); save(); render()
}
function detectVibration() { raiseAlert('Vibration Detected', 'Possible unauthorized access to the cabinet.') }
function activateBuzzer() { if (!cfg.buzzer || S.buzzer) return; S.buzzer = true; cmd('buzzer', { on: true }); snd.start() }
function silenceBuzzer() { S.buzzer = false; snd.stop(); cmd('buzzer', { on: false }); render() } /* alert stays active */
function acknowledgeAlert() { if (!S.alert) return; S.alert.acked = true; S.alert.ackT = now(); api.push('alerts', S.alert); S.alert = null; S.vib = false; S.buzzer = false; snd.stop(); cmd('buzzer', { on: false }); createNotification('info', 'Security alert acknowledged'); save(); render() }
/* dev = event from the device {cardUID,username,accessStatus}. If the device already decided, we record its decision;
   if it only sent a card UID, the page checks the registered users (unknown or inactive cards are always denied). */
function processRFIDAccess(uid, dev) {
    const u = uid ? S.users.find(x => x.uid === uid) : null, ok = dev && dev.accessStatus ? String(dev.accessStatus).toUpperCase() === 'GRANTED' : !!(u && u.active);
    if (ok) {
        S.fails = 0; S.authAt = Date.now(); if (!dev || !dev.accessStatus) { S.lock = S.lock === 'LOCKED' ? 'UNLOCKED' : 'LOCKED'; cmd('lock', { lock: S.lock }) }
        addAccessLog({ user: (u && u.user) || (dev && dev.username) || 'Unknown', uid, action: 'Access Attempt', status: 'Granted', details: dev && dev.accessStatus ? 'Authorized card' : S.lock === 'UNLOCKED' ? 'Cabinet Unlocked' : 'Cabinet Locked' })
    }
    else { snd.denied(); addAccessLog({ user: u ? u.user : 'Guest', uid: uid || '0000', action: 'Access Attempt', status: 'Denied', details: u ? 'Card deactivated' : 'Unauthorized Card' }); S.fails++; createNotification('sec', 'Unauthorized RFID access attempt ' + S.fails + ' of 3 (card #' + (uid || '0000') + ')'); if (S.fails >= 3) { S.fails = 0; raiseAlert('Vibration Detected', '3 unauthorized RFID attempts in a row. Possible unauthorized access to the cabinet.', 'triggered by 3 failed RFID scans') } } render()
}
/* Security events sent by the hardware, e.g. {"event":"VIBRATION_DETECTED","status":"ALERT","buzzerStatus":true} */
function handleSecurityEvent(m) {
    const e = String(m.event || '').toUpperCase();
    if (e === 'VIBRATION_DETECTED') detectVibration();
    else if (e === 'FORCED_OPEN_ATTEMPT') raiseAlert('Forced Opening Attempt', 'Someone is trying to open the locked cabinet.');
    else if (e === 'LOW_BATTERY') createNotification('warn', 'Low battery warning');
    else console.warn('Unknown security event', e);
    if (m.buzzerStatus === true && S.alert && !S.buzzer) { S.buzzer = true; render() }
}
/* The lock state is never changed locally: the device reports it back in its sensor data. */
function updateCabinetLockStatus(s) { if (needDevice()) return; const go = () => { if (s === 'UNLOCKED') S.authAt = Date.now(); cmd('lock', { lock: s }); toast('Command sent – waiting for the device to confirm') }; if (s === 'UNLOCKED') confirmBox('Unlock the cabinet remotely?', go, 'Unlock', '🔓'); else go() }
/* History is stored at most once a minute (about 7 days kept). */
function updateTemperature(v) { S.temp = v; if (!S.lastH || Date.now() - S.lastH >= 60000) { S.lastH = Date.now(); const h = { t: now(), temp: +v.toFixed(1), hum: S.hum == null ? null : Math.round(S.hum) }; S.hist.push(h); api.push('readings', h) } controlFanAutomatically() }
function updateHumidity(v) { S.hum = v }
function updateDashboard() { if (page !== 'logs' && page !== 'users' && page !== 'settings') render(); else conn(); bell() }
/* ===== iot.js section: REST + WebSocket, validation, reconnect ===== */
/* ===== API layer: REST + WebSocket to the ESP32 and a database server. No simulated data. =====
 REST (base URL = cfg.api): GET /state -> sensor JSON | POST /command {command,...}
   POST /logs|alerts|notifications|readings|users (upsert by id) | GET /logs|alerts|notifications|users | DELETE /users/:id
 WebSocket (cfg.device): device sends sensor JSON, RFID events {cardUID,...} and security events {event,...}; page sends {command,...} */
const api = {
    base() { return (cfg.api || '').replace(/\/+$/, '') },
    async req(path, opt) {
        const b = this.base(); if (!b) return null; const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
        try { const r = await fetch(b + path, { headers: { 'Content-Type': 'application/json' }, signal: c.signal, ...opt }); if (!r.ok) throw new Error(r.status); return await r.json().catch(() => ({})) } catch (e) { return null } finally { clearTimeout(t) }
    },
    push(kind, rec) { if (this.base()) this.req('/' + kind, { method: 'POST', body: JSON.stringify(rec) }) },
    async pull() {
        let added = 0; for (const k of ['logs', 'alerts', 'notifications', 'users']) {
            const rows = await this.req('/' + k); if (!Array.isArray(rows)) continue;
            const key = { logs: 'logs', alerts: 'alerts', notifications: 'notifs', users: 'users' }[k], have = new Set(S[key].map(x => String(x.id)));
            rows.forEach(r => { if (r && r.id != null && !have.has(String(r.id))) { S[key].push(r); added++ } }); S[key].sort((a, b) => new Date(a.t || a.date) - new Date(b.t || b.date))
        }
        if (added) { S.alert = S.alerts.slice().reverse().find(a => !a.acked) || null; save(); bell(); if (page !== 'settings') render() }
    }
};
function setLive(b) {
    if (S.live === b) return; S.live = b;
    if (b) { createNotification('info', S.seen ? 'System connection restored' : 'Device connected'); S.seen = 1 } else if (S.seen) createNotification('warn', 'System connection lost');
    updateDashboard()
}
const iot = {
    ws: null, tries: 0, url: '', pt: null,
    valid(d) { return d && typeof d.temperature === 'number' && typeof d.humidity === 'number' && d.temperature > -40 && d.temperature < 125 && d.humidity >= 0 && d.humidity <= 100 },
    apply(d) {
        if (!this.valid(d)) return console.warn('Invalid sensor payload', d);
        S.last = Date.now(); setLive(true); const fan = !!d.fanStatus; if (S.fan !== fan) snd.fan(fan); S.fan = fan; S.mode = d.fanMode === 'MANUAL' ? 'MANUAL' : 'AUTO';
        if (d.cabinetLock === 'LOCKED' || d.cabinetLock === 'UNLOCKED') {
            const was = S.lock; S.lock = d.cabinetLock;
            /* Cabinet went LOCKED -> UNLOCKED. If no authorized card or remote unlock happened within 15 s (3 s grace for message order), it is a forced opening. */
            if (was === 'LOCKED' && S.lock === 'UNLOCKED') { const t0 = Date.now(); setTimeout(() => { if (!(S.authAt && S.authAt > t0 - 15000)) raiseAlert('Cabinet Opened Without Authorization', 'The cabinet was unlocked without a valid RFID card or remote command.') }, 3000) }
        }
        if (typeof d.batteryLevel === 'number') { S.batt = d.batteryLevel; if (S.batt < 20 && !S.lowB) { S.lowB = 1; createNotification('warn', 'Low battery warning') } else if (S.batt >= 25) S.lowB = 0 }
        S.hum = d.humidity; updateTemperature(d.temperature);
        if (d.vibrationDetected && !S.vibRaw) detectVibration(); S.vibRaw = !!d.vibrationDetected; /* only on the rising edge */
        const fo = !!(d.forcedOpenAttempt || d.tamper); if (fo && !S.foRaw) raiseAlert('Forced Opening Attempt', 'Someone is trying to open the locked cabinet.'); S.foRaw = fo;
        updateDashboard()
    },
    handle(m) {
        if (!m || typeof m !== 'object') return;
        if (m.temperature !== undefined) this.apply(m); else if (m.cardUID !== undefined) processRFIDAccess(String(m.cardUID), m); else if (m.event !== undefined) handleSecurityEvent(m); else console.warn('Unknown message', m)
    },
    send(c, p) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify({ command: c, ...p })); return true } return false },
    poll() {
        clearInterval(this.pt); this.pt = null; if (!api.base()) return; let n = 0, busy = false;
        const tick = async () => { if (busy) return; busy = true; const d = await api.req('/state'); busy = false; if (d) iot.handle(d); if (++n % 5 === 0) api.pull() }; tick(); this.pt = setInterval(tick, 2000)
    }
};
function connectToIoTDevice(url) {
    if (!url) { toast('Enter a WebSocket URL, e.g. ws://192.168.1.50:81'); return }
    iot.url = url; if (iot.ws) { try { iot.ws.onclose = null; iot.ws.close() } catch (e) { } }
    try {
        const w = new WebSocket(url); iot.ws = w;
        w.onopen = () => { iot.tries = 0; S.last = Date.now(); setLive(true); toast('Connected to the device') };
        w.onmessage = e => { try { iot.handle(JSON.parse(e.data)) } catch (x) { console.warn('Bad message', x) } };
        w.onclose = () => { setLive(false); if (iot.url) { iot.tries++; setTimeout(() => iot.url && connectToIoTDevice(iot.url), Math.min(15000, 2000 * iot.tries)) } }; /* automatic reconnection */
        w.onerror = () => toast('Could not reach the device at ' + url)
    } catch (e) { toast('Invalid device URL: ' + e.message) }
}
function connectAll() {
    cfg.device = $('#s_dev').value.trim(); cfg.api = $('#s_api').value.trim(); save();
    if (!cfg.device && !cfg.api) return toast('Enter a WebSocket URL and/or a REST API URL');
    if (cfg.device) connectToIoTDevice(cfg.device); if (cfg.api) { iot.poll(); api.pull() }; toast('Connecting…')
}
function disconnectFromIoTDevice() { iot.url = ''; if (iot.ws) { iot.ws.onclose = null; iot.ws.close() } clearInterval(iot.pt); iot.pt = null; setLive(false); toast('Disconnected'); render() }
/* Returns true only if the command was really sent to a connected device. */
function cmd(c, p) { const ws = iot.send(c, p); if (api.base()) api.req('/command', { method: 'POST', body: JSON.stringify({ command: c, ...p }) }); return ws || (!!api.base() && S.live) }
/* No data for 10 s = connection lost */
setInterval(() => { if (S.live && Date.now() - S.last > 10000) setLive(false) }, 2000);
/* ===== charts (canvas, no libraries) ===== */
function chart(id, key, color, min, max, lines, range) {
    const c = $('#' + id); if (!c) return; const r = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight; c.width = W * r; c.height = H * r; const g = c.getContext('2d'); g.scale(r, r);
    const ms = { hour: 36e5, day: 864e5, week: 6048e5 }[range] || 864e5, d = S.hist.filter(h => h[key] != null && Date.now() - new Date(h.t) <= ms);
    g.strokeStyle = 'rgba(120,160,255,.2)'; g.fillStyle = '#9db0d3'; g.font = '11px sans-serif';
    const Y = v => H - 18 - (v - min) / (max - min) * (H - 28);
    (lines || []).forEach(l => { g.setLineDash([5, 4]); g.strokeStyle = l >= 28 ? '#ef4444' : '#f59e0b'; g.beginPath(); g.moveTo(30, Y(l)); g.lineTo(W, Y(l)); g.stroke(); g.fillText(l + '°', 2, Y(l) + 4) }); g.setLineDash([]);
    if (d.length < 2) { g.fillText('Waiting for device data…', W / 2 - 40, H / 2); return }
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); d.forEach((h, i) => { const x = 30 + i / (d.length - 1) * (W - 34); i ? g.lineTo(x, Y(h[key])) : g.moveTo(x, Y(h[key])) }); g.stroke(); g.fillText(min, 2, H - 6); g.fillText(max, 2, 10)
}
/* ===== pages ===== */
const NAV = [['dashboard', '🏠', 'Dashboard'], ['logs', '🕒', 'Access Logs'], ['temp', '🌡', 'Temperature Monitoring'], ['security', '🛡', 'Security Monitoring'], ['users', '👥', 'User Management'], ['notifs', '🔔', 'Notifications'], ['settings', '⚙', 'Settings']];
const P = {};
P.dashboard = () => {
    const [ts, tc] = tempStatus(), [hs, hc] = humStatus(), a = S.alert, recent = S.logs.slice(-3).reverse();
    return `<h2>Dashboard</h2><p class="sub">Real-time laboratory status overview.</p>
 ${S.live ? '' : `<div class="glass" style="border-color:var(--wn);margin-bottom:14px">⚠️ <b>No device connected.</b> Values show -- until your ESP32 sends data. Set the device address in <a href="#settings" style="color:var(--cy)">Settings</a>.</div>`}
 <div class="grid"><div class="glass"><span class="mu">🌡 Temperature</span><div class="big">${num(S.temp, 1)} °C</div><span class="st ${tc}">${ts}</span></div>
 <div class="glass"><span class="mu">💧 Humidity</span><div class="big">${num(S.hum, 0)}%</div><span class="st ${hc}">${hs}</span></div>
 <div class="glass"><span class="mu"><span class="fanic${S.fan ? ' spin' : ''}" style="animation-delay:-${(Date.now() % 1000) / 1000}s">🌀</span> Exhaust Fan</span> <span class="st ${S.fan ? '' : 'i'}">${S.fan ? 'ON' : 'OFF'}</span> <span class="st ${S.mode === 'MANUAL' ? 'w' : 'i'}">${S.mode === 'MANUAL' ? 'MANUAL MODE' : 'AUTO MODE'}</span>
 <p class="mu" style="margin:8px 0">ON ≥ ${cfg.on}°C · OFF ≤ ${cfg.off}°C</p><button class="btn s" onclick="setManualFanControl(${!S.fan})">Turn ${S.fan ? 'Off' : 'On'}</button> ${S.mode === 'MANUAL' ? '<button class="btn g s" onclick="enableAutomaticMode()">Return to Auto</button>' : ''}</div></div>
 <div class="grid" style="margin-top:14px"><div class="glass">🔒 Cabinet Lock<br><span class="st ${S.lock === 'LOCKED' ? '' : S.lock ? 'w' : 'i'}">${S.lock || 'NO DATA'}</span>${S.live && S.lock ? `<br><button class="btn g s" style="margin-top:6px" onclick="updateCabinetLockStatus('${S.lock === 'LOCKED' ? 'UNLOCKED' : 'LOCKED'}')">${S.lock === 'LOCKED' ? 'Unlock' : 'Lock'}</button>` : ''}</div>
 <div class="glass">🛡 Security<br><span class="st ${a ? 'd' : ''}">${a ? 'ALERT' : 'NORMAL'}</span></div>
 <div class="glass">🔋 Battery<br><b>${num(S.batt, 0)}%</b><div class="bar"><i style="width:${S.batt || 0}%;background:${S.batt != null && S.batt < 20 ? 'var(--rd)' : 'var(--ok)'}"></i></div></div></div>
 <div class="grid two" style="margin-top:14px"><div class="glass"><b>Latest Activity</b> <a class="mu" href="#logs" style="float:right">View All</a>
 ${recent.map(l => `<div class="ev"><span>${l.status === 'Granted' ? '✅' : l.status === 'Denied' ? '⛔' : '⚠️'}</span><div><b>RFID ${l.action === 'Security Alert' ? l.details : 'Access ' + l.status}</b><br><small>${fmt(l.t)} · ${esc(l.user)}</small></div></div>`).join('') || '<p class="mu">No activity yet.</p>'}</div>
 <div class="glass ${a ? 'alert' : ''}"><b style="color:${a ? '#ff7b7b' : 'inherit'}">${a ? '🚨 SECURITY ALERT' : '🛡 Security Alert'}</b>
 ${a ? `<p><b>${esc(a.title || 'Vibration Detected')}!</b><br>${esc(a.msg || 'Possible unauthorized access to the cabinet.')}<br><small>${fmt(a.t)}</small></p><button class="btn r s" ${S.buzzer ? '' : 'disabled'} onclick="silenceBuzzer()">🔕 Silence Buzzer</button> <button class="btn s" onclick="acknowledgeAlert()">Acknowledge Alert</button>` : '<p class="mu">No active alerts.</p>'}</div></div>`
};
P.logs = () => {
    let r = S.logs.slice().reverse(); const q = lf.q.toLowerCase(), lim = { day: 864e5, week: 6048e5 }[lf.range];
    r = r.filter(l => (!lf.st || l.status === lf.st) && (!lim || Date.now() - new Date(l.t) < lim) && (!q || [l.user, l.uid, l.action, l.details, l.status].join(' ').toLowerCase().includes(q)));
    const cnt = s => S.logs.filter(l => l.status === s).length, pages = Math.max(1, Math.ceil(r.length / 5)); lf.pg = Math.min(lf.pg, pages);
    return `<h2>Access Logs</h2><p class="sub">Track all RFID access activities and security events.</p>
 <div class="row"><select onchange="lf.range=this.value;lf.pg=1;render()">${[['all', 'All time'], ['day', 'Last 24 Hours'], ['week', 'Last 7 Days']].map(o => `<option value="${o[0]}" ${lf.range === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
 <select onchange="lf.st=this.value;lf.pg=1;render()">${['', 'Granted', 'Denied', 'Alert'].map(o => `<option value="${o}" ${lf.st === o ? 'selected' : ''}>${o || 'All status'}</option>`).join('')}</select>
 <input id="lq" placeholder="Search by user, card ID, or event…" value="${esc(lf.q)}"><button class="btn s" onclick="exportAccessLogs()">Export Logs</button></div>
 <div class="glass tw"><table><tr><th>Date &amp; Time</th><th>User</th><th>Card UID</th><th>Action</th><th>Status</th><th>Details</th></tr>
 ${r.slice((lf.pg - 1) * 5, lf.pg * 5).map(l => `<tr><td>${fmt(l.t)}</td><td>${esc(l.user)}</td><td>${l.uid === '-' ? '-' : '#' + esc(l.uid)}</td><td>${l.action}</td><td><span class="st ${l.status === 'Granted' ? '' : l.status === 'Denied' ? 'd' : 'w'}">${l.status}</span></td><td>${esc(l.details)}</td></tr>`).join('') || '<tr><td colspan=6 class="mu">No logs yet. Records appear when the device reports an RFID scan or alert.</td></tr>'}</table></div>
 <div class="row glass" style="margin-top:12px"><span>Total Logs: ${S.logs.length}</span><span class="st">Granted: ${cnt('Granted')}</span><span class="st d">Denied: ${cnt('Denied')}</span><span class="st w">Alerts: ${cnt('Alert')}</span>
 <span style="margin-left:auto"><button class="btn g s" onclick="lf.pg=Math.max(1,lf.pg-1);render()">‹</button> ${lf.pg}/${pages} <button class="btn g s" onclick="lf.pg=Math.min(${pages},lf.pg+1);render()">›</button></span></div>`
};
function exportAccessLogs() {
    const rows = [['Date', 'User', 'Card UID', 'Action', 'Status', 'Details']].concat(S.logs.map(l => [l.t, l.user, l.uid, l.action, l.status, l.details]));
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'access-logs.csv'; a.click() } catch (e) { }
    if (navigator.clipboard) navigator.clipboard.writeText(csv).then(() => toast('CSV downloaded and copied to clipboard'), () => toast('CSV export started'))
}
P.temp = () => {
    const t = S.hist.map(h => h.temp), has = t.length > 0, mn = has ? Math.min(...t) : null, mx = has ? Math.max(...t) : null, av = has ? t.reduce((a, b) => a + b, 0) / t.length : null;
    return `<h2>Temperature Monitoring</h2><p class="sub">Readings, history and fan activity.</p>
 <div class="grid"><div class="glass">Current<div class="big">${num(S.temp, 1)}°C</div></div><div class="glass">Humidity<div class="big">${num(S.hum, 0)}%</div></div>
 <div class="glass">Min / Max / Avg<div style="font-size:20px;margin-top:8px">${num(mn, 1)} / ${num(mx, 1)} / ${num(av, 1)} °C</div></div><div class="glass">Fan<div class="big">${S.fan ? 'ON' : 'OFF'}</div><span class="mu">${S.mode}</span></div></div>
 <div class="row" style="margin-top:14px"><select id="rng" onchange="tr=this.value;render()">${[['hour', 'Last Hour'], ['day', 'Last 24 Hours'], ['week', 'Last 7 Days']].map(o => `<option value="${o[0]}" ${tr === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select><span class="mu">Dashed lines: ${cfg.off}° and ${cfg.on}° thresholds</span></div>
 <div class="grid two"><div class="glass"><b style="color:var(--bl)">Temperature (°C)</b><canvas id="c1"></canvas></div><div class="glass"><b style="color:var(--cy)">Humidity (%)</b><canvas id="c2"></canvas></div></div>`};
let tr = 'day';
P.security = () => {
    const a = S.alert; return `<h2>Security Monitoring</h2><p class="sub">Cabinet lock, vibration and buzzer state.</p>
 <div class="grid"><div class="glass">🔒 Cabinet<br><span class="st ${S.lock === 'LOCKED' ? '' : S.lock ? 'w' : 'i'}">${S.lock || 'NO DATA'}</span></div>
 <div class="glass">📳 Vibration<br><span class="st ${S.vib ? 'd' : ''}">${S.vib ? 'DETECTED' : 'NONE'}</span></div><div class="glass">🔔 Buzzer<br><span class="st ${S.buzzer ? 'd' : 'i'}">${S.buzzer ? 'SOUNDING' : 'SILENT'}</span></div></div>
 ${a ? `<div class="glass alert" style="margin-top:14px"><b>Active alert</b> · ${fmt(a.t)}<br><button class="btn r s" onclick="silenceBuzzer()">Silence Buzzer</button> <button class="btn s" onclick="acknowledgeAlert()">Acknowledge Alert</button></div>` : ''}
 <div class="glass tw" style="margin-top:14px"><b>Security event history</b><table><tr><th>Time</th><th>Event</th><th>Alert status</th></tr>${S.alerts.slice().reverse().map(x => `<tr><td>${fmt(x.t)}</td><td>${esc(x.title || 'Vibration Detected')}</td><td><span class="st ${x.acked ? 'i' : 'd'}">${x.acked ? 'Acknowledged ' + fmt(x.ackT) : 'Active'}</span></td></tr>`).join('') || '<tr><td colspan=3 class="mu">No security events recorded.</td></tr>'}</table></div>`
};
P.users = () => {
    const r = S.users.filter(u => (u.name + u.user + u.uid).toLowerCase().includes(uq.toLowerCase()));
    return `<h2>User Management</h2><p class="sub">Administrator only. Unknown cards are always denied.</p>
 <div class="row"><input id="uq" placeholder="Search users…" value="${esc(uq)}"><button class="btn" onclick="userForm()">Add User</button></div>
 <div class="glass tw"><table><tr><th>ID</th><th>Full Name</th><th>Username</th><th>RFID UID</th><th>Role</th><th>Access</th><th>Registered</th><th></th></tr>
 ${r.map(u => `<tr><td>${u.id}</td><td>${esc(u.name)}</td><td>${esc(u.user)}</td><td>${u.uid ? '#' + esc(u.uid) : '-'}</td><td>${u.role}</td><td><span class="st ${u.active ? '' : 'd'}">${u.active ? 'Active' : 'Inactive'}</span></td><td>${u.date}</td>
 <td style="white-space:nowrap"><button class="btn g s" onclick="userForm(${u.id})">Edit</button> <button class="btn g s" onclick="toggleUser(${u.id})">${u.active ? 'Deactivate' : 'Activate'}</button> <button class="btn r s" onclick="delUser(${u.id})">Delete</button></td></tr>`).join('') || '<tr><td colspan=8 class="mu">No users found.</td></tr>'}</table></div>`
};
function userForm(id) {
    const u = S.users.find(x => x.id === id) || {}; modal(id ? 'Edit User' : 'Add User', [{ k: 'name', l: 'Full name', v: u.name }, { k: 'user', l: 'Username', v: u.user }, { k: 'uid', l: 'RFID card UID', v: u.uid }, { k: 'role', l: 'Role', type: 'select', opts: ['User', 'Admin'], v: u.role || 'User' }], v => {
        if (!v.name || !v.user) return 'Name and username are required.';
        if (v.uid && S.users.some(x => x.uid === v.uid && x.id !== id)) return 'That card UID is already registered to another user.';
        if (id) Object.assign(u, v); else S.users.push({ id: Math.max(0, ...S.users.map(x => Number(x.id) || 0)) + 1, ...v, active: true, date: now().slice(0, 10) }); api.push('users', id ? u : S.users[S.users.length - 1]); save(); render()
    })
}
const toggleUser = id => { const u = S.users.find(x => x.id === id); u.active = !u.active; api.push('users', u); save(); render() };
const delUser = id => { const u = S.users.find(x => x.id === id); if (u.user === cfg.admin) return toast('The administrator account cannot be deleted.'); confirmBox('Delete ' + u.name + '? This cannot be undone.', () => { S.users = S.users.filter(x => x.id !== id); if (api.base()) api.req('/users/' + id, { method: 'DELETE' }); save(); render() }, 'Delete') };
P.notifs = () => `<h2>Notifications</h2><p class="sub">Red: security · Yellow: warnings · Blue: system.</p>
 <div class="row"><button class="btn s" onclick="S.notifs.forEach(n=>n.read=true);save();render();bell()">Mark All as Read</button><button class="btn r s" onclick="confirmBox('Clear all notification history?',()=>{S.notifs=[];save();render();bell()},'Clear')">Clear History</button></div>
 <div class="glass">${S.notifs.slice().reverse().map(n => `<div class="ev"><span class="st ${n.type === 'sec' ? 'd' : n.type === 'warn' ? 'w' : 'i'}">${n.type === 'sec' ? 'Security' : n.type === 'warn' ? 'Warning' : 'System'}</span><div style="flex:1"><b style="${n.read ? 'font-weight:400' : ''}">${esc(n.msg)}</b><br><small>${fmt(n.t)} · ${n.read ? 'Read' : 'Unread'}</small></div>${n.read ? '' : `<button class="btn g s" onclick="S.notifs.find(x=>x.id=='${n.id}').read=true;save();render();bell()">Mark as Read</button>`}</div>`).join('') || '<p class="mu">No notifications yet.</p>'}</div>`;
P.settings = () => `<h2>Settings</h2><p class="sub">Browser settings are saved locally. Nothing is sent to hardware unless a device is connected.</p>
 <div class="grid two"><div class="glass"><b>Temperature</b><label>Fan ON threshold (°C)</label><input id="s_on" type="number" step=".5" value="${cfg.on}"><label>Fan OFF threshold (°C)</label><input id="s_off" type="number" step=".5" value="${cfg.off}">
 <label>Fan mode</label><select id="s_mode"><option ${S.mode === 'AUTO' ? 'selected' : ''}>AUTO</option><option ${S.mode === 'MANUAL' ? 'selected' : ''}>MANUAL</option></select>
 <label><input type="checkbox" id="s_buz" style="width:auto" ${cfg.buzzer ? 'checked' : ''}> Buzzer enabled on alerts</label><label><input type="checkbox" id="s_not" style="width:auto" ${cfg.notif ? 'checked' : ''}> Show system notifications</label><label><input type="checkbox" id="s_sfx" style="width:auto" ${cfg.sfx !== false ? 'checked' : ''}> Interface &amp; fan sounds</label>
 <div class="err" id="serr"></div><button class="btn" onclick="saveSettings()">Save settings</button> <span class="st i">Saved in browser only</span></div>
 <div class="glass"><b>IoT device &amp; database</b><p>Device: <span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'ONLINE' : 'OFFLINE'}</span> <small class="mu">${S.last ? 'Last data ' + fmt(S.last) : 'No data received yet'}</small></p>
 <label>ESP32 WebSocket URL (live data and events)</label><input id="s_dev" placeholder="ws://192.168.1.50:81" value="${esc(cfg.device)}">
 <label>REST API base URL (state, commands, database)</label><input id="s_api" placeholder="http://192.168.1.50/api" value="${esc(cfg.api || '')}">
 <div class="row" style="margin-top:10px"><button class="btn s" onclick="connectAll()">Connect</button><button class="btn g s" onclick="disconnectFromIoTDevice()">Disconnect</button></div>
 <p class="mu">Settings are saved in this browser. They reach the device only while it shows ONLINE. Records are kept in this browser${cfg.api ? ' and synced to the REST API' : ''}. A page opened from https cannot use ws:// or http:// addresses.</p>
 <hr style="border-color:var(--bd)"><b>Account</b><label>Administrator username</label><input id="a_u" value="${esc(cfg.admin)}"><label>New password</label><input id="a_p" type="password" placeholder="Leave blank to keep">
 <div class="err" id="aerr"></div><button class="btn" onclick="saveAcct()">Update account</button></div></div>`;
function saveSettings() {
    const on = +$('#s_on').value, off = +$('#s_off').value; if (!(off < on)) return $('#serr').textContent = 'OFF threshold must be lower than ON threshold.';
    cfg.on = on; cfg.off = off; cfg.buzzer = $('#s_buz').checked; cfg.notif = $('#s_not').checked; cfg.sfx = $('#s_sfx').checked; const m = $('#s_mode').value; if (m !== S.mode) { if (S.live) { if (m === 'AUTO') enableAutomaticMode(); else { S.mode = 'MANUAL'; cmd('mode', { mode: 'MANUAL' }) } } else toast('Fan mode not changed: device offline') } save(); const sent = cmd('config', { fanOn: on, fanOff: off, buzzer: cfg.buzzer }); toast('Settings saved in this browser' + (sent ? ' and sent to the device' : ' – not sent to a device (offline)')); render()
}
function saveAcct() { const u = $('#a_u').value.trim(), p = $('#a_p').value; if (!u) return $('#aerr').textContent = 'Username is required.'; if (p && p.length < 6) return $('#aerr').textContent = 'Password needs at least 6 characters.'; cfg.admin = u; if (p) cfg.pass = p; save(); toast('Account updated'); $('#a_p').value = '' }
/* ===== routing + render ===== */
const alarmBar = () => S.alert && page !== 'dashboard' ? `<div class="glass alert alarmbar">🚨 <b>${esc(S.alert.title)}</b><span>${esc(S.alert.msg)}</span><span style="margin-left:auto"><button class="btn r s" ${S.buzzer ? '' : 'disabled'} onclick="silenceBuzzer()">🔕 Silence Buzzer</button> <button class="btn s" onclick="acknowledgeAlert()">Acknowledge</button></span></div>` : '';
function conn() { const c = $('#conn'); if (c) { c.className = 'chip ' + (S.live ? 'live' : 'off'); c.textContent = S.live ? '● Device Online' : '● Device Offline' } }
function render() {
    if (!$('#app') || $('#app').classList.contains('hid')) return;
    $('#nav').innerHTML = NAV.map(n => `<a class="${n[0] === page ? 'on' : ''}" href="#${n[0]}">${n[1]} ${n[2]}</a>`).join('') + '<a id="lo">🚪 Logout</a>'; $('#lo').onclick = () => confirmBox('Are you sure you want to log out?', logout, 'Log out', '🚪');
    $('#main').innerHTML = alarmBar() + P[page]();
    conn();
    if (page === 'temp') { chart('c1', 'temp', '#2f7bff', 18, 38, [cfg.off, cfg.on], tr); chart('c2', 'hum', '#22d3ee', 20, 90, [], tr) }
    const lq = $('#lq'); if (lq) lq.oninput = e => { lf.q = e.target.value; lf.pg = 1; const p = e.target.selectionStart; render(); const n = $('#lq'); n.focus(); n.setSelectionRange(p, p) };
    const uqe = $('#uq'); if (uqe) uqe.oninput = e => { uq = e.target.value; const p = e.target.selectionStart; render(); const n = $('#uq'); n.focus(); n.setSelectionRange(p, p) }
}
function enter() { const m = $('#main'); m.classList.remove('enter'); void m.offsetWidth; m.classList.add('enter'); clearTimeout(enter.t); enter.t = setTimeout(() => m.classList.remove('enter'), 1000) }
function route() { const h = location.hash.slice(1); page = P[h] ? h : 'dashboard'; $('#side').classList.remove('open'); render(); enter() }
$('#nav').addEventListener('click', e => { if (e.target.closest('a')) snd.nav() });
addEventListener('hashchange', route); addEventListener('resize', () => page === 'temp' && render());
$('#burger').onclick = () => $('#side').classList.toggle('open'); $('#bell').onclick = () => location.hash = 'notifs';
/* ===== auth (demo only; frontend login is NOT secure) ===== */
/* Login lasts only for this browser tab/session, so opening the app again always asks for the password. */
const auth = { m: false, get() { try { return sessionStorage.getItem('inc_auth') === '1' } catch (e) { return this.m } }, set(v) { this.m = v; try { v ? sessionStorage.setItem('inc_auth', '1') : sessionStorage.removeItem('inc_auth') } catch (e) { } } };
try { localStorage.removeItem('inc_auth') } catch (e) { }
function showApp() { const ok = auth.get(); $('#login').classList.toggle('hid', ok); $('#app').classList.toggle('hid', !ok); if (ok) { const a = $('#app'); a.classList.add('open'); setTimeout(() => a.classList.remove('open'), 1200); route(); bell() } }
function logout() { auth.set(false); location.hash = ''; showApp() }
$('#eye').onclick = () => { const p = $('#lp'); p.type = p.type === 'password' ? 'text' : 'password' };
function login() { if ($('#lu').value.trim() === cfg.admin && $('#lp').value === cfg.pass) { auth.set(true); $('#lerr').textContent = ''; snd.welcome(); showApp() } else $('#lerr').textContent = 'Incorrect username or password. Try again.' }
$('#lgo').onclick = login; $('#lp').onkeydown = e => { if (e.key === 'Enter') login() };
/* Logo / name in the sidebar goes to the Dashboard */
(() => {
    const b = $('#side .brand'); b.setAttribute('role', 'link'); b.tabIndex = 0; b.title = 'Go to Dashboard';
    const go = () => { snd.nav(); if (location.hash === '#dashboard') route(); else location.hash = 'dashboard' };
    b.addEventListener('click', go); b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } })
})();
if (cfg.device) connectToIoTDevice(cfg.device); if (cfg.api) { iot.poll(); api.pull() }
showApp();
