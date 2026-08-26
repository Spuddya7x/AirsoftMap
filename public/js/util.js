/* Small helpers shared by the rest of the app. */
(function (global) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    for (const c of children || []) node.appendChild(c);
    return node;
  }

  /* --- geo ---------------------------------------------------------- */
  const R = 6371008.8; // mean earth radius, metres
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function distance(a, b) {
    if (!a || !b) return null;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const la1 = rad(a.lat);
    const la2 = rad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearing(a, b) {
    if (!a || !b) return null;
    const la1 = rad(a.lat);
    const la2 = rad(b.lat);
    const dLng = rad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]) || 0;
    return total;
  }

  /** Destination point given start, bearing (deg) and distance (m). */
  function destination(from, brg, dist) {
    const d = dist / R;
    const b = rad(brg);
    const la1 = rad(from.lat);
    const lo1 = rad(from.lng);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    const lo2 = lo1 + Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
    return { lat: deg(la2), lng: ((deg(lo2) + 540) % 360) - 180 };
  }

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (b) => (b == null ? '--' : COMPASS[Math.round(b / 22.5) % 16]);

  function fmtDist(m) {
    if (m == null) return '--';
    if (m < 1000) return Math.round(m) + 'm';
    return (m / 1000).toFixed(m < 10000 ? 2 : 1) + 'km';
  }

  function fmtAge(ms) {
    if (ms == null) return '--';
    const s = Math.round(ms / 1000);
    if (s < 5) return 'now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.round(m / 60) + 'h ago';
  }

  /* --- storage ------------------------------------------------------ */
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('am.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('am.' + key, JSON.stringify(value)); } catch { /* private mode */ }
    },
    del(key) {
      try { localStorage.removeItem('am.' + key); } catch { /* ignore */ }
    },
  };

  /* --- misc --------------------------------------------------------- */
  let toastTimer = null;
  function toast(text, ms) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), ms || 2200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function uid() {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  global.U = {
    $, $$, el, distance, bearing, pathLength, destination, compass,
    fmtDist, fmtAge, store, toast, escapeHtml, uid, rad, deg,
  };
})(window);
