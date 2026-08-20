import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(script, 'index.html should contain an inline script');

const context = {
  console,
  setTimeout,
  clearTimeout,
  document: { addEventListener() {} },
  window: {},
  navigator: {},
};
vm.createContext(context);
vm.runInContext(script, context, { filename: 'index.html' });

const plain = value => JSON.parse(JSON.stringify(value));

const sample = fs.readFileSync(new URL('./fixtures/workout-sample.txt', import.meta.url), 'utf8');
const parsed = context.txtToSessions(sample);

assert.equal(parsed.sessions.length, 2);
assert.deepEqual(plain(parsed.glossary), { BP: 'Panca piana', SQ: 'Squat' });
assert.deepEqual(plain(parsed.muscleGroups), { BP: { petto: 1 }, SQ: { gambe: 1 } });

const latest = parsed.sessions[0];
assert.equal(latest.date, '2026-05-04');
assert.equal(latest.bodyWeight, 78.5);
assert.equal(latest.exercises.length, 2);

const bp = latest.exercises.find(ex => ex.abbr === 'BP');
assert.equal(bp.volume, 1800);
assert.equal(bp.estimated1RM, 80);
assert.equal(bp.comment, 'pausa corta');

const sq = latest.exercises.find(ex => ex.abbr === 'SQ');
assert.equal(sq.volume, 1450);
assert.equal(sq.pattern, 'drop');

const exported = context.sessionsToTxt(parsed.sessions, parsed.glossary, parsed.muscleGroups);
assert.match(exported, /^## BP = Panca piana\n## SQ = Squat\n### BP = petto\n### SQ = gambe/m);

const reparsed = context.txtToSessions(exported);
assert.deepEqual(
  reparsed.sessions.map(s => ({ date: s.date, bodyWeight: s.bodyWeight, exercises: s.exercises.map(ex => ex.abbr) })),
  parsed.sessions.map(s => ({ date: s.date, bodyWeight: s.bodyWeight, exercises: s.exercises.map(ex => ex.abbr) })),
);
assert.deepEqual(plain(reparsed.glossary), plain(parsed.glossary));
assert.deepEqual(plain(reparsed.muscleGroups), plain(parsed.muscleGroups));

const withoutGroups = context.txtToSessions('## BP = Panca piana\n\n# 2026-05-04\nBP 3x10 @60\n');
assert.deepEqual(plain(withoutGroups.muscleGroups), {});

// Marcatori V8 (! !! w) e mappe muscolari frazionarie
const marked = context.parseWorkoutLine('BP 12@30w + 2x10@60 + 1x8@60!');
assert.equal(marked.segments[0].warm, true);
assert.equal(marked.segments[2].bang, '!');
assert.equal(marked.hasBang, true);
assert.equal(context.parseWorkoutLine('BP 3x10 @60!').segments[0].bang, '!');
assert.equal(context.parseWorkoutLine('BP 3x10@60!!!'), null, 'tre bang non sono sintassi valida');

const kinds = context.SFA.classify(marked.segments).map(s => s.kind);
assert.deepEqual(kinds, ['warm', 'work', 'work']);
const sfa = context.SFA.forExercise(marked, { BP: { petto: 1, tricipiti: 0.5 } });
assert.equal(sfa.nSets, 3, 'il riscaldamento non conta negli SFA');
assert.ok(sfa.perMuscle.petto[1] > 0);
const grouped = context.SFA.forExercise(context.parseWorkoutLine('OHP 3x8@40'), { OHP: { 'delt-ant': 1, 'delt-lat': 0.5 } });
assert.ok(Math.abs(grouped.perGroup.spalle[1] - 3 * 0.85) < 1e-9, 'i capi della spalla contano insieme, massimo 1 per set');

assert.deepEqual(plain(context.parseMuscleMap('petto, tricipiti .5')), { petto: 1, tricipiti: 0.5 });
assert.equal(context.muscleMapToStr({ petto: 1, tricipiti: 0.5 }), 'petto, tricipiti .5');
const fractional = context.txtToSessions('### BP = petto, tricipiti .5\n\n# 2026-05-04\nBP 3x10@60!\n');
assert.deepEqual(plain(fractional.muscleGroups), { BP: { petto: 1, tricipiti: 0.5 } });
const fracExport = context.sessionsToTxt(fractional.sessions, {}, fractional.muscleGroups);
assert.match(fracExport, /^### BP = petto, tricipiti \.5$/m);
assert.match(fracExport, /BP 3x10@60!/);

console.log('parser/import/export tests OK');
