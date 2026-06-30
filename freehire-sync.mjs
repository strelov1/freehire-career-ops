#!/usr/bin/env node

/**
 * freehire-sync.mjs — One-way mirror: career-ops tracker → freehire account.
 *
 * career-ops keeps `data/applications.md` as the system of record (it works
 * across ALL providers, drives the dashboard, patterns, follow-ups, etc.).
 * This script PUSHES that state into freehire so you can browse and manage
 * your shortlist in the freehire web UI: it `save`s each matching job, drops
 * a `note` with the career-ops score, and maps the tracker status to a
 * freehire `stage`.
 *
 * Only freehire-sourced jobs can sync (freehire tracks by slug). Jobs whose
 * posting URL isn't in the scan-time cache (data/freehire-cache.jsonl) are
 * skipped and reported — nothing is lost, they just stay local-only.
 *
 * Safe by default: prints a plan and changes nothing. Pass --apply to write.
 *
 * Usage:
 *   node freehire-sync.mjs                 # dry-run, score >= 4.0
 *   node freehire-sync.mjs --apply         # execute save/note/stage
 *   node freehire-sync.mjs --min-score 3.5 # widen the shortlist
 *   node freehire-sync.mjs --no-note       # skip the score note
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TRACKER = path.join(ROOT, 'data', 'applications.md');
const CACHE = path.join(ROOT, 'data', 'freehire-cache.jsonl');
const FREEHIRE_BIN = process.env.FREEHIRE_BIN || 'freehire';

// career-ops status (templates/states.yml) → freehire stage. Stages allowed by
// the CLI: applied, screening, responded, interview, offer, accepted, rejected,
// withdrawn. "Evaluated" is pre-application — we save it but set no stage.
const STATUS_TO_STAGE = {
  Applied: 'applied',
  Responded: 'responded',
  Interview: 'interview',
  Offer: 'offer',
  Rejected: 'rejected',
  Discarded: 'withdrawn',
};
const SKIP_STATUSES = new Set(['SKIP']); // never push these

function parseArgs(argv) {
  const a = { apply: false, minScore: 4.0, note: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--no-note') a.note = false;
    else if (argv[i] === '--min-score') a.minScore = parseFloat(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') a.help = true;
  }
  return a;
}

function loadSlugByUrl() {
  const map = new Map();
  if (!existsSync(CACHE)) return map;
  for (const line of readFileSync(CACHE, 'utf-8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e.url && e.slug) map.set(e.url, e.slug); // last write wins
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

/** Parse the markdown tracker into row objects. */
function loadTrackerRows() {
  const rows = [];
  for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue; // data rows start with a number
    const c = line.split('|').map(s => s.trim());
    // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    const score = parseFloat(c[5]);
    const reportMatch = c[8] && c[8].match(/\(([^)]+)\)/);
    rows.push({
      num: c[1],
      company: c[3],
      role: c[4],
      score: Number.isNaN(score) ? null : score,
      status: c[6],
      reportPath: reportMatch ? reportMatch[1] : null,
      note: c[9] || '',
    });
  }
  return rows;
}

/** Resolve the posting URL recorded in a report's header. */
function urlFromReport(reportPath) {
  if (!reportPath) return null;
  // Tracker links are relative to data/; strip a leading ../ and anchor at ROOT.
  const rel = reportPath.replace(/^\.\.\//, '');
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return null;
  const m = readFileSync(abs, 'utf-8').match(/^\*\*URL:\*\*\s*(\S+)/m);
  return m ? m[1].trim() : null;
}

function runFreehire(args) {
  return execFileSync(FREEHIRE_BIN, args, { encoding: 'utf-8', maxBuffer: 4_000_000 });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node freehire-sync.mjs [--apply] [--min-score N] [--no-note]');
    return;
  }
  if (!existsSync(TRACKER)) {
    console.error(`freehire-sync: tracker not found at ${TRACKER}`);
    process.exit(1);
  }

  const slugByUrl = loadSlugByUrl();
  const rows = loadTrackerRows();

  const planned = [];
  const skippedNoSlug = [];
  for (const r of rows) {
    if (SKIP_STATUSES.has(r.status)) continue;
    if (r.score === null || r.score < args.minScore) continue;
    const url = urlFromReport(r.reportPath);
    const slug = url ? slugByUrl.get(url) : null;
    if (!slug) {
      skippedNoSlug.push(r);
      continue;
    }
    planned.push({ ...r, url, slug, stage: STATUS_TO_STAGE[r.status] || null });
  }

  console.log(
    `freehire-sync: ${planned.length} job(s) ≥ ${args.minScore}/5 to mirror` +
      (args.apply ? ' (APPLYING)' : ' (dry-run — pass --apply to write)'),
  );
  console.log('');

  for (const p of planned) {
    const actions = ['save', ...(args.note ? ['note'] : []), ...(p.stage ? [`stage:${p.stage}`] : [])];
    console.log(`  ${p.score.toFixed(1)}  ${p.company} — ${p.role}`);
    console.log(`        slug: ${p.slug}  →  ${actions.join(', ')}`);
    if (!args.apply) continue;
    try {
      runFreehire(['save', p.slug]);
      if (args.note) {
        runFreehire(['note', p.slug, `career-ops: ${p.score.toFixed(1)}/5 (report #${p.num}) — ${p.note}`.slice(0, 480)]);
      }
      if (p.stage) runFreehire(['stage', p.slug, p.stage]);
      console.log('        ✓ synced');
    } catch (err) {
      console.log(`        ✗ failed — ${String(err.stderr || err.message).trim()}`);
    }
  }

  if (skippedNoSlug.length) {
    console.log('');
    console.log(`Skipped ${skippedNoSlug.length} non-freehire job(s) (no slug in cache — stay local-only):`);
    for (const s of skippedNoSlug) console.log(`  - ${s.company} — ${s.role}`);
  }
}

main();
