import assert from 'node:assert/strict';
import test from 'node:test';

// Exercises the sweep loop's bookkeeping in isolation: the route pulls its
// pass structure from these same three rules, and the failure mode they guard
// against (an ASIN leaving `pending` without ever emitting a final row) is a
// silent one — progress just never reaches total.
function runSweeps({ asins, gaps, outcomeFor }) {
  const events = [];
  let completed = 0;
  let pending = [...asins];
  const resolved = new Set();

  for (let sweepIndex = 0; sweepIndex <= gaps.length; sweepIndex += 1) {
    if (pending.length === 0) break;
    if (sweepIndex > 0) events.push({ type: 'sweep_waiting', sweep: sweepIndex, pending: pending.length });

    const batch = pending;
    for (const asin of batch) {
      const isFinalPass = sweepIndex >= gaps.length;
      const ok = outcomeFor(asin, sweepIndex);
      if (ok) {
        resolved.add(asin);
        events.push({ type: 'item', asin, status: 'success', progress: ++completed });
      } else if (!isFinalPass) {
        resolved.delete(asin);
        events.push({ type: 'item', asin, status: 'retrying', progress: completed });
      } else {
        resolved.add(asin);
        events.push({ type: 'item', asin, status: 'error', progress: ++completed });
      }
    }
    pending = batch.filter(asin => !resolved.has(asin));
  }
  return { events, completed, pending };
}

test('every ASIN emits exactly one final row, and progress reaches total', () => {
  const asins = ['A', 'B', 'C', 'D'];
  // B recovers on sweep 1, C on sweep 2, D never recovers.
  const recoverOn = { A: 0, B: 1, C: 2 };
  const { events, completed } = runSweeps({
    asins, gaps: [45000, 120000],
    outcomeFor: (asin, sweep) => recoverOn[asin] === sweep
  });

  const finals = events.filter(e => e.status === 'success' || e.status === 'error');
  assert.equal(finals.length, asins.length, 'one final row per ASIN');
  assert.deepEqual(finals.map(e => e.asin).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(completed, asins.length, 'progress must reach total');
  assert.equal(finals.find(e => e.asin === 'D').status, 'error', 'D exhausts every sweep');
  assert.equal(finals.find(e => e.asin === 'C').status, 'success');
});

test('a retrying row never advances the progress counter', () => {
  const { events } = runSweeps({
    asins: ['A'], gaps: [1000],
    outcomeFor: (_a, sweep) => sweep === 1
  });
  const retrying = events.find(e => e.status === 'retrying');
  assert.equal(retrying.progress, 0, 'parked rows are not counted as done');
  assert.equal(events.at(-1).progress, 1);
});

test('no sweeps configured means failures are final immediately', () => {
  const { events, completed, pending } = runSweeps({
    asins: ['A', 'B'], gaps: [], outcomeFor: (asin) => asin === 'A'
  });
  assert.equal(events.filter(e => e.status === 'retrying').length, 0);
  assert.equal(events.filter(e => e.status === 'error').length, 1);
  assert.equal(completed, 2);
  assert.equal(pending.length, 0);
});

test('an all-success first pass runs no sweeps at all', () => {
  const { events } = runSweeps({
    asins: ['A', 'B'], gaps: [45000, 120000], outcomeFor: () => true
  });
  assert.equal(events.filter(e => e.type === 'sweep_waiting').length, 0,
    'users must not wait out gaps when nothing failed');
});
