/* ------------------------------------------------------------------ *
 * Replay.
 *
 * The server writes every game to an append-only log, so afterwards you
 * can scrub back through it: where everyone was, minute by minute, with
 * the markers and hit calls that went with it. Useful for settling an
 * argument, for showing a squad what actually happened, and for working
 * out why one flank never arrived.
 *
 * Games are not started and stopped by hand - nobody remembers - so the
 * log is split into sessions wherever it went quiet for 20 minutes.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  const STALE_MS = 60000;      // hide a blip this long after its last fix
  const TRAIL_MS = 90000;      // how much history each blip drags behind it

  function Replay(ctx) {
    this.ctx = ctx;
    this.sessions = [];
    this.data = null;          // { players, tracks, events }
    this.layer = L.layerGroup();
    this.blips = new Map();    // id -> { marker, trail }
    this.markers = new Map();  // id -> L.Marker for replayed intel
    this.at = 0;               // current playback time
    this.playing = false;
    this.speed = 8;
    this.timer = null;
    this.onTick = null;
  }

  Replay.prototype.active = function () {
    return !!this.data;
  };

  /* --- loading -------------------------------------------------------- */

  Replay.prototype.listSessions = async function () {
    const room = encodeURIComponent(this.ctx.state.me.room);
    const res = await fetch('/api/room/' + room + '/sessions');
    if (!res.ok) throw new Error('could not read the game log');
    const body = await res.json();
    this.sessions = body.sessions || [];
    return this.sessions;
  };

  Replay.prototype.open = async function (session) {
    const room = encodeURIComponent(this.ctx.state.me.room);
    const res = await fetch('/api/room/' + room + '/replay?from=' +
      session.start + '&to=' + session.end);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'could not load that game');
    }
    this.data = await res.json();
    this.session = session;

    /* Sort each track once; everything downstream assumes time order. */
    for (const id of Object.keys(this.data.tracks)) {
      this.data.tracks[id].sort((a, b) => a[0] - b[0]);
    }
    this.layer.addTo(this.ctx.map);
    this.seek(session.start);
    return this.data;
  };

  Replay.prototype.close = function () {
    this.pause();
    this.layer.clearLayers();
    this.ctx.map.removeLayer(this.layer);
    this.blips.clear();
    this.markers.clear();
    this.data = null;
    this.session = null;
  };

  /* --- sampling ------------------------------------------------------- */

  /** Where was this player at time t? Interpolated between fixes. */
  Replay.prototype.sampleAt = function (track, t) {
    if (!track || !track.length) return null;
    if (t < track[0][0] - STALE_MS) return null;

    let lo = 0;
    let hi = track.length - 1;
    if (t >= track[hi][0]) {
      return t - track[hi][0] > STALE_MS ? null : {
        lat: track[hi][1], lng: track[hi][2], hdg: track[hi][3], status: track[hi][4],
      };
    }
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid][0] <= t) lo = mid; else hi = mid;
    }
    const a = track[lo];
    const b = track[hi];
    const span = b[0] - a[0];
    /* A long gap is missing data, not a straight-line sprint. */
    if (span > STALE_MS) {
      return t - a[0] > STALE_MS ? null : { lat: a[1], lng: a[2], hdg: a[3], status: a[4] };
    }
    const f = span > 0 ? (t - a[0]) / span : 0;
    return {
      lat: a[1] + (b[1] - a[1]) * f,
      lng: a[2] + (b[2] - a[2]) * f,
      hdg: a[3] == null ? b[3] : a[3],
      status: a[4],
    };
  };

  /** The recent past of a track, for the tail behind each blip. */
  Replay.prototype.trailAt = function (track, t) {
    const pts = [];
    for (const row of track) {
      if (row[0] > t) break;
      if (row[0] >= t - TRAIL_MS) pts.push([row[1], row[2]]);
    }
    return pts;
  };

  /* --- rendering ------------------------------------------------------ */

  Replay.prototype.seek = function (t) {
    if (!this.data) return;
    this.at = Math.max(this.session.start, Math.min(this.session.end, t));
    const showTrails = this.ctx.state.opts.trails !== false;

    for (const id of Object.keys(this.data.tracks)) {
      const who = this.data.players[id] || { callsign: '?', team: 'BLUE' };
      const at = this.sampleAt(this.data.tracks[id], this.at);
      let blip = this.blips.get(id);

      if (!at) {
        if (blip) {
          this.layer.removeLayer(blip.marker);
          if (blip.trail) this.layer.removeLayer(blip.trail);
          this.blips.delete(id);
        }
        continue;
      }

      const shown = {
        id, callsign: who.callsign, team: who.team, role: who.role,
        hdg: at.hdg, status: at.status, online: true, stale: false,
      };
      if (!blip) {
        blip = { marker: L.marker([at.lat, at.lng], { pane: 'players', icon: ICONS.playerIcon(shown, false) }) };
        this.layer.addLayer(blip.marker);
        this.blips.set(id, blip);
      } else {
        blip.marker.setLatLng([at.lat, at.lng]);
        blip.marker.setIcon(ICONS.playerIcon(shown, false));
      }

      if (showTrails) {
        const pts = this.trailAt(this.data.tracks[id], this.at);
        if (!blip.trail) {
          blip.trail = L.polyline(pts, {
            color: ICONS.teamColor(who.team), weight: 2, opacity: 0.5,
            dashArray: '4 5', interactive: false,
          });
          this.layer.addLayer(blip.trail);
        } else {
          blip.trail.setLatLngs(pts);
        }
      } else if (blip.trail) {
        this.layer.removeLayer(blip.trail);
        blip.trail = null;
      }
    }

    /* Intel appears at the moment it was dropped, and stays. */
    for (const ev of this.data.events || []) {
      if (ev.k !== 'marker') continue;
      const live = this.markers.get(ev.id);
      if (ev.t <= this.at) {
        if (!live) {
          const marker = L.marker([ev.a, ev.o], {
            pane: 'intel',
            interactive: false,
            icon: ICONS.markerIcon({ kind: ev.kind, label: ev.label }),
          });
          this.layer.addLayer(marker);
          this.markers.set(ev.id, marker);
        }
      } else if (live) {
        this.layer.removeLayer(live);
        this.markers.delete(ev.id);
      }
    }

    if (this.onTick) this.onTick(this.at);
  };

  /* --- transport ------------------------------------------------------ */

  Replay.prototype.play = function () {
    if (!this.data || this.playing) return;
    this.playing = true;
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const step = (now - last) * this.speed;
      last = now;
      if (this.at + step >= this.session.end) {
        this.seek(this.session.end);
        this.pause();
        return;
      }
      this.seek(this.at + step);
    }, 100);
  };

  Replay.prototype.pause = function () {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    if (this.onTick) this.onTick(this.at);
  };

  Replay.prototype.toggle = function () {
    if (this.playing) this.pause(); else this.play();
  };

  /** Who was in this game, with how long each was actually tracked. */
  Replay.prototype.roster = function () {
    if (!this.data) return [];
    return Object.keys(this.data.tracks).map((id) => {
      const track = this.data.tracks[id];
      const who = this.data.players[id] || {};
      let metres = 0;
      for (let i = 1; i < track.length; i++) {
        metres += U.distance(
          { lat: track[i - 1][1], lng: track[i - 1][2] },
          { lat: track[i][1], lng: track[i][2] }
        ) || 0;
      }
      return {
        id,
        callsign: who.callsign || '?',
        team: who.team || '',
        fixes: track.length,
        metres,
        from: track[0][0],
        to: track[track.length - 1][0],
      };
    }).sort((a, b) => b.metres - a.metres);
  };

  global.Replay = Replay;
})(window);
