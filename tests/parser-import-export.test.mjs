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
assert.deepEqual(plain(parsed.muscleGroups), { BP: 'petto', SQ: 'gambe' });

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

console.log('parser/import/export tests OK');
