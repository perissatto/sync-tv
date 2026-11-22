/* Sync TV — utilidades compartilhadas (TV e controle).
 * Escrito em JS "conservador" (sem optional chaining, sem ??) para rodar
 * nos navegadores webOS mais antigos das TVs LG. */
(function (global) {
  'use strict';

  var NS = 'synctv-v1';
  var BROKERS = {
    hivemq: 'wss://broker.hivemq.com:8884/mqtt',
    emqx: 'wss://broker.emqx.io:8084/mqtt'
  };
  var ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
  }

  function rand(n, alphabet) {
    alphabet = alphabet || ALPHA;
    var out = '';
    var buf = new Uint32Array(n);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(buf);
    else for (var j = 0; j < n; j++) buf[j] = Math.floor(Math.random() * 4294967296);
    for (var i = 0; i < n; i++) out += alphabet.charAt(buf[i] % alphabet.length);
    return out;
  }

  // Relógio monotônico (não pula com ajustes de NTP do aparelho).
  var perf = global.performance && global.performance.now ? global.performance : null;
  var base = Date.now() - (perf ? perf.now() : 0);
  function now() { return perf ? base + perf.now() : Date.now(); }

  // ID estável do aparelho. Começa com o timestamp de criação, assim a TV
  // configurada há mais tempo vira a "líder" de forma estável.
  function deviceId() {
    var id = lsGet('synctv.id');
    if (!id) { id = Date.now().toString(36) + rand(4); lsSet('synctv.id', id); }
    return id;
  }

  function normRoom(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function fmtRoom(s) { s = normRoom(s).toUpperCase(); return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s; }
  function newRoom() { return rand(8); }

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(global.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }

  function brokerUrl(key) {
    key = key || qs('broker') || lsGet('synctv.broker', 'hivemq');
    if (/^wss?:\/\//.test(key)) return key;
    return BROKERS[key] || BROKERS.hivemq;
  }

  // Aceita: link watch?v=, youtu.be, shorts, live, embed, music.youtube, ou ID puro.
  function parseYouTube(input) {
    if (!input) return null;
    var s = String(input).trim();
    var id = null;
    var m = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|\/v\/)([A-Za-z0-9_-]{11})/.exec(s);
    if (m) id = m[1];
    else if (/^[A-Za-z0-9_-]{11}$/.test(s)) id = s;
    if (!id) return null;
    var start = 0;
    var t = /[?&#](?:t|start)=([0-9hms]+)/.exec(s);
    if (t) {
      var v = t[1];
      if (/^\d+$/.test(v)) start = parseInt(v, 10);
      else {
        var h = /(\d+)h/.exec(v), mi = /(\d+)m/.exec(v), se = /(\d+)s/.exec(v);
        start = (h ? +h[1] * 3600 : 0) + (mi ? +mi[1] * 60 : 0) + (se ? +se[1] : 0);
      }
    }
    return { vid: id, start: start };
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  /* Conexão MQTT por WebSocket com tópicos relativos à sala. */
  function Link(opts) {
    var self = this;
    this.opts = opts;
    this.room = opts.room ? normRoom(opts.room) : null;
    this.base = NS + '/' + (this.room || '_');
    this.connected = false;
    this.client = global.mqtt.connect(brokerUrl(opts.broker), {
      clientId: 'stv_' + deviceId() + '_' + rand(4),
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
      clean: true
    });
    this.client.on('connect', function () {
      self.connected = true;
      var subs = (opts.subs || []).map(function (t) { return self.abs(t); });
      if (subs.length) self.client.subscribe(subs, { qos: 0 });
      status('online');
      if (opts.onConnect) opts.onConnect();
    });
    this.client.on('message', function (topic, payload) {
      var data;
      try { data = JSON.parse(payload.toString()); } catch (e) { return; }
      var rel = topic.indexOf(self.base + '/') === 0 ? topic.slice(self.base.length + 1) : topic.slice(NS.length + 1);
      if (opts.onMessage) opts.onMessage(rel, data, topic);
    });
    this.client.on('reconnect', function () { status('reconectando'); });
    this.client.on('offline', function () { self.connected = false; status('offline'); });
    this.client.on('close', function () { self.connected = false; status('offline'); });
    this.client.on('error', function () { status('erro'); });
    function status(s) { if (opts.onStatus) opts.onStatus(s); }
  }
  Link.prototype.abs = function (rel) {
    // Tópicos começando com "/" são globais (fora da sala), ex.: pareamento.
    return rel.charAt(0) === '/' ? NS + rel : this.base + '/' + rel;
  };
  Link.prototype.pub = function (rel, obj, retain) {
    if (!this.client) return;
    this.client.publish(this.abs(rel), JSON.stringify(obj), { qos: 0, retain: !!retain });
  };
  Link.prototype.sub = function (rel) { this.client.subscribe(this.abs(rel), { qos: 0 }); };
  Link.prototype.unsub = function (rel) { this.client.unsubscribe(this.abs(rel)); };
  Link.prototype.end = function () { try { this.client.end(true); } catch (e) {} this.client = null; };

  function qrSvg(text, cell) {
    var qr = global.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: cell || 6, margin: 2, scalable: true });
  }

  function appBaseUrl() {
    // URL da raiz do app (funciona em /sync-tv/ e em /sync-tv/tv/)
    var p = global.location.pathname.replace(/[^\/]*$/, '');
    p = p.replace(/\/tv\/$/, '/');
    return global.location.origin + p;
  }

  global.STV = {
    NS: NS, BROKERS: BROKERS,
    lsGet: lsGet, lsSet: lsSet, rand: rand, now: now, deviceId: deviceId,
    normRoom: normRoom, fmtRoom: fmtRoom, newRoom: newRoom, qs: qs, brokerUrl: brokerUrl,
    parseYouTube: parseYouTube, fmtTime: fmtTime, Link: Link, qrSvg: qrSvg, appBaseUrl: appBaseUrl
  };
})(window);
