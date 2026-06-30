#!/usr/bin/env node

/**
 * freehire-jd.mjs — Fetch a full job description from the freehire CLI.
 *
 * The freehire *search* endpoint returns a truncated `description` (~1KB), but
 * `freehire job <slug>` returns the full JD. The scanner caches `url → slug`
 * at scan time (data/freehire-cache.jsonl, written by providers/freehire.mjs),
 * so this helper can resolve a posting URL back to its freehire slug and pull
 * the complete JD — no WebFetch, no JS-rendered ATS pages, zero extraction
 * failures.
 *
 * Usage:
 *   node freehire-jd.mjs <slug>            # full JD by freehire public_slug
 *   node freehire-jd.mjs --url <jobUrl>    # resolve slug via cache, then JD
 *   node freehire-jd.mjs --json <slug>     # raw freehire job JSON passthrough
 *
 * Output (default): markdown — a small header block + the JD body converted
 * from HTML to readable markdown. Exit 0 on success, non-zero on failure.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(ROOT, 'data', 'freehire-cache.jsonl');
const FREEHIRE_BIN = process.env.FREEHIRE_BIN || 'freehire';

function fail(msg) {
  console.error(`freehire-jd: ${msg}`);
  process.exit(1);
}

/** Resolve a posting URL to a freehire slug via the scan-time cache. */
function slugFromUrl(url) {
  if (!existsSync(CACHE_PATH)) {
    fail(`no cache at ${CACHE_PATH} — run a freehire scan first (node scan.mjs)`);
  }
  const lines = readFileSync(CACHE_PATH, 'utf-8').split('\n').filter(Boolean);
  // Last write wins — later scans supersede earlier slugs for the same URL.
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.url === url && entry.slug) return entry.slug;
  }
  fail(`URL not found in cache: ${url}`);
}

/** Decode the handful of HTML entities freehire JDs actually contain. */
function decodeEntities(s) {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&rsquo;', '’')
    .replaceAll('&nbsp;', ' ');
}

/** Light HTML → markdown for JD bodies (headings, lists, paragraphs, breaks). */
function htmlToMarkdown(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<\s*(h[1-6])[^>]*>(.*?)<\s*\/\s*\1\s*>/gis, (_, _tag, txt) => `\n\n## ${txt.trim()}\n`);
  s = s.replace(/<\s*li[^>]*>(.*?)<\s*\/\s*li\s*>/gis, (_, txt) => `\n- ${txt.trim()}`);
  s = s.replace(/<\s*\/\s*(p|div|ul|ol)\s*>/gi, '\n\n');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ''); // strip remaining tags
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function fetchJob(slug) {
  let stdout;
  try {
    stdout = execFileSync(FREEHIRE_BIN, ['job', slug, '--json'], {
      maxBuffer: 8_000_000,
      encoding: 'utf-8',
    });
  } catch (err) {
    if (err.code === 'ENOENT') fail(`"${FREEHIRE_BIN}" not found on PATH`);
    fail(`freehire job ${slug} failed — ${String(err.stderr || err.message).trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail('freehire returned invalid JSON');
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node freehire-jd.mjs <slug> | --url <jobUrl> | --json <slug>');
    process.exit(args.length === 0 ? 1 : 0);
  }

  const rawJson = args.includes('--json');
  const urlIdx = args.indexOf('--url');
  let slug;
  if (urlIdx !== -1) {
    const url = args[urlIdx + 1];
    if (!url) fail('--url requires a value');
    slug = slugFromUrl(url);
  } else {
    slug = args.find(a => !a.startsWith('--'));
    if (!slug) fail('missing slug');
  }

  const job = fetchJob(slug);

  if (rawJson) {
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    return;
  }

  if (job.closed_at) {
    console.error(`freehire-jd: warning — posting is CLOSED (closed_at=${job.closed_at})`);
  }

  const header = [
    `# ${job.title || ''} — ${job.company || ''}`,
    '',
    `**URL:** ${job.url || ''}`,
    `**Location:** ${job.location || ''}`,
    `**Work mode:** ${job.work_mode || ''}`,
    `**Posted:** ${job.posted_at || ''}`,
    job.closed_at ? `**Closed:** ${job.closed_at}` : null,
    '',
    '---',
    '',
  ].filter(l => l !== null).join('\n');

  process.stdout.write(header + htmlToMarkdown(job.description) + '\n');
}

main();
