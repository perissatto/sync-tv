#!/usr/bin/env python3
"""
Ponte Sync TV -> app oficial do YouTube nas TVs.

Usa o protocolo do "Vincular com código de TV" do YouTube (Lounge API, não oficial)
para comandar o app do YouTube de cada TV, e o mesmo broker MQTT do Sync TV para
receber os comandos do controle no celular (perissatto.github.io/sync-tv).

Uso:
    python ponte.py --sala ABCD-EFGH        (primeira vez: grava a sala no config.json)
    python ponte.py                          (próximas vezes)
    python ponte.py --parear 123456789012 --nome Sala   (opcional: parear pelo terminal)
"""
import argparse
import asyncio
import json
import logging
import os
import re
import ssl
import statistics
import sys
import time
import uuid

import aiomqtt
from pyytlounge import EventListener, State, YtLoungeApi

NS = 'synctv-v1'
BROKERS = {'hivemq': ('broker.hivemq.com', 8883), 'emqx': ('broker.emqx.io', 8883)}
CFG_PATH = os.environ.get('STV_CONFIG') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
DEVICE_NAME = 'Sync TV'

log = logging.getLogger('ponte')


def now():
    return time.monotonic()


def ms():
    return int(time.time() * 1000)


def norm_room(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


class Tela(EventListener):
    """Uma TV com o app do YouTube, controlada pela Lounge API."""

    def __init__(self, ponte, key, name, auth=None, api_factory=YtLoungeApi):
        super().__init__()
        self.p = ponte
        self.key = key
        self.name = name
        self.api = api_factory(DEVICE_NAME, self, logger=logging.getLogger('pyytlounge'))
        if auth:
            self.api.load_auth_state(auth)
        self.state = None
        self.pos = 0.0
        self.pos_t = now()
        self.reports = 0
        self.dur = 0.0
        self.vid = None
        self.speed = 1.0
        self.online = False
        self.err = None
        self.lead = 0.8          # compensação aprendida do seek (s)
        self.diffs = []
        self.last_report_used = -1
        self.last_seek = -1e9
        self.calib = False
        self.task = None
        self.opened = False

    # ---- estimativa de posição ----
    def est(self, t=None):
        t = t or now()
        if self.state == State.Playing:
            return self.pos + (t - self.pos_t) * self.speed
        return self.pos

    def fresh(self, t=None):
        return (t or now()) - self.pos_t < 4.0

    # ---- eventos vindos da TV ----
    async def playback_state_changed(self, ev):
        self._upd(ev.current_time, ev.state, ev.duration)

    async def now_playing_changed(self, ev):
        if ev.video_id:
            self.vid = ev.video_id
        self._upd(ev.current_time, ev.state if ev.video_id else None, ev.duration)

    async def playback_speed_changed(self, ev):
        self.speed = ev.playback_speed or 1.0

    async def disconnected(self, ev):
        self.online = False
        self.err = 'app do YouTube fechado'
        log.info('[%s] desconectou (%s)', self.name, getattr(ev, 'reason', ''))

    def _upd(self, cur, st, dur):
        prev = self.state
        if cur is not None:
            self.pos = float(cur)
            self.pos_t = now()
            self.reports += 1
        if st is not None:
            self.state = st
        if dur:
            self.dur = float(dur)
        self.p.on_tv_update(self, prev)

    # ---- conexão ----
    async def open(self):
        if not self.opened:
            await self.api.__aenter__()
            self.opened = True

    async def run(self):
        await self.open()
        backoff = 2
        while True:
            try:
                if not self.api.linked():
                    await self.api.refresh_auth()
                    self.p.save_auth(self)
                if not await self.api.is_available():
                    if self.online or self.err != 'abra o app do YouTube na TV':
                        log.info('[%s] app do YouTube não está aberto na TV', self.name)
                    self.online = False
                    self.err = 'abra o app do YouTube na TV'
                    await asyncio.sleep(5)
                    continue
                if not await self.api.connect():
                    await asyncio.sleep(2)
                    continue
                self.online = True
                self.err = None
                backoff = 2
                log.info('[%s] conectada', self.name)
                try:
                    await self.api.set_auto_play_mode(False)
                    await self.api.get_now_playing()
                except Exception:
                    pass
                self.p.on_tv_connected(self)
                while self.api.connected():
                    await self.api.subscribe()
                self.online = False
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.online = False
                self.err = 'sem conexão com o YouTube'
                log.warning('[%s] erro: %s', self.name, e)
                await asyncio.sleep(backoff)
                backoff = min(30, backoff * 2)
                continue
            await asyncio.sleep(1)

    async def close(self):
        if self.task:
            self.task.cancel()
        try:
            await self.api.disconnect()
        except Exception:
            pass
        if self.opened:
            try:
                await self.api.close()
            except Exception:
                pass

    # ---- comandos ----
    async def call(self, fn, *args):
        if not self.online:
            return False
        try:
            return await getattr(self.api, fn)(*args)
        except Exception as e:
            log.warning('[%s] comando %s falhou: %s', self.name, fn, e)
            return False

    async def raw(self, cmd, params=None):
        if not self.online:
            return False
        try:
            return await self.api._command(cmd, params)
        except Exception as e:
            log.warning('[%s] comando %s falhou: %s', self.name, cmd, e)
            return False

    async def load(self, vid, t):
        self.vid = vid
        return await self.raw('setPlaylist', {'videoId': vid, 'currentTime': round(max(0, t), 2),
                                              'currentIndex': 0, 'videoIds': vid})


class Ponte:
    def __init__(self, cfg, api_factory=YtLoungeApi):
        self.cfg = cfg
        self.api_factory = api_factory
        self.room = norm_room(cfg['sala'])
        self.base = f'{NS}/{self.room}'
        self.telas = {}
        self.st = {'seq': 0, 'vid': '', 'playing': False, 'pos': 0, 'at': ms(), 'queue': [], 'title': '', 'by': 'ponte'}
        self.mq = None
        self.lock = asyncio.Lock()
        self.busy = False
        self.last_poll = 0
        self.restored = False

    # ---------- configuração ----------
    def save(self):
        self.cfg['telas'] = [{'key': t.key, 'name': t.name, 'lead': round(t.lead, 3), 'auth': t.api.store_auth_state()}
                             for t in self.telas.values()]
        tmp = CFG_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CFG_PATH)

    def save_auth(self, tela):
        if tela.key in self.telas:
            self.save()

    def add_tela(self, key, name, auth=None, start=True):
        t = Tela(self, key, name, auth, self.api_factory)
        self.telas[key] = t
        if start:
            t.task = asyncio.create_task(t.run())
        return t

    # ---------- MQTT ----------
    async def pub(self, rel, obj, retain=False):
        if not self.mq:
            return
        try:
            await self.mq.publish(f'{self.base}/{rel}', json.dumps(obj, ensure_ascii=False), qos=0, retain=retain)
        except Exception as e:
            log.debug('publish falhou: %s', e)

    async def mqtt_loop(self):
        key = self.cfg.get('broker', 'hivemq')
        host, port = BROKERS.get(key, BROKERS['hivemq'])
        host = os.environ.get('STV_BROKER_HOST', host)
        port = int(os.environ.get('STV_BROKER_PORT', port))
        use_tls = os.environ.get('STV_BROKER_TLS', '1' if port == 8883 else '0') == '1'
        will = aiomqtt.Will(f'{self.base}/bridge/status', json.dumps({'online': False}), retain=True)
        while True:
            try:
                async with aiomqtt.Client(host, port, identifier='stv_ponte_' + uuid.uuid4().hex[:10],
                                          tls_context=ssl.create_default_context() if use_tls else None,
                                          keepalive=20, will=will) as c:
                    self.mq = c
                    for rel in ('cmd', 't/+', 'bridge/pair', 'state'):
                        await c.subscribe(f'{self.base}/{rel}')
                    await self.pub('bridge/status', {'online': True, 'v': 1, 'telas': len(self.telas)}, retain=True)
                    log.info('Conectado ao broker %s:%s — sala %s', host, port, self.room.upper())
                    async for m in c.messages:
                        rel = str(m.topic)[len(self.base) + 1:]
                        try:
                            d = json.loads(m.payload)
                        except Exception:
                            continue
                        await self.on_msg(rel, d)
            except aiomqtt.MqttError as e:
                self.mq = None
                log.warning('Broker indisponível (%s). Tentando de novo em 3 s…', e)
                await asyncio.sleep(3)

    async def on_msg(self, rel, d):
        if rel == 'cmd':
            asyncio.create_task(self.run_cmd(d))
        elif rel == 'state':
            # Recupera a fila depois de reiniciar a ponte.
            if not self.restored and d.get('by') == 'ponte' and isinstance(d.get('seq'), int):
                self.restored = True
                if self.st['seq'] == 0:
                    self.st['seq'] = d['seq']
                    self.st['queue'] = d.get('queue') or []
        elif rel == 'bridge/pair':
            asyncio.create_task(self.pair(d.get('code', ''), d.get('name', '')))
        elif rel.startswith('t/'):
            t = self.telas.get(rel[2:])
            if not t:
                return
            c = d.get('c')
            if c == 'unpair':
                await self.remove(t)
            elif c == 'rename' and d.get('name'):
                t.name = str(d['name'])[:30]
                self.save()
            elif c == 'reload':
                await t.close()
                t.opened = False
                t.api = self.api_factory(DEVICE_NAME, t, logger=logging.getLogger('pyytlounge'))
                t.api.load_auth_state(self.cfg_auth(t.key))
                t.task = asyncio.create_task(t.run())

    def cfg_auth(self, key):
        for x in self.cfg.get('telas', []):
            if x['key'] == key:
                return x['auth']
        return None

    # ---------- pareamento ----------
    async def pair(self, code, name):
        code = re.sub(r'\D', '', str(code))
        name = (str(name).strip() or f'TV {len(self.telas) + 1}')[:30]
        key = 'app-' + uuid.uuid4().hex[:8]
        t = Tela(self, key, name, None, self.api_factory)
        try:
            await t.open()
            ok = await t.api.pair(code)
            if not ok:
                raise ValueError('sem resposta')
        except Exception:
            await t.close()
            log.warning('Falha ao parear com o código %s', code)
            await self.pub('bridge/pair/ok', {'code': code, 'ok': False,
                                              'error': 'Código inválido ou expirado. Gere um novo no app do YouTube da TV.'})
            return False
        self.telas[key] = t
        t.task = asyncio.create_task(t.run())
        self.save()
        log.info('TV "%s" pareada', name)
        await self.pub('bridge/pair/ok', {'code': code, 'ok': True, 'name': name})
        return True

    async def remove(self, t):
        await t.close()
        self.telas.pop(t.key, None)
        self.save()
        await self.pub(f'p/{t.key}', {'id': t.key, 'gone': True})
        log.info('TV "%s" desvinculada', t.name)

    # ---------- estado da sala ----------
    def principal(self):
        for t in self.telas.values():
            if t.online:
                return t
        return None

    def online(self):
        return [t for t in self.telas.values() if t.online]

    async def publish_state(self):
        self.st['seq'] += 1
        ref = self.principal()
        if ref and ref.vid == self.st['vid']:
            self.st['pos'] = round(ref.est(), 2)
        self.st['at'] = ms()
        await self.pub('state', self.st, retain=True)

    def on_tv_update(self, t, prev):
        # Fim do vídeo na TV principal -> próximo da fila.
        if (t is self.principal() and self.st['playing'] and not self.busy and t.state == State.Buffering
                and prev == State.Playing and t.vid == self.st['vid']):
            asyncio.create_task(self.run_cmd({'c': 'next', 'auto': True}))

    def on_tv_connected(self, t):
        if self.st['vid'] and not self.busy:
            asyncio.create_task(self.catch_up(t))

    async def catch_up(self, t):
        await asyncio.sleep(1.5)
        ref = self.principal()
        if ref is t or not self.st['vid']:
            return
        pos = ref.est() if ref and ref.vid == self.st['vid'] else self.st['pos']
        await t.load(self.st['vid'], pos + (t.lead + 1.5 if self.st['playing'] else 0))
        t.diffs = []
        t.last_seek = now()
        if not self.st['playing']:
            await asyncio.sleep(3)
            await t.call('pause')

    # ---------- comandos do controle ----------
    async def run_cmd(self, c):
        async with self.lock:
            try:
                await self.handle(c)
            except Exception:
                log.exception('Erro ao executar %s', c)

    async def all(self, fn, *args, telas=None):
        telas = telas if telas is not None else self.online()
        return await asyncio.gather(*[t.call(fn, *args) for t in telas])

    async def handle(self, c):
        st = self.st
        q = st['queue']
        cmd = c.get('c')
        ref = self.principal()
        cur = ref.est() if ref and ref.vid == st['vid'] else st['pos']

        def item_from(x):
            return {'vid': x['vid'], 'start': x.get('start') or 0, 'title': x.get('title') or ''}

        if cmd == 'load':
            await self.start_video(item_from(c))
        elif cmd == 'enqueue':
            if len(q) < 50:
                q.append(item_from(c))
            if not st['vid']:
                await self.start_video(q.pop(0))
            else:
                await self.publish_state()
        elif cmd == 'playq':
            i = int(c.get('i', -1))
            if 0 <= i < len(q):
                await self.start_video(q.pop(i))
        elif cmd == 'removeq':
            i = int(c.get('i', -1))
            if 0 <= i < len(q):
                q.pop(i)
                await self.publish_state()
        elif cmd == 'clearq':
            q.clear()
            await self.publish_state()
        elif cmd == 'next':
            if q:
                await self.start_video(q.pop(0))
            elif c.get('auto'):
                st['playing'] = False
                await self.publish_state()
        elif cmd in ('play', 'pause', 'toggle'):
            if not st['vid']:
                return
            play = (cmd == 'play') or (cmd == 'toggle' and not st['playing'])
            if play:
                await self.all('play')
                st['playing'] = True
                for t in self.online():
                    t.diffs = []
                    t.last_seek = now() - 3
                await self.publish_state()
            else:
                await self.all('pause')
                st['playing'] = False
                await self.publish_state()
                await self.align_paused()
        elif cmd in ('seek', 'seekrel'):
            if not st['vid']:
                return
            p = float(c['pos']) if cmd == 'seek' else cur + float(c.get('d', 0))
            if ref and ref.dur:
                p = min(p, ref.dur - 1)
            p = max(0.0, p)
            await self.all('seek_to', p)
            for t in self.online():
                t.pos, t.pos_t, t.diffs, t.last_seek = p, now(), [], now()
            st['pos'] = p
            await self.publish_state()
        elif cmd == 'stop':
            await asyncio.gather(*[t.raw('stopVideo') for t in self.online()])
            st.update({'vid': '', 'playing': False, 'pos': 0, 'title': ''})
            await self.publish_state()

    async def align_paused(self):
        """Depois de pausar, coloca todas as TVs exatamente no ponto da principal."""
        await asyncio.sleep(1.2)
        await self.all('get_now_playing')
        await asyncio.sleep(0.8)
        ref = self.principal()
        if not ref:
            return
        p = ref.pos
        others = [t for t in self.online() if t is not ref and abs(t.pos - p) > 0.05]
        if others:
            await self.all('seek_to', p, telas=others)
        self.st['pos'] = p
        await self.publish_state()

    async def wait_for(self, telas, pred, timeout):
        end = now() + timeout
        last_poll = 0
        while now() < end:
            if all(pred(t) for t in telas):
                return True
            if now() - last_poll > 2:
                last_poll = now()
                await asyncio.gather(*[t.call('get_now_playing') for t in telas])
            await asyncio.sleep(0.2)
        return False

    async def start_video(self, item):
        """Carrega o vídeo em todas as TVs e dá a partida junto."""
        st = self.st
        vid, start = item['vid'], float(item.get('start') or 0)
        st.update({'vid': vid, 'title': item.get('title', ''), 'playing': True, 'pos': start})
        telas = self.online()
        if not telas:
            await self.publish_state()
            return
        self.busy = True
        try:
            log.info('Carregando %s em %d TV(s)', vid, len(telas))
            for t in telas:
                t.state = None
            await asyncio.gather(*[t.load(vid, start) for t in telas])
            await self.publish_state()
            await self.wait_for(telas, lambda t: t.vid == vid and t.state == State.Playing, 25)
            ready = [t for t in telas if t.online and t.vid == vid]
            if len(ready) > 1:
                # Partida alinhada: pausa todas, posiciona no mesmo ponto, espera o buffer e solta juntas.
                await self.all('pause', telas=ready)
                await self.wait_for(ready, lambda t: t.state == State.Paused, 4)
                p = max(t.pos for t in ready)
                await self.all('seek_to', p, telas=ready)
                await asyncio.sleep(1.5)
                await self.all('play', telas=ready)
                st['pos'] = p
            for t in ready:
                t.diffs = []
                t.last_seek = now()
                t.calib = False
            await self.publish_state()
        finally:
            self.busy = False

    # ---------- correção contínua ----------
    async def sync_loop(self):
        while True:
            await asyncio.sleep(0.5)
            try:
                await self.sync_step()
            except Exception:
                log.exception('erro na sincronização')

    async def sync_step(self):
        if self.busy or self.lock.locked() or not self.st['playing'] or not self.st['vid']:
            return
        t = now()
        telas = self.online()
        if t - self.last_poll > 3 and telas:
            self.last_poll = t
            await asyncio.gather(*[x.call('get_now_playing') for x in telas])
            return
        ref = self.principal()
        if not ref or ref.state != State.Playing or ref.vid != self.st['vid'] or not ref.fresh(t):
            return
        for f in telas:
            if f is ref:
                f.diffs = []
                continue
            if f.vid != self.st['vid']:
                if t - f.last_seek > 10:
                    f.last_seek = t
                    await f.load(self.st['vid'], ref.est() + f.lead + 1.5)
                continue
            if f.state == State.Paused and t - f.last_seek > 4:
                f.last_seek = t
                await f.call('play')
                continue
            if f.state != State.Playing or not f.fresh(t) or f.reports == f.last_report_used:
                continue
            f.last_report_used = f.reports
            if t - f.last_seek < 5:
                continue
            f.diffs.append(f.est(t) - ref.est(t))
            f.diffs = f.diffs[-3:]
            if len(f.diffs) < 2:
                continue
            m = statistics.median(f.diffs)
            if f.calib:
                f.lead = max(0.0, min(4.0, f.lead - m * 0.7))
                f.calib = False
                self.save()
            if abs(m) > 0.4 and len(f.diffs) >= 3:
                target = ref.est() + f.lead
                log.info('[%s] diferença %+.2f s → seek para %.1f s', f.name, m, target)
                await f.call('seek_to', target)
                f.pos, f.pos_t = target - f.lead, now()
                f.last_seek = now()
                f.calib = True
                f.diffs = []

    # ---------- presença ----------
    async def presence_loop(self):
        while True:
            await asyncio.sleep(1)
            ref = self.principal()
            for t in list(self.telas.values()):
                ps = 1 if t.state == State.Playing else 2 if t.state == State.Paused else 3 if t.state else -1
                drift = 0 if (t is ref or not t.diffs) else int(statistics.median(t.diffs) * 1000)
                await self.pub(f'p/{t.key}', {
                    'id': t.key, 'name': t.name, 'kind': 'app', 'leader': t is ref, 'act': t.online,
                    'ready': t.online, 'synced': True, 'err': t.err, 'drift': drift, 'rtt': 0,
                    'lead': int(t.lead * 1000), 'vid': t.vid, 'title': self.st['title'] if t.vid == self.st['vid'] else '',
                    'cur': round(t.est(), 2), 'dur': t.dur, 'ps': ps, 'rate': t.speed})
            if not self.principal() and self.telas:
                pass

    async def main(self):
        for x in self.cfg.get('telas', []):
            t = self.add_tela(x['key'], x['name'], x['auth'])
            t.lead = float(x.get('lead', t.lead))
        await asyncio.gather(self.mqtt_loop(), self.sync_loop(), self.presence_loop())


def load_cfg():
    if os.path.exists(CFG_PATH):
        with open(CFG_PATH, encoding='utf-8') as f:
            return json.load(f)
    return {'telas': []}


async def amain(args):
    cfg = load_cfg()
    if args.sala:
        cfg['sala'] = norm_room(args.sala)
    if args.broker:
        cfg['broker'] = args.broker
    if not cfg.get('sala'):
        print('Informe a sala: python ponte.py --sala ABCD-EFGH  (o código aparece no topo do controle no celular)')
        sys.exit(1)
    cfg.setdefault('broker', 'hivemq')
    ponte = Ponte(cfg)
    ponte.save()
    if args.parear:
        ok = await ponte.pair(args.parear, args.nome or '')
        print('Pareada!' if ok else 'Falhou: código inválido ou expirado.')
    log.info('Ponte Sync TV rodando — sala %s, %d TV(s) pareada(s). Ctrl+C para sair.', cfg['sala'].upper(), len(cfg.get('telas', [])))
    await ponte.main()


def cli():
    ap = argparse.ArgumentParser(description='Ponte Sync TV → app do YouTube nas TVs')
    ap.add_argument('--sala', help='código da sala mostrado no controle (ex.: ABCD-EFGH)')
    ap.add_argument('--broker', choices=list(BROKERS), help='servidor de sincronização (igual ao do controle)')
    ap.add_argument('--parear', help='código de 12 dígitos do "Vincular com código de TV"')
    ap.add_argument('--nome', help='nome da TV ao parear')
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s %(message)s', datefmt='%H:%M:%S')
    logging.getLogger('pyytlounge').setLevel(logging.WARNING)
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print('\nPonte encerrada.')


if __name__ == '__main__':
    cli()
