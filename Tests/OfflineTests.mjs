import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = 'https://example.test/base/jellyemu/';
const script = readFileSync(new URL('../Web/Injection/coi-serviceworker.js', import.meta.url), 'utf8');
const clientScript = readFileSync(new URL('../Web/ejs.offline.js', import.meta.url), 'utf8');

function storage() {
    const stores = new Map();
    return {
        keys: async () => [...stores.keys()],
        delete: async name => stores.delete(name),
        open: async name => {
            if (!stores.has(name)) stores.set(name, new Map());
            const files = stores.get(name);
            return {
                put: async (url, response) => files.set(String(url), response.clone()),
                match: async (request, options = {}) => {
                    const url = typeof request === 'string' ? request : request.url;
                    const key = options.ignoreSearch
                        ? [...files.keys()].find(key => key.split('?')[0] === url.split('?')[0]) : url;
                    return files.get(key)?.clone();
                },
                addAll: async urls => {
                    for (const url of urls) files.set(url, new Response('shell'));
                }
            };
        }
    };
}

function worker(caches = storage()) {
    const handlers = {};
    let fetcher = async url => new Response('downloaded:' + url);
    const context = vm.createContext({ URL, Request, Response, Headers, caches, crypto: webcrypto,
        fetch: (...args) => fetcher(...args),
        self: { location: { href: root + 'assets/coi-serviceworker.js' },
            clients: { claim: async () => {}, get: async () => ({ url: root + 'ejs/play/game?userId=user&core=genesis_plus_gx' }) },
            skipWaiting: async () => {}, addEventListener: (name, fn) => { handlers[name] = fn; } }
    });
    vm.runInContext(script, context);
    return {
        caches,
        setFetch: fn => { fetcher = fn; },
        command: async (action, value) => {
            let result;
            let pending;
            handlers.message({ source: { url: root + 'offline/' }, data: { action, value },
                ports: [{ postMessage: data => { if (!data.progress) result = data; } }],
                waitUntil: promise => { pending = promise; } });
            await pending;
            if (result.error) throw new Error(result.error);
            return result.result;
        },
        navigate: async url => {
            let pending;
            handlers.fetch({ request: { url, method: 'GET', mode: 'navigate', destination: 'document', cache: 'default' },
                clientId: '', respondWith: p => { pending = p; } });
            return pending;
        },
        fetch: async (url, options) => {
            let pending;
            handlers.fetch({ request: new Request(url, options), clientId: 'player', respondWith: p => { pending = p; } });
            return pending;
        }
    };
}

const manifest = {
    name: 'Test game', userId: 'user', core: 'genesis_plus_gx',
    pageUrl: root + 'ejs/play/game?userId=user&core=genesis_plus_gx',
    urls: [root + 'ejs/play/game?userId=user&core=genesis_plus_gx', root + 'ejs/loader.js', root + 'rom/game/game.7z']
};

test('completed downloads serve assets and HEAD requests with no network', async () => {
    const w = worker();
    await w.command('download', { manifest });
    w.setFetch(async () => { throw new Error('server is unreachable'); });
    assert.equal((await w.command('list')).length, 1);
    assert.match(await (await w.fetch(root + 'ejs/loader.js?v=4.2.3')).text(), /downloaded:/);
    const head = await w.fetch(root + 'rom/game/game.7z', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
});

test('failed replacement downloads keep the last complete version', async () => {
    const w = worker();
    await w.command('download', { manifest });
    w.setFetch(async () => new Response('storage or network failure', { status: 503 }));
    await assert.rejects(w.command('download', { manifest }), /Could not download/);
    assert.equal((await w.command('list')).length, 1);
    assert.equal((await w.caches.keys()).filter(name => name.includes('-game-')).length, 1);
});

test('downloads cannot fetch another origin or a route outside this plugin', async () => {
    for (const url of ['https://elsewhere.test/rom', 'https://example.test/private']) {
        const w = worker();
        await assert.rejects(w.command('download', { manifest: { ...manifest, urls: [...manifest.urls, url] } }),
            /must belong/);
        assert.equal((await w.command('list')).length, 0);
    }
});

test('different accounts cannot receive each others pinned assets', async () => {
    const w = worker();
    await w.command('download', { manifest: { ...manifest,
        pageUrl: manifest.pageUrl.replace('userId=user', 'userId=other'),
        urls: [manifest.pageUrl.replace('userId=user', 'userId=other'), root + 'ejs/loader.js'] } });
    w.setFetch(async () => new Response('online version'));
    assert.equal(await (await w.fetch(root + 'ejs/loader.js')).text(), 'online version');
});

function player(caches, userId = 'user', core = 'genesis_plus_gx') {
    const controls = Object.fromEntries(['je-device-save', 'je-device-load', 'je-device-state-status']
        .map(id => [id, { disabled: false, textContent: '' }]));
    let loaded;
    const cfg = { userId, itemId: 'game' };
    const win = { JellyEmuConfig: cfg, EJS_core: core,
        EJS_emulator: { gameManager: { getState: async () => new Uint8Array([1, 2, 3]), loadState: data => { loaded = data; } } },
        _jeEnsureBinary: data => new Blob([data]), _jeClosePopup: () => {} };
    const context = vm.createContext({ URL, Response, Blob, Uint8Array, caches, window: win,
        document: { currentScript: { src: root + 'assets/ejs.offline.js' }, getElementById: id => controls[id] } });
    vm.runInContext(clientScript, context);
    return { controls, get loaded() { return loaded; } };
}

test('device state survives a fresh player and is isolated by account and core', async () => {
    const caches = storage();
    const first = player(caches);
    await first.controls['je-device-save'].onclick();
    assert.equal(first.controls['je-device-state-status'].textContent, 'Saved on this device.');
    const restarted = player(caches);
    await restarted.controls['je-device-load'].onclick();
    assert.deepEqual([...restarted.loaded], [1, 2, 3]);
    for (const [user, core] of [['other', 'genesis_plus_gx'], ['user', 'picodrive']]) {
        const other = player(caches, user, core);
        await other.controls['je-device-load'].onclick();
        assert.match(other.controls['je-device-state-status'].textContent, /No state saved/);
        assert.equal(other.loaded, undefined);
    }
});

test('a fresh worker launches the cached player document without the server', async () => {
    const first = worker();
    await first.command('download', { manifest });
    const restarted = worker(first.caches);
    restarted.setFetch(async () => { throw new Error('server is unreachable'); });
    const response = await restarted.navigate(manifest.pageUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /downloaded:/);
    assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
});

test('a new download removes unfinished files left by a stopped worker', async () => {
    const w = worker();
    const abandoned = 'jellyemu-offline-v1-' + encodeURIComponent('/base/jellyemu/') + '-game-abandoned';
    const cache = await w.caches.open(abandoned);
    await cache.put(root + 'rom/game/game.7z', new Response('partial download'));
    assert.equal((await w.command('list')).length, 0);
    await w.command('download', { manifest });
    assert.equal((await w.caches.keys()).includes(abandoned), false);
    assert.equal((await w.command('list')).length, 1);
});

test('cached save responses do not replace another cloud slot', async () => {
    const w = worker();
    const firstSlot = root + 'save/game/user?slot=1';
    await w.command('download', { manifest: { ...manifest, urls: [...manifest.urls, firstSlot] } });
    w.setFetch(async () => new Response('different cloud slot'));
    assert.equal(await (await w.fetch(root + 'save/game/user?slot=2')).text(), 'different cloud slot');
});
