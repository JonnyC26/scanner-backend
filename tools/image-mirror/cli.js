#!/usr/bin/env node
'use strict';

const path = require('path');
const { runMirror } = require('./src/run');
const { createR2Store } = require('./src/r2');
const { DEFAULT_WRITE_CAP } = require('./src/constants');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--dry_run') {
      out.dry_run = true;
      continue;
    }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function asBool(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function asInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = asBool(args.dry_run);
  const limit = asInt(args.limit, 0);
  const sampleSeed = args.sample_seed == null || args.sample_seed === ''
    ? '20260924'
    : String(args.sample_seed);
  const offset = asInt(args.offset, 0);
  const writeCap = asInt(args.write_cap, DEFAULT_WRITE_CAP);
  const concurrency = args.concurrency == null ? undefined : asInt(args.concurrency, undefined);
  const dumpUrl = args.dump_url || undefined;
  const artifactDir = args.artifact_dir
    ? path.resolve(args.artifact_dir)
    : path.join(process.cwd(), 'artifact');

  const scope = args.scope;
  const store = dryRun ? null : createR2Store();
  await runMirror({
    dumpUrl,
    limit,
    sampleSeed,
    offset,
    dryRun,
    writeCap,
    concurrency,
    store,
    artifactDir,
    scope,
  });
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
