// Test JSC (osascript -l JavaScript) per app.js — parser marcatori, SFA 2, notazione, mappe muscolari
// Unico harness eseguibile su questa macchina (niente node): la suite completa
// node:test gira in CI (GitHub Actions).
ObjC.import('Foundation');

function readFile(p) {
  return $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null).js;
}

const src = readFile('/Users/nicolafalcioni/Desktop/palestra/app.js');
if (!src) throw new Error('app.js non trovato');

const documentStub = { addEventListener() {} };
const exportNames = ['parseWorkoutLine','parseAllLines','SFA','parseMuscleMap','muscleMapToStr','muscleMapLabel',
  'normalizeMuscleGroups','sessionsToTxt','txtToSessions','suggerisciPerNome','patternForWork','MUSCOLI','CONFIG',
  'GRUPPI_SFA','gruppoDiMuscolo','gruppoInfo','fmtPeso','computeAutoInv','exOptsToStr','parseExOpts'];
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

/* ── B. Credito per set / patternForWork ─────────────────────────── */
const A = (line, opts, xo) => app.SFA.analyze(app.parseWorkoutLine(line, xo || {}), opts || {});
let a = A('LP 12@25 + 12@35 + 3x8@45');
check('rampa: il primo set non conta', a.segCredit[0][0] < 0.15 && a.segCredit[2].every(c => approx(c, 0.9)), a.segCredit);
a = A('BP 12@30w + 3x10@60');
check('w esclude il set', a.sets[0].src === 'risc' && a.sets[0].c[1] === 0 && approx(a.total[1], 2.7), a.total);
check('pattern ignora il set escluso', app.patternForWork(app.parseWorkoutLine('BP 12@30w + 3x10@60').segments, a.segCredit) === null);
a = A('BP 1x10@60 + 1x8@50 + 1x6@40');
check('drop pattern', app.patternForWork(app.parseWorkoutLine('BP 1x10@60 + 1x8@50 + 1x6@40').segments, a.segCredit) === 'drop');

/* ── C. analyze: cedimento, presunzione, banda ───────────────────── */
a = A('BP 3x10@60!!');
check('!! tutti a cedimento', a.anchored && eq(a.total, [3, 3, 3]), a.total);
a = A('BP 10@60 + 9@60 + 8@60!');
check('calo di ripetizioni verso il ! = tutti al limite', approx(a.total[1], 3, 1e-9), a.total);
a = A('BP 3x10@60');
check('senza ! il set migliore è presunto a 3 dal cedimento', approx(a.total[1], 2.7) && !a.anchored && a.sets.every(s => s.src === 'top'), a.total);
check('banda ordinata', a.total[0] <= a.total[1] && a.total[1] <= a.total[2], a.total);
a = A('LM 2x12@35 + 2x12@40');
check('LM 2x12@35 + 2x12@40 = 2,94 (V9)', approx(a.total[1], 2.9406, 1e-3) && approx(a.segCredit[0][0], 0.57, 0.005), a.total);
check('seduta marcata: non marcato = non a cedimento', A('LM 2x12@35 + 2x12@40', { marcata: true }).total[1] < a.total[1]);
check('un ! in più non abbassa il totale', A('LM 2x12@35 + 12@40!').total[1] >= A('LM 2x12@35 + 12@40').total[1]);
check('una ripetizione in più non abbassa quel set',
  A('BP 10@60 + 9@60 + 9@60!').sets[2].c[1] >= A('BP 10@60 + 9@60 + 8@60!').sets[2].c[1]);
a = A('CR 3x15');
check('corpo libero: contano le ripetizioni', approx(a.total[1], 2.7), a.total);
a = A('TRZ 8 + 6@10 + 5@10');
check('senza peso fra set col peso: non confrontabile', a.sets[0].src === 'nc' && a.sets[0].c[1] === 0, a.sets[0]);
a = A('HE 15@5 + 15@10! + 10@10!', { marcata: true, tara: 40 });
const aNoTara = A('HE 15@5 + 15@10! + 10@10!', { marcata: true });
check('tara: 5 kg contro 10 kg di zavorra non è metà carico', aNoTara.sets[0].c[1] === 0 && approx(a.sets[0].c[1], 0.8, 0.005), [aNoTara.sets[0].c[1], a.sets[0].c[1]]);
// regressione sul diario reale: seduta del 4 ottobre, verificata contro la V9
const oct = ['CC 12@20 + 12@30 + 8@40 + 6@40! + 1@50! + 4@40!', 'FP 12@13 + 12@18! + 11@18! + 5@18!',
             'LM 12@40 + 5@50! + 8@45! + 6@45!', 'BC 7@18! + 7@18! + 5@18!'];
check('seduta del 4 ottobre = 13,94', approx(oct.reduce((t, l) => t + A(l, { marcata: true }).total[1], 0), 13.9426, 1e-3));

let r = app.SFA.forExercise(app.parseWorkoutLine('XX 3x10@60'), {});
check('senza mappa: set contati, nessun muscolo', r.mapped === false && r.sets.length === 3 && eq(r.perMuscle, {}) && eq(r.perGroup, {}));

/* ── C2. Gruppi di lettura: tetto a 1 per set fisico ─────────────── */
check('membro→gruppo', app.gruppoDiMuscolo('delt-post') === 'spalle' && app.gruppoDiMuscolo('femorali') === 'posteriore'
  && app.gruppoDiMuscolo('trapezi') === 'schiena' && app.gruppoDiMuscolo('petto') === 'petto');
check('gruppoInfo legacy singleton', app.gruppoInfo('x:gambe').label === 'gambe' && eq(app.gruppoInfo('x:gambe').obiettivo, [8,12]));
check('obiettivi per gruppo', eq(app.gruppoInfo('spalle').obiettivo, [8,12]) && eq(app.gruppoInfo('schiena').obiettivo, [10,14])
  && eq(app.gruppoInfo('bicipiti').obiettivo, [6,10]));

r = app.SFA.forExercise(app.parseWorkoutLine('OHP 3x8@40'), { OHP: { 'delt-ant': 1, 'delt-lat': 0.5, tricipiti: 0.5 } });
check('spalle: capi sommati ma tetto a 1', approx(r.perGroup.spalle[1], 3 * 0.9), r.perGroup);
check('tricipiti restano gruppo a parte', approx(r.perGroup.tricipiti[1], 3 * 0.9 * 0.5), r.perGroup);

r = app.SFA.forExercise(app.parseWorkoutLine('RDL 3x8@100'), { RDL: { glutei: 1, femorali: 1 } });
check('posteriore: RDL vale 1 set, non 2', approx(r.perGroup.posteriore[1], 3 * 0.9), r.perGroup);

r = app.SFA.forExercise(app.parseWorkoutLine('SQ 3x8@100'), { SQ: { quadricipiti: 1, glutei: 0.5 } });
check('squat: quad pieno, posteriore mezzo', approx(r.perGroup.quadricipiti[1], 3 * 0.9) && approx(r.perGroup.posteriore[1], 3 * 0.9 * 0.5), r.perGroup);

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
const mkSession = (date, raw, xo) => {
  const lines = app.parseAllLines(raw, xo || {});
  return { date, raw, exercises: lines.filter(l => l.type === 'exercise'), bodyWeight: null, lines };
};
const sess = [mkSession(d0, 'BP 3x10@60!\nXX 3x8@40'), mkSession(d1, 'BP 3x10@60')];
const fs = app.SFA.forSessions(sess, { BP: { petto: 1 } });
check('forSessions somma per gruppo', fs.tot.petto && fs.tot.petto[1] > 0, fs.tot);
check('sedute contate', fs.sedute.petto === 2, fs.sedute);
check('non mappati segnalati', eq(fs.nonMappati, ['XX']), fs.nonMappati);
check('confidenza parziale', fs.confidenza > 0 && fs.confidenza < 1, fs.confidenza);
check('scritti e credito', fs.scritti === 9 && fs.credito > 0 && fs.credito <= 9, [fs.scritti, fs.credito]);
const fsTara = app.SFA.forSessions([mkSession(d0, 'HE 15@5 + 15@10! + 10@10!')], { HE: { glutei: 1 } }, { tara: () => 40 });
check('forSessions usa la tara', fsTara.tot.posteriore[1] > app.SFA.forSessions([mkSession(d0, 'HE 15@5 + 15@10! + 10@10!')], { HE: { glutei: 1 } }).tot.posteriore[1]);

/* ── H. Notazione serie@ripetizioni e opzioni per esercizio ──────── */
const INV = { CR: { inv: true } };
ex = app.parseWorkoutLine('CR 2x1@15 + 1@12', INV);
check('inv: dopo @ le ripetizioni', ex && ex.inv && eq(ex.segments.map(s => [s.count, s.reps, s.weight]), [[2, 15, null], [1, 12, null]]) && ex.peakWeight === null, ex);
ex = app.parseWorkoutLine('CR 15 + 1@12', INV);
check('inv: @ in coda non è peso globale', ex && eq(ex.segments.map(s => [s.count, s.reps, s.weight]), [[1, 15, null], [1, 12, null]]), ex);
ex = app.parseWorkoutLine('CR 2@12', INV);
check('inv: N prima di @ è il carico', ex && ex.segments[0].reps === 12 && ex.segments[0].weight === 2, ex);
ex = app.parseWorkoutLine('CR 2x1@15 + 1@12', {});
check('senza inv la riga resta rip@kg', ex && !ex.inv && ex.segments[0].weight === 15, ex);
check('inv non allenta il parser atomico', app.parseWorkoutLine('CR 1@12 + BAD', INV) === null);
check('rilevazione notazione', eq(app.computeAutoInv([{ raw: 'CR 1@12 + 1@15\nBP 3x10@60' }, { raw: 'CR 2x1@15 + 1@12' }]), ['CR']));
check('rilevazione: le righe senza @ non contano', eq(app.computeAutoInv([{ raw: 'CR 1@12\nCR 3x15' }, { raw: 'CR 1@15' }]), ['CR']));
check('rilevazione: una riga sola non basta', eq(app.computeAutoInv([{ raw: 'CR 1@12' }]), []));
check('opzioni → testo', app.exOptsToStr({ inv: true, tara: 40 }) === 'inv, tara 40' && app.exOptsToStr({ inv: false }) === 'noinv');
check('testo → opzioni', eq(app.parseExOpts('inv, tara 40'), { inv: true, tara: 40 }) && eq(app.parseExOpts('noinv'), { inv: false }));

/* ── H2. File: righe "####" e a capo di Windows ─────────────────── */
const sCR = mkSession('2026-09-17', 'CR 1@12 + 1@15 + 1@12', INV);
const txtOp = app.sessionsToTxt([sCR], { CR: 'Crunch' }, {}, { CR: { inv: true }, HE: { tara: 40 } });
check('export: righe ####', txtOp.includes('#### CR = inv') && txtOp.includes('#### HE = tara 40'), txtOp);
const backOp = app.txtToSessions(txtOp);
check('import: opzioni lette', eq(backOp.exOpts, { CR: { inv: true }, HE: { tara: 40 } }), backOp.exOpts);
check('import: righe lette con la notazione del file', eq(backOp.sessions[0].exercises[0].segments.map(s => s.reps), [12, 15, 12]), backOp.sessions[0].exercises[0].segments);
check('import: #### non diventa nome né muscoli', eq(backOp.glossary, { CR: 'Crunch' }) && eq(backOp.muscleGroups, {}));
const crlf = app.txtToSessions('## BP = Panca piana\r\n### BP = petto\r\n\r\n# 2026-05-04\r\nBP 3x10@60\r\n');
check('a capo di Windows', eq(crlf.glossary, { BP: 'Panca piana' }) && eq(crlf.muscleGroups, { BP: { petto: 1 } }) && crlf.sessions.length === 1, crlf.glossary);

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
