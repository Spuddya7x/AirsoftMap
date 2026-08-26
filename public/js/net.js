/* WebSocket link to the game server, with automatic reconnect. */
(function (global) {
  'use strict';

  function Net() {
    this.ws = null;
    this.identity = null;      // { id, callsign, team, role, room }
    this.handlers = {};
    this.connected = false;
    this.retries = 0;
    this.queue = [];
    this.enabled = false;
    this.timer = null;
  }

  Net.prototype.on = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
    return this;
  };

  Net.prototype.emit = function (type, payload) {
    for (const fn of this.handlers[type] || []) {
      try { fn(payload); } catch (err) { console.error('[net] handler', type, err); }
    }
  };

  Net.prototype.connect = function (identity) {
    this.identity = identity;
    this.enabled = true;
    this.open();
  };

  Net.prototype.open = function () {
    if (!this.enabled) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws');
    } catch (err) {
      this.scheduleReopen();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retries = 0;
      this.send(Object.assign({ t: 'join' }, this.identity));
      const pending = this.queue.splice(0);
      for (const m of pending) this.send(m);
      this.emit('link', { up: true });
    };

    ws.onclose = () => {
      this.connected = false;
      this.emit('link', { up: false });
      this.scheduleReopen();
    };

    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg.t === 'string') this.emit(msg.t, msg);
    };
  };

  Net.prototype.scheduleReopen = function () {
    if (!this.enabled || this.timer) return;
    const wait = Math.min(15000, 800 * Math.pow(1.6, this.retries++));
    this.timer = setTimeout(() => { this.timer = null; this.open(); }, wait);
  };

  /** Send now if we can; otherwise queue anything that is not a position fix. */
  Net.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    if (obj.t !== 'pos' && this.queue.length < 100) this.queue.push(obj);
    return false;
  };

  Net.prototype.disconnect = function () {
    this.enabled = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this.connected = false;
  };

  global.Net = Net;
})(window);
