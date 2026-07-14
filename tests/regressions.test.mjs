import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(script, 'index.html should contain an inline script');

function loadApp(overrides = {}) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    document: { addEventListener() {} },
    window: {},
    navigator: {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'index.html' });
  return context;
}

const plain = value => JSON.parse(JSON.stringify(value));
const flushTasks = () => new Promise(resolve => setImmediate(resolve));

function memoryLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    values,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function controlledTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      tasks.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    async runNext() {
      const next = tasks.entries().next();
      assert.equal(next.done, false, 'expected a scheduled timer');
      const [id, task] = next.value;
      tasks.delete(id);
      return task.fn();
    },
  };
}

test('a workout line is atomic: malformed or zero-valued segments invalidate it', () => {
  const context = loadApp();
  const invalidLines = [
    'BP 3x10@60 + BAD',
    'BP BAD + 3x10@60',
    'BP 3x10@60 +',
    'BP 3x10@60 ++ 2x5@80',
    'BP 0x10@60',
    'BP 3x0@60',
    'BP 3x10@0',
    'BP 0',
    'BP 10@0',
  ];

  for (const line of invalidLines) {
    assert.equal(context.parseWorkoutLine(line), null, `${line} must not be partially accepted`);
    assert.deepEqual(
      plain(context.parseAllLines(line)),
      [{ type: 'invalid', text: line }],
      `${line} must remain visible as an invalid line`,
    );
  }

  const valid = plain(context.parseWorkoutLine('BP 3x10@60 + 2x5@80'));
  assert.deepEqual(valid.segments, [
    { count: 3, reps: 10, weight: 60 },
    { count: 2, reps: 5, weight: 80 },
  ]);
  assert.deepEqual(
    plain(context.parseWorkoutLine('PU 3x10')).segments,
    [{ count: 3, reps: 10, weight: null }],
    'an omitted weight still represents a valid bodyweight exercise',
  );
});

test('import rejects duplicate dates before either workout block can overwrite the other', () => {
  const context = loadApp();
  const duplicateDateFile = [
    '# 2026-07-10',
    'BP 3x10@60',
    '// prima parte',
    '',
    '# 2026-07-10',
    'SQ 5x5@100',
    '// seconda parte',
    '',
  ].join('\n');

  assert.throws(
    () => context.txtToSessions(duplicateDateFile),
    /Data duplicata: 2026-07-10/,
    'ambiguous files must fail explicitly instead of silently selecting one workout',
  );
});

function trendFixture() {
  const elements = new Map();
  const makeElement = () => ({
    value: '',
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    querySelectorAll() { return []; },
  });
  for (const id of ['exSelect', 'metricSeg', 'trendEmpty', 'chartWrap', 'trendBig', 'statsGrid', 'stagnationBanner']) {
    elements.set(id, makeElement());
  }
  elements.get('exSelect').value = 'BP';
  elements.get('metricSeg').querySelectorAll = () => [makeElement(), makeElement(), makeElement()];
  const document = {
    addEventListener() {},
    getElementById(id) {
      assert.ok(elements.has(id), `unexpected trend element requested: ${id}`);
      return elements.get(id);
    },
  };
  return { document, elements };
}

test('trend metrics aggregate repeated occurrences of the same exercise in one session', () => {
  const fixture = trendFixture();
  const context = loadApp({ document: fixture.document });
  vm.runInContext(`
    State.sessions = [
      {
        date: '2026-07-10', bodyWeight: null,
        exercises: [parseWorkoutLine('BP 3x10@60'), parseWorkoutLine('BP 2x5@80')]
      },
      {
        date: '2026-07-01', bodyWeight: null,
        exercises: [parseWorkoutLine('BP 1x5@50')]
      }
    ];
    renderSVGChart = (_container, pts) => { globalThis.__capturedTrendPoints = pts; };
  `, context);

  const expected = {
    peak: [50, 80],
    volume: [250, 2600],
    e1rm: [58, 93],
  };
  for (const [metric, values] of Object.entries(expected)) {
    vm.runInContext(`State.trendMetric = ${JSON.stringify(metric)}; renderTrend({ chartOnly: true });`, context);
    const points = plain(vm.runInContext('__capturedTrendPoints', context));
    assert.deepEqual(points.map(point => point.value), values, `${metric} must include every BP row on 2026-07-10`);
  }
});

function readableIndexedDB() {
  let openCount = 0;
  const db = {
    transaction() {
      const transaction = {
        objectStore() {
          return {
            get() {
              const request = {};
              queueMicrotask(() => {
                request.result = undefined;
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
  return {
    get openCount() { return openCount; },
    open() {
      openCount += 1;
      const request = {};
      queueMicrotask(() => request.onsuccess?.({ target: { result: db } }));
      return request;
    },
  };
}

test('parallel reads share one in-flight IndexedDB open', async () => {
  const indexedDB = readableIndexedDB();
  const context = loadApp({ indexedDB });
  await vm.runInContext(`Promise.all([
    DB.get('sessions_v1'),
    DB.get('glossary_v1'),
    DB.get('musclegroups_v1'),
    DB.get('draft_v1')
  ])`, context);
  assert.equal(indexedDB.openCount, 1, 'startup must not open the same database four times');
});

function controlledWritableIndexedDB() {
  let transaction;
  let putRequest;
  const db = {
    transaction() {
      transaction = {
        error: null,
        objectStore() {
          return {
            put() {
              putRequest = {};
              return putRequest;
            },
          };
        },
      };
      return transaction;
    },
  };
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => request.onsuccess?.({ target: { result: db } }));
      return request;
    },
  };
  return {
    indexedDB,
    get transaction() { return transaction; },
    get putRequest() { return putRequest; },
  };
}

function transactionalIndexedDB(initialValues) {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const values = new Map(Object.entries(initialValues).map(([key, value]) => [key, clone(value)]));
  const transactionQueue = [];
  let activeTransaction = null;

  const activateNextTransaction = () => {
    if (activeTransaction || !transactionQueue.length) return;
    const state = transactionQueue.shift();
    activeTransaction = state;
    state.started = true;
    for (const read of state.reads) state.runRead(read);
  };

  const db = {
    close() {},
    transaction() {
      const state = {
        started: false,
        reads: [],
        pending: new Map(),
        completionScheduled: false,
      };
      const transaction = {
        error: null,
        abort() {
          if (state.aborted) return;
          state.aborted = true;
          transaction.error = new Error('transaction aborted');
          queueMicrotask(() => {
            transaction.onabort?.();
            if (activeTransaction === state) activeTransaction = null;
            activateNextTransaction();
          });
        },
        objectStore() { return store; },
      };
      state.runRead = read => queueMicrotask(() => {
        if (state.aborted) return;
        read.request.result = clone(values.get(read.key));
        read.request.onsuccess?.();
      });
      const store = {
        get(key) {
          const request = {};
          const read = { key, request };
          state.reads.push(read);
          if (state.started) state.runRead(read);
          return request;
        },
        put(value, key) {
          state.pending.set(key, clone(value));
          if (!state.completionScheduled) {
            state.completionScheduled = true;
            queueMicrotask(() => {
              if (state.aborted) return;
              for (const [pendingKey, pendingValue] of state.pending) values.set(pendingKey, pendingValue);
              transaction.oncomplete?.();
              if (activeTransaction === state) activeTransaction = null;
              activateNextTransaction();
            });
          }
          return {};
        },
      };
      transactionQueue.push(state);
      queueMicrotask(activateNextTransaction);
      return transaction;
    },
  };
  return {
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => request.onsuccess?.({ target: { result: db } }));
        return request;
      },
    },
    get(key) { return clone(values.get(key)); },
  };
}

async function protectedConcurrentMutation({ baseRaw, currentRaw, candidateRaw }) {
  const date = '2026-07-10';
  const storage = transactionalIndexedDB({
    sessions_v1: [{ date, raw: currentRaw, exercises: [], bodyWeight: null }],
    draft_v1: {},
  });
  const context = loadApp({ indexedDB: storage.indexedDB });
  const result = await vm.runInContext(`
    (() => {
      const raw = ${JSON.stringify(candidateRaw)};
      const lines = parseAllLines(raw);
      const bodyWeight = lines.find(line => line.type === 'bw')?.weight ?? null;
      return DB.mutateWorkout(
        ${JSON.stringify(date)},
        {
          date: ${JSON.stringify(date)},
          raw,
          exercises: lines.filter(line => line.type === 'exercise'),
          bodyWeight,
        },
        null,
        {
          protectConcurrent: true,
          recoveryEntry: { baseKnown: true, baseRaw: ${JSON.stringify(baseRaw)} },
        },
      );
    })()
  `, context);
  return {
    date,
    result: plain(result),
    storedSessions: storage.get('sessions_v1'),
    storedDrafts: storage.get('draft_v1'),
  };
}

test('protected workout mutation preserves a same-date session changed by another tab', async () => {
  const combinable = await protectedConcurrentMutation({
    baseRaw: 'BP 3x10@60',
    currentRaw: 'BP 3x10@60\nSQ 5x5@100',
    candidateRaw: 'BP 3x10@60\nDL 3x5@120',
  });
  const mergedSession = combinable.result.sessions.find(session => session.date === combinable.date);
  assert.equal(combinable.result.merged, true);
  assert.equal(combinable.result.conflicted, false);
  assert.match(mergedSession.raw, /SQ 5x5@100/, 'the concurrent version must not be overwritten');
  assert.match(mergedSession.raw, /DL 3x5@120/, 'the new proposal must also be retained');
  assert.equal(
    mergedSession.raw.split('\n').filter(line => line.trim() === 'BP 3x10@60').length,
    1,
    'the common base must appear only once after a three-way append merge',
  );
  assert.equal(
    mergedSession.exercises.filter(exercise => exercise.abbr === 'BP').length,
    1,
    'the common base must contribute to metrics only once',
  );
  assert.equal(combinable.result.drafts[combinable.date], undefined);
  assert.equal(combinable.storedSessions[0].raw, mergedSession.raw, 'the merged result must reach durable storage');

  const sharedSuffix = await protectedConcurrentMutation({
    baseRaw: 'BP 3x10@60',
    currentRaw: 'BP 3x10@60\nSQ 5x5@100\nDL 3x5@120',
    candidateRaw: 'BP 3x10@60\nSQ 5x5@100\nOHP 3x8@40',
  });
  const sharedSuffixSession = sharedSuffix.result.sessions.find(session => session.date === sharedSuffix.date);
  assert.equal(sharedSuffix.result.conflicted, false);
  assert.equal(
    sharedSuffixSession.raw.split('\n').filter(line => line.trim() === 'SQ 5x5@100').length,
    1,
    'the longest common prefix inside concurrent suffixes must appear only once',
  );
  assert.equal(
    sharedSuffixSession.exercises.filter(exercise => exercise.abbr === 'SQ').length,
    1,
    'the shared suffix prefix must contribute to metrics only once',
  );
  assert.match(sharedSuffixSession.raw, /DL 3x5@120/, 'the current suffix branch must survive');
  assert.match(sharedSuffixSession.raw, /OHP 3x8@40/, 'the candidate suffix branch must survive');
  assert.equal(sharedSuffix.result.drafts[sharedSuffix.date], undefined);

  const divergent = await protectedConcurrentMutation({
    baseRaw: 'BP 3x10@60',
    currentRaw: 'BP 3x10@65',
    candidateRaw: 'BP 5x5@70',
  });
  const divergentSession = divergent.result.sessions.find(session => session.date === divergent.date);
  const divergentDraft = divergent.result.drafts[divergent.date];
  assert.equal(divergent.result.merged, true);
  assert.equal(divergent.result.conflicted, true);
  assert.equal(divergentSession.raw, 'BP 3x10@65', 'a divergent valid proposal must not replace the concurrent session');
  assert.match(divergentDraft, /BP 3x10@65/, 'the concurrent valid version must remain in the conflict draft');
  assert.match(divergentDraft, /BP 5x5@70/, 'the proposed valid version must remain in the conflict draft');
  assert.equal(divergent.storedSessions[0].raw, 'BP 3x10@65');
  assert.equal(divergent.storedDrafts[divergent.date], divergentDraft);

  const conflicting = await protectedConcurrentMutation({
    baseRaw: 'BW 80',
    currentRaw: 'BW 79',
    candidateRaw: 'BW 81',
  });
  const preservedSession = conflicting.result.sessions.find(session => session.date === conflicting.date);
  const conflictDraft = conflicting.result.drafts[conflicting.date];
  assert.equal(conflicting.result.merged, true);
  assert.equal(conflicting.result.conflicted, true);
  assert.equal(preservedSession.raw, 'BW 79', 'an unmergeable proposal must not replace the concurrent session');
  assert.match(conflictDraft, /BW 79/, 'the concurrent value must be retained in the conflict draft');
  assert.match(conflictDraft, /BW 81/, 'the proposed value must be retained in the conflict draft');
  assert.equal(conflicting.storedSessions[0].raw, 'BW 79');
  assert.equal(conflicting.storedDrafts[conflicting.date], conflictDraft);
});

test('stale draft cleanup preserves a newer same-date draft', async () => {
  const date = '2026-07-10';
  const staleDraft = 'BP 3x10@60';
  const newerDraft = 'SQ 5x5@100';
  const storage = transactionalIndexedDB({
    sessions_v1: [],
    draft_v1: { [date]: newerDraft },
  });
  const context = loadApp({ indexedDB: storage.indexedDB });
  const result = plain(await vm.runInContext(`DB.mutateWorkout(
    ${JSON.stringify(date)},
    undefined,
    null,
    { expectedDraftRaw: ${JSON.stringify(staleDraft)} }
  )`, context));

  assert.equal(result.draftPreserved, true);
  assert.equal(result.drafts[date], newerDraft);
  assert.equal(storage.get('draft_v1')[date], newerDraft, 'stale cleanup must not delete a newer draft');
  assert.deepEqual(storage.get('sessions_v1'), []);
});

test('concurrent protected draft writes merge instead of overwriting one another', async () => {
  const date = '2026-07-10';
  const baseRaw = 'BP 3x10@60';
  const firstRaw = baseRaw + '\nSQ 5x5@100';
  const secondRaw = baseRaw + '\nDL 3x5@120';
  const storage = transactionalIndexedDB({
    sessions_v1: [],
    draft_v1: { [date]: baseRaw },
  });
  const context = loadApp({ indexedDB: storage.indexedDB });
  const results = plain(await vm.runInContext(`Promise.all([
    DB.mutateWorkout(
      ${JSON.stringify(date)}, undefined, ${JSON.stringify(firstRaw)},
      { protectDraft: true, recoveryEntry: { baseKnown: true, baseRaw: ${JSON.stringify(baseRaw)} } }
    ),
    DB.mutateWorkout(
      ${JSON.stringify(date)}, undefined, ${JSON.stringify(secondRaw)},
      { protectDraft: true, recoveryEntry: { baseKnown: true, baseRaw: ${JSON.stringify(baseRaw)} } }
    )
  ])`, context));

  const durableDraft = storage.get('draft_v1')[date];
  assert.match(durableDraft, /SQ 5x5@100/, 'the first concurrent draft must survive');
  assert.match(durableDraft, /DL 3x5@120/, 'the second concurrent draft must survive');
  assert.ok(results.some(result => result.draftMerged), 'one serialized transaction should detect and merge the concurrent draft');
  assert.deepEqual(storage.get('sessions_v1'), []);
});

test('a known BW conflict draft can be resolved into the chosen session', async () => {
  const date = '2026-07-10';
  const storage = transactionalIndexedDB({
    sessions_v1: [{ date, raw: 'BW 79', exercises: [], bodyWeight: 79 }],
    draft_v1: {},
  });
  const context = loadApp({ indexedDB: storage.indexedDB });
  vm.runInContext(`
    globalThis.__saveProtectedBW = (raw, baseRaw) => {
      const lines = parseAllLines(raw);
      return DB.mutateWorkout(
        ${JSON.stringify(date)},
        {
          date: ${JSON.stringify(date)},
          raw,
          exercises: lines.filter(line => line.type === 'exercise'),
          bodyWeight: lines.find(line => line.type === 'bw')?.weight ?? null,
        },
        null,
        { protectConcurrent: true, recoveryEntry: { baseKnown: true, baseRaw } },
      );
    };
  `, context);

  const conflict = plain(await vm.runInContext(`__saveProtectedBW('BW 81', 'BW 80')`, context));
  const conflictDraft = conflict.drafts[date];
  assert.equal(conflict.conflicted, true);
  assert.match(conflictDraft, /BW 79/);
  assert.match(conflictDraft, /BW 81/);

  context.__knownConflictDraft = conflictDraft;
  const resolved = plain(await vm.runInContext(`__saveProtectedBW('BW 81', __knownConflictDraft)`, context));
  const resolvedSession = resolved.sessions.find(session => session.date === date);
  assert.equal(resolved.conflicted, false);
  assert.equal(resolvedSession.raw, 'BW 81');
  assert.equal(resolvedSession.bodyWeight, 81);
  assert.equal(resolved.drafts[date], undefined, 'choosing a value from the known conflict must remove its draft');
  assert.equal(storage.get('sessions_v1')[0].raw, 'BW 81');
  assert.equal(storage.get('draft_v1')[date], undefined);
});

test('sessionBaseRaw allows resolving a replacement draft that does not contain its session', async () => {
  const date = '2026-07-10';
  const sessionRaw = 'BP 3x10@60';
  const draftRaw = 'SQ 5x';
  const candidateRaw = 'SQ 5x5@100';
  const storage = transactionalIndexedDB({
    sessions_v1: [{
      date,
      raw: sessionRaw,
      exercises: [],
      bodyWeight: null,
    }],
    draft_v1: { [date]: draftRaw },
  });
  const context = loadApp({ indexedDB: storage.indexedDB });
  const result = plain(await vm.runInContext(`
    (() => {
      const raw = ${JSON.stringify(candidateRaw)};
      const lines = parseAllLines(raw);
      return DB.mutateWorkout(
        ${JSON.stringify(date)},
        {
          date: ${JSON.stringify(date)},
          raw,
          exercises: lines.filter(line => line.type === 'exercise'),
          bodyWeight: lines.find(line => line.type === 'bw')?.weight ?? null,
        },
        null,
        {
          protectConcurrent: true,
          recoveryEntry: {
            baseKnown: true,
            baseRaw: ${JSON.stringify(draftRaw)},
            sessionBaseKnown: true,
            sessionBaseRaw: ${JSON.stringify(sessionRaw)},
          },
        },
      );
    })()
  `, context));

  const resolvedSession = result.sessions.find(session => session.date === date);
  assert.equal(result.merged, false);
  assert.equal(result.conflicted, false);
  assert.equal(resolvedSession.raw, candidateRaw);
  assert.equal(resolvedSession.exercises[0].abbr, 'SQ');
  assert.equal(result.drafts[date], undefined, 'the resolved replacement draft must be removed');
  assert.equal(storage.get('sessions_v1')[0].raw, candidateRaw);
  assert.equal(storage.get('draft_v1')[date], undefined);
});

test('IndexedDB writes resolve only when their transaction commits', async () => {
  const controlled = controlledWritableIndexedDB();
  const context = loadApp({ indexedDB: controlled.indexedDB });
  let outcome = 'pending';
  const write = vm.runInContext(`DB.set('sessions_v1', [{ date: '2026-07-10' }])`, context);
  write.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

  await flushTasks();
  assert.ok(controlled.putRequest, 'the write request should have started');
  controlled.putRequest.onsuccess?.();
  await flushTasks();
  assert.equal(outcome, 'pending', 'request success is not durable transaction success');

  controlled.transaction.oncomplete?.();
  await write;
  assert.equal(outcome, 'resolved');
});

test('IndexedDB writes reject if the transaction aborts after put succeeds', async () => {
  const controlled = controlledWritableIndexedDB();
  const context = loadApp({ indexedDB: controlled.indexedDB });
  const write = vm.runInContext(`DB.set('sessions_v1', [{ date: '2026-07-10' }])`, context);

  await flushTasks();
  controlled.putRequest.onsuccess?.();
  controlled.transaction.error = new Error('transaction aborted');
  controlled.transaction.onabort?.();

  await assert.rejects(write, /aborted/i);
});

test('startup exposes the input before storage hydration and preserves text typed meanwhile', async () => {
  const elements = {
    logDateInput: { value: '', max: '' },
    logInput: { value: '' },
  };
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  const document = {
    addEventListener() {},
    getElementById(id) {
      assert.ok(id in elements, `unexpected startup element requested: ${id}`);
      return elements[id];
    },
  };
  const context = loadApp({ document, localStorage });
  vm.runInContext(`
    renderTopbarMark = () => {};
    attachGlobalListeners = () => {};
    renderHero = () => {};
    renderHeroStats = () => {};
    renderLogPreview = () => {};
    renderNeglected = () => {};
    renderFileStatus = () => {};

    globalThis.__storageWrites = [];
    globalThis.__hydrationGate = new Promise(resolve => { globalThis.__resolveHydration = resolve; });
    DB.get = key => __hydrationGate.then(values => values[key] ?? null);
    DB.getMany = keys => __hydrationGate.then(values =>
      Object.fromEntries(keys.map(key => [key, values[key] ?? null])));
    DB.set = (key, value) => { __storageWrites.push({ [key]: value }); return Promise.resolve(); };
    DB.setMany = values => {
      __storageWrites.push(Array.isArray(values) ? Object.fromEntries(values) : values);
      return Promise.resolve();
    };
    DB.mutateWorkout = (date, session, draftRaw) => {
      __storageWrites.push({ [CONFIG.SESSIONS]: session, [CONFIG.DRAFT]: draftRaw });
      const sessions = State.sessions.filter(item => item.date !== date);
      if (session) sessions.push(session);
      sessions.sort((a, b) => b.date.localeCompare(a.date));
      return Promise.resolve({ sessions, drafts: { ...State.pendingDrafts } });
    };
  `, context);

  const init = vm.runInContext('initApp()', context);

  assert.match(elements.logDateInput.value, /^\d{4}-\d{2}-\d{2}$/, 'date input should be ready synchronously');
  assert.equal(vm.runInContext('_activeDate', context), elements.logDateInput.value);

  elements.logInput.value = 'BP 3x10@60';
  vm.runInContext(`
    _logInputDirty = true;
    if (typeof _inputRevision !== 'undefined') _inputRevision += 1;
    autosaveCommit();
  `, context);
  assert.equal(
    vm.runInContext(`__storageWrites.some(values => Object.hasOwn(values, CONFIG.SESSIONS))`, context),
    false,
    'pre-hydration autosave must not overwrite stored sessions',
  );

  vm.runInContext(`__resolveHydration({
    [CONFIG.SESSIONS]: [{
      date: '2026-07-01', raw: 'SQ 5x5@100', bodyWeight: null,
      exercises: [parseWorkoutLine('SQ 5x5@100')]
    }],
    [CONFIG.GLOSSARY]: {},
    [CONFIG.MUSCLE_GROUPS]: {},
    [CONFIG.DRAFT]: null
  })`, context);
  await init;
  await flushTasks();

  assert.equal(elements.logInput.value, 'BP 3x10@60', 'late hydration must not replace text already typed by the user');
  const history = plain(vm.runInContext('State.sessions', context));
  const historicSession = history.find(session => session.date === '2026-07-01');
  assert.ok(historicSession, 'the existing history must survive hydration');
  assert.equal(historicSession.raw, 'SQ 5x5@100');
});

async function runSameDateHydrationConflict({ storedSession = null, storedDraft = null }) {
  const date = '2026-07-10';
  const oldRaw = 'SQ 5x5@100';
  const newRaw = 'BP 3x10@60';
  const elements = {
    logDateInput: { value: date, max: '' },
    logInput: { value: '' },
  };
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  const document = {
    addEventListener() {},
    getElementById(id) {
      assert.ok(id in elements, `unexpected hydration-conflict element requested: ${id}`);
      return elements[id];
    },
  };
  const context = loadApp({ document, localStorage });
  vm.runInContext(`
    renderTopbarMark = () => {};
    attachGlobalListeners = () => {};
    renderHero = () => {};
    renderHeroStats = () => {};
    renderLogPreview = () => {};
    renderNeglected = () => {};
    renderFileStatus = () => {};
    showToast = () => {};

    globalThis.__mutations = [];
    globalThis.__hydrationGate = new Promise(resolve => { globalThis.__resolveHydration = resolve; });
    DB.getMany = () => __hydrationGate;
    DB.set = () => Promise.resolve();
    DB.setMany = () => Promise.resolve();
    DB.mutateWorkout = (date, session, draftRaw) => {
      __mutations.push({ date, session, draftRaw });
      const sessions = State.sessions.filter(item => item.date !== date);
      if (session !== undefined && session !== null) sessions.push(session);
      sessions.sort((a, b) => b.date.localeCompare(a.date));
      const drafts = { ...State.pendingDrafts };
      if (draftRaw !== undefined) {
        if (typeof draftRaw === 'string' && draftRaw.trim()) drafts[date] = draftRaw;
        else delete drafts[date];
      }
      return Promise.resolve({ sessions, drafts });
    };
  `, context);

  const init = vm.runInContext('initApp()', context);
  assert.equal(elements.logInput.value, '', 'the input must start empty for this race');
  await flushTasks();

  elements.logInput.value = newRaw;
  vm.runInContext('captureCurrentDraftSync()', context);

  const sessions = storedSession ? [{
    date,
    raw: oldRaw,
    bodyWeight: null,
    exercises: [{
      abbr: 'SQ',
      segments: [{ count: 5, reps: 5, weight: 100 }],
      peakWeight: 100,
      volume: 2500,
      estimated1RM: 117,
      isMultiWeight: false,
      pattern: null,
    }],
  }] : [];
  const drafts = storedDraft ? { [date]: oldRaw } : null;
  context.__resolveHydration({
    sessions_v1: sessions,
    glossary_v1: {},
    musclegroups_v1: {},
    draft_v1: drafts,
  });
  await init;
  await flushTasks();

  return {
    date,
    oldRaw,
    newRaw,
    inputRaw: elements.logInput.value,
    stateSessions: plain(vm.runInContext('State.sessions', context)),
    mutations: plain(vm.runInContext('__mutations', context)),
  };
}

function assertSameDateConflictPreserved(result, sourceLabel) {
  assert.match(result.inputRaw, /SQ 5x5@100/, `${sourceLabel} text must remain in the active input`);
  assert.match(result.inputRaw, /BP 3x10@60/, 'text typed during hydration must remain in the active input');

  const saved = result.stateSessions.find(session => session.date === result.date);
  assert.ok(saved, 'the reconciled day must remain present as a session');
  assert.match(saved.raw, /SQ 5x5@100/, `${sourceLabel} text must remain in the reconciled session`);
  assert.match(saved.raw, /BP 3x10@60/, 'new text must remain in the reconciled session');

  const sessionMutations = result.mutations.filter(mutation => mutation.session?.raw);
  assert.ok(sessionMutations.length > 0, 'the reconciled workout should be durably committed');
  for (const mutation of sessionMutations) {
    assert.match(mutation.session.raw, /SQ 5x5@100/, 'no mutation may replace the old workout with only the new input');
    assert.match(mutation.session.raw, /BP 3x10@60/, 'the committed mutation must include the new input too');
  }
}

test('hydration merges same-date stored session with text typed into the initially empty input', async () => {
  const result = await runSameDateHydrationConflict({ storedSession: true });
  assertSameDateConflictPreserved(result, 'stored session');
});

test('hydration merges same-date stored draft with text typed into the initially empty input', async () => {
  const result = await runSameDateHydrationConflict({ storedDraft: true });
  assertSameDateConflictPreserved(result, 'stored draft');
});

test('per-date recovery journals from separate tabs do not overwrite one another', () => {
  const localStorage = memoryLocalStorage();
  const firstTab = loadApp({ localStorage });
  const secondTab = loadApp({ localStorage });

  assert.equal(firstTab.journalDraft('2026-07-10', 'BP 3x10@60'), true);
  assert.equal(secondTab.journalDraft('2026-07-11', 'SQ 5x5@100'), true);

  assert.ok(localStorage.getItem('workout_log_recovery_v1:2026-07-10'));
  assert.ok(localStorage.getItem('workout_log_recovery_v1:2026-07-11'));
  const combined = plain(loadApp({ localStorage }).recoveryDrafts());
  assert.deepEqual(combined, {
    '2026-07-10': 'BP 3x10@60',
    '2026-07-11': 'SQ 5x5@100',
  });

  firstTab.clearRecoveryDraft('2026-07-10', 'BP 3x10@60');
  assert.equal(localStorage.getItem('workout_log_recovery_v1:2026-07-10'), null);
  assert.ok(localStorage.getItem('workout_log_recovery_v1:2026-07-11'), 'clearing one day must not clear another tab\'s day');
  assert.deepEqual(plain(loadApp({ localStorage }).recoveryDrafts()), {
    '2026-07-11': 'SQ 5x5@100',
  });
});

test('autosave retry keeps using its original date after the user opens another day', async () => {
  const dateToRetry = '2026-07-10';
  const activeDate = '2026-07-11';
  const retryRaw = 'BP 3x10@60';
  const activeRaw = 'SQ 5x5@100';
  const timers = controlledTimers();
  const localStorage = memoryLocalStorage();
  const elements = {
    logDateInput: { value: activeDate },
    logInput: { value: activeRaw },
  };
  const document = {
    addEventListener() {},
    getElementById(id) {
      assert.ok(id in elements, `unexpected inactive-retry element requested: ${id}`);
      return elements[id];
    },
  };
  const context = loadApp({
    document,
    localStorage,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(`
    renderFileStatus = () => {};
    globalThis.__retryMutations = [];
    DB.mutateWorkout = (date, session, draftRaw) => {
      __retryMutations.push({ date, session, draftRaw });
      const sessions = State.sessions.filter(item => item.date !== date);
      if (session !== undefined && session !== null) sessions.push(session);
      return Promise.resolve({ sessions, drafts: {} });
    };
    _hydrationState = 'ready';
    _activeDate = ${JSON.stringify(activeDate)};
    State.pendingDrafts[${JSON.stringify(dateToRetry)}] = ${JSON.stringify(retryRaw)};
    journalDraft(${JSON.stringify(dateToRetry)}, ${JSON.stringify(retryRaw)});
    scheduleAutosaveRetry(${JSON.stringify(dateToRetry)});
  `, context);

  assert.equal(timers.tasks.size, 1);
  await timers.runNext();
  await flushTasks();

  const mutations = plain(vm.runInContext('__retryMutations', context));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].date, dateToRetry);
  assert.equal(mutations[0].session.raw, retryRaw);
  assert.equal(mutations[0].draftRaw, null);
  assert.equal(elements.logInput.value, activeRaw, 'retrying an old date must not read or replace the active input');
  assert.equal(vm.runInContext('_activeDate', context), activeDate);
  assert.equal(vm.runInContext(`State.pendingDrafts[${JSON.stringify(dateToRetry)}]`, context), undefined);
  assert.equal(localStorage.getItem(`workout_log_recovery_v1:${dateToRetry}`), null);
  assert.equal(timers.tasks.size, 0, 'a successful inactive-date retry must not reschedule itself');
});

test('an import preserves input typed during its commit and blocks a concurrent reset', async () => {
  const activeDate = '2026-07-10';
  const concurrentRaw = 'BP 3x10@60';
  const importedDate = '2026-07-01';
  const timers = controlledTimers();
  const elements = {
    logDateInput: { value: activeDate },
    logInput: { value: '' },
    'tab-log': { setAttribute() {} },
  };
  const localStorage = memoryLocalStorage();
  const document = {
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById(id) {
      assert.ok(id in elements, `unexpected dataset-mutation element requested: ${id}`);
      return elements[id];
    },
  };
  const context = loadApp({
    document,
    localStorage,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(`
    hydrateApp = () => Promise.resolve(true);
    renderFileStatus = () => {};
    renderLogPreview = () => {};
    renderHeroStats = () => {};
    renderNeglected = () => {};
    renderAfterDatasetMutation = () => {};
    stopRestTimer = () => {};
    showToast = message => { globalThis.__datasetToasts.push(message); };
    globalThis.__datasetToasts = [];
    globalThis.__setManyCalls = [];
    globalThis.__mutationsDuringImport = [];
    globalThis.__importCommitGate = new Promise(resolve => { globalThis.__resolveImportCommit = resolve; });
    DB.setMany = values => {
      __setManyCalls.push(values);
      return __importCommitGate;
    };
    DB.mutateWorkout = (date, session, draftRaw) => {
      __mutationsDuringImport.push({ date, session, draftRaw });
      let sessions = [...State.sessions];
      if (session !== undefined) {
        sessions = sessions.filter(item => item.date !== date);
        if (session !== null) sessions.push(session);
      }
      sessions.sort((a, b) => b.date.localeCompare(a.date));
      const drafts = { ...State.pendingDrafts };
      if (draftRaw !== undefined) {
        if (typeof draftRaw === 'string' && draftRaw.trim()) drafts[date] = draftRaw;
        else delete drafts[date];
      }
      return Promise.resolve({ sessions, drafts });
    };
    _hydrationState = 'ready';
    _activeDate = ${JSON.stringify(activeDate)};
    globalThis.__importResult = importFromText(
      '# ${importedDate}\\nSQ 5x5@100\\n',
      'replacement.txt'
    );
  `, context);
  await flushTasks();

  assert.equal(vm.runInContext('_datasetBusy', context), true);
  assert.equal(vm.runInContext('__setManyCalls.length', context), 1);
  elements.logInput.value = concurrentRaw;
  vm.runInContext('captureCurrentDraftSync()', context);

  await vm.runInContext('handleNewFile()', context);
  assert.equal(vm.runInContext('__setManyCalls.length', context), 1, 'a reset must be blocked while import is committing');

  vm.runInContext('__resolveImportCommit()', context);
  assert.equal(await vm.runInContext('__importResult', context), true);
  await flushTasks();

  const sessions = plain(vm.runInContext('State.sessions', context));
  assert.match(sessions.find(session => session.date === importedDate)?.raw || '', /SQ 5x5@100/);
  assert.match(sessions.find(session => session.date === activeDate)?.raw || '', /BP 3x10@60/);
  assert.equal(elements.logInput.value, concurrentRaw);
  const concurrentMutations = plain(vm.runInContext('__mutationsDuringImport', context))
    .filter(mutation => mutation.date === activeDate && mutation.session);
  assert.ok(concurrentMutations.length > 0, 'input typed during import must be committed after reconciliation');
  assert.ok(concurrentMutations.every(mutation => mutation.session.raw === concurrentRaw));
  assert.equal(vm.runInContext('_datasetBusy', context), false);
  assert.equal(timers.tasks.size, 0, 'a successful reconciliation must not leave an autosave retry pending');
  assert.ok(
    plain(vm.runInContext('__datasetToasts', context)).includes('Operazione già in corso'),
    'the blocked reset should be visible to the user',
  );
});

test('a failed import leaves concurrent input in the per-date recovery journal', async () => {
  const activeDate = '2026-07-10';
  const existingRaw = 'DL 3x5@120';
  const concurrentRaw = 'BP 3x10@60';
  const timers = controlledTimers();
  const localStorage = memoryLocalStorage();
  const elements = {
    logDateInput: { value: activeDate },
    logInput: { value: existingRaw },
    'tab-log': { setAttribute() {} },
  };
  const document = {
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById(id) {
      assert.ok(id in elements, `unexpected failed-import element requested: ${id}`);
      return elements[id];
    },
  };
  const context = loadApp({
    document,
    localStorage,
    console: { log() {}, warn() {}, error() {} },
    confirm: () => true,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  vm.runInContext(`
    hydrateApp = () => Promise.resolve(true);
    renderFileStatus = () => {};
    showToast = message => { globalThis.__failedImportToasts.push(message); };
    globalThis.__failedImportToasts = [];
    globalThis.__rejectImportCommit = null;
    DB.setMany = () => new Promise((_, reject) => { globalThis.__rejectImportCommit = reject; });
    _hydrationState = 'ready';
    _activeDate = ${JSON.stringify(activeDate)};
    State.sessions = [{
      date: ${JSON.stringify(activeDate)},
      raw: ${JSON.stringify(existingRaw)},
      bodyWeight: null,
      exercises: [parseWorkoutLine(${JSON.stringify(existingRaw)})]
    }];
    globalThis.__failedImportResult = importFromText(
      '# 2026-07-01\\nSQ 5x5@100\\n',
      'broken-import.txt'
    );
  `, context);
  await flushTasks();
  assert.equal(vm.runInContext('_datasetBusy', context), true);

  elements.logInput.value = concurrentRaw;
  vm.runInContext('captureCurrentDraftSync()', context);
  vm.runInContext(`__rejectImportCommit(new Error('disk full'))`, context);
  assert.equal(await vm.runInContext('__failedImportResult', context), false);
  await flushTasks();

  assert.equal(vm.runInContext('_datasetBusy', context), false);
  assert.equal(elements.logInput.value, concurrentRaw);
  const sessions = plain(vm.runInContext('State.sessions', context));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].date, activeDate);
  assert.equal(sessions[0].raw, existingRaw, 'failed replacement must leave the previous dataset intact');
  assert.equal(vm.runInContext(`State.pendingDrafts[${JSON.stringify(activeDate)}]`, context), concurrentRaw);
  assert.equal(
    JSON.parse(localStorage.getItem(`workout_log_recovery_v1:${activeDate}`)).raw,
    concurrentRaw,
  );
  assert.deepEqual(plain(vm.runInContext('[..._retryTimers.keys()]', context)), [activeDate]);
  assert.equal(timers.tasks.size, 1, 'the recovered edit should be retried after the failed dataset operation');
  assert.ok(
    plain(vm.runInContext('__failedImportToasts', context)).includes('Import non salvato: dati attuali intatti'),
  );
});

test('autosave commits the session and draft removal atomically before reporting success', async () => {
  const date = '2026-07-10';
  const raw = 'BP 3x10@60';
  const elements = {
    logDateInput: { value: date, max: date },
    logInput: { value: raw },
  };
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  const document = {
    addEventListener() {},
    getElementById(id) {
      assert.ok(id in elements, `unexpected autosave element requested: ${id}`);
      return elements[id];
    },
  };
  const context = loadApp({ document, localStorage });
  vm.runInContext(`
    renderFileStatus = () => {};
    renderLogPreview = () => {};
    renderHeroStats = () => {};
    renderNeglected = () => {};
    globalThis.__workoutWrites = [];
    globalThis.__commitGate = new Promise(resolve => { globalThis.__resolveCommit = resolve; });
    DB.set = (key, value) => {
      __workoutWrites.push({ kind: 'single', values: { [key]: value } });
      return __commitGate;
    };
    DB.setMany = values => {
      __workoutWrites.push({
        kind: 'batch',
        values: Array.isArray(values) ? Object.fromEntries(values) : values
      });
      return __commitGate;
    };
    DB.mutateWorkout = (date, session, draftRaw) => {
      __workoutWrites.push({ kind: 'mutation', date, session, draftRaw });
      return __commitGate.then(() => ({ sessions: session ? [session] : [], drafts: {} }));
    };
    State.sessions = [];
    State.pendingDrafts = { [${JSON.stringify(date)}]: ${JSON.stringify(raw)} };
    _activeDate = ${JSON.stringify(date)};
    _logInputDirty = true;
    _lastSavedAt = null;
    if (typeof _hydrated !== 'undefined') _hydrated = true;
    if (typeof _hydrationState !== 'undefined') _hydrationState = 'ready';
    if (typeof captureCurrentDraftSync === 'function') captureCurrentDraftSync();
    globalThis.__autosaveResult = autosaveCommit();
  `, context);
  await flushTasks();

  const writes = plain(vm.runInContext('__workoutWrites', context));
  const workoutWrites = writes.filter(write =>
    write.kind === 'mutation' ||
    Object.hasOwn(write.values, 'sessions_v1') ||
    Object.hasOwn(write.values, 'draft_v1'));
  assert.equal(workoutWrites.length, 1, 'session and draft must not be persisted in racing transactions');
  if (workoutWrites[0].kind === 'mutation') {
    assert.equal(workoutWrites[0].date, date);
    assert.equal(workoutWrites[0].session.raw, raw);
    assert.ok(workoutWrites[0].draftRaw === null || workoutWrites[0].draftRaw === '');
  } else {
    assert.equal(workoutWrites[0].kind, 'batch');
    assert.deepEqual(
      Object.keys(workoutWrites[0].values)
        .filter(key => key === 'draft_v1' || key === 'sessions_v1')
        .sort(),
      ['draft_v1', 'sessions_v1'],
    );
  }
  assert.equal(vm.runInContext('_lastSavedAt', context), null, 'the UI must not claim success before commit');
  assert.ok(
    [...localStorage.values.values()].some(value => value.includes(raw)),
    'the synchronous emergency journal must retain the raw input while the commit is pending',
  );

  vm.runInContext('__resolveCommit()', context);
  await vm.runInContext('Promise.resolve(__autosaveResult)', context);
  await flushTasks();
  assert.ok(vm.runInContext('_lastSavedAt instanceof Date', context), 'success timestamp should be set after commit');
});
