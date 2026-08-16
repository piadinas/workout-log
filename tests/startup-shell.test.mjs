import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('the first-paint shell stays small and defers the full application', () => {
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(inlineScripts.length, 1, 'index.html should contain only the startup loader inline');
  assert.ok(Buffer.byteLength(inlineScripts[0]) < 1500, 'the inline loader must remain cheap to parse');
  assert.ok(Buffer.byteLength(html) < 70000, 'the first-paint HTML shell must not absorb app.js again');
  assert.ok(Buffer.byteLength(app) > 100000, 'the complete application should remain in app.js');
  assert.match(html, /<link rel="preload" href="app\.js" as="script">/);
  assert.match(inlineScripts[0], /requestAnimationFrame\(\(\) => setTimeout\(loadApp, 0\)\)/);
  assert.match(inlineScripts[0], /script\.onload = \(\) => window\.initApp\?\.\(\)/);
});

test('the loader yields a render opportunity before appending app.js', () => {
  const loader = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const frames = [];
  const timers = [];
  const appended = [];
  let initCalls = 0;
  const context = {
    initApp() { initCalls += 1; },
    document: {
      createElement() { return {}; },
      getElementById() { return null; },
      head: { appendChild(node) { appended.push(node); } },
    },
    requestAnimationFrame(callback) { frames.push(callback); },
    setTimeout(callback) { timers.push(callback); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(loader, context, { filename: 'index.html#startup-loader' });

  assert.equal(appended.length, 0, 'app.js must not be appended during HTML parsing');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(appended.length, 0, 'the frame callback must yield before loading app.js');
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, 'app.js');
  appended[0].onload();
  assert.equal(initCalls, 1);
});

test('the service worker precaches both halves of the application shell', () => {
  const worker = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(worker, /new URL\('app\.js', SCOPE_URL\)\.href/);
  assert.match(worker, /ledger-workout-v10-first-frame/);
});
