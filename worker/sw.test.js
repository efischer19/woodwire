import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, test, vi } from 'vitest';

function createCacheStorage(initialEntries = {}) {
  const entries = new Map(Object.entries(initialEntries));
  const cache = {
    addAll: vi.fn(async () => {}),
    put: vi.fn(async (request, response) => {
      entries.set(typeof request === 'string' ? request : request.url, response);
    }),
  };

  return {
    cache,
    caches: {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      match: vi.fn(async (request) => {
        const key = typeof request === 'string' ? request : request.url;
        return entries.get(key);
      }),
      open: vi.fn(async () => cache),
    },
  };
}

function loadServiceWorker({ caches, fetch }) {
  const sourcePath = path.resolve(import.meta.dirname, '../src/sw.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const listeners = new Map();
  const self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    clients: { claim() {} },
    location: { origin: 'https://pwa.example.com' },
    skipWaiting() {},
  };

  vm.runInNewContext(source, { URL, caches, fetch, self }, { filename: sourcePath });

  return {
    dispatchFetch(request) {
      let responsePromise;
      listeners.get('fetch')({
        request,
        respondWith(promise) {
          responsePromise = promise;
        },
      });
      return responsePromise;
    },
  };
}

function createNavigationRequest(url = 'https://pwa.example.com/') {
  return { method: 'GET', mode: 'navigate', url };
}

describe('service worker navigation handling', () => {
  test('sends navigations to the network so Cloudflare Access can renew the session', async () => {
    const accessRedirect = { clone: vi.fn(), ok: false, status: 0, type: 'opaqueredirect' };
    const fetch = vi.fn().mockResolvedValue(accessRedirect);
    const cachedShell = { ok: true, type: 'basic' };
    const { cache, caches } = createCacheStorage({ 'https://pwa.example.com/': cachedShell });
    const serviceWorker = loadServiceWorker({ caches, fetch });

    const response = await serviceWorker.dispatchFetch(createNavigationRequest());

    expect(response).toBe(accessRedirect);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test('falls back to the cached app shell when a navigation fails offline', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const cachedShell = { ok: true, type: 'basic' };
    const { caches } = createCacheStorage({ './index.html': cachedShell });
    const serviceWorker = loadServiceWorker({ caches, fetch });

    const response = await serviceWorker.dispatchFetch(
      createNavigationRequest('https://pwa.example.com/?conversation=1'),
    );

    expect(response).toBe(cachedShell);
  });

  test('keeps serving static assets from the cache first', async () => {
    const fetch = vi.fn();
    const cachedScript = { ok: true, type: 'basic' };
    const scriptUrl = 'https://pwa.example.com/scripts/app.js';
    const { caches } = createCacheStorage({ [scriptUrl]: cachedScript });
    const serviceWorker = loadServiceWorker({ caches, fetch });

    const response = await serviceWorker.dispatchFetch({
      method: 'GET',
      mode: 'no-cors',
      url: scriptUrl,
    });

    expect(response).toBe(cachedScript);
    expect(fetch).not.toHaveBeenCalled();
  });
});
