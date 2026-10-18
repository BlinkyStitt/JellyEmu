/*! Based on coi-serviceworker v0.1.7. */
(function() {
    if (typeof window !== 'undefined') {
        if ('serviceWorker' in navigator && window.isSecureContext) {
            var swUrl = (document.currentScript && document.currentScript.src)
                || (window.JellyEmu && window.JellyEmu.getUrl ? window.JellyEmu.getUrl('/jellyemu/assets/coi-serviceworker.js') : null)
                || (window.JellyEmuConfig && window.JellyEmuConfig.baseUrl ? window.JellyEmuConfig.baseUrl + '/jellyemu/assets/coi-serviceworker.js' : '/jellyemu/assets/coi-serviceworker.js');
            navigator.serviceWorker.register(swUrl, {
                    scope: new URL('../', new URL(swUrl, window.location.href)).pathname
                })
                .then(function(reg) {
                    reg.addEventListener('updatefound', function() {
                        if (!navigator.serviceWorker.controller) return;
                        var installingWorker = reg.installing;
                        if (!installingWorker) return;
                        installingWorker.addEventListener('statechange', function() {
                            if (installingWorker.state === 'activated' && !window.crossOriginIsolated) {
                                if (!sessionStorage.getItem('coi_reloaded')) {
                                    sessionStorage.setItem('coi_reloaded', 'true');
                                    window.location.reload();
                                }
                            }
                        });
                    });
                })
                .catch(function(err) {
                    console.warn('[JellyEmu COI] ServiceWorker registration failed:', err);
                });

            if (!window.crossOriginIsolated && navigator.serviceWorker.controller) {
                if (!sessionStorage.getItem('coi_reloaded')) {
                    sessionStorage.setItem('coi_reloaded', 'true');
                    window.location.reload();
                } else {
                    console.warn('[JellyEmu COI] Cross-Origin Isolation could not be established. Stopping reload loop.');
                }
            } else if (window.crossOriginIsolated) {
                sessionStorage.removeItem('coi_reloaded');
            }
        }
        return;
    }

    var root = new URL('../', self.location.href);
    var prefix = 'jellyemu-offline-v1-' + encodeURIComponent(root.pathname);
    var shellCache = prefix + '-shell';
    var gamePrefix = prefix + '-game-';
    var downloadQueue = Promise.resolve();
    var entryKey = new URL('offline/entry.json', root).href;
    var shellUrls = ['offline/', 'offline/manifest.webmanifest', 'assets/ejs.offline.js']
        .map(function (path) { return new URL(path, root).href; });

    async function entries() {
        var result = [];
        var names = await caches.keys();
        for (var name of names) {
            if (!name.startsWith(gamePrefix)) continue;
            var cache = await caches.open(name);
            var response = await cache.match(entryKey);
            if (response) result.push({ cacheName: name, game: await response.json() });
        }
        return result;
    }

    function localUrl(path) {
        var url = new URL(path, root);
        if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
            throw new Error('Download files must belong to this JellyEmu server.');
        }
        return url.href;
    }

    async function download(value, port) {
        var manifest = value.manifest;
        var pageUrl = localUrl(manifest.pageUrl);
        var urls = Array.from(new Set(manifest.urls.map(localUrl)));
        if (!urls.includes(pageUrl)) throw new Error('The download is missing its player page.');
        for (var oldName of await caches.keys()) {
            if (!oldName.startsWith(gamePrefix)) continue;
            var oldCache = await caches.open(oldName);
            if (!await oldCache.match(entryKey)) await caches.delete(oldName);
        }
        var name = gamePrefix + crypto.randomUUID();
        var cache = await caches.open(name);
        try {
            var done = 0;
            for (var url of urls) {
                var response = await fetch(url, { cache: 'reload', headers: value.headers, credentials: 'same-origin' });
                if (!response.ok || response.status === 206) throw new Error('Could not download ' + new URL(url).pathname);
                await cache.put(url, response);
                port.postMessage({ progress: { done: ++done, total: urls.length } });
            }
            var game = { name: manifest.name, pageUrl: pageUrl, userId: manifest.userId, core: manifest.core };
            await cache.put(entryKey, new Response(JSON.stringify(game), {
                headers: { 'Content-Type': 'application/json' }
            }));
            for (var entry of await entries()) {
                if (entry.cacheName !== name && entry.game.pageUrl === pageUrl) await caches.delete(entry.cacheName);
            }
            return game;
        } catch (err) {
            await caches.delete(name);
            throw err;
        }
    }

    self.addEventListener('install', function (event) {
        event.waitUntil((async function () {
            var cache = await caches.open(shellCache);
            await cache.addAll(shellUrls);
            await self.skipWaiting();
        })());
    });

    self.addEventListener('activate', function (event) {
        event.waitUntil(self.clients.claim());
    });

    self.addEventListener('message', function (event) {
        var port = event.ports[0];
        if (!port || !event.source || !event.source.url.startsWith(root.href)) return;
        event.waitUntil((async function () {
            try {
                var result;
                if (event.data.action === 'download') {
                    downloadQueue = downloadQueue.catch(function () {}).then(function () {
                        return download(event.data.value, port);
                    });
                    result = await downloadQueue;
                } else if (event.data.action === 'list') result = (await entries()).map(function (entry) { return entry.game; });
                else if (event.data.action === 'remove') {
                    for (var entry of await entries()) {
                        if (entry.game.pageUrl === event.data.value) await caches.delete(entry.cacheName);
                    }
                } else throw new Error('Unknown offline action.');
                port.postMessage({ result: result });
            } catch (err) {
                port.postMessage({ error: err.message });
            }
        })());
    });

    async function respond(event) {
        var request = event.request;
        var response;
        var shell = await caches.open(shellCache);
        response = await shell.match(request.url, { ignoreSearch: true });
        if (!response) {
            var client = event.clientId ? await self.clients.get(event.clientId) : null;
            var pageUrl = request.mode === 'navigate' ? request.url : client && client.url;
            var entry = (await entries()).find(function (item) { return item.game.pageUrl === pageUrl; });
            if (entry) {
                var cache = await caches.open(entry.cacheName);
                var path = new URL(request.url).pathname;
                var staticAsset = path.startsWith(new URL('assets/', root).pathname) ||
                    path.startsWith(new URL('ejs/', root).pathname);
                response = await cache.match(request.url, { ignoreSearch: staticAsset });
            }
        }
        if (!response) response = await fetch(request);
        if (request.method === 'HEAD') response = new Response(null, { status: response.status, headers: response.headers });
        if (response.status && (request.mode === 'navigate' ||
            ['document', 'worker', 'sharedworker', 'script'].includes(request.destination))) {
            var headers = new Headers(response.headers);
            headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
            response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: headers });
        }
        return response;
    }

    self.addEventListener('fetch', function (event) {
        var request = event.request;
        if (request.method !== 'GET' && request.method !== 'HEAD') return;
        if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
        event.respondWith(respond(event));
    });
})();
