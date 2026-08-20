// Test JSC (osascript -l JavaScript) per index.html — parser marcatori, SFA, mappe muscolari
ObjC.import('Foundation');

function readFile(p) {
  return $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null).js;
}

const html = readFile('/Users/nicolafalcioni/Desktop/palestra/index.html');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('inline script non trovato');
const src = m[1];

const documentStub = { addEventListener() {} };
const exportNames = ['parseWorkoutLine','parseAllLines','SFA','parseMuscleMap','muscleMapToStr','muscleMapLabel',
  'normalizeMuscleGroups','sessionsToTxt','txtToSessions','suggerisciPerNome','patternForWork','MUSCOLI','CONFIG',
  'GRUPPI_SFA','gruppoDiMuscolo','gruppoInfo','fmtPeso'];
const factory = new Function('document','window','navigator',
  src + '\nreturn {' + exportNames.join(',') + '};');
const app = factory(documentStub, {}, {});

let passed = 0; const failures = [];
function check(name, cond, extra) {
  if (cond) passed++;
  else failures.push(name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const approx = (a, b, tol) => Math.abs(a - b) <= (tol ?? 1e-9);

/* ── A. Parser: marcatori ! !! w ─────────────────────────────────── */
let ex = app.parseWorkoutLine('BP 3x10 @60!');
check('global bang on last seg', ex && ex.segments.length === 1 && ex.segments[0].bang === '!' && ex.segments[0].weight === 60 && ex.hasBang === true, ex);

ex = app.parseWorkoutLine('BP 3x10@60!!');
check('double bang', ex && ex.segments[0].bang === '!!', ex);

ex = app.parseWorkoutLine('BP 2x10@60 + 1x8@60!');
check('bang only on marked seg', ex && ex.segments[0].bang === null && ex.segments[1].bang === '!', ex);

ex = app.parseWorkoutLine('BP 12@30w + 3x10@60');
check('warm marker', ex && ex.segments[0].warm === true && ex.segments[1].warm === false, ex);

ex = app.parseWorkoutLine('BP 10 @60!');
check('single-count global weight + bang', ex && ex.segments[0].count === 1 && ex.segments[0].reps === 10 && ex.segments[0].weight === 60 && ex.segments[0].bang === '!', ex);

ex = app.parseWorkoutLine('BP 3x10@60! + 2x8@50');
check('bang mid-line, no global steal', ex && ex.segments[0].bang === '!' && ex.segments[1].bang === null && ex.segments[1].weight === 50, ex);

check('peak/volume unaffected by markers',
  (() => { const e = app.parseWorkoutLine('BP 12@30w + 3x10@60!'); return e.peakWeight === 60 && e.volume === 12*30 + 3*10*60; })());

check('e1rm single rep preserved (V9)', app.parseWorkoutLine('BP 1@100').estimated1RM === 100);

/* atomicità preservata (dalla suite di regressione) */
const invalids = ['BP 3x10@60 + BAD','BP BAD + 3x10@60','BP 3x10@60 +','BP 3x10@60 ++ 2x5@80',
  'BP 0x10@60','BP 3x0@60','BP 3x10@0','BP 0','BP 10@0','BP 3x10@60!!!','BP 3x10@60 !!!'];
for (const line of invalids) {
  check('invalid stays invalid: ' + line, app.parseWorkoutLine(line) === null, app.parseWorkoutLine(line));
  check('parseAllLines flags invalid: ' + line,
    eq(JSON.parse(JSON.stringify(app.parseAllLines(line))), [{ type: 'invalid', text: line }]));
}
check('# resta invalid', app.parseAllLines('# 2025-01-01')[0].type === 'invalid');
check('BW ok', eq(JSON.parse(JSON.stringify(app.parseAllLines('BW 78,5'))), [{ type: 'bw', weight: 78.5 }]));

/* ── B. classify / patternForWork ────────────────────────────────── */
let cls = app.SFA.classify(app.parseWorkoutLine('LP 12@25 + 12@35 + 3x8@45').segments);
check('rampa auto-warm', eq(cls.map(s => s.kind), ['warm','warm','work']), cls.map(s => s.kind));
check('rampa: nessun pattern', app.patternForWork(cls) === null, app.patternForWork(cls));

cls = app.SFA.classify(app.parseWorkoutLine('BP 1x10@60 + 1x8@50 + 1x6@40').segments);
check('drop set tails', eq(cls.map(s => s.kind), ['work','drop','drop']), cls.map(s => s.kind));
check('drop pattern', app.patternForWork(cls) === 'drop');

cls = app.SFA.classify(app.parseWorkoutLine('SQ 3x5@100 + 3x8@80').segments);
check('backoff (multi-set) non è drop', eq(cls.map(s => s.kind), ['work','backoff']), cls.map(s => s.kind));

cls = app.SFA.classify(app.parseWorkoutLine('BP 12@30w + 3x10@60').segments);
check('warm esplicito', cls[0].kind === 'warm' && cls[0].D === 0);

/* ── C. forExercise: sforzo e ancoraggio ─────────────────────────── */
let r = app.SFA.forExercise(app.parseWorkoutLine('BP 3x10@60!!'), { BP: { petto: 1 } });
check('!! tutti ancorati', r.nSets === 3 && r.nAnchored === 3 && approx(r.perMuscle.petto[1], 3), r);

r = app.SFA.forExercise(app.parseWorkoutLine('BP 10@60 + 9@60 + 8@60!'), { BP: { petto: 1 } });
check('RIR dedotto dal calo reps → tutti E=1', approx(r.perMuscle.petto[1], 3) && r.nAnchored === 3, r.perMuscle.petto);

r = app.SFA.forExercise(app.parseWorkoutLine('BP 3x10@60'), { BP: { petto: 1, tricipiti: 0.5 } });
check('prior neutro senza marcature', approx(r.perMuscle.petto[1], 3 * 0.85) && approx(r.perMuscle.tricipiti[1], 3 * 0.85 * 0.5) && r.nAnchored === 0, r.perMuscle);

r = app.SFA.forExercise(app.parseWorkoutLine('BP 12@30w + 3x10@60'), { BP: { petto: 1 } });
check('warm-up non conta', r.nSets === 3, r.nSets);

r = app.SFA.forExercise(app.parseWorkoutLine('BP 1x10@60 + 1x8@50 + 1x6@40'), { BP: { petto: 1 } });
check('code di drop valgono ½', approx(r.nSets, 2), r.nSets);

r = app.SFA.forExercise(app.parseWorkoutLine('XX 3x10@60'), {});
check('senza mappa: set contati, nessun muscolo', r.mapped === false && r.nSets === 3 && eq(r.perMuscle, {}));

/* ── C2. Gruppi di lettura: tetto a 1 per set fisico ─────────────── */
check('membro→gruppo', app.gruppoDiMuscolo('delt-post') === 'spalle' && app.gruppoDiMuscolo('femorali') === 'posteriore'
  && app.gruppoDiMuscolo('trapezi') === 'schiena' && app.gruppoDiMuscolo('petto') === 'petto');
check('gruppoInfo legacy singleton', app.gruppoInfo('x:gambe').label === 'gambe' && eq(app.gruppoInfo('x:gambe').obiettivo, [8,12]));
check('obiettivi per gruppo', eq(app.gruppoInfo('spalle').obiettivo, [8,12]) && eq(app.gruppoInfo('schiena').obiettivo, [10,14])
  && eq(app.gruppoInfo('bicipiti').obiettivo, [6,10]));

r = app.SFA.forExercise(app.parseWorkoutLine('OHP 3x8@40'), { OHP: { 'delt-ant': 1, 'delt-lat': 0.5, tricipiti: 0.5 } });
check('spalle: capi sommati ma tetto a 1', approx(r.perGroup.spalle[1], 3 * 0.85), r.perGroup);
check('tricipiti restano gruppo a parte', approx(r.perGroup.tricipiti[1], 3 * 0.85 * 0.5), r.perGroup);

r = app.SFA.forExercise(app.parseWorkoutLine('RDL 3x8@100'), { RDL: { glutei: 1, femorali: 1 } });
check('posteriore: RDL vale 1 set, non 2', approx(r.perGroup.posteriore[1], 3 * 0.85), r.perGroup);

r = app.SFA.forExercise(app.parseWorkoutLine('SQ 3x8@100'), { SQ: { quadricipiti: 1, glutei: 0.5 } });
check('squat: quad pieno, posteriore mezzo', approx(r.perGroup.quadricipiti[1], 3 * 0.85) && approx(r.perGroup.posteriore[1], 3 * 0.85 * 0.5), r.perGroup);

r = app.SFA.forExercise(app.parseWorkoutLine('LP 3x10@100'), { LP: { gambe: 1 } });
check('legacy "gambe" resta visibile come singleton', !!r.perGroup['x:gambe'], r.perGroup);

check('pesi arbitrari dal file', eq(app.parseMuscleMap('glutei, dorsali .33'), { glutei: 1, dorsali: 0.33 }));
check('fmtPeso frazioni', app.fmtPeso(0.5) === '½' && app.fmtPeso(1/3) === '⅓' && app.fmtPeso(0.25) === '¼' && app.fmtPeso(0.4) === ',4');
check('muscleMapLabel con peso arbitrario', app.muscleMapLabel({ dorsali: 0.33, glutei: 1 }) === 'glutei, dorsali ⅓');

/* ── D. forSessions: settimana, confidenza, non mappati ──────────── */
const today = new Date(); today.setHours(12,0,0,0);
const iso = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
const d0 = iso(today);
const d1 = iso(new Date(today.getTime() - 2*86400000));
const mkSession = (date, raw) => {
  const lines = app.parseAllLines(raw);
  return { date, raw, exercises: lines.filter(l => l.type === 'exercise'), bodyWeight: null, lines };
};
const sess = [mkSession(d0, 'BP 3x10@60!\nXX 3x8@40'), mkSession(d1, 'BP 3x10@60')];
const fs = app.SFA.forSessions(sess, { BP: { petto: 1 } });
check('forSessions somma i muscoli', fs.tot.petto && fs.tot.petto[1] > 0, fs.tot);
check('sedute contate', fs.sedute.petto === 2, fs.sedute);
check('non mappati segnalati', eq(fs.nonMappati, ['XX']), fs.nonMappati);
check('confidenza parziale', fs.confidenza > 0 && fs.confidenza < 1, fs.confidenza);

/* ── E. Mappe muscolari: parse / serializza / normalizza ─────────── */
check('parseMuscleMap piatto', eq(app.parseMuscleMap('petto'), { petto: 1 }));
check('parseMuscleMap frazioni', eq(app.parseMuscleMap('petto, tricipiti .5, delt-ant .5'), { petto: 1, tricipiti: 0.5, 'delt-ant': 0.5 }));
check('parseMuscleMap virgola decimale', eq(app.parseMuscleMap('dorsali, bicipiti 0,5'), { dorsali: 1, bicipiti: 0.5 }));
check('muscleMapToStr round', app.muscleMapToStr({ petto: 1, tricipiti: 0.5 }) === 'petto, tricipiti .5');
check('roundtrip map→str→map', eq(app.parseMuscleMap(app.muscleMapToStr({ petto: 1, 'delt-ant': 0.5 })), { petto: 1, 'delt-ant': 0.5 }));
check('normalizeMuscleGroups v1+v2', eq(app.normalizeMuscleGroups({ BP: 'petto', SQ: { quadricipiti: 1 } }), { BP: { petto: 1 }, SQ: { quadricipiti: 1 } }));
check('suggerisciPerNome panca', eq(app.suggerisciPerNome('Panca piana BP'), { petto: 1, tricipiti: 0.5, 'delt-ant': 0.5 }));
check('suggerisciPerNome rdl prima di stacco', eq(app.suggerisciPerNome('Stacco rumeno'), { glutei: 1, femorali: 1 }));

/* ── F. File .txt: export/import v2 con marcatori ────────────────── */
const glossary = { BP: 'Panca piana' };
const groups = { BP: { petto: 1, tricipiti: 0.5 } };
const s1 = mkSession('2026-08-18', 'BP 2x10@60 + 1x8@60!\nBW 78.5');
const txt = app.sessionsToTxt([s1], glossary, groups);
check('export contiene ###  frazionario', txt.includes('### BP = petto, tricipiti .5'), txt);
check('export contiene ## nome', txt.includes('## BP = Panca piana'));
check('export conserva il bang', txt.includes('BP 2x10@60 + 1x8@60!'));
const back = app.txtToSessions(txt);
check('import ricostruisce le mappe', eq(back.muscleGroups, groups), back.muscleGroups);
check('import ricostruisce glossario', eq(back.glossary, glossary));
check('import riparsa i marcatori', back.sessions[0].exercises[0].segments[1].bang === '!', back.sessions[0].exercises[0].segments);
check('import BW', back.sessions[0].bodyWeight === 78.5);
const backOld = app.txtToSessions('### LP = gambe\n\n# 2026-08-18\nLP 3x10@100\n');
check('import vecchio formato piatto', eq(backOld.muscleGroups, { LP: { gambe: 1 } }), backOld.muscleGroups);
check('gambe è fuori vocabolario', app.MUSCOLI.indexOf('gambe') < 0);

/* '#' nel raw esportato declassato a commento (regressione preservata) */
const s2 = mkSession('2026-08-17', 'BP 3x10@60');
s2.raw = 'BP 3x10@60\n# appunto';
const txt2 = app.sessionsToTxt([s2], {}, {});
check('safeRaw declassa #', txt2.includes('// appunto') && !txt2.includes('\n# appunto'));

/* ── G. CONFIG v2 ────────────────────────────────────────────────── */
check('chiave v2 attiva', app.CONFIG.MUSCLE_GROUPS === 'musclegroups_v2' && app.CONFIG.MUSCLE_GROUPS_V1 === 'musclegroups_v1');

/* ── Esito ───────────────────────────────────────────────────────── */
const summary = failures.length
  ? 'FAIL ' + failures.length + ' (pass ' + passed + ')\n' + failures.map(f => '  ✗ ' + f).join('\n')
  : 'PASS tutti i ' + passed + ' test';
console.log(summary);
summary;
