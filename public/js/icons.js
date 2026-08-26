/* Marker catalogue + Leaflet icon builders. */
(function (global) {
  'use strict';

  const TEAMS = {
    BLUE:  { color: '#38bdf8' },
    RED:   { color: '#ff5a5a' },
    GREEN: { color: '#4ade80' },
    GOLD:  { color: '#facc15' },
  };
  const TEAM_ORDER = ['BLUE', 'RED', 'GREEN', 'GOLD'];
  const teamColor = (t) => (TEAMS[t] || TEAMS.BLUE).color;

  /* Marker kinds. glyph is drawn upright inside a diamond. */
  const KINDS = [
    { key: 'spawn',     name: 'SPAWN',     glyph: 'S',  color: '#b6ff3a' },
    { key: 'rally',     name: 'RALLY',     glyph: 'R',  color: '#86efac' },
    { key: 'objective', name: 'OBJECTIVE', glyph: '★', color: '#a78bfa' },
    { key: 'flag',      name: 'FLAG',      glyph: '⚑', color: '#f472b6' },
    { key: 'ammo',      name: 'AMMO',      glyph: '▣', color: '#fbbf24' },
    { key: 'medic',     name: 'MEDIC',     glyph: '+',  color: '#34d399' },
    { key: 'overwatch', name: 'OVERWATCH', glyph: '◉', color: '#c084fc' },
    { key: 'cover',     name: 'COVER',     glyph: '▲', color: '#38bdf8' },
    { key: 'contact',   name: 'CONTACT',   glyph: '?',  color: '#f97316' },
    { key: 'enemy',     name: 'ENEMY',     glyph: '✖', color: '#ff5a5a' },
    { key: 'hazard',    name: 'HAZARD',    glyph: '!',  color: '#ef4444' },
    { key: 'nogo',      name: 'NO-GO',     glyph: '⊘', color: '#ef4444' },
    { key: 'route',     name: 'DIRECTION', glyph: '→', color: '#60a5fa' },
    { key: 'safe',      name: 'SAFE ZONE', glyph: '⌂', color: '#22d3ee' },
    { key: 'chrono',    name: 'CHRONO',    glyph: 'C',  color: '#e2e8f0' },
    { key: 'parking',   name: 'PARKING',   glyph: 'P',  color: '#94a3b8' },
    { key: 'poi',       name: 'POINT',     glyph: '●', color: '#e5e7eb' },
    { key: 'station',   name: 'STATION',   glyph: '⌖', color: '#b6ff3a' },
  ];
  const KIND_BY_KEY = Object.fromEntries(KINDS.map((k) => [k.key, k]));
  const kind = (key) => KIND_BY_KEY[key] || KIND_BY_KEY.poi;

  const SHAPES = [
    { key: 'line',     name: 'LINE',     color: '#7dd3fc' },
    { key: 'arrow',    name: 'ARROW',    color: '#60a5fa' },
    { key: 'area',     name: 'ZONE',     color: '#fbbf24' },
    /* Two kinds of ground: the land you own, and land you have
       permission to play on. Worth telling apart on the map and in the
       warning, because trespass and your own trees are different
       problems. */
    { key: 'boundary', name: 'MY LAND',  color: '#ff5a5a' },
    { key: 'permit',   name: 'PLAYABLE', color: '#b6ff3a' },
  ];

  /* --- SVG builders -------------------------------------------------- */

  function diamondSvg(color, glyph, size) {
    const s = size || 30;
    const c = s / 2;
    const r = c - 3;
    return (
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '">' +
      '<polygon points="' + c + ',' + (c - r) + ' ' + (c + r) + ',' + c + ' ' + c + ',' + (c + r) + ' ' + (c - r) + ',' + c + '"' +
      ' fill="rgba(4,10,6,.82)" stroke="' + color + '" stroke-width="2.2"/>' +
      '<text x="' + c + '" y="' + (c + 0.5) + '" text-anchor="middle" dominant-baseline="central"' +
      ' font-family="ui-monospace,monospace" font-size="' + Math.round(s * 0.42) + '" fill="' + color + '">' +
      glyph + '</text></svg>'
    );
  }

  /** Player blip: ring + heading triangle, like a MilSim contact icon. */
  function playerSvg(color, heading, isMe) {
    const s = 34;
    const c = s / 2;
    const rot = heading == null ? 0 : heading;
    const ring = isMe
      ? '<circle cx="' + c + '" cy="' + c + '" r="15" fill="none" stroke="' + color + '" stroke-width="1" opacity=".55" class="pl-pulse"/>'
      : '';
    return (
      '<svg width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '">' + ring +
      '<circle cx="' + c + '" cy="' + c + '" r="11" fill="rgba(4,10,6,.72)" stroke="' + color + '" stroke-width="2.4"/>' +
      '<g transform="rotate(' + rot + ' ' + c + ' ' + c + ')">' +
      '<polygon points="' + c + ',' + (c - 7) + ' ' + (c + 5.5) + ',' + (c + 6) + ' ' + c + ',' + (c + 3) + ' ' + (c - 5.5) + ',' + (c + 6) + '"' +
      ' fill="' + color + '"/></g></svg>'
    );
  }

  /* --- Leaflet icons -------------------------------------------------- */

  function markerIcon(m) {
    const k = kind(m.kind);
    const label = m.label || k.name;
    return L.divIcon({
      className: 'mk',
      html: diamondSvg(k.color, k.glyph, 30) +
            '<div class="mk-label">' + U.escapeHtml(label) + '</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  function playerIcon(p, isMe) {
    const color = isMe ? '#b6ff3a' : teamColor(p.team);
    const classes = ['mk'];
    if (p.stale || !p.online) classes.push('pl-stale');
    const sub = p.status && p.status !== 'ok'
      ? ' <span style="color:#ffb020">[' + U.escapeHtml(p.status.toUpperCase()) + ']</span>'
      : '';
    return L.divIcon({
      className: classes.join(' '),
      html: playerSvg(color, p.hdg, isMe) +
            '<div class="mk-label">' + U.escapeHtml(p.callsign || '?') + sub + '</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  global.ICONS = {
    TEAMS, TEAM_ORDER, teamColor, KINDS, kind, SHAPES,
    diamondSvg, playerSvg, markerIcon, playerIcon,
  };
})(window);
