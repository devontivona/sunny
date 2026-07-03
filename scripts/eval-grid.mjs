#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Comparison-grid runner (`npm run eval:grid`): sweeps eval cells sequentially —
 * one `npm run eval` subprocess per cell (the eval Local World + PGlite requires
 * single-process runs) — then aggregates the cell scorecards into a matrix.
 *
 * Cell axes (comma-separated env lists; a single value pins the axis):
 *   EVAL_GRID_MODELS    default: claude-sonnet-5
 *   EVAL_GRID_THINKING  default: '' (config default)   values: adaptive,off
 *   EVAL_GRID_VARIANTS  default: '' (baseline)          values: baseline,gateway,diary
 *   EVAL_GRID_FEWSHOT   default: '' (off)               values: 0,1
 *   EVAL_GRID_COMPOSER  default: '' (off)               values: 0,1
 * Per-cell run settings: EVAL_DIMENSION (default elicitation), EVAL_N (default 3),
 * EVAL_COST_CAP_USD (default 3, PER CELL). Safety: EVAL_GRID_MAX_CELLS (default 12).
 * EVAL_GRID_DRY=1 prints the planned cells and exits without spending.
 *
 * NOTE: judge-grader calls (scratch quality) are not metered by the in-run
 * CostMeter — the cap covers the model under test only; judge spend is extra
 * (~$0.01-0.03 per graded run at Sonnet pricing).
 */

const list = (name, fallback) => {
  const v = process.env[name];
  return (v === undefined || v === '' ? fallback : v).split(',').map((s) => s.trim());
};

const models = list('EVAL_GRID_MODELS', 'claude-sonnet-5');
const thinkings = list('EVAL_GRID_THINKING', '');
const variants = list('EVAL_GRID_VARIANTS', '');
const fewshots = list('EVAL_GRID_FEWSHOT', '');
const composers = list('EVAL_GRID_COMPOSER', '');
const dimension = process.env.EVAL_DIMENSION ?? 'elicitation';
const n = process.env.EVAL_N ?? '3';
const capPerCell = Number(process.env.EVAL_COST_CAP_USD ?? 3);
const maxCells = Number(process.env.EVAL_GRID_MAX_CELLS ?? 12);
const dry = process.env.EVAL_GRID_DRY === '1';

const cells = [];
for (const model of models)
  for (const thinking of thinkings)
    for (const variant of variants)
      for (const fewshot of fewshots)
        for (const composer of composers)
          cells.push({ model, thinking, variant, fewshot, composer });

const cellName = (c) =>
  [
    c.model,
    c.thinking && `t-${c.thinking}`,
    c.variant && `v-${c.variant}`,
    c.fewshot && `fs${c.fewshot}`,
    c.composer === '1' && 'composer',
  ]
    .filter(Boolean)
    .join(' ');

console.log(
  `Grid: ${cells.length} cell(s) × dimension=${dimension} × N=${n}, cap $${capPerCell}/cell ` +
    `(≤ $${(cells.length * capPerCell).toFixed(2)} total, judge calls extra)`,
);
for (const c of cells) console.log(`  - ${cellName(c)}`);
if (cells.length > maxCells) {
  console.error(`\nRefusing to run ${cells.length} cells > EVAL_GRID_MAX_CELLS=${maxCells}.`);
  process.exit(1);
}
if (dry) {
  console.log('\nEVAL_GRID_DRY=1 — nothing run.');
  process.exit(0);
}

const SCORECARD_DIR = join(process.cwd(), 'evals', 'scorecards');
const before = new Set(safeList(SCORECARD_DIR));
const results = [];

for (const c of cells) {
  console.log(`\n=== ${cellName(c)} ===`);
  const env = {
    ...process.env,
    EVAL_MODEL: c.model,
    EVAL_THINKING: c.thinking,
    EVAL_PROMPT_VARIANT: c.variant === 'baseline' ? '' : c.variant,
    EVAL_FEWSHOT: c.fewshot,
    EVAL_COMPOSER: c.composer,
    EVAL_DIMENSION: dimension,
    EVAL_N: n,
    EVAL_COST_CAP_USD: String(capPerCell),
  };
  const r = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.eval.config.ts', 'evals/run.eval.test.ts'], {
    env,
    stdio: 'inherit',
  });
  const fresh = safeList(SCORECARD_DIR).filter((f) => !before.has(f));
  fresh.forEach((f) => before.add(f));
  const scorecard = fresh
    .map((f) => JSON.parse(readFileSync(join(SCORECARD_DIR, f), 'utf8')))
    .at(-1);
  results.push({ cell: c, ok: r.status === 0, scorecard });
}

// ---- Matrix report -------------------------------------------------------

const pct = (x) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);

/** Mean pass rate over a subset of cases; also mean per-run rate for one grader prefix. */
function summarize(scorecard, tierFilter) {
  if (!scorecard) return {};
  const cases = scorecard.cases.filter((cs) => !tierFilter || (cs.history ?? 'live') === tierFilter);
  if (!cases.length) return {};
  const mean = (f) => cases.reduce((s, cs) => s + f(cs), 0) / cases.length;
  const graderRate = (prefix) => {
    const withGrader = cases.filter((cs) =>
      Object.keys(cs.graderPasses).some((g) => g.startsWith(prefix)),
    );
    if (!withGrader.length) return undefined;
    return (
      withGrader.reduce((s, cs) => {
        const key = Object.keys(cs.graderPasses).find((g) => g.startsWith(prefix));
        return s + (cs.graderPasses[key] ?? 0) / (cs.runs || 1);
      }, 0) / withGrader.length
    );
  };
  return {
    passRate: mean((cs) => cs.passRate),
    noRecovery: graderRate('elicited-without-recovery'),
    scratchNotes: graderRate('scratch-is-working-notes'),
  };
}

console.log('\n\n==== GRID MATRIX ====');
console.log(
  '\ncell | pass(live) | pass(clean) | pass(poisoned) | no-recovery | scratch-notes | cost',
);
for (const { cell, ok, scorecard } of results) {
  const live = summarize(scorecard, 'live');
  const clean = summarize(scorecard, 'seeded-clean');
  const poisoned = summarize(scorecard, 'seeded-poisoned');
  const all = summarize(scorecard);
  console.log(
    `${cellName(cell)}${ok ? '' : ' (FAILED)'} | ${pct(live.passRate)} | ${pct(clean.passRate)} | ` +
      `${pct(poisoned.passRate)} | ${pct(all.noRecovery)} | ${pct(all.scratchNotes)} | ` +
      `$${scorecard?.costUsd?.toFixed(2) ?? '—'}`,
  );
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
