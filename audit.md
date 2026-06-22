# Code Audit — index.html / sw.js

> File pubblicato: `index.html` (V8 redesign) · Service worker: `sw.js` · Stato: **passaggio 5 del 2026-06-22**
>
> Passaggio 5: caccia ai bug multi-agente (7 lenti in parallelo: iOS/scroll, layout CSS, touch, logica, rendering, a11y, sicurezza) con verifica avversariale — 24 bug confermati su 25, 0 falsi positivi. Fix e verifica dal vivo nel browser. Innescato dal bug della tabbar fluttuante, sfuggito ai passaggi precedenti perché puramente di rendering iOS.
>
> Passaggio 4 (2026-06-10): 3 audit indipendenti (parser/round-trip, persistenza/race, date/rendering/PWA). I passaggi 1–3 (audit di palestraV7, 2026-05-05) sono superati.

---

## RISOLTI NEL PASSAGGIO 5

### Rendering / iOS (il sintomo che ha innescato il giro)

1. **Tabbar che "fluttua" durante lo scroll su iOS** — un elemento `position: fixed` con `backdrop-filter` ri-rasterizza il blur con un frame di ritardo durante lo scroll. Fix: `transform: translateZ(0)` + `will-change: transform` (proprio layer di compositing) + `overscroll-behavior: none` su `html`/`body` contro il rimbalzo rubber-band. Verificato: barra inchiodata a tutte le posizioni di scroll.

2. **Grafico Trend incollato al bordo inferiore sui plateau** (MEDIUM) — con valori tutti uguali `minV===maxV` mappava ogni punto sul fondo. Fix: scala dell'asse separata dai dati, con padding simmetrico che centra la linea piatta. Verificato: linea a metà altezza con banner stagnazione.

3. **Heatmap: l'etichetta del mese allargava la colonna-settimana** (LOW) — disallineava tutte le celle. Fix: `flex: 0 0 11px` sulla settimana + niente etichetta sulla colonna parziale di sinistra (evita "genfeb" sovrapposti). Verificato: 22 colonne tutte a 11px.

### Sicurezza / crash (HIGH/MEDIUM)

4. **Stored XSS via nome gruppo muscolare** (HIGH) — `renderMuscleVolume` interpolava il nome del gruppo non escapato in `innerHTML`: `### BP = <img src=x onerror=...>` eseguiva JS. Fix: `escapeHTML()` al sink. Verificato: il payload viene escapato, `onerror` non scatta.

5. **Crash del Diario per data di calendario impossibile** (MEDIUM) — importare `# 2026-13-45` salvava la sessione, poi `Intl.format(Invalid Date)` lanciava `RangeError` rompendo il render. Fix: `isRealISODate()` valida la data reale all'import (rigetta anche 2026-02-30); `fmtDate*` difensive sui dati legacy. Verificato: date impossibili rigettate, Diario non crasha.

### Interazione / logica (LOW)

6. **CTA "Salva" bloccato su "✓ Salvato"** dopo cambio tab durante il flash di 2s — `handleTabSwitch` ora richiama `renderLogPreview()` tornando su Oggi.
7. **Quick-add non fondeva con newline finale** nella textarea — ora ignora le righe vuote in coda.
8. **Enter sul campo "reps"** non aggiungeva esercizi a corpo libero (senza peso) — rimossa la condizione sul peso.
9. **Etichetta "volume oggi"** mostrata anche su date passate — ora "volume sessione" se la data ≠ oggi.
10. **Cutoff range muscolari 1m/3m errato a fine mese** (es. 31 marzo − 1 mese → 3 marzo) — clamp all'ultimo giorno valido del mese-target.
11. **Swipe cambio tab su scroll diagonale** — aggiunta guard di direzione prevalente (`|dx| > |dy|·1.5`).

### Accessibilità (MEDIUM/LOW)

12. **Zoom pinch bloccato** (`user-scalable=no`, WCAG 1.4.4) — rimosso dal meta viewport; sblocca anche il recupero dall'auto-zoom iOS sui campi.
13. **`outline:none` globale senza sostituto** — aggiunta regola `:focus-visible` (appare solo da tastiera, invisibile al tocco).
14. **Toast non annunciato** dagli screen reader — `role="status" aria-live="polite"`.
15. **`input type=date` senza nome** — `aria-label="Data allenamento"`.
16. **Scroll `smooth`** ignorava `prefers-reduced-motion` — ora calcolato.

### Layout / pulizia (LOW)

17. **Token lunghi senza spazi traboccavano** orizzontalmente (commenti con URL) — `overflow-wrap: break-word` + `min-width: 0`. Nomi gruppo lunghi: ellissi su `.muscle-name`.
18. **CSS morto del bottomsheet** (`.sheet`/`.sheet-mask`, ~29 righe mai collegate) — rimosso.

### Applicati su conferma dell'utente (toccano il look)

19. **Contrasto `--ink-3`/`--ink-4`** (WCAG 1.4.3): `--ink-3` #6c675e→#827d72 (~5:1), `--ink-4` #3b3833→#635e55 (1.69:1→~3:1). Micro-etichette ora leggibili, gerarchia preservata.
20. **Font input a 16px**: tutti i campi testuali (qa-input, freetext, search, gl-name, gl-group, gl-new-*) a 16px → niente auto-zoom iOS al focus. Aggiunto `min-width: 0` su `.gl-name`/`.gl-group` per non sfondare la griglia (nota: gruppi di 7+ caratteri tipo "schiena" vengono troncati visivamente nel pill da 84px, valore intatto).
21. **stat-grid responsive**: `.stat-cell-val` → `clamp(16px, 5vw, 22px)`, le 4 card non sforano su iPhone stretti.

22. **Etichette asse X del grafico sovrapposte a destra** ("31GIGIU"): le etichette regolari troppo vicine all'ultima (sempre disegnata) ora vengono saltate. Verificato: nessuna sovrapposizione.

### NON modificati

- **Fallback date-picker su iOS < 16** (no `showPicker`): raro e rischioso da ristrutturare. Unico finding confermato non corretto.

---

## RISOLTI NEL PASSAGGIO 4 (storico)

### Data loss (HIGH)

1. **Cambio data dal picker perdeva la bozza** — `handleLogDateChange` non stashava il testo corrente e non cancellava `_draftTimer`: il testo spariva da UI e memoria, e il timer pendente sovrascriveva/azzerava anche il draft su IDB (riprodotto: bozza persa al 100%). Fix: `stashCurrentDraft()` su ogni cambio data, con `_activeDate` per conoscere la data che si lascia.

2. **Slot DRAFT singolo su IDB** — solo una bozza alla volta sopravviveva al kill della PWA; digitare su un'altra data distruggeva l'unica copia durevole. Fix: `draft_v1` ora contiene l'intera mappa `{date: raw}` (`persistDrafts()`), con migrazione automatica dal formato legacy `{date, raw}` al boot.

3. **Nessun flush su backgrounding** — la persistenza della bozza dipendeva solo dal debounce di 2 s; bloccare il telefono subito dopo aver digitato = testo perso se iOS killava la PWA. Fix: `visibilitychange(hidden)` + `pagehide` → stash immediato.

4. **Risveglio dopo mezzanotte = allenamento salvato su ieri** — `logDateInput` veniva impostato a oggi solo al boot; una PWA tenuta viva per giorni restava sulla data vecchia (e topbar/"Da riprendere"/heatmap stantii). Fix: `handleAppResume()` su `visibilitychange(visible)`: avanza la data se l'utente era sul "vecchio oggi" (bozza conservata, con toast), aggiorna topbar, `max` del picker, neglected e viste attive.

5. **Glossario importato mai persistito** — `importFromText` salvava sessioni e muscleGroups ma NON il glossario su IDB: al riavvio i nomi importati sparivano (riprodotto), e il successivo export propagava la perdita al file. Fix: persist del glossario nell'import.

6. **Quick-add corrompeva righe esistenti** (riprodotto in 3 varianti):
   - su `LP 12+10+8 @40` l'append faceva perdere il peso globale ai primi segmenti (volume da 1520 → 640, PR/1RM falsati);
   - su `ROW 3x12 @12` il merge generava `ROW 3x12 @2x12` (riga invalida, esercizio sparito);
   - su `BP 2x10@60 // commento` la nuova serie finiva DENTRO il commento (set perso in silenzio).
   Fix: il merge ora separa il commento inline, **ri-parsa la riga con `parseWorkoutLine`** e la ricostruisce in forma canonica per-segmento. Bonus: ora merge-a anche `BP 3x10 @60` e i pesi con virgola.

7. **Riga `# data` nel testo libero spaccava la sessione al re-import** — droppata in silenzio dal parser, ma conservata nel raw: l'export la trasformava in header e lo split creava sessioni fantasma/duplicate. Fix triplo: il parser la segnala come "riga non riconosciuta" (visibile); l'export declassa le righe `#` interne a `//`; lo split import accetta anche `#2026-…` senza spazio (coerenza con la regex dell'header).

8. **Service worker: lo shell poteva essere sovrascritto da spazzatura** — il ramo navigate cachava QUALSIASI risposta come `./index.html` (404/500/captive portal/redirect): offline l'app "spariva". Fix: `put` solo se `response.ok && type === 'basic'`. Cache bumpata a `workout-v7-debug-fixes`.

### Correttezza e sicurezza dei dati (MEDIUM)

9. **CTA "Elimina allenamento" come stato di riposo** — 2 s dopo ogni salvataggio (textarea svuotata dal codice) il bottone primario diventava rosso "Elimina allenamento" (riprodotto). Fix: flag `_logInputDirty` — l'eliminazione è proposta solo se è stato l'utente a svuotare il testo; lo stato vuoto "programmatico" mostra "Salva allenamento" disabilitato.

10. **`handleEditSession` avvelenava le bozze con `''`** — il flusso "Modifica" con textarea vuota creava una bozza vuota che mascherava la sessione salvata. Fix: lo stash ignora svuotamenti non-dirty e cancella la bozza se il testo coincide con la sessione salvata.

11. **`handleOpenFile` adottava il `fileHandle` prima della validazione** — dopo un import fallito l'autosave poteva riscrivere un file estraneo (es. appunti) col contenuto dell'app. Fix: handle adottato solo a import riuscito.

12. **Import distruttivo senza conferma** — aprire un file sostituiva subito tutte le sessioni su IDB. Fix: `confirm` se esistono sessioni locali.

13. **"Nuovo file" e import lasciavano stato residuo** — glossario/gruppi/bozze del vecchio dataset sopravvivevano in memoria e su IDB (riprodotto). Fix: reset completo e persistito in entrambi i flussi (textarea inclusa).

14. **`BW 78,5 // commento` → riga invalida** — la regex BW era testata prima dello strip del commento inline: peso corporeo perso con warning. Fix: strip prima del match.

15. **Glossario accettava abbr fuori `[A-Z]{1,6}`** (es. `T2`) che si perdevano in silenzio a ogni export/import (riprodotto). Fix: validazione con toast esplicativo.

16. **Trend select rotta dopo import** — `sel.value = prev` con valore inesistente → `selectedIndex -1`, pill vuota e "Nessuna sessione" con dati presenti (riprodotto). Fix: fallback al primo esercizio disponibile.

17. **Chart bloccava lo scroll** — `touchstart` con `preventDefault` sui hit circle (r=22, coprono tutta la linea): trascinare partendo dal grafico non scrollava la pagina. Fix: rimosso, listener passive.

### Minori (LOW)

18. **e1RM ignorava le singole** (`reps < 2`): il grafico 1RM ometteva proprio i giorni di massimale. Ora `reps === 1` → e1RM = peso alzato.
19. **Gruppi muscolari case-sensitive** — "Petto" e "petto" diventavano due gruppi con colori diversi. Normalizzazione lowercase su input, import e boot.
20. **Stat grid del ramo BW ereditava 4 colonne** dallo stile inline del ramo esercizio. Reset esplicito.
21. **Esercizi senza `@peso` nel Trend**: stats "sessioni N" + empty state "Nessuna sessione" contraddittori. Messaggio dedicato "Nessun peso registrato".
22. **Render multi-peso con segmento a corpo libero**: `1×10@60 + 1×8 kg` (l'8 sembrava un peso) e badge "drop" improprio. Suffisso `kg` e pattern solo se tutti i segmenti sono pesati.
23. **Migrazione localStorage accoppiata** — un JSON corrotto bloccava anche l'altra chiave e lasciava un retry-loop. Try separati per chiave.
24. **Boot fragile** — listener attaccati solo dopo il load IDB (app inerte se IDB appeso, noto bug WebKit). Ora `attachGlobalListeners()` prima dell'`await`; `persistData` mostra un toast (one-shot) se la scrittura fallisce invece di confermare "✓ Salvato" a vuoto.
25. **`s.lines` non cachato dopo reload** — ogni `renderStorico` ri-parsava tutte le sessioni. Cache al primo parse.
26. **`URL.createObjectURL` mai revocato** nell'export. Revoke dopo 30 s.
27. **Date future selezionabili** dal picker (sessioni fantasma invisibili in heatmap, neglected con giorni negativi). `max = oggi` sul date input, aggiornato al rollover.
28. **Google Fonts esclusi dal SW** — offline senza Geist al primo lancio senza rete. Ora cache-first anche per `fonts.googleapis.com`/`fonts.gstatic.com`.

---

## ANCORA APERTI (decisioni o migliorie future, non bug attivi)

- **SW senza `skipWaiting`** (intenzionale, commentato in `sw.js`): i cambi alla logica del service worker arrivano solo quando tutti i client sono chiusi. L'HTML è network-first quindi l'app si aggiorna comunque; valutare un canale di update esplicito se si toccherà spesso `sw.js`.
- **`fileHandle`/`fileName` non persistiti tra sessioni** (desktop): dopo un reload il binding al file va ristabilito a mano. I `FileSystemHandle` sono serializzabili in IDB (con re-richiesta permessi): possibile miglioria.
- **Import = sostituzione totale** (ora con confirm). Un merge per data sarebbe più sicuro ma cambia la semantica del file.
- **`qaSets` nascosto** (`display:none` in HTML): residuo di design, il campo "set" del quick-add non è raggiungibile.
- **`updateQaHint`** mostra l'ultima sessione con quell'esercizio anche se successiva alla data in editing.
- **Heatmap**: `totalCount` calcolato in O(N·154) a ogni render; sessioni con data futura già salvate restano invisibili nella griglia.
- **IDB `open` senza timeout**: con il fix dei listener l'app resta usabile, ma i dati non caricano se WebKit appende l'apertura; un retry/timeout esplicito resta da valutare.
