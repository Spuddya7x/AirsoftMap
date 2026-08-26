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
        plan: r.plan || null,
        teamLock: !!r.teamLock,
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
        plan: r.plan || null,
        teamLock: !!r.teamLock,
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
    room = {
      id, markers: new Map(), drawings: new Map(), players: new Map(),
      plan: null, teamLock: false, updatedAt: Date.now(),
    };
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
    lat: p.lat, lng: p.lng, acc: p.acc, hdg: p.hdg, spd: p.spd, batt: p.batt, src: p.src,
    ts: p.ts, online: p.online, stale: p.ts ? Date.now() - p.ts > STALE_MS : true,
  };
}

/* ------------------------------------------------------------------ *
 * Visibility
 *
 * With team lock on, a game can be run where each team only sees its own
 * players and its own tactical intel. Safety and site information stays
 * visible to everyone, because a hazard is a hazard whichever bib you
 * are wearing, and marshals always see the whole picture.
 * ------------------------------------------------------------------ */

const SHARED_KINDS = ['station', 'spawn', 'safe', 'chrono', 'parking', 'nogo', 'hazard', 'medic'];
const SHARED_SHAPES = ['boundary'];
const isMarshal = (p) => !!p && String(p.role || '').indexOf('MARSHAL') !== -1;

function canSeePlayer(room, viewer, subject) {
  if (!room.teamLock) return true;
  if (!viewer) return false;
  if (isMarshal(viewer) || isMarshal(subject)) return true;
  return viewer.team === subject.team;
}

function canSeeItem(room, viewer, item) {
  if (!room.teamLock) return true;
  if (!viewer) return false;
  if (isMarshal(viewer)) return true;
  if (!item.team) return true;                                  // pre-dates team lock
  if (SHARED_KINDS.indexOf(item.kind) !== -1) return true;      // safety + site info
  if (SHARED_SHAPES.indexOf(item.shape) !== -1) return true;    // the site boundary
  return viewer.team === item.team;
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

/* --- site plans -----------------------------------------------------
 * A site plan is any image (survey drawing, hand sketch, photo of a
 * whiteboard) laid over the map. Underground, where there is no imagery
 * and no GPS, it is the only basemap there is.
 * ------------------------------------------------------------------- */

const PLAN_DIR = path.join(DATA_DIR, 'plans');
fs.mkdirSync(PLAN_DIR, { recursive: true });
app.use('/plans', express.static(PLAN_DIR, { maxAge: '10m' }));

const PLAN_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

app.post('/api/room/:id/plan',
  express.raw({ type: Object.keys(PLAN_TYPES), limit: '16mb' }),
  (req, res) => {
    const ext = PLAN_TYPES[req.headers['content-type']];
    if (!ext) return res.status(415).json({ error: 'unsupported image type' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });

    const roomId = cleanRoomId(req.params.id);
    const room = getRoom(roomId);
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const file = roomId + '-' + Date.now().toString(36) + '.' + ext;
    try {
      fs.writeFileSync(path.join(PLAN_DIR, file), req.body);
    } catch (err) {
      return res.status(500).json({ error: 'could not store the plan' });
    }

    if (room.plan && room.plan.file) {
      fs.unlink(path.join(PLAN_DIR, room.plan.file), () => {});
    }

    room.plan = {
      file,
      url: '/plans/' + file,
      lat,
      lng,
      widthM: clamp(Number(req.query.widthM) || 200, 5, 50000),
      aspect: clamp(Number(req.query.aspect) || 1, 0.05, 20),
      rotation: 0,
      opacity: 1,
      name: cleanText(req.query.name, 40) || 'SITE PLAN',
      ts: Date.now(),
    };
    room.updatedAt = room.plan.ts;
    saveStateSoon();
    broadcast(room, { t: 'site', plan: room.plan });
    res.json({ ok: true, plan: room.plan });
  });

/* Read-only snapshot, used by the printable station sheet. */
app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(cleanRoomId(req.params.id));
  if (!room) return res.status(404).json({ error: 'no such game' });
  res.json({
    id: room.id,
    plan: room.plan,
    markers: [...room.markers.values()],
    drawings: [...room.drawings.values()],
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

function broadcast(room, obj, exceptWs, visibleTo) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    if (client.roomId !== room.id) continue;
    if (client === exceptWs) continue;
    if (visibleTo && !visibleTo(room.players.get(client.playerId))) continue;
    client.send(payload);
  }
}

/** Everything one player is allowed to see, as sent on join and on resync. */
function snapshotFor(room, viewer) {
  return {
    room: room.id,
    teamLock: !!room.teamLock,
    plan: room.plan,
    players: [...room.players.values()]
      .filter((p) => canSeePlayer(room, viewer, p))
      .map(publicPlayer),
    markers: [...room.markers.values()].filter((m) => canSeeItem(room, viewer, m)),
    drawings: [...room.drawings.values()].filter((d) => canSeeItem(room, viewer, d)),
  };
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

      send(ws, Object.assign({ t: 'welcome', you: id, serverTime: Date.now() },
        snapshotFor(room, player)));
      broadcast(room, { t: 'player', player: publicPlayer(player) }, ws,
        (viewer) => canSeePlayer(room, viewer, player));
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
        /* how the position was arrived at: satellite fix, a check-in at a
           known point, dead reckoning, or placed by hand */
        const src = cleanText(msg.src, 8).toLowerCase();
        p.src = ['gps', 'anchor', 'dr', 'manual'].includes(src) ? src : 'gps';
        p.ts = now;
        broadcast(room, {
          t: 'pos', id: p.id, lat: p.lat, lng: p.lng, acc: p.acc,
          hdg: p.hdg, spd: p.spd, batt: p.batt, src: p.src, ts: p.ts,
        }, ws, (viewer) => canSeePlayer(room, viewer, p));
        return;
      }

      /* --- status (ok / hit / down / respawn) ---------------------- */
      case 'status': {
        const p = room.players.get(ws.playerId);
        if (!p) return;
        const s = cleanText(msg.status, 12).toLowerCase();
        if (!['ok', 'hit', 'down', 'respawn'].includes(s)) return;
        p.status = s;
        broadcast(room, { t: 'player', player: publicPlayer(p) }, null,
          (viewer) => canSeePlayer(room, viewer, p));
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
          team: (room.players.get(ws.playerId) || {}).team || '',
          ts: Date.now(),
        };
        room.markers.set(marker.id, marker);
        room.updatedAt = marker.ts;
        saveStateSoon();
        broadcast(room, { t: 'marker', marker }, null,
          (viewer) => canSeeItem(room, viewer, marker));
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
        broadcast(room, { t: 'marker', marker: m }, null,
          (viewer) => canSeeItem(room, viewer, m));
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
          team: (room.players.get(ws.playerId) || {}).team || '',
          ts: Date.now(),
        };
        room.drawings.set(drawing.id, drawing);
        room.updatedAt = drawing.ts;
        saveStateSoon();
        broadcast(room, { t: 'draw', drawing }, null,
          (viewer) => canSeeItem(room, viewer, drawing));
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

      /* --- room settings -------------------------------------------- */
      case 'room:set': {
        if (typeof msg.teamLock !== 'boolean') return;
        room.teamLock = msg.teamLock;
        room.updatedAt = Date.now();
        saveStateSoon();
        /* Everyone's view of the game just changed, so hand each player a
           fresh snapshot of what they are now allowed to see. */
        for (const client of wss.clients) {
          if (client.readyState !== client.OPEN || client.roomId !== room.id) continue;
          const viewer = room.players.get(client.playerId);
          send(client, Object.assign({ t: 'resync' }, snapshotFor(room, viewer)));
        }
        return;
      }

      /* --- site plan placement ------------------------------------- */
      case 'site:set': {
        if (!room.plan) return;
        const ll = latLng(msg);
        if (ll) { room.plan.lat = ll.lat; room.plan.lng = ll.lng; }
        if (num(msg.widthM) !== null) room.plan.widthM = clamp(msg.widthM, 5, 50000);
        if (num(msg.rotation) !== null) room.plan.rotation = ((msg.rotation % 360) + 360) % 360;
        if (num(msg.opacity) !== null) room.plan.opacity = clamp(msg.opacity, 0.05, 1);
        if (msg.name !== undefined) room.plan.name = cleanText(msg.name, 40);
        room.plan.ts = Date.now();
        room.updatedAt = room.plan.ts;
        saveStateSoon();
        broadcast(room, { t: 'site', plan: room.plan });
        return;
      }
      case 'site:clear': {
        if (room.plan && room.plan.file) {
          fs.unlink(path.join(PLAN_DIR, room.plan.file), () => {});
        }
        room.plan = null;
        room.updatedAt = Date.now();
        saveStateSoon();
        broadcast(room, { t: 'site', plan: null });
        return;
      }

      /* --- transient map ping + text ------------------------------- */
      case 'ping:map': {
        const ll = latLng(msg);
        if (!ll) return;
        const from = room.players.get(ws.playerId) || {};
        broadcast(room, {
          t: 'ping:map',
          lat: ll.lat, lng: ll.lng,
          by: from.callsign || '',
          ts: Date.now(),
        }, null, (viewer) => canSeePlayer(room, viewer, from));
        return;
      }
      case 'msg': {
        const p = room.players.get(ws.playerId) || {};
        const text = cleanText(msg.text, 200);
        if (!text) return;
        broadcast(room, { t: 'msg', text, by: p.callsign || '', team: p.team || '', ts: Date.now() },
          null, (viewer) => canSeePlayer(room, viewer, p));
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
    broadcast(room, { t: 'player', player: publicPlayer(p) }, null,
      (viewer) => canSeePlayer(room, viewer, p));
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
