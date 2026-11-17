import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const [kitArg, scratchArg, split = 'dev'] = process.argv.slice(2);
if (!kitArg || !scratchArg || !['dev', 'holdout', 'practice'].includes(split)) {
  throw new Error('Usage: node verify.mjs KIT SCRATCH dev|holdout|practice');
}
const kit = resolve(kitArg), scratch = resolve(scratchArg);
const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const levels = [.05, .25, .5, .75, .95];
const HOUR = 3600000;
const SPLIT = '2025-06-01T00:00:00Z';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = ms => new Date(ms).toISOString();

function validate(bytes) {
  assert.ok(bytes.length <= 65536);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(data), ['hours']);
  assert.equal(data.hours.length, 23);
  data.hours.forEach(({ hour, q, ...extra }, i) => {
    assert.equal(hour, 2 + i);
    assert.deepEqual(extra, {});
    assert.equal(q.length, 5);
    assert.ok(q.every((v, j) => Number.isFinite(v) && v > 0 && v <= 1e9 && (!j || v >= q[j - 1])));
  });
  return data;
}

function run(entry, inputDir, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const before = performance.now();
  const proc = spawnSync(process.execPath, [entry], {
    timeout: 8000, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outputDir },
  });
  if (proc.error || proc.status !== 0) throw new Error(proc.error ?? proc.stderr);
  return performance.now() - before;
}

if (split === 'practice') {
  const report = readdirSync(join(kit, 'input')).filter(f => f.endsWith('.in')).sort().map(file => {
    const id = basename(file, '.in');
    const inputDir = join(scratch, 'input', id);
    const outputDirs = [join(scratch, 'first', id), join(scratch, 'second', id)];
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(join(inputDir, file), readFileSync(join(kit, 'input', file)));
    const milliseconds = outputDirs.map(dir => run(main, inputDir, dir));
    const outputs = outputDirs.map(dir => {
      assert.deepEqual(readdirSync(dir), [id + '.out']);
      return readFileSync(join(dir, id + '.out'));
    });
    validate(outputs[0]);
    assert.deepEqual(outputs[0], outputs[1]);
    return { id, milliseconds, sha256: digest(outputs[0]), bytes: outputs[0].length };
  });
  console.log(JSON.stringify(report, null, 2));
} else {
  // Keep the later titles out of both analogue inputs and development calculations.
  const games = read(join(kit, 'input', 'p00.in')).comparables
    .filter(g => !/target-history|not a launch/i.test(g.unlock));
  const early = games.filter(g => g.day_start < SPLIT);
  const pool = split === 'dev' ? early : games.filter(g => g.day_start >= SPLIT);
  mkdirSync(scratch, { recursive: true });
  const cases = pool.flatMap((g, index) => {
    const start = Date.parse(g.day_start), cut = start + HOUR, checkpoint = iso(cut);
    const first = g.hourly.find(row => Date.parse(row.from) === start);
    const answer = new Map(g.hourly.filter(row => Date.parse(row.from) >= cut && Date.parse(row.from) < start + 24 * HOUR)
      .map(row => [(Date.parse(row.from) - start) / HOUR + 1, row.viewers]));
    if (!first || first.viewers <= 0 || answer.size < 18) return [];
    const id = 'historical-' + index;
    const input = {
      schema: 'makefun/twitch-ccu-case/v1', id, game: { name: g.name, platforms: g.platforms },
      day_start: g.day_start, checkpoint, levels,
      known: [{ hour: 1, from: g.day_start, until: checkpoint, viewers: first.viewers, channels: first.channels, reads: 1 }],
      forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, from: iso(start + (i + 1) * HOUR), until: iso(start + (i + 2) * HOUR) })),
      history: g.hourly.filter(row => Date.parse(row.from) < cut).map(row => ({ at: row.from, viewers: row.viewers, channels: row.channels })),
      history_hourly: g.hourly.filter(row => Date.parse(row.from) < cut),
      streams: null, categories_hourly: null,
      notes: String(g.unlock).split(/source:|tier:|research note:|inferred from/i)[0],
      comparables: early.filter(other => other.name !== g.name),
    };
    assert.ok(input.history.every(row => Date.parse(row.at) < cut));
    assert.ok(input.history_hourly.every(row => Date.parse(row.from) < cut));
    assert.ok(input.comparables.every(other => other.name !== g.name));
    const inDir = join(scratch, id, 'input');
    mkdirSync(inDir, { recursive: true });
    writeFileSync(join(inDir, id + '.in'), JSON.stringify(input));
    return [{ g, id, inDir, answer }];
  });

  function stats(forecast, answer) {
    const total = { loss: 0, median: 0, coverage: 0, hours: 0 };
    for (const { hour, q } of forecast.hours) {
      const y = answer.get(hour);
      if (y === undefined) continue;
      const print = Math.max(1, y);
      const errors = q.map(v => Math.log(print) - Math.log(v));
      total.loss += errors.reduce((sum, d, j) => sum + 2 * Math.max(levels[j] * d, (levels[j] - 1) * d), 0) / 5;
      total.median += Math.abs(errors[2]);
      total.coverage += Number(q[0] <= print && print <= q[4]);
      total.hours++;
    }
    return total;
  }
  const totals = { model: { loss: 0, median: 0, coverage: 0, hours: 0 },
    baseline: { loss: 0, median: 0, coverage: 0, hours: 0 } };
  const summarize = x => ({ loss: x.loss / x.hours, typicalMissPercent: 100 * Math.expm1(x.median / x.hours), coverage90: x.coverage / x.hours });
  const results = cases.map(({ g, id, inDir, answer }) => {
    // The scorer keeps the labels in memory; each child gets only its own case file.
    const modelOut = join(scratch, id, 'model');
    const baseOut = join(scratch, id, 'baseline');
    run(main, inDir, modelOut);
    run(join(kit, 'starter', 'main.ts'), inDir, baseOut);
    const forecast = validate(readFileSync(join(modelOut, id + '.out')));
    const baseline = validate(readFileSync(join(baseOut, id + '.out')));
    const scores = { model: stats(forecast, answer), baseline: stats(baseline, answer) };
    for (const mode of Object.keys(totals)) {
      for (const key of Object.keys(totals[mode])) totals[mode][key] += scores[mode][key];
    }
    return { name: g.name, hours: answer.size, model: summarize(scores.model), baseline: summarize(scores.baseline) };
  });
  console.log(JSON.stringify({ split, cutoff: SPLIT, titles: results.length, hours: totals.model.hours,
    model: summarize(totals.model), baseline: summarize(totals.baseline), results }, null, 2));
}
