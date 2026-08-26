'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');
const STALE_MS = 90000;        // no fix for this long -> shown as stale
const DROP_MS = 15 * 60000;    // disconnected players forgotten after this
const MAX_MARKERS = 500;
const MAX_DRAWINGS = 300;
const MAX_MSG_BYTES = 64 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * Room state
 * ------------------------------------------------------------------ */

/** roomId -> { id, markers: Map, drawings: Map, players: Map, updatedAt } */
const rooms = new Map();

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const r of raw.rooms || []) {
      rooms.set(r.id, {
        id: r.id,
        markers: new Map((r.markers || []).map((m) => [m.id, m])),
        drawings: new Map((r.drawings || []).map((d) => [d.id, d])),
        players: new Map(),
        updatedAt: r.updatedAt || 0,
      });
    }
    console.log('[state] restored ' + rooms.size + ' room(s) from ' + STATE_FILE);
  } catch (err) {
    console.error('[state] could not read state file:', err.message);
  }
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out = {
      savedAt: Date.now(),
      rooms: [...rooms.values()].map((r) => ({
        id: r.id,
        updatedAt: r.updatedAt,
        markers: [...r.markers.values()],
        drawings: [...r.drawings.values()],
      })),
    };
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(out), (err) => {
      if (err) return console.error('[state] write failed:', err.message);
      fs.rename(STATE_FILE + '.tmp', STATE_FILE, (err2) => {
        if (err2) console.error('[state] rename failed:', err2.message);
      });
    });
  }, 1500);
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { id, markers: new Map(), drawings: new Map(), players: new Map(), updatedAt: Date.now() };
    rooms.set(id, room);
  }
  return room;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function cleanRoomId(v) {
  return String(v || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24) || 'LOBBY';
}

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function newId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function latLng(v) {
  if (!v || typeof v !== 'object') return null;
  const lat = num(v.lat);
  const lng = num(v.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function publicPlayer(p) {
  return {
    id: p.id, callsign: p.callsign, team: p.team, role: p.role, status: p.status,
    lat: p.lat, lng: p.lng, acc: p.acc, hdg: p.hdg, spd: p.spd, batt: p.batt,
    ts: p.ts, online: p.online, stale: p.ts ? Date.now() - p.ts > STALE_MS : true,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: [...rooms.values()].map((r) => ({
      id: r.id,
      players: [...r.players.values()].filter((p) => p.online).length,
      markers: r.markers.size,
      drawings: r.drawings.size,
    })),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptWs) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    if (client.roomId !== room.id) continue;
    if (client === exceptWs) continue;
    client.send(payload);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.playerId = null;
  ws.lastPos = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    /* --- join ------------------------------------------------------ */
    if (msg.t === 'join') {
      const roomId = cleanRoomId(msg.room);
      const room = getRoom(roomId);
      const id = cleanText(msg.id, 40) || newId('p');

      const existing = room.players.get(id);
      const player = existing || {
        id, lat: null, lng: null, acc: null, hdg: null, spd: null,
        batt: null, ts: 0, status: 'ok',
      };
      player.callsign = cleanText(msg.callsign, 16).toUpperCase() || 'UNKNOWN';
      player.team = cleanText(msg.team, 16).toUpperCase() || 'BLUE';
      player.role = cleanText(msg.role, 16).toUpperCase() || 'RIFLE';
      player.online = true;
      player.leftAt = 0;
      room.players.set(id, player);

      ws.roomId = roomId;
      ws.playerId = id;

      send(ws, {
        t: 'welcome',
        you: id,
        room: roomId,
        serverTime: Date.now(),
        players: [...room.players.values()].map(publicPlayer),
        markers: [...room.markers.values()],
        drawings: [...room.drawings.values()],
      });
      broadcast(room, { t: 'player', player: publicPlayer(player) }, ws);
      console.log('[join] ' + player.callsign + ' (' + player.team + ') -> ' + roomId);
      return;
    }

    const room = ws.roomId && rooms.get(ws.roomId);
    if (!room) return;

    switch (msg.t) {
      /* --- position ------------------------------------------------ */
      case 'pos': {
        const p = room.players.get(ws.playerId);
        const ll = latLng(msg);
        if (!p || !ll) return;
        const now = Date.now();
        if (now - ws.lastPos < 200) return; // cheap flood guard
        ws.lastPos = now;
        p.lat = ll.lat;
        p.lng = ll.lng;
        p.acc = num(msg.acc) !== null ? clamp(msg.acc, 0, 10000) : null;
        p.hdg = num(msg.hdg) !== null ? ((msg.hdg % 360) + 360) % 360 : null;
        p.spd = num(msg.spd) !== null ? clamp(msg.spd, 0, 200) : null;
        p.batt = num(msg.batt) !== null ? clamp(msg.batt, 0, 1) : p.batt;
        p.ts = now;
        broadcast(room, {
          t: 'pos', id: p.id, lat: p.lat, lng: p.lng, acc: p.acc,
          hdg: p.hdg, spd: p.spd, batt: p.batt, ts: p.ts,
        }, ws);
        return;
      }

      /* --- status (ok / hit / down / respawn) ---------------------- */
      case 'status': {
        const p = room.players.get(ws.playerId);
        if (!p) return;
        const s = cleanText(msg.status, 12).toLowerCase();
        if (!['ok', 'hit', 'down', 'respawn'].includes(s)) return;
        p.status = s;
        broadcast(room, { t: 'player', player: publicPlayer(p) });
        return;
      }

      /* --- markers ------------------------------------------------- */
      case 'marker:add': {
        if (room.markers.size >= MAX_MARKERS) return;
        const ll = latLng(msg);
        if (!ll) return;
        const marker = {
          id: newId('m'),
          kind: cleanText(msg.kind, 24) || 'objective',
          label: cleanText(msg.label, 40),
          note: cleanText(msg.note, 240),
          lat: ll.lat,
          lng: ll.lng,
          by: ws.playerId,
          byName: (room.players.get(ws.playerId) || {}).callsign || '',
          ts: Date.now(),
        };
        room.markers.set(marker.id, marker);
        room.updatedAt = marker.ts;
        saveStateSoon();
        broadcast(room, { t: 'marker', marker });
        return;
      }
      case 'marker:update': {
        const m = room.markers.get(cleanText(msg.id, 40));
        if (!m) return;
        const ll = latLng(msg);
        if (ll) { m.lat = ll.lat; m.lng = ll.lng; }
        if (msg.label !== undefined) m.label = cleanText(msg.label, 40);
        if (msg.note !== undefined) m.note = cleanText(msg.note, 240);
        if (msg.kind !== undefined) m.kind = cleanText(msg.kind, 24) || m.kind;
        m.ts = Date.now();
        room.updatedAt = m.ts;
        saveStateSoon();
        broadcast(room, { t: 'marker', marker: m });
        return;
      }
      case 'marker:del': {
        const id = cleanText(msg.id, 40);
        if (!room.markers.delete(id)) return;
        room.updatedAt = Date.now();
        saveStateSoon();
        broadcast(room, { t: 'marker:del', id });
        return;
      }

      /* --- drawings (lines, arrows, zones, boundary) --------------- */
      case 'draw:add': {
        if (room.drawings.size >= MAX_DRAWINGS) return;
        const pts = Array.isArray(msg.points)
          ? msg.points.map(latLng).filter(Boolean).slice(0, 400)
          : [];
        if (pts.length < 2) return;
        const shape = cleanText(msg.shape, 16) || 'line';
        const drawing = {
          id: newId('d'),
          shape: ['line', 'arrow', 'area', 'boundary'].includes(shape) ? shape : 'line',
          color: /^#[0-9a-f]{6}$/i.test(String(msg.color || '')) ? msg.color : '#7dd3fc',
          label: cleanText(msg.label, 40),
          points: pts,
          by: ws.playerId,
          byName: (room.players.get(ws.playerId) || {}).callsign || '',
          ts: Date.now(),
        };
        room.drawings.set(drawing.id, drawing);
        room.updatedAt = drawing.ts;
        saveStateSoon();
        broadcast(room, { t: 'draw', drawing });
        return;
      }
      case 'draw:del': {
        const id = cleanText(msg.id, 40);
        if (!room.drawings.delete(id)) return;
        room.updatedAt = Date.now();
        saveStateSoon();
        broadcast(room, { t: 'draw:del', id });
        return;
      }

      /* --- transient map ping + text ------------------------------- */
      case 'ping:map': {
        const ll = latLng(msg);
        if (!ll) return;
        broadcast(room, {
          t: 'ping:map',
          lat: ll.lat, lng: ll.lng,
          by: (room.players.get(ws.playerId) || {}).callsign || '',
          ts: Date.now(),
        });
        return;
      }
      case 'msg': {
        const p = room.players.get(ws.playerId) || {};
        const text = cleanText(msg.text, 200);
        if (!text) return;
        broadcast(room, { t: 'msg', text, by: p.callsign || '', team: p.team || '', ts: Date.now() });
        return;
      }
      case 'keepalive':
        send(ws, { t: 'keepalive', ts: Date.now() });
        return;
      default:
        return;
    }
  });

  ws.on('close', () => {
    const room = ws.roomId && rooms.get(ws.roomId);
    if (!room) return;
    const p = room.players.get(ws.playerId);
    if (!p) return;
    p.online = false;
    p.leftAt = Date.now();
    broadcast(room, { t: 'player', player: publicPlayer(p) });
  });
});

/* Heartbeat + housekeeping */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const [id, p] of room.players) {
      if (!p.online && p.leftAt && now - p.leftAt > DROP_MS) {
        room.players.delete(id);
        broadcast(room, { t: 'leave', id });
      }
    }
  }
}, 20000);

loadState();
server.listen(PORT, HOST, () => {
  console.log('AirsoftMap running on http://' + HOST + ':' + PORT);
});
