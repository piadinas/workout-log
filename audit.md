# Code Audit — palestraV7.html (passaggio 2)

> File: `palestraV7.html` (1364 righe) · Stato: dopo commit `8591c98`
>
> **Già risolti** rispetto al passaggio 1: boot in `Promise.all`, skip re-parse a boot, heatmap TZ, `todayStr` locale, `getCachedPRs` in Storico, FS write queue, `skipFs` su import, `clearTimeout(_draftTimer)` in saveDay, rimozione listener `blur` doppi, SW deferito a `requestIdleCallback`.
>
> Cosa segue è **nuovo** o **ancora aperto**, in ordine di priorità.

---

## 1. STARTUP PERFORMANCE

### L909–921 | `historicalPRs` ricostruito a ogni keystroke al primo accesso | **HIGH**

Quando l'utente apre l'app sul giorno di oggi (caso più comune), `existingSession` è `undefined` → il branch `else` itera tutte le sessioni × tutti gli esercizi a ogni 200ms di debounce. Il `_prCache` viene calcolato ma **non sfruttato**: si ricalcola comunque il "running max" da zero.

**Fix** — espandi `buildRunningPRs` per restituire anche lo snapshot finale:
```js
function buildRunningPRs(sessions) {
  const sorted = [...sessions].sort((a,b) => a.date.localeCompare(b.date));
  const map = new Map();
  const running = {};
  for (const s of sorted) {
    map.set(s.date, {...running});
    for (const ex of s.exercises) {
      if (ex.peakWeight && ex.peakWeight > (running[ex.abbr]||0)) running[ex.abbr] = ex.peakWeight;
    }
  }
  map.latest = running;          // <-- aggiungi
  return map;
}
```
Poi a L909–921 sostituisci tutto il blocco `if (existingSession) … else { historicalPRs={}; for … }` con:
```js
const historicalPRs = existingSession ? (prMap.get(targetDate) || {}) : prMap.latest;
```
Elimina l'O(N·M) per keystroke.

---

### L1010–1011 | `renderSummaryStats` + `renderHeatmap` rifatti a ogni keystroke di ricerca | **HIGH**

`renderStorico()` chiama entrambi all'inizio, ma **nessuno dei due dipende dal query**. Con il debounce 200ms in [palestraV7.html:1303–1306](palestraV7.html:1303), ogni lettera digitata rilancia: scan completo per somma volumi (L1200–1203) + 18×7 = 126 celle heatmap.

**Fix** — separa: la ricerca tocca solo la lista. Versione minima:
```js
function renderStorico({ skipStats = false } = {}) {
  if (!skipStats) { renderSummaryStats(); renderHeatmap(); }
  // … resto invariato
}
// nell'handler search:
_searchTimer = setTimeout(() => renderStorico({ skipStats: true }), 200);
```

---

## 2. RUNTIME PERFORMANCE

### L871 + L1296 | Quick-Add bypassa l'evento `input` → bozza non persistita | **HIGH (data-loss)**

`handleQuickAdd` fa `ta.value = lines.join('\n')` (L871). Settare `.value` programmaticamente **non emette** `input`, quindi `schedulePreviewAndDraft` (L1296) non parte: la bozza non finisce mai su IDB. Se l'utente aggiunge 5 set con i pulsanti e poi l'iPhone killa il PWA in background, perde tutto.

**Fix** — chiama esplicitamente lo schedule in fondo a `handleQuickAdd`:
```js
ta.value = lines.join('\n');
schedulePreviewAndDraft();        // <-- aggiungi
document.getElementById('qaReps').value = '';
// (rimuovi la chiamata diretta a renderLogPreview, già dentro schedule)
```

---

### L830–837 | `handleEditSession` non flusha la bozza su IDB | **HIGH (data-loss)**

Confermato dal feedback di Gemini: `State.pendingDrafts[currentDate] = currentRaw` aggiorna solo la memoria. Se l'utente è in 2026-04-18 con modifiche non salvate, clicca "Modifica" su un'altra sessione, e poi l'app va in background → la bozza muore.

**Fix** — flush sincrono prima di cambiare data:
```js
function handleEditSession(date) {
  clearTimeout(_draftTimer);
  const currentDate = document.getElementById('logDateInput').value || todayStr();
  const currentRaw = document.getElementById('logInput').value;
  State.pendingDrafts[currentDate] = currentRaw;
  if (currentRaw.trim()) DB.set(CONFIG.DRAFT, { date: currentDate, raw: currentRaw }).catch(()=>{});
  handleTabSwitch('log');
  document.getElementById('logDateInput').value = date;
  handleLogDateChange();
}
```

---

### L762–765 + L1226–1228 | `persistGlossary` / `persistMuscleGroups` non debouncing → re-serializzano l'intero file su ogni tasto | **MEDIUM**

`persistGlossary` fa `queueFsSave()` → `handleSaveToFs` → `sessionsToTxt(State.sessions, …)` su tutto lo storico. Se l'utente rinomina un'abbreviazione battendo 10 caratteri e iOS spara `change` ad ogni blur, sono N rewrite del file completo. Stesso per i muscle groups.

**Fix** — debouncer condiviso:
```js
let _glossaryDebounce = null;
function persistGlossaryDebounced() {
  clearTimeout(_glossaryDebounce);
  _glossaryDebounce = setTimeout(() => {
    DB.set(CONFIG.GLOSSARY, State.glossary).catch(()=>{});
    if (State.fileHandle) queueFsSave();
  }, 600);
}
```
Sostituisci le chiamate a `persistGlossary()` con `persistGlossaryDebounced()`. Stesso pattern per `persistMuscleGroups`.

---

### L1049 + L1050 | `renderMuscleVolume` e `allAbbrs` ricomputati a ogni cambio di metrica | **MEDIUM**

`renderTrend` viene rilanciato sia da `exSelect` che da `metricSelect` ([palestraV7.html:1307–1308](palestraV7.html:1307)). La metrica però **non cambia** né i muscle-set né l'elenco delle abbreviazioni. Inutile.

**Fix** — split:
```js
function renderTrend({ chartOnly = false } = {}) {
  if (!chartOnly) { renderMuscleVolume(); /* + rebuild di allAbbrs/<select> */ }
  // … blocco BW/pts/stats/chart che dipende da abbr/metric
}
document.getElementById('exSelect').addEventListener('change', () => renderTrend());
document.getElementById('metricSelect').addEventListener('change', () => renderTrend({ chartOnly: true }));
```

---

### L1162–1176 | `updateQaHint` ordina TUTTE le sessioni per data ad ogni keystroke di `qaAbbr` | **MEDIUM**

Sort O(N log N) ad ogni lettera digitata nel campo abbreviazione. Con sessioni già ordinate desc (lo sono — vedi L957–960), il sort è inutile.

**Fix** — `State.sessions` è già `b.date.localeCompare(a.date)`; basta `find` diretto:
```js
const prev = State.sessions.find(s => s.date !== targetDate && s.exercises.some(e => e.abbr === abbr));
```

---

### L94 (CSS) + L1036 (HTML) | Storico senza `content-visibility` → layout/paint di tutto lo scroll | **MEDIUM**

Buona segnalazione di Gemini. Safari 18+ supporta `content-visibility: auto`: rinvia layout e paint dei `.session-block` fuori viewport.

**Fix** — modifica CSS [palestraV7.html:94](palestraV7.html:94):
```css
.session-block {
  margin-bottom: 24px;
  content-visibility: auto;
  contain-intrinsic-size: auto 200px;
}
```
Zero rischio: su browser senza supporto la regola viene ignorata.

---

### L825 + L887 | `State.sessions.find(s => s.date === date)` ripetuto in tutti i render | **LOW**

Linear scan ad ogni `handleLogDateChange`, `renderLogPreview`, `renderTrend`, ecc. Costruisci una mappa indicizzata con la stessa versione del PR cache:
```js
let _sessByDate = null, _sessByDateVer = -1;
function getSessByDate() {
  if (_sessByDateVer !== _prCacheVer) {
    _sessByDate = new Map(State.sessions.map(s => [s.date, s]));
    _sessByDateVer = _prCacheVer;
  }
  return _sessByDate;
}
```
Sostituisci i `find` con `getSessByDate().get(date)`.

---

### L782–783 | `Intl.DateTimeFormat` istanziato per ogni cella heatmap / riga storico | **LOW**

`fmtDateShort` / `fmtDateChart` creano un nuovo `Intl.DateTimeFormat` interno ad ogni call (`toLocaleDateString` lo fa sotto). Su Safari mobile è ~2ms a chiamata; su 500 sessioni × 2 chart = lag visibile.

**Fix** — singleton a module scope:
```js
const _fmtShort = new Intl.DateTimeFormat('it-IT', {weekday:'short',day:'numeric',month:'short',year:'numeric'});
const _fmtChart = new Intl.DateTimeFormat('it-IT', {day:'numeric',month:'short'});
function fmtDateShort(d) { return _fmtShort.format(new Date(d+'T12:00:00')); }
function fmtDateChart(d) { return _fmtChart.format(new Date(d+'T12:00:00')); }
```

---

### L637–664 | Chart SVG: 4 listener per punto | **LOW** (ancora aperto dal passaggio 1)

Per chi ha 200+ sessioni, `renderTrend` allega ~800 listener ad ogni cambio metrica. Delega un singolo listener su `<svg>`:
```js
hit.dataset.idx = i;
// dopo il forEach:
svg.addEventListener('mouseover', e => {
  if (e.target.dataset.idx) showTipFor(+e.target.dataset.idx);
});
```

---

### L1057 | `<option>` ricostruito a ogni `renderTrend` | **LOW** (ancora aperto)

Skip se la firma non è cambiata:
```js
const sig = allAbbrs.join('|');
if (sel.dataset.sig !== sig) {
  sel.innerHTML = allAbbrs.map(a=>`<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join('');
  sel.dataset.sig = sig;
  sel.value = prev || allAbbrs[0];
}
```

---

## 3. LOGIC BUGS AND EDGE CASES

### L1014 | Search: query corte tipo "10" producono falsi positivi sulla data | **LOW**

> **Correzione passaggio precedente:** avevo scritto che `toUpperCase()` rompe il match data perché le cifre falliscono. **Falso**: `"10".toUpperCase() === "10"`, quindi il match funziona correttamente. Il bug non esiste; resta solo una piccola questione UX.

Reale problema: cercando `"10"`, `s.date.replace(/-/g,'').includes("10")` matcha qualunque data contenente "10" (es. anno 2010, giorno 10, mese 10). L'utente vede risultati apparentemente casuali. Il branch `abbr` è invece corretto (entrambi upper).

**Fix** — soglia minima sul branch data:
```js
const qUp = (document.getElementById('storicoSearch')?.value||'').trim().toUpperCase();
const qDigits = qUp.replace(/[^0-9]/g, '');
const filtered = qUp ? State.sessions.filter(s =>
  s.exercises.some(e => e.abbr.includes(qUp)) ||
  (qDigits.length >= 4 && s.date.replace(/-/g,'').includes(qDigits))
) : State.sessions;
```
Refactor cosmetico, nessun bug funzionale da correggere.

---

### L944–963 | `handleSaveDay` scrive `DB.set(CONFIG.DRAFT, null)` cancellando l'unica bozza, ma può eseguire prima il timer della bozza per *altre date* | **MEDIUM**

Lo schema `{date, raw}` consente solo una bozza alla volta. Se l'utente ha lavorato sulla data A (bozza persistita), poi va sulla data B e salva → `DB.set(CONFIG.DRAFT, null)` cancella anche la bozza di A. Al prossimo riavvio la bozza di A è persa, anche se è ancora in `State.pendingDrafts` in memoria (che non sopravvive).

**Fix non invasivo** — invece di `null`, persisti l'altra bozza pendente più recente:
```js
delete State.pendingDrafts[targetDate];
const others = Object.entries(State.pendingDrafts).filter(([,v]) => v && v.trim());
const next = others.length ? { date: others[0][0], raw: others[0][1] } : null;
DB.set(CONFIG.DRAFT, next).catch(() => {});
```
(Lo schema `{date, raw}` resta invariato — non cambia chiave né formato.)

---

### L739–746 | `handleNewFile` chiama `handleLogDateChange` due volte | **LOW**

Riga 744 esplicita; poi `refreshAllViews()` (745) → `initLogTab()` (799) → `handleLogDateChange()` di nuovo. Doppio render preview. Rimuovi la chiamata esplicita a L744.

---

### L975 | `setTimeout` post-save non cancellato su switch tab/data | **LOW** (ancora aperto)

Già segnalato. Promemoria del fix:
```js
let _saveFlashTimer = null;
// in handleSaveDay sostituisci setTimeout(...) con:
_saveFlashTimer = setTimeout(() => { … }, 2000);
// in handleTabSwitch + handleLogDateChange:
clearTimeout(_saveFlashTimer);
```

---

### L728–731 | `navigator.share` può rifiutare silenziosamente su iOS | **LOW** (ancora aperto)

Fallback al download su qualsiasi errore non-AbortError:
```js
catch(e) {
  if (e.name === 'AbortError') return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type:'text/plain'}));
  a.download = fileName; a.click();
}
```

---

## 4. MEMORY AND LISTENER HYGIENE

### L663 | `setTimeout(hideTip, 1500)` per ogni touch del chart | **LOW** (ancora aperto)

```js
let _tipTimer = null;
// in cima a renderSVGChart:
clearTimeout(_tipTimer);
// nel handler touchend:
hit.addEventListener('touchend', () => {
  clearTimeout(_tipTimer);
  _tipTimer = setTimeout(hideTip, 1500);
});
```

---

### L1266 | `<select id="muscleRangeSel" onchange="renderMuscleVolume()">` inline + sostituzione completa del DOM | **LOW** (ancora aperto)

Ad ogni cambio range si sostituisce l'intera sezione (header + select + barre): perdita focus e flash visivo. Delegare:
```js
// in attachGlobalListeners:
document.getElementById('muscleVolumeSection').addEventListener('change', e => {
  if (e.target.id === 'muscleRangeSel') renderMuscleVolume();
});
// nel template, rimuovi onchange="..."
```

---

### L330–333 + L753 | `_fsQueue` cresce indefinitamente in caso di errore silenziato | **LOW**

`_fsQueue.then(...).catch(() => {})` → la catena rimane viva. Per migliaia di salvataggi consecutivi (improbabile ma teorico) la memoria della catena non è mai liberata. Sostituisci con flag mutex:
```js
let _fsBusy = false, _fsPending = false;
async function queueFsSave() {
  if (_fsBusy) { _fsPending = true; return; }
  _fsBusy = true;
  try { await handleSaveToFs(); } catch {}
  _fsBusy = false;
  if (_fsPending) { _fsPending = false; queueFsSave(); }
}
```

---

### L1302–1306 | `_searchTimer` in chiusura di `attachGlobalListeners` non cancellato su tab-switch | **LOW**

Se l'utente digita nella ricerca Storico, poi cambia tab prima dei 200ms, `renderStorico` viene comunque chiamato sulla tab non visibile (lavoro inutile). Promuovi `_searchTimer` a module scope e cancellalo in `handleTabSwitch`.

---

## 5. TABELLA RIASSUNTIVA RANKED

| Rank | Impact | Riga(e) | Problema | Fix |
|------|--------|---------|----------|-----|
| 1 | HIGH | 871 + 1296 | Quick-Add non triggera `input` → bozza non salvata su IDB | Chiama `schedulePreviewAndDraft()` esplicitamente in fondo a `handleQuickAdd` |
| 2 | HIGH | 830–837 | `handleEditSession` non flusha la bozza → data loss su backgrounding | `DB.set(CONFIG.DRAFT, …)` sincrono prima del cambio data |
| 3 | HIGH | 909–921 | `historicalPRs` ricostruito a ogni keystroke (caso oggi) | Aggiungi `map.latest` in `buildRunningPRs`, usalo nel branch `else` |
| 4 | HIGH | 1010–1011 | Summary + Heatmap rifatti su ogni keystroke ricerca | Flag `skipStats` in `renderStorico`; passalo dal debounce della search |
| 5 | MEDIUM | 762–765 + 1226 | Ogni edit di legenda re-serializza l'intero file | Debounce 600ms su `persistGlossary` / `persistMuscleGroups` |
| 6 | MEDIUM | 1049 + 1050 | Cambio metrica rifa muscle-volume + abbrs | Split `renderTrend({chartOnly})` |
| 7 | MEDIUM | 1162–1176 | `updateQaHint` ordina N sessioni per keystroke | Le sessioni sono già ordinate; sostituisci con `find` diretto |
| 8 | MEDIUM | 94 (CSS) | Storico senza `content-visibility: auto` | Aggiungi a `.session-block` con `contain-intrinsic-size: auto 200px` |
| 9 | LOW | 1014 | Search "10" produce falsi positivi su data (non è un bug, solo UX) | Soglia `qDigits.length >= 4` sul branch data |
| 10 | MEDIUM | 944–963 | `DB.set(DRAFT, null)` cancella bozze di altre date | Persisti la prossima bozza pendente invece di `null` |
| 11 | LOW | 825 + 887 | `State.sessions.find(s.date===…)` ripetuto | Mappa `_sessByDate` indicizzata, invalidata con `_prCacheVer` |
| 12 | LOW | 782–783 | `Intl.DateTimeFormat` ricreato per ogni call | Singleton a module scope |
| 13 | LOW | 637–664 | 4 listener per punto chart | Event delegation su `<svg>` |
| 14 | LOW | 1057 | `<option>` ricostruito ad ogni `renderTrend` | Skip rebuild se firma immutata (`dataset.sig`) |
| 15 | LOW | 739–746 | `handleNewFile` chiama `handleLogDateChange` due volte | Rimuovi la chiamata esplicita a L744 |
| 16 | LOW | 975 | `setTimeout` post-save sopravvive a navigation | Track + clear in tab/date handlers |
| 17 | LOW | 728–731 | `navigator.share` rifiuta silenziosamente | Fallback a blob download su errore non-Abort |
| 18 | LOW | 663 | `setTimeout(hideTip, 1500)` per ogni touch chart | Singolo `_tipTimer` cleared on re-render |
| 19 | LOW | 1266 | `<select>` muscleRangeSel rigenerato perde focus | Event delegation su `#muscleVolumeSection` |
| 20 | LOW | 330–333 | `_fsQueue` catena di promise mai liberata | Mutex con flag `_fsBusy`/`_fsPending` |
| 21 | LOW | 1302–1306 | `_searchTimer` non cancellato su tab-switch | Promuovi a module scope, clear in `handleTabSwitch` |
