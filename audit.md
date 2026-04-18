# Code Audit — palestraV7.html

> File: `palestraV7.html` (~1359 lines) · Platform: iOS Safari PWA · Stack: vanilla JS, IndexedDB, zero deps

---

## 1. STARTUP PERFORMANCE

### L1321–1328 | Re-parse every session on boot | **HIGH**

On boot, every session's `raw` text is re-parsed with `parseAllLines()` even though `exercises` is already persisted in IndexedDB; this produces a large regex workload on the main thread before first paint.

**Root cause of startup lag.**

**Fix:**
```js
if (sessions) State.sessions = sessions.map(sess => ({
  ...sess,
  exercises: sess.exercises || [],
  bodyWeight: sess.bodyWeight ?? null,
  // lines: undefined — parse on demand in renderStorico
}));
```
The existing `s.lines || parseAllLines(s.raw)` fallback at L1008 already handles lazy parsing.

---

### L1305–1345 | 6 sequential `await DB.get()` calls | **HIGH**

Six sequential IDB round-trips serialize boot. Each opens its own transaction.

**Fix:** parallelize independent reads after migration:
```js
const [sessions, glossary, muscleGroups, draft] = await Promise.all([
  DB.get(CONFIG.SESSIONS), DB.get(CONFIG.GLOSSARY),
  DB.get(CONFIG.MUSCLE_GROUPS), DB.get(CONFIG.DRAFT)
]);
```

---

### L1347–1349 | `renderLogPreview()` on empty boot | **LOW**

`initLogTab()` → `renderLogPreview()` runs synchronously on empty textarea before first paint.

**Fix:** early-exit when input is empty:
```js
if (!rawText.trim()) {
  document.getElementById('invalidWarnings').style.display = 'none';
  document.getElementById('preview').innerHTML = '';
  return;
}
```

---

### L1351–1353 | Service worker registration competes with first paint | **LOW**

**Fix:** defer to idle:
```js
if ('serviceWorker' in navigator) {
  ('requestIdleCallback' in window ? requestIdleCallback : setTimeout)(
    () => navigator.serviceWorker.register('./sw.js').catch(() => {}), 1);
}
```

---

## 2. RUNTIME PERFORMANCE

### L1006 | `renderStorico` bypasses PR cache | **HIGH**

`buildRunningPRs(State.sessions)` called directly instead of `getCachedPRs()` — recomputes on every search keystroke.

**Fix:** `const prMap = getCachedPRs();`

---

### L904–909 | Preview rebuilds historicalPRs per keystroke | **MEDIUM**

For unsaved sessions, nested loops over all sessions/exercises run on every 200 ms debounce tick.

**Fix:** memoize the "latest running PRs" snapshot alongside `_prCache`:
```js
// in getCachedPRs(), also store _prCacheLatest = running snapshot after last session
historicalPRs = existingSession ? prMap.get(targetDate) || {} : _prCacheLatest;
```

---

### L1036–1037 | `renderMuscleVolume` + abbrs recomputed on every metric change | **MEDIUM**

Both `renderMuscleVolume()` and `flatMap+Set` over all sessions fire even when only the metric select changes.

**Fix:** gate muscle-volume on a data version counter; metric changes skip the section entirely and only re-run the pts/stats/chart block at L1078.

---

### L1044 | `<option>` list rebuilt on every `renderTrend` | **LOW**

Destroys focus and costs parse work on metric change.

**Fix:**
```js
const sig = allAbbrs.join('|');
if (sel.dataset.sig !== sig) {
  sel.innerHTML = allAbbrs.length
    ? allAbbrs.map(a => `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join('')
    : '<option>—</option>';
  sel.dataset.sig = sig;
}
```

---

### L1079–1094 | Two linear scans of sessions for Trend | **LOW**

`pts` and `allEx` are built with separate `.filter().map()` passes over the same data.

**Fix:** single pass:
```js
const allEx = [];
for (const s of State.sessions) {
  const ex = s.exercises.find(e => e.abbr === abbr);
  if (ex) allEx.push({ ex, date: s.date });
}
```

---

### L631–659 | 4 listeners per chart point | **LOW**

800+ listeners rebuilt on every tab switch for a 200-session history.

**Fix:** event delegation on the `<svg>` — set `hit.dataset.idx = i`, handle `mouseover`/`touchstart` on the SVG element.

---

### L1121 | Glossary rebuilds known set on every tab open | **LOW**

`flatMap` over every session each time the Legend tab opens. Acceptable in isolation; share the cached abbr list from the Trend fix.

---

## 3. LOGIC BUGS AND EDGE CASES

### L980 | Heatmap UTC vs local timezone | **HIGH**

`date.toISOString().slice(0,10)` uses UTC. In Italy (UTC+1/+2) dates after ~22:00 local shift a day — the cell for "today" doesn't match sessions saved via `todayStr()`.

**Fix:**
```js
const dateStr = date.getFullYear() + '-' +
  String(date.getMonth() + 1).padStart(2, '0') + '-' +
  String(date.getDate()).padStart(2, '0');
```

---

### L770 | `todayStr()` fragile TZ manipulation | **MEDIUM**

`setMinutes(d.getMinutes() - d.getTimezoneOffset())` then `toISOString()` happens to work for Italy but is the root of the heatmap inconsistency.

**Fix:** use the same local-components helper:
```js
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
```

---

### L950 + L342 | Draft null-write races debounced draft writer | **MEDIUM**

`handleSaveDay` writes `DB.set(CONFIG.DRAFT, null)` but doesn't clear `_draftTimer`. If the user types and saves within 2 s, the debounced `persistCurrentDraft` fires after and restores a stale draft.

**Fix:** add at the top of `handleSaveDay`:
```js
clearTimeout(_previewTimer);
clearTimeout(_draftTimer);
```

---

### L676 / L689 | Import writes file back to itself | **MEDIUM**

After import, `updateSessions(parsed.sessions)` triggers `handleSaveToFs()` because `fileHandle` was just set — writing the file we just read back to disk.

**Fix:** add a `skipFs` option:
```js
function updateSessions(newSessions, { skipFs = false } = {}) {
  State.sessions = newSessions; _prCacheVer++;
  persistData();
  if (!skipFs && State.fileHandle) handleSaveToFs();
  renderFileStatus();
}
// call as updateSessions(parsed.sessions, { skipFs: true }) after import
```

---

### L747 | Concurrent FS writes on fast saves | **MEDIUM**

`persistData()` and `handleSaveToFs()` called without awaiting — two rapid saves can overlap `createWritable()` and throw `InvalidStateError`.

**Fix:** serialize with a promise queue:
```js
let _fsQueue = Promise.resolve();
function queueFsSave() {
  _fsQueue = _fsQueue.then(() => handleSaveToFs()).catch(() => {});
}
```
Use `queueFsSave()` everywhere `handleSaveToFs()` is called from `updateSessions`, `persistGlossary`, `persistMuscleGroups`.

---

### L722 | `navigator.share` may reject silently on iOS | **LOW**

After async file read the user-gesture chain can be broken; `share` throws `NotAllowedError`, caught but no fallback.

**Fix:**
```js
catch(e) {
  if (e.name === 'AbortError') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = fileName; a.click();
}
```

---

### L1001 | Date search matches noisy 2-char substrings | **LOW**

Query "10" matches years 2010/2020, day 10, month 10.

**Fix:** require ≥4 chars for date branch:
```js
const dq = q.replace(/[-\/]/g, '');
... || (dq.length >= 4 && s.date.replace(/-/g, '').includes(dq))
```

---

## 4. MEMORY AND LISTENER HYGIENE

### L1130–1142 | `change` + `blur` both bound → double DB writes | **MEDIUM**

On iOS, `blur` fires right after `change`, so every glossary edit triggers two `persistGlossary()` calls (two IDB writes + two FS writes when a file handle exists).

**Fix:** drop `blur` listeners, keep only `change`:
```js
document.querySelectorAll('.gl-input').forEach(i =>
  i.addEventListener('change', handleGlossaryInputUpdate));
document.querySelectorAll('.gl-group-input').forEach(i =>
  i.addEventListener('change', handler));
```

---

### L657 | `setTimeout` closures survive chart re-render | **LOW**

`touchend` sets a 1.5 s `setTimeout` that captures `tip`. Re-rendering the chart via `container.innerHTML=''` removes the DOM node but the timer runs regardless.

**Fix:**
```js
let _tipTimer = null;
// at top of renderSVGChart:
clearTimeout(_tipTimer);
// in touchend handler:
hit.addEventListener('touchend', () => {
  clearTimeout(_tipTimer);
  _tipTimer = setTimeout(hideTip, 1500);
});
```

---

### L962 | Post-save `setTimeout` overwrites state after tab/date change | **LOW**

2 s after save, `renderLogPreview()` fires even if the user has switched tabs or dates.

**Fix:** track and clear the timer:
```js
let _saveFlashTimer = null;
// in handleSaveDay:
_saveFlashTimer = setTimeout(...);
// in handleTabSwitch and handleLogDateChange:
clearTimeout(_saveFlashTimer);
```

---

### L1255 | Inline `onchange` replaces entire muscle section on select | **LOW**

`onchange="renderMuscleVolume()"` swaps the full `el.innerHTML` including the `<select>`, losing focus. Relies on global scope.

**Fix:** attach one delegated listener on `#muscleVolumeSection`; on range change update only the bar rows, not the header/select.

---

### L1323 | `State.sessions` retains `lines` arrays permanently | **LOW**

With 500 sessions × 10 items each, `lines` arrays live in memory for the tab's lifetime. Lazy fix (paired with startup fix #1): never populate `lines` at load time; derive transiently inside `renderStorico`.

---

## 5. RANKED IMPROVEMENT TABLE

| Rank | Impact | Line(s) | Problem summary | Fix summary |
|------|--------|---------|-----------------|-------------|
| 1 | HIGH | 1321–1328 | Re-parses every session on boot before first paint | Skip re-parse; reuse stored `exercises`, parse `lines` lazily |
| 2 | HIGH | 1305–1345 | 6 sequential `await DB.get()` serialize boot I/O | `Promise.all` the 4 independent reads |
| 3 | HIGH | 1006 | `renderStorico` bypasses PR cache on every keystroke | Use `getCachedPRs()` |
| 4 | HIGH | 980 | Heatmap UTC ISO string → wrong cells in Italy tz | Build YMD from local `get*` methods |
| 5 | MEDIUM | 904–909 | Preview rebuilds historicalPRs per keystroke | Memoize "latest running PRs" in `_prCacheLatest` |
| 6 | MEDIUM | 1036–1037 | `renderMuscleVolume` + abbrs recomputed on metric change | Gate on version counter; skip on metric-only change |
| 7 | MEDIUM | 770 | `todayStr()` fragile TZ manipulation | Use local-components YMD helper |
| 8 | MEDIUM | 950 + 342 | Draft null-write races pending 2 s debounced write | `clearTimeout(_draftTimer)` in `handleSaveDay` |
| 9 | MEDIUM | 676 / 689 | Import writes file back to itself via `handleSaveToFs` | `{ skipFs: true }` option on `updateSessions` |
| 10 | MEDIUM | 747 | Concurrent FS writes can overlap `createWritable()` | Serialize with a promise queue |
| 11 | MEDIUM | 1130–1142 | `change`+`blur` → double IDB+FS writes per edit | Drop `blur` listeners |
| 12 | LOW | 1044 | `<option>` list rebuilt on every metric change | Skip rebuild when signature unchanged |
| 13 | LOW | 1079–1094 | Two linear scans for Trend pts vs allEx | Single pass combining both |
| 14 | LOW | 631–659 | 4 listeners per chart point (800+ on large histories) | Event delegation on `<svg>` |
| 15 | LOW | 1121 | Glossary rebuilds known set each tab open | Share cache with Trend abbrs list |
| 16 | LOW | 1347–1349 | `renderLogPreview` runs synchronously on empty boot | Early-exit when raw is empty |
| 17 | LOW | 1351–1353 | SW registration competes with first paint | Defer with `requestIdleCallback` |
| 18 | LOW | 722 | `navigator.share` rejects silently on iOS gesture loss | Fall back to blob download on error |
| 19 | LOW | 1001 | Date search matches any 2-char substring (noisy) | Require ≥4 chars for date match |
| 20 | LOW | 657 | Per-point `setTimeout` closures survive chart re-render | Single `_tipTimer`, clear on re-render |
| 21 | LOW | 962 | Post-save `setTimeout` overwrites state after nav | Track and clear in `handleTabSwitch` / `handleLogDateChange` |
| 22 | LOW | 1255 | Inline `onchange` replaces full muscle section on select | Delegate listener; update rows only |
| 23 | LOW | 1323 | `State.sessions` retains `lines` arrays permanently | Keep `lines` transient (pairs with fix #1) |
