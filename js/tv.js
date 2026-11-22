/* Sync TV — tela da TV.
 * Modelo: a sala tem um "estado" (vídeo, tocando/pausado, posição pos no instante at).
 * Uma TV é eleita líder: ela recebe os comandos do celular, publica o estado e é o
 * relógio de referência. As demais TVs medem a diferença de relógio para a líder
 * (ping/pong estilo NTP) e corrigem o atraso com rajadas de velocidade ou seek. */
(function () {
  'use strict';
  var U = window.STV;
  var ME = U.deviceId();
  var $ = function (id) { return document.getElementById(id); };

  if (U.qs('sala')) U.lsSet('synctv.room', U.normRoom(U.qs('sala')));
  if (U.qs('nome')) U.lsSet('synctv.name', U.qs('nome'));
  var room = U.lsGet('synctv.room');
  var name = U.lsGet('synctv.name') || ('TV ' + ME.slice(-4).toUpperCase());

  var link = null;
  var player = null, playerReady = false, activated = false, loadedVid = null, lastErr = null;
  var peers = {};                 // id -> { d: presença, seen: t }
  var leaderId = null, isLeader = false, startedAt = U.now();
  var state = null;               // estado da sala (publicado pela líder, retido no broker)
  var clock = { peer: null, samples: [], offset: 0, ready: false };
  var peerOffsets = {};           // últimos offsets conhecidos por líder (para troca de líder)
  var pingN = 0, scheduleTimer = null, burstTimer = null;
  var lead = parseFloat(U.lsGet('synctv.lead', '0.15')) || 0.15; // compensação aprendida do seek (s)
  var rateUp = null, rateDown = null, curRate = 1;
  var corr = { lastSeek: -1e9, calib: false, burstUntil: 0, lastAnchor: 0, samples: [], drift: 0 };

  /* ---------------- Pareamento (TV ainda sem sala) ---------------- */
  if (!room) { startPairing(); return; }
  startRoom();

  function startPairing() {
    show('pair');
    var code = U.rand(6, '0123456789');
    $('pairCode').textContent = code.slice(0, 3) + ' ' + code.slice(3);
    var url = U.appBaseUrl() + '?parear=' + code;
    $('pairQr').innerHTML = U.qrSvg(url, 6);
    $('pairUrl').textContent = url.replace(/^https?:\/\//, '');
    link = new U.Link({
      room: null,
      subs: ['/pair/' + code],
      onStatus: function (s) { $('pairStatus').textContent = s === 'online' ? 'Aguardando o celular…' : 'Conectando (' + s + ')…'; },
      onMessage: function (rel, d) {
        if (rel === 'pair/' + code && d && d.room) {
          U.lsSet('synctv.room', U.normRoom(d.room));
          if (d.name) U.lsSet('synctv.name', String(d.name).slice(0, 30));
          if (d.broker) U.lsSet('synctv.broker', d.broker);
          link.pub('/pair/' + code + '/ok', { id: ME });
          setTimeout(function () { location.replace(location.pathname); }, 300);
        }
      }
    });
    $('manualForm').onsubmit = function (e) {
      e.preventDefault();
      var r = U.normRoom($('manualRoom').value);
      if (r.length < 6) { $('manualRoom').focus(); return; }
      U.lsSet('synctv.room', r);
      var n = $('manualName').value.trim();
      if (n) U.lsSet('synctv.name', n.slice(0, 30));
      location.replace(location.pathname);
    };
  }

  /* ---------------- Sala ---------------- */
  function startRoom() {
    show('main');
    $('roomCode').textContent = U.fmtRoom(room);
    $('tvName').textContent = name;
    var ctl = U.appBaseUrl() + '?sala=' + room;
    $('ctlQr').innerHTML = U.qrSvg(ctl, 6);
    $('ctlUrl').textContent = ctl.replace(/^https?:\/\//, '');
    showIdle(true);

    link = new U.Link({
      room: room,
      subs: ['state', 'cmd', 'p/+', 'ping', 'pong/' + ME, 't/' + ME],
      onStatus: function (s) { hud.conn = s; drawHud(); },
      onConnect: function () { startedAt = U.now(); },
      onMessage: onMessage
    });

    setInterval(presence, 1000);
    setInterval(elect, 500);
    setInterval(pingLoop, 3000);
    setInterval(tick, 250);
    window.addEventListener('beforeunload', function () { if (link) link.pub('p/' + ME, { id: ME, gone: true }); });

    if (U.qs('auto') === '1') activate();
    else { show('activate', true); setTimeout(function () { $('activateBtn').focus(); }, 50); }
    $('activateBtn').onclick = activate;
    $('resetBtn').onclick = function () { if (confirm('Desvincular esta TV da sala?')) unpair(); };
  }

  function onMessage(rel, d) {
    if (rel === 'state') return onState(d);
    if (rel === 'cmd') { if (isLeader) handleCmd(d); return; }
    if (rel.indexOf('p/') === 0) {
      var id = rel.slice(2);
      if (id === ME || d.kind === 'app') return; // TVs do app oficial são da ponte
      if (d.gone) delete peers[id]; else peers[id] = { d: d, seen: U.now() };
      return;
    }
    if (rel === 'ping') {
      if (isLeader && d.to === ME) link.pub('pong/' + d.from, { from: ME, n: d.n, t0: d.t0, tl: U.now() });
      return;
    }
    if (rel === 'pong/' + ME) return onPong(d);
    if (rel === 't/' + ME) {
      if (d.c === 'unpair') unpair();
      else if (d.c === 'reload') location.reload();
      else if (d.c === 'rename' && d.name) { name = String(d.name).slice(0, 30); U.lsSet('synctv.name', name); $('tvName').textContent = name; }
    }
  }

  function unpair() {
    U.lsSet('synctv.room', null);
    if (link) link.pub('p/' + ME, { id: ME, gone: true });
    setTimeout(function () { location.replace(location.pathname); }, 300);
  }

  /* ---------------- Ativação e player ---------------- */
  function activate() {
    if (activated) return;
    activated = true;
    show('activate', false);
    var el = document.documentElement;
    try {
      var rf = el.requestFullscreen || el.webkitRequestFullscreen;
      if (rf) { var p = rf.call(el); if (p && p.catch) p.catch(function () {}); }
    } catch (e) {}
    window.onYouTubeIframeAPIReady = makePlayer;
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }

  function makePlayer() {
    player = new window.YT.Player('player', {
      width: '100%', height: '100%',
      playerVars: {
        autoplay: 0, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1,
        iv_load_policy: 3, modestbranding: 1, origin: location.origin
      },
      events: {
        onReady: function () {
          playerReady = true;
          var rates = [];
          try { rates = player.getAvailablePlaybackRates() || []; } catch (e) {}
          updateRates(rates);
          applyState();
        },
        onStateChange: onPlayerState,
        onError: function (e) {
          var msgs = { 2: 'link inválido', 5: 'erro no player HTML5', 100: 'vídeo não encontrado ou privado',
            101: 'o dono do vídeo não permite tocar fora do YouTube', 150: 'o dono do vídeo não permite tocar fora do YouTube',
            153: 'o YouTube recusou o player incorporado' };
          lastErr = msgs[e.data] || ('erro ' + e.data);
          toast('Não deu para tocar: ' + lastErr);
          if (isLeader && state && state.queue && state.queue.length) setTimeout(function () { handleCmd({ c: 'next', auto: true }); }, 4000);
        }
      }
    });
  }

  function updateRates(rates) {
    rateUp = null; rateDown = null;
    for (var i = 0; i < rates.length; i++) {
      var r = rates[i];
      if (r > 1 && r <= 1.5 && (rateUp === null || r < rateUp)) rateUp = r;
      if (r < 1 && r >= 0.5 && (rateDown === null || r > rateDown)) rateDown = r;
    }
  }

  function onPlayerState(e) {
    var ps = e.data;
    if (ps === 1) {
      lastErr = null;
      try {
        var r = player.getAvailablePlaybackRates();
        if (r && r.length) updateRates(r);
      } catch (x) {}
      // Vídeo carregou mas ainda não é hora de tocar: segura pausado (já com buffer).
      if (state && usable() && (!state.playing || startsIn() > 80)) player.pauseVideo();
      showIdle(false);
    }
    if (ps === 0 && isLeader) handleCmd({ c: 'next', auto: true });
  }

  /* ---------------- Eleição de líder ---------------- */
  function elect() {
    var t = U.now();
    var cands = [{ id: ME, act: activated }];
    for (var id in peers) {
      if (t - peers[id].seen > 3500) { delete peers[id]; continue; }
      cands.push({ id: id, act: !!peers[id].d.act });
    }
    if (t - startedAt < 2500) return; // espera conhecer as outras TVs
    // Preferência: TV ativada; depois a configurada há mais tempo (ID menor).
    cands.sort(function (a, b) { return (a.act === b.act) ? (a.id < b.id ? -1 : 1) : (a.act ? -1 : 1); });
    var L = cands[0].id;
    if (L !== leaderId) {
      if (clock.ready && clock.peer) peerOffsets[clock.peer] = clock.offset;
      leaderId = L;
      isLeader = (L === ME);
      clock = { peer: L, samples: [], offset: 0, ready: isLeader };
      if (isLeader) adoptLeadership();
      else for (var k = 0; k < 6; k++) setTimeout(sendPing, k * 250);
      drawHud();
    } else if (isLeader && state && state.by !== ME) {
      adoptLeadership();
    }
  }

  function adoptLeadership() {
    if (!state || state.by === ME) return;
    var ns = copy(state);
    var actual = actualPos();
    if (actual !== null) ns.pos = actual;
    else if (state.playing && peerOffsets[state.by] !== undefined) {
      ns.pos = state.pos + Math.max(0, (U.now() + peerOffsets[state.by] - state.at) / 1000);
    }
    ns.at = U.now() + (ns.playing ? 600 : 0);
    pubState(ns, actual === null);
  }

  /* ---------------- Relógio (ping/pong com a líder) ---------------- */
  function pingLoop() { if (!isLeader && leaderId) sendPing(); }
  function sendPing() {
    if (!link || !link.connected || isLeader || !leaderId) return;
    link.pub('ping', { from: ME, to: leaderId, n: ++pingN, t0: U.now() });
  }
  function onPong(d) {
    if (d.from !== clock.peer) return;
    var t1 = U.now();
    var rtt = t1 - d.t0;
    if (rtt < 0 || rtt > 5000) return;
    clock.samples.push({ off: d.tl - (d.t0 + t1) / 2, rtt: rtt });
    if (clock.samples.length > 15) clock.samples.shift();
    var best = clock.samples[0];
    for (var i = 1; i < clock.samples.length; i++) if (clock.samples[i].rtt < best.rtt) best = clock.samples[i];
    clock.offset = best.off;
    clock.rtt = best.rtt;
    var wasReady = clock.ready;
    if (clock.samples.length >= 3) clock.ready = true;
    if (clock.ready && !wasReady) applyState();
  }

  /* ---------------- Linha do tempo ---------------- */
  function offsetFor(by) {
    if (by === ME) return 0;
    if (clock.peer === by && clock.ready) return clock.offset;
    return null;
  }
  function usable() { return !!state && offsetFor(state.by) !== null; }
  function sNow() { return U.now() + offsetFor(state.by); }
  function startsIn() { return state.at - sNow(); }
  function expected() {
    if (!state.playing) return state.pos;
    var dt = (sNow() - state.at) / 1000;
    return dt <= 0 ? state.pos : state.pos + dt;
  }
  function actualPos() {
    if (!playerReady || !state || loadedVid !== state.vid) return null;
    var ps = player.getPlayerState();
    if (ps === 1 || ps === 2) return player.getCurrentTime();
    return null;
  }

  function onState(d) {
    if (!d || typeof d.seq !== 'number') return;
    if (state && d.seq === state.seq && d.by === state.by) return;
    if (state && d.seq < state.seq) return;
    state = d;
    applyState();
  }

  function applyState() {
    if (!state) return;
    if (!state.vid) { showIdle(true); }
    if (!playerReady || !usable()) return;
    clearTimeout(scheduleTimer);
    resetSamples();
    if (!state.vid) {
      if (loadedVid) { try { player.stopVideo(); } catch (e) {} loadedVid = null; }
      return;
    }
    if (loadedVid !== state.vid) {
      loadedVid = state.vid;
      player.loadVideoById({ videoId: state.vid, startSeconds: Math.max(0, expected()) });
      corr.lastSeek = U.now();
      schedulePlay();
      return;
    }
    if (state.playing) {
      if (startsIn() > 50) { player.pauseVideo(); player.seekTo(state.pos, true); schedulePlay(); }
      else {
        var e = expected();
        if (Math.abs(player.getCurrentTime() - e) > 0.3) player.seekTo(e + (isLeader ? 0 : lead), true);
        player.playVideo();
      }
    } else {
      player.pauseVideo();
      if (Math.abs(player.getCurrentTime() - state.pos) > 0.15) player.seekTo(state.pos, true);
    }
    corr.lastSeek = U.now();
  }

  function schedulePlay() {
    if (!state.playing) return;
    var w = Math.max(0, startsIn() - 60);
    scheduleTimer = setTimeout(function () {
      if (!state || !state.playing || loadedVid !== state.vid) return;
      var e = expected();
      if (Math.abs(player.getCurrentTime() - e) > 0.25) player.seekTo(e, true);
      player.playVideo();
      corr.lastSeek = U.now();
      resetSamples();
    }, w);
  }

  /* ---------------- Correção contínua de atraso ---------------- */
  function resetSamples() { corr.samples = []; }
  function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }

  function tick() {
    if (!state || !playerReady || !usable() || !state.vid || loadedVid !== state.vid) return;
    var t = U.now();
    var ps = player.getPlayerState();
    if (!state.playing) { if (ps === 1) player.pauseVideo(); corr.drift = 0; return; }
    if (startsIn() > 0) return;
    if (ps === 2 || ps === 5) { if (t - corr.lastSeek > 1500) { player.playVideo(); corr.lastSeek = t; } return; }
    if (ps !== 1) return;

    var cur = player.getCurrentTime();
    var dur = player.getDuration() || 0;
    var e = expected();
    if (dur && e > dur - 1) return;
    var d = cur - e; // > 0: esta TV está adiantada

    if (isLeader) {
      corr.drift = 0;
      // A líder é a referência. Se ela travou (buffer), re-ancora a linha do tempo nela.
      if (Math.abs(d) > 0.6 && t - corr.lastAnchor > 2000 && t - corr.lastSeek > 1500) {
        corr.lastAnchor = t;
        var ns = copy(state); ns.pos = cur; ns.at = U.now();
        pubState(ns, false);
      }
      return;
    }

    if (t < corr.burstUntil) return;
    if (t - corr.lastSeek < (corr.calib ? 2000 : 1200)) return;
    corr.samples.push(d);
    if (corr.samples.length > 6) corr.samples.shift();
    if (Math.abs(d) > 0.8) { seekFollow(); return; }
    if (corr.samples.length < 4) return;
    var m = median(corr.samples);
    corr.drift = m;
    if (corr.calib) {
      // Aprende quanto o player demora para "pegar" depois de um seek.
      lead = Math.min(2, Math.max(0, lead - m * 0.7));
      U.lsSet('synctv.lead', lead.toFixed(3));
      corr.calib = false;
    }
    var ad = Math.abs(m);
    if (ad > 0.45) seekFollow();
    else if (ad > 0.07) rateBurst(m);
  }

  function seekFollow() {
    player.seekTo(expected() + lead, true);
    corr.lastSeek = U.now();
    corr.calib = true;
    resetSamples();
  }

  function rateBurst(d) {
    var r = d > 0 ? rateDown : rateUp;
    if (!r) { if (Math.abs(d) > 0.15) seekFollow(); return; }
    var ms = Math.abs(d) / Math.abs(1 - r) * 1000;
    if (ms > 4000) { seekFollow(); return; }
    player.setPlaybackRate(r); curRate = r;
    clearTimeout(burstTimer);
    burstTimer = setTimeout(function () { player.setPlaybackRate(1); curRate = 1; }, ms);
    corr.burstUntil = U.now() + ms + 700;
    resetSamples();
  }

  /* ---------------- Comandos (só a líder processa) ---------------- */
  function handleCmd(c) {
    if (!c || !c.c) return;
    var ns = state ? copy(state) : { vid: '', playing: false, pos: 0, at: U.now(), queue: [], title: '' };
    if (!ns.queue) ns.queue = [];
    var here = actualPos();
    var pos = here !== null ? here : (usable() ? expected() : ns.pos);
    var dur = playerReady && loadedVid === ns.vid ? (player.getDuration() || 0) : 0;
    var t = U.now();
    function load(item) { ns.vid = item.vid; ns.pos = item.start || 0; ns.title = item.title || ''; ns.playing = true; ns.at = t + 2500; }

    switch (c.c) {
      case 'load': load(c); break;
      case 'enqueue':
        if (ns.queue.length < 50) ns.queue.push({ vid: c.vid, start: c.start || 0, title: c.title || '' });
        if (!ns.vid) load(ns.queue.shift());
        break;
      case 'playq':
        if (ns.queue[c.i]) load(ns.queue.splice(c.i, 1)[0]);
        break;
      case 'removeq': if (ns.queue[c.i]) ns.queue.splice(c.i, 1); break;
      case 'clearq': ns.queue = []; break;
      case 'next':
        if (ns.queue.length) load(ns.queue.shift());
        else if (c.auto) { ns.playing = false; ns.pos = dur || pos; ns.at = t; }
        else return;
        break;
      case 'play': if (!ns.vid) return; ns.playing = true; ns.pos = pos; ns.at = t + 900; break;
      case 'pause': ns.playing = false; ns.pos = pos; ns.at = t; break;
      case 'toggle':
        if (!ns.vid) return;
        if (ns.playing) { ns.playing = false; ns.pos = pos; ns.at = t; }
        else { ns.playing = true; ns.pos = pos; ns.at = t + 900; }
        break;
      case 'seek': case 'seekrel':
        if (!ns.vid) return;
        var p = c.c === 'seek' ? +c.pos : pos + (+c.d);
        if (dur) p = Math.min(p, dur - 1);
        ns.pos = Math.max(0, p); ns.at = t + (ns.playing ? 1200 : 0);
        break;
      case 'stop': ns.vid = ''; ns.playing = false; ns.pos = 0; ns.title = ''; ns.at = t; break;
      default: return;
    }
    pubState(ns, true);
  }

  function pubState(ns, apply) {
    ns.seq = (state ? state.seq : 0) + 1;
    ns.by = ME;
    state = ns;
    link.pub('state', ns, true);
    if (apply) applyState();
  }

  /* ---------------- Presença / UI ---------------- */
  function presence() {
    if (!link || !link.connected) return;
    var d = { id: ME, name: name, leader: isLeader, act: activated, ready: playerReady, err: lastErr,
      drift: Math.round(corr.drift * 1000), rtt: clock.rtt ? Math.round(clock.rtt) : 0,
      lead: Math.round(lead * 1000), rate: curRate, synced: isLeader || clock.ready };
    if (playerReady) {
      try {
        d.ps = player.getPlayerState(); d.cur = player.getCurrentTime(); d.dur = player.getDuration();
        var vd = player.getVideoData ? player.getVideoData() : null;
        if (vd) { d.vid = vd.video_id; d.title = vd.title; }
      } catch (e) {}
    }
    link.pub('p/' + ME, d);
    drawHud();
  }

  var hud = { conn: 'conectando' };
  function drawHud() {
    var role = !leaderId ? '…' : (isLeader ? 'TV principal' : 'seguindo');
    var parts = [hud.conn === 'online' ? '● online' : '○ ' + hud.conn, name, role];
    if (!isLeader && clock.ready) parts.push('Δ ' + Math.round(corr.drift * 1000) + ' ms', 'rtt ' + Math.round(clock.rtt || 0) + ' ms');
    var n = Object.keys(peers).length + 1;
    parts.push(n + (n > 1 ? ' TVs' : ' TV'));
    $('hud').textContent = parts.join('  ·  ');
    $('idleRole').textContent = role + ' · ' + n + (n > 1 ? ' TVs na sala' : ' TV na sala');
  }

  var hudTimer = null;
  document.addEventListener('keydown', function () {
    document.body.classList.add('showhud');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { document.body.classList.remove('showhud'); }, 6000);
  });

  function showIdle(on) { document.body.classList.toggle('idle', !!on); }
  function show(id, on) {
    if (on === undefined) { $('pair').hidden = id !== 'pair'; $('main').hidden = id !== 'main'; return; }
    $(id).hidden = !on;
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 6000);
  }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  // Exposto para diagnóstico/testes.
  window.__stv = { get state() { return state; }, get leader() { return isLeader; }, get clock() { return clock; }, get drift() { return corr.drift; }, get lead() { return lead; } };
})();
