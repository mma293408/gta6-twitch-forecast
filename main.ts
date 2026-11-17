import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Point = { from?: string; at?: string; viewers: number; channels?: number | null };
type Game = { name: string; day_start: string; unlock: string; platforms: string; hourly: Point[] };
type Case = {
  schema: string; id: string; game: { name: string; platforms?: string }; day_start: string; checkpoint: string;
  known: { hour: number; viewers: number }[]; forecast: { hour: number }[];
  history: Point[]; history_hourly: Point[]; notes?: string | string[];
  comparables: Game[];
};
type Profile = { day: Map<number, number>; feature: number[]; console: boolean; schedule: number };
type Row = { hour: number; q: number[] };

const HOUR = 3600000;
const MINUTE = 60000;
const LEVELS = [0.05, 0.25, 0.50, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const logCount = (x: number) => Math.log(Math.max(1, x));

function frame(rows: Point[], start: number): Map<number, number> {
  const result = new Map<number, number>();
  for (const row of rows) {
    const hour = (Date.parse(row.from ?? row.at ?? '') - start) / HOUR;
    if (Number.isInteger(hour) && Number.isFinite(row.viewers) && row.viewers >= 0) {
      result.set(hour, row.viewers);
    }
  }
  return result;
}

function schedule(text: string): number {
  const known = text.split(/source:|tier:|research note:|inferred from/i)[0];
  if (/midnight local|rolling/i.test(known)) return 1;
  if (/simultaneous|single global|single time/i.test(known)) return -1;
  return 0;
}

function consoleOnly(platforms: string): boolean {
  return !/\b(?:pc|steam|stadia)\b/i.test(platforms);
}

function profile(
  day: Map<number, number>, first: number, console: boolean, timing: number,
): Profile {
  const anchor = logCount(first);
  const change = (old: number) => clamp(anchor - logCount(old), -2.5, 4);
  const recent = [...day].filter(([h]) => h >= -12 && h < 0).map(([, n]) => n);
  const previous = day.get(-1) ?? day.get(-2) ?? first;
  const peak = recent.length ? Math.max(...recent) : first;
  return { day, feature: [anchor, change(previous), change(peak)], console, schedule: timing };
}

function analogs(input: Case): Profile[] {
  return input.comparables.flatMap(game => {
    const start = Date.parse(game.day_start);
    if (!Number.isFinite(start) || game.name === input.game.name ||
        /target-history|not a launch/i.test(game.unlock)) return [];
    const day = frame(game.hourly, start);
    const first = day.get(0);
    if (first === undefined || first <= 0 ||
        Array.from({ length: 23 }, (_, i) => day.has(i + 1)).filter(Boolean).length < 18) return [];
    return [profile(day, first, consoleOnly(game.platforms), schedule(game.unlock))];
  });
}

function mean(values: number[]): number {
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function shortTrend(input: Case): number {
  const checkpoint = Date.parse(input.checkpoint);
  const half = [[], []] as number[][];
  for (const point of input.history) {
    const age = (checkpoint - Date.parse(point.at ?? '')) / MINUTE;
    if (age > 0 && age <= 40 && Number.isFinite(point.viewers) && point.viewers >= 0) {
      half[age > 20 ? 0 : 1].push(point.viewers);
    }
  }
  if (half.some(samples => samples.length < 10)) return 0;
  return clamp(logCount(mean(half[1])) - logCount(mean(half[0])), -0.55, 0.55);
}

function normal(x: number): number {
  const u = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = 0.3989422804 * Math.exp(-0.5 * x * x) * u *
    (0.31938153 + u * (-0.356563782 + u * (1.781477937 + u * (-1.821255978 + u * 1.330274429))));
  return x < 0 ? p : 1 - p;
}

function mixture(parts: { center: number; width: number; weight: number }[], level: number): number {
  const weight = parts.reduce((sum, part) => sum + part.weight, 0);
  let lo = Math.min(...parts.map(p => p.center - 6 * p.width));
  let hi = Math.max(...parts.map(p => p.center + 6 * p.width));
  for (let i = 0; i < 27; i++) {
    const mid = (lo + hi) / 2;
    const cdf = parts.reduce((sum, p) => sum + p.weight * normal((mid - p.center) / p.width), 0);
    if (cdf < weight * level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function predict(input: Case): { hours: Row[] } {
  if (input.schema !== 'makefun/twitch-ccu-case/v1') throw new Error('Unrecognized case schema');
  const first = Math.max(1, input.known.find(row => row.hour === 1)?.viewers ?? 1);
  const anchor = logCount(first);
  const notes = Array.isArray(input.notes) ? input.notes.join(' ') : input.notes ?? '';
  // The final's own pre-release series describes its unlock but is never a launch analogue.
  const metadata = input.comparables.find(game =>
    /target-history/i.test(game.unlock) && game.name.startsWith(input.game.name + ' category'));
  const timing = schedule(notes) || schedule(metadata?.unlock ?? '');
  const platforms = input.game.platforms ?? metadata?.platforms;
  const target = profile(frame(input.history_hourly, Date.parse(input.day_start)), first,
    platforms ? consoleOnly(platforms) : !/\b(?:PC only|PC launch|on PC)\b/i.test(notes), timing);
  const trend = shortTrend(input);
  const neighbors = analogs(input).map(p => {
    const [a, b, c] = p.feature.map((n, i) => n - target.feature[i]);
    const distance = 0.22 * a * a + 0.28 * b * b + 0.32 * c * c +
      (p.console === target.console ? 0 : 1.15) +
      (target.schedule * p.schedule < 0 ? 2.5 : target.schedule && !p.schedule ? 0.45 : 0);
    return { ...p, weight: Math.exp(-0.5 * distance) };
  });
  const hours = input.forecast.map(({ hour }) => {
    const offset = hour - 1;
    const width = 0.14 + 0.055 * Math.sqrt(offset);
    const parts = neighbors.flatMap(p => {
      const count = p.day.get(offset);
      if (count === undefined) return [];
      const ratio = clamp(logCount(count) - p.feature[0], -5, 7);
      // The farther out we forecast, the less precisely the first print fixes the scale.
      // This is deliberately asymmetric: a nearly empty category can still have a large launch.
      const scale = clamp(p.feature[0] - anchor, -2, 4);
      const pull = (scale > 0 ? 0.24 : 0.10) * (1 - Math.exp(-offset / 5)) * scale;
      return [{ center: ratio + pull, width, weight: p.weight }];
    });
    const mass = parts.reduce((sum, p) => sum + p.weight, 0);
    parts.push({ center: 0, width: 0.15 * Math.sqrt(offset), weight: 0.13 * mass });
    const adjustment = trend * 0.75 * Math.exp(-(offset - 1) / 2);
    const q = LEVELS.map((tau, i) => {
      const relative = mass > 1e-9 ? mixture(parts, tau) : Z[i] * 0.15 * Math.sqrt(offset);
      return Number(clamp(Math.exp(anchor + relative + adjustment), 0.01, 1e9).toFixed(2));
    });
    return { hour, q };
  });
  return { hours };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.in'))
    .map(entry => entry.name).sort();
  for (const file of files) {
    const input = JSON.parse(readFileSync(join(inputDir, file), 'utf8')) as Case;
    const output = JSON.stringify(predict(input));
    writeFileSync(join(outputDir, basename(file, '.in') + '.out'), output + '\n', 'utf8');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
