/* Sync TV — controle (celular). */
(function () {
  'use strict';
  var U = window.STV;
  var $ = function (id) { return document.getElementById(id); };

  var room = U.qs('sala') ? U.normRoom(U.qs('sala')) : U.lsGet('synctv.ctlroom');
  if (!room || room.length < 6) room = U.newRoom();
  U.lsSet('synctv.ctlroom', room);

  var link = null, state = null, tvs = {}, titles = {};
  var dragging = false;

  connect();
  setInterval(render, 500);

  var tvUrl = U.appBaseUrl() + 'tv';
  $('tvUrl').textContent = tvUrl.replace(/^https?:\/\//, '');
  var els = document.querySelectorAll('.tvUrl2');
  for (var i = 0; i < els.length; i++) els[i].textContent = tvUrl.replace(/^https?:\/\//, '');

  // Link recebido pelo "Compartilhar" do Android (PWA instalado) ou ?v=
  var shared = U.qs('url') || U.qs('text') || U.qs('v');
  if (shared && U.parseYouTube(shared)) { $('url').value = shared; toast('Link recebido. Toque em Tocar agora ou Fila.'); }
  if (U.qs('parear')) setTimeout(function () { openPair(U.qs('parear')); }, 200);
  if (U.qs('sala') || shared || U.qs('parear')) history.replaceState(null, '', location.pathname);

  function connect() {
    if (link) link.end();
    state = null; tvs = {};
    $('roomBtn').textContent = U.fmtRoom(room);
    link = new U.Link({
      room: room,
      subs: ['state', 'p/+'],
      onStatus: function (s) { $('dot').className = 'dot' + (s === 'online' ? ' on' : ''); },
      onMessage: function (rel, d) {
        if (rel === 'state') { if (d && typeof d.seq === 'number') state = d; render(); }
        else if (rel.indexOf('p/') === 0) {
          var id = rel.slice(2);
          if (d.gone) delete tvs[id]; else tvs[id] = { d: d, seen: U.now() };
        } else if (rel.indexOf('pair/') === 0 && /\/ok$/.test(rel)) pairOk();
      }
    });
  }

  function cmd(o) {
    if (!leader()) { toast('Nenhuma TV conectada na sala.'); return; }
    link.pub('cmd', o);
    if (navigator.vibrate) navigator.vibrate(10);
  }
  function leader() {
    var t = U.now();
    for (var id in tvs) if (t - tvs[id].seen < 3500 && tvs[id].d.leader) return tvs[id];
    return null;
  }

  /* ----- Entrada de link ----- */
  function readInput() {
    var v = U.parseYouTube($('url').value);
    if (!v) { toast('Não reconheci esse link do YouTube.'); $('url').focus(); return null; }
    return v;
  }
  function withTitle(v, cb) {
    fetchTitle(v.vid, function (t) { v.title = t || ''; cb(v); });
  }
  $('playNow').onclick = function () {
    var v = readInput(); if (!v) return;
    withTitle(v, function (v) { cmd({ c: 'load', vid: v.vid, start: v.start, title: v.title }); $('url').value = ''; });
  };
  $('enqueue').onclick = function () {
    var v = readInput(); if (!v) return;
    withTitle(v, function (v) { cmd({ c: 'enqueue', vid: v.vid, start: v.start, title: v.title }); $('url').value = ''; toast('Adicionado à fila.'); });
  };
  $('paste').onclick = function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) { $('url').focus(); return; }
    navigator.clipboard.readText().then(function (t) { $('url').value = t.trim(); }).catch(function () { $('url').focus(); });
  };
  $('url').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('playNow').click(); });

  function fetchTitle(vid, cb) {
    if (titles[vid]) return cb(titles[vid]);
    var done = false;
    var finish = function (t) { if (done) return; done = true; if (t) titles[vid] = t; cb(t); };
    setTimeout(function () { finish(''); }, 2500);
    var u = 'https://www.youtube.com/watch?v=' + vid;
    fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u))
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) { finish(j.title); })
      .catch(function () {
        fetch('https://noembed.com/embed?url=' + encodeURIComponent(u))
          .then(function (r) { return r.json(); })
          .then(function (j) { finish(j.title || ''); })
          .catch(function () { finish(''); });
      });
  }

  /* ----- Controles ----- */
  $('toggle').onclick = function () { cmd({ c: 'toggle' }); };
  $('back').onclick = function () { cmd({ c: 'seekrel', d: -10 }); };
  $('fwd').onclick = function () { cmd({ c: 'seekrel', d: 10 }); };
  $('next').onclick = function () { cmd({ c: 'next' }); };
  $('stop').onclick = function () { cmd({ c: 'stop' }); };
  $('clearQ').onclick = function () { cmd({ c: 'clearq' }); };
  var seek = $('seek');
  seek.addEventListener('input', function () { dragging = true; $('tCur').textContent = U.fmtTime(+seek.value); });
  seek.addEventListener('change', function () { dragging = false; cmd({ c: 'seek', pos: +seek.value }); });

  /* ----- Render ----- */
  function render() {
    var t = U.now();
    var list = [];
    for (var id in tvs) { if (t - tvs[id].seen > 3500) delete tvs[id]; else list.push(tvs[id]); }
    list.sort(function (a, b) { return (b.d.leader ? 1 : 0) - (a.d.leader ? 1 : 0) || (a.d.name < b.d.name ? -1 : 1); });

    var L = leader();
    var s = state;
    if (s && s.vid) {
      var title = (L && L.d.vid === s.vid && L.d.title) || s.title || titles[s.vid] || s.vid;
      $('nowTitle').textContent = title;
      $('nowThumb').style.backgroundImage = 'url(https://i.ytimg.com/vi/' + s.vid + '/mqdefault.jpg)';
      $('toggle').textContent = s.playing ? '❚❚' : '▶';
      var dur = L && L.d.vid === s.vid ? (L.d.dur || 0) : 0;
      var cur = s.pos;
      if (L && L.d.vid === s.vid && typeof L.d.cur === 'number') {
        cur = L.d.cur + (s.playing && L.d.ps === 1 ? (t - L.seen) / 1000 : 0);
      }
      $('nowSub').textContent = s.playing ? 'Tocando em ' + list.length + (list.length === 1 ? ' TV' : ' TVs') : 'Pausado';
      if (dur) { seek.max = Math.floor(dur); $('tDur').textContent = U.fmtTime(dur); }
      if (!dragging) { seek.value = Math.floor(cur); $('tCur').textContent = U.fmtTime(cur); }
      seek.disabled = false;
    } else {
      $('nowTitle').textContent = 'Nada tocando';
      $('nowSub').textContent = list.length ? 'Cole um link acima' : '';
      $('nowThumb').style.backgroundImage = '';
      $('toggle').textContent = '▶';
      seek.value = 0; seek.disabled = true;
      $('tCur').textContent = '0:00'; $('tDur').textContent = '0:00';
    }

    // TVs
    var box = $('tvs');
    if (!list.length) {
      if (!box.querySelector('.empty')) box.innerHTML = '<div class="empty">Nenhuma TV conectada. Abra <b>' + esc(tvUrl.replace(/^https?:\/\//, '')) + '</b> no navegador da TV.</div>';
    } else {
      box.innerHTML = list.map(function (x) {
        var d = x.d, badges = '', info;
        if (d.leader) badges += '<span class="badge lead">principal</span>';
        if (!d.act) badges += '<span class="badge warn">aperte OK na TV</span>';
        if (d.err) badges += '<span class="badge warn">' + esc(d.err) + '</span>';
        if (d.leader) info = 'referência de tempo';
        else if (!d.synced) info = 'sincronizando relógio…';
        else info = 'diferença ' + fmtMs(d.drift) + ' · rede ' + d.rtt + ' ms';
        return '<div class="tv"><div><div class="n">' + esc(d.name || d.id) + badges + '</div><div class="m">' + info + '</div></div>' +
          '<div class="b"><button class="small" data-tv="' + esc(d.id) + '">⋯</button></div></div>';
      }).join('');
    }

    // Fila
    var q = s && s.queue ? s.queue : [];
    $('queue').innerHTML = q.length ? q.map(function (it, i) {
      return '<div class="q"><div class="thumb" style="background-image:url(https://i.ytimg.com/vi/' + esc(it.vid) + '/default.jpg)"></div>' +
        '<div class="t">' + esc(it.title || it.vid) + '</div>' +
        '<button class="small" data-playq="' + i + '">▶</button><button class="small link" data-rmq="' + i + '">✕</button></div>';
    }).join('') : '<div class="empty">Fila vazia.</div>';
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.dataset.playq !== undefined) cmd({ c: 'playq', i: +b.dataset.playq });
    else if (b.dataset.rmq !== undefined) cmd({ c: 'removeq', i: +b.dataset.rmq });
    else if (b.dataset.tv) openTv(b.dataset.tv);
  });

  function fmtMs(ms) { ms = ms || 0; return (ms > 0 ? '+' : '') + ms + ' ms'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ----- Pareamento ----- */
  var pairTimer = null, pairCode = null;
  $('addTv').onclick = function () { openPair(''); };
  function openPair(code) {
    $('pairCode').value = code || ''; $('pairMsg').textContent = '';
    $('pairDlg').showModal();
    setTimeout(function () { (code ? $('pairName') : $('pairCode')).focus(); }, 50);
  }
  $('pairCancel').onclick = function () { stopPair(); $('pairDlg').close(); };
  $('pairGo').onclick = function () {
    var code = $('pairCode').value.replace(/\D/g, '');
    if (code.length !== 6) { $('pairMsg').textContent = 'O código tem 6 dígitos.'; return; }
    var name = $('pairName').value.trim() || ('TV ' + (Object.keys(tvs).length + 1));
    stopPair();
    pairCode = code;
    link.sub('/pair/' + code + '/ok');
    var n = 0;
    var send = function () {
      if (++n > 15) { stopPair(); $('pairMsg').textContent = 'A TV não respondeu. Confira o código e se ela está com a tela de pareamento aberta.'; return; }
      link.pub('/pair/' + code, { room: room, name: name, broker: U.lsGet('synctv.broker', 'hivemq') });
    };
    send(); pairTimer = setInterval(send, 1000);
    $('pairMsg').textContent = 'Enviando para a TV…';
  };
  function pairOk() {
    stopPair();
    $('pairDlg').close();
    toast('TV pareada! Agora aperte OK no controle da TV.');
  }
  function stopPair() {
    clearInterval(pairTimer); pairTimer = null;
    if (pairCode) { try { link.unsub('/pair/' + pairCode + '/ok'); } catch (e) {} pairCode = null; }
  }

  /* ----- Sala ----- */
  $('roomBtn').onclick = function () {
    $('roomBig').textContent = U.fmtRoom(room);
    $('broker').value = U.lsGet('synctv.broker', 'hivemq');
    $('roomDlg').showModal();
  };
  $('roomClose').onclick = function () { $('roomDlg').close(); };
  $('shareRoom').onclick = function () {
    var url = U.appBaseUrl() + '?sala=' + room;
    if (navigator.share) navigator.share({ title: 'Sync TV', url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('Link copiado.'); });
    else prompt('Link da sala', url);
  };
  $('joinGo').onclick = function () {
    var r = U.normRoom($('joinRoom').value);
    if (r.length < 6) { toast('Código inválido.'); return; }
    room = r; U.lsSet('synctv.ctlroom', room); $('roomDlg').close(); connect();
  };
  $('newRoom').onclick = function () {
    if (!confirm('Criar uma sala nova? As TVs atuais continuarão na sala antiga até serem pareadas de novo.')) return;
    room = U.newRoom(); U.lsSet('synctv.ctlroom', room); $('roomDlg').close(); connect();
  };
  $('broker').onchange = function () {
    U.lsSet('synctv.broker', $('broker').value);
    toast('Servidor alterado. Pareie as TVs de novo para elas usarem o mesmo.');
    connect();
  };

  /* ----- Ações por TV ----- */
  var tvSel = null;
  function openTv(id) {
    var x = tvs[id]; if (!x) return;
    tvSel = id;
    $('tvDlgTitle').textContent = x.d.name || id;
    $('tvDlgInfo').textContent = (x.d.leader ? 'TV principal (referência de tempo). ' : '') +
      'Compensação de seek aprendida: ' + x.d.lead + ' ms.';
    $('tvRename').value = x.d.name || '';
    $('tvDlg').showModal();
  }
  function tvCmd(o) { if (tvSel) link.pub('t/' + tvSel, o); }
  $('tvRenameGo').onclick = function () { var n = $('tvRename').value.trim(); if (n) tvCmd({ c: 'rename', name: n }); $('tvDlg').close(); };
  $('tvReload').onclick = function () { tvCmd({ c: 'reload' }); $('tvDlg').close(); };
  $('tvUnpair').onclick = function () { if (confirm('Desvincular esta TV da sala?')) { tvCmd({ c: 'unpair' }); $('tvDlg').close(); } };
  $('tvClose').onclick = function () { $('tvDlg').close(); };

  var toastTimer = null;
  function toast(m) {
    var el = $('toast'); el.textContent = m; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 3500);
  }
})();
