/* Demo mode: fake squad + sample intel so the map can be shown without
   a real game running. Everything here is local - nothing is sent to the
   server, so demoing never pollutes a live game. */
(function (global) {
  'use strict';

  const BOTS = [
    { callsign: 'VIPER',   team: 'RED',   role: 'SQUAD LEAD' },
    { callsign: 'FOX',     team: 'BLUE',  role: 'RIFLE' },
    { callsign: 'GHOST',   team: 'BLUE',  role: 'SNIPER' },
    { callsign: 'HAWK',    team: 'GOLD',  role: 'DMR' },
    { callsign: 'WOLF',    team: 'GOLD',  role: 'SUPPORT' },
    { callsign: 'PHOENIX', team: 'GREEN', role: 'MEDIC' },
  ];

  const SEED_MARKERS = [
    { kind: 'spawn',     label: 'SPAWN - ALPHA', brg: 285, dist: 190 },
    { kind: 'spawn',     label: 'SPAWN - BRAVO', brg: 130, dist: 200 },
    { kind: 'objective', label: 'RADIO MAST',    brg: 5,   dist: 150 },
    { kind: 'ammo',      label: 'AMMO CACHE',    brg: 95,  dist: 140 },
    { kind: 'overwatch', label: 'OVERWATCH RIDGE', brg: 225, dist: 170 },
    { kind: 'contact',   label: 'LAST CONTACT',  brg: 330, dist: 120 },
    { kind: 'hazard',    label: 'DEEP DITCH',    brg: 45,  dist: 130 },
    { kind: 'medic',     label: 'REGEN POINT',   brg: 180, dist: 90 },
  ];

  function Demo() {
    this.bots = [];
    this.timer = null;
    this.running = false;
  }

  Demo.prototype.seed = function (center) {
    this.center = center;
    this.bots = BOTS.map((b, i) => {
      const start = U.destination(center, (i * 61) % 360, 60 + (i % 3) * 45);
      return Object.assign({
        id: 'demo_' + b.callsign.toLowerCase(),
        lat: start.lat, lng: start.lng,
        hdg: 0, spd: 0, acc: 6, batt: 0.6 + (i % 4) * 0.1,
        status: 'ok', online: true, stale: false, ts: Date.now(),
        demo: true,
        target: U.destination(center, Math.random() * 360, 40 + Math.random() * 140),
        speed: 1.1 + Math.random() * 1.4,
      }, b);
    });

    const markers = SEED_MARKERS.map((m, i) => {
      const at = U.destination(center, m.brg, m.dist);
      return {
        id: 'demo_m' + i, kind: m.kind, label: m.label, note: '',
        lat: at.lat, lng: at.lng, byName: 'DEMO', ts: Date.now(), demo: true,
      };
    });

    const a = U.destination(center, 200, 210);
    const drawings = [{
      id: 'demo_d0', shape: 'arrow', color: '#60a5fa', label: 'PUSH LEFT FLANK',
      points: [a, U.destination(center, 250, 90), U.destination(center, 20, 60), U.destination(center, 340, 120)],
      byName: 'DEMO', ts: Date.now(), demo: true,
    }];

    return { players: this.bots.slice(), markers, drawings };
  };

  Demo.prototype.start = function (onTick) {
    this.running = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const bot of this.bots) {
        const toTarget = U.distance(bot, bot.target);
        if (toTarget == null || toTarget < 10) {
          bot.target = U.destination(this.center, Math.random() * 360, 40 + Math.random() * 150);
          bot.speed = 0.9 + Math.random() * 1.6;
        }
        const brg = U.bearing(bot, bot.target);
        const wobble = (Math.random() - 0.5) * 18;
        const step = bot.speed; // one tick per second
        const next = U.destination(bot, brg + wobble, step);
        bot.lat = next.lat;
        bot.lng = next.lng;
        bot.hdg = brg;
        bot.spd = step;
        bot.ts = now;
        // occasional hit/respawn cycle so the status colours are visible
        if (Math.random() < 0.004) bot.status = 'hit';
        else if (bot.status === 'hit' && Math.random() < 0.05) bot.status = 'respawn';
        else if (bot.status === 'respawn' && Math.random() < 0.08) bot.status = 'ok';
      }
      onTick(this.bots.slice());
    }, 1000);
  };

  Demo.prototype.stop = function () {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    const ids = this.bots.map((b) => b.id);
    this.bots = [];
    return ids;
  };

  global.Demo = Demo;
})(window);
