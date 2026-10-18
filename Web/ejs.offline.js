(function () {
    'use strict';

    var scriptUrl = new URL(document.currentScript.src);
    var root = new URL('../', scriptUrl);
    var cfg = window.JellyEmuConfig || {};
    var stateCache = 'jellyemu-device-states-v1-' + encodeURIComponent(root.pathname);
    var stateKey = new URL('offline/state/' + [cfg.userId || 'guest', cfg.itemId, window.EJS_core]
        .map(encodeURIComponent).join('/'), root).href;

    function status(id, message) {
        var el = document.getElementById(id);
        if (el) el.textContent = message;
    }

    async function workerRequest(action, value, onProgress) {
        if (!window.isSecureContext || !navigator.serviceWorker || !window.caches) {
            throw new Error('Offline play needs HTTPS or localhost and website storage.');
        }
        var registration = await navigator.serviceWorker.ready;
        return new Promise(function (resolve, reject) {
            var channel = new MessageChannel();
            channel.port1.onmessage = function (event) {
                var data = event.data;
                if (data.progress) {
                    if (onProgress) onProgress(data.progress);
                    return;
                }
                channel.port1.close();
                if (data.error) reject(new Error(data.error));
                else resolve(data.result);
            };
            registration.active.postMessage({ action: action, value: value }, [channel.port2]);
        });
    }

    async function renderLibrary() {
        var list = document.getElementById('je-offline-games');
        if (!list) return;
        try {
            var games = await workerRequest('list');
            list.replaceChildren();
            status('je-offline-status', games.length ? '' : 'No games downloaded on this device.');
            games.forEach(function (game) {
                var row = document.createElement('li');
                var link = document.createElement('a');
                link.href = game.pageUrl;
                link.textContent = game.name;
                var remove = document.createElement('button');
                remove.textContent = 'Remove download';
                remove.onclick = async function () {
                    remove.disabled = true;
                    try {
                        await workerRequest('remove', game.pageUrl);
                        await renderLibrary();
                        status('je-offline-status', 'Download removed. Device save state kept.');
                    } catch (err) {
                        status('je-offline-status', err.message);
                        remove.disabled = false;
                    }
                };
                row.append(link, document.createElement('br'), remove);
                list.append(row);
            });
        } catch (err) {
            status('je-offline-status', err.message);
        }
    }

    var download = document.getElementById('je-offline-download');
    if (download) {
        download.onclick = async function () {
            download.disabled = true;
            try {
                status('je-offline-status', 'Preparing download. Keep this app open.');
                if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
                var url = new URL('offline/' + cfg.itemId + '/manifest', root);
                url.searchParams.set('userId', cfg.userId || '');
                url.searchParams.set('core', window.EJS_core);
                var headers = cfg.token ? { Authorization: 'MediaBrowser Token="' + cfg.token + '"' } : {};
                var response = await fetch(url, { headers: headers });
                if (!response.ok) throw new Error(await response.text());
                await workerRequest('download', { manifest: await response.json(), headers: headers }, function (p) {
                    status('je-offline-status', 'Downloading ' + p.done + ' of ' + p.total + ' files. Keep this app open.');
                });
                status('je-offline-status', 'Available offline. Open it from Offline Games.');
            } catch (err) {
                status('je-offline-status', 'Download failed: ' + err.message);
            } finally {
                download.disabled = false;
            }
        };
    }

    var save = document.getElementById('je-device-save');
    var load = document.getElementById('je-device-load');
    if (save && load) {
        save.onclick = async function () {
            save.disabled = true;
            try {
                var manager = window.EJS_emulator && window.EJS_emulator.gameManager;
                if (!manager) throw new Error('Start the game first.');
                var data = window._jeEnsureBinary(await manager.getState());
                if (!data || !data.size) throw new Error('The emulator returned an empty state.');
                var cache = await caches.open(stateCache);
                await cache.put(stateKey, new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }));
                status('je-device-state-status', 'Saved on this device.');
            } catch (err) {
                status('je-device-state-status', 'Save failed: ' + err.message);
            } finally {
                save.disabled = false;
            }
        };
        load.onclick = async function () {
            load.disabled = true;
            try {
                var manager = window.EJS_emulator && window.EJS_emulator.gameManager;
                if (!manager) throw new Error('Start the game first.');
                var cache = await caches.open(stateCache);
                var response = await cache.match(stateKey);
                if (!response) throw new Error('No state saved on this device for this game and core.');
                await manager.loadState(new Uint8Array(await response.arrayBuffer()));
                status('je-device-state-status', 'Loaded from this device.');
                window._jeClosePopup('je-pop-saves');
            } catch (err) {
                status('je-device-state-status', 'Load failed: ' + err.message);
            } finally {
                load.disabled = false;
            }
        };
    }
    renderLibrary();
})();
