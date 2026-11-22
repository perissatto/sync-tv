// Service worker mínimo: permite instalar o controle como app (e receber links
// pelo "Compartilhar" do Android). Não faz cache — sempre busca a versão nova.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () {});
