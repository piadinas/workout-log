import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://example.test/workout-log/';
const INDEX = new URL('index.html', SCOPE).href;

function loadWorker({ caches, fetchImpl = async () => { throw new Error('unexpected fetch'); } }) {
  const listeners = new Map();
  const self = {
    registration: { scope: SCOPE },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {},
  };
  const context = {
    URL,
    Request,
    Response,
    Set,
    Promise,
    caches,
    fetch: fetchImpl,
    self,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });
  return listeners;
}

function fetchEvent(request) {
  const waits = [];
  let response;
  return {
    event: {
      request,
      respondWith(value) { response = Promise.resolve(value); },
      waitUntil(value) { waits.push(Promise.resolve(value)); },
    },
    waits,
    get response() { return response; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushTasks = () => new Promise(resolve => setImmediate(resolve));

test('canonical navigation returns the cached shell immediately and refreshes it in the background', async () => {
  const cachedShell = { source: 'cache' };
  const refreshedClone = { source: 'network-clone' };
  const network = deferred();
  const puts = [];
  const caches = {
    async match(request) {
      assert.equal(request, INDEX);
      return cachedShell;
    },
    async open() {
      return {
        async match(request) {
          assert.equal(request, INDEX);
          return cachedShell;
        },
        async put(request, response) { puts.push([request, response]); },
      };
    },
  };
  const listeners = loadWorker({
    caches,
    fetchImpl(request) {
      assert.equal(request.url, INDEX);
      return network.promise;
    },
  });
  const dispatched = fetchEvent({
    method: 'GET',
    url: SCOPE,
    mode: 'navigate',
    destination: 'document',
  });

  listeners.get('fetch')(dispatched.event);
  assert.ok(dispatched.response, 'the canonical document must be intercepted');
  assert.equal(dispatched.waits.length, 1, 'the network refresh must extend the fetch event lifetime');
  assert.equal(await dispatched.response, cachedShell, 'the cache must win without waiting for the network');

  const freshShell = {
    ok: true,
    type: 'basic',
    redirected: false,
    url: INDEX,
    clone() { return refreshedClone; },
  };
  network.resolve(freshShell);
  await Promise.all(dispatched.waits);
  assert.deepEqual(puts, [[INDEX, refreshedClone]], 'the background response must replace the canonical shell');
});

test('non-canonical documents bypass the app-shell handler', () => {
  let fetchCalls = 0;
  let matchCalls = 0;
  const caches = {
    async match() { matchCalls += 1; },
    async open() { throw new Error('unexpected cache open'); },
  };
  const listeners = loadWorker({
    caches,
    fetchImpl: async () => { fetchCalls += 1; },
  });
  const dispatched = fetchEvent({
    method: 'GET',
    url: new URL('palestraV7.html', SCOPE).href,
    mode: 'navigate',
    destination: 'document',
  });

  listeners.get('fetch')(dispatched.event);
  assert.equal(dispatched.response, undefined, 'legacy documents must remain under normal browser navigation');
  assert.equal(dispatched.waits.length, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(matchCalls, 0);
});

test('activation removes only this app\'s obsolete caches', async () => {
  const current = 'ledger-workout-v9-instant';
  const deleted = [];
  const caches = {
    async keys() {
      return [
        current,
        'ledger-workout-v8-slow',
        'workout-v8-daylight',
        'workout-v7-debug-fixes',
        'unrelated-photo-app-v2',
      ];
    },
    async delete(key) { deleted.push(key); return true; },
  };
  const listeners = loadWorker({ caches });
  const waits = [];

  listeners.get('activate')({ waitUntil(value) { waits.push(Promise.resolve(value)); } });
  assert.equal(waits.length, 1);
  await Promise.all(waits);

  assert.deepEqual(deleted.sort(), [
    'ledger-workout-v8-slow',
    'workout-v7-debug-fixes',
    'workout-v8-daylight',
  ].sort());
  assert.ok(!deleted.includes(current), 'the active cache must survive activation');
  assert.ok(!deleted.includes('unrelated-photo-app-v2'), 'other apps on the origin must not be touched');
});

test('a cacheable asset response does not finish until cache.put commits', async () => {
  const put = deferred();
  const clonedResponse = { source: 'clone' };
  const networkResponse = {
    ok: true,
    type: 'basic',
    clone() { return clonedResponse; },
  };
  const putCalls = [];
  const caches = {
    async match() { return undefined; },
    async open() {
      return {
        put(request, response) {
          putCalls.push([request, response]);
          return put.promise;
        },
      };
    },
  };
  const listeners = loadWorker({ caches, fetchImpl: async () => networkResponse });
  const request = {
    method: 'GET',
    url: new URL('icon.png', SCOPE).href,
    mode: 'no-cors',
    destination: 'image',
  };
  const dispatched = fetchEvent(request);

  listeners.get('fetch')(dispatched.event);
  assert.ok(dispatched.response, 'same-origin assets must be intercepted');
  let settled = false;
  dispatched.response.finally(() => { settled = true; });
  await flushTasks();

  assert.deepEqual(putCalls, [[request, clonedResponse]]);
  assert.equal(settled, false, 'respondWith must still be pending while cache.put is pending');

  put.resolve();
  assert.equal(await dispatched.response, networkResponse);
  assert.equal(settled, true);
});
