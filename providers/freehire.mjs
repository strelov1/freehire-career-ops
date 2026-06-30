// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// freehire provider — shells out to the `freehire` CLI (a thin client over the
// freehire.dev API). Unlike greenhouse/ashby, this is a *query* source: one
// portals.yml entry = one faceted search, not one company. The CLI emits a
// flat JSON array with `--json`, so we exec it the same way local-parser does
// (execFile, no shell → no injection) and ignore the HTTP ctx.
//
// Auth is handled out-of-band: `freehire auth login` stores a key in
// ~/.freehire/creds.json. If the key is missing the CLI errors and we surface
// it verbatim.
//
// portals.yml shape (nested, namespaced under `freehire:`):
//
//   - name: freehire — AI Engineer EU
//     provider: freehire
//     enabled: true
//     freehire:
//       query: "AI engineer"      # positional <query>; optional if facets given
//       limit: 50                 # --limit (default 50)
//       offset: 0                 # --offset
//       remote: true              # --remote
//       region: [eu, us]          # --region (repeatable)
//       seniority: [senior, staff]# --seniority (repeatable)
//       category: [ml_ai]         # --category (repeatable)
//       skills: [python, go]      # --skills (repeatable)
//       company: [apollo-io]      # --company slug (repeatable)
//       bin: freehire             # override binary (else $FREEHIRE_BIN or PATH)
//       api_url: https://...      # --api-url override

import { execFile } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// url → slug cache, written at scan time so freehire-jd.mjs can later resolve a
// posting URL back to its freehire slug and pull the FULL JD (the search API
// only returns a truncated description). Best-effort: a cache write failure
// must never break a scan.
const CACHE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'freehire-cache.jsonl',
);

function writeJdCache(rows) {
  if (!rows.length) return;
  try {
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    appendFileSync(CACHE_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  } catch {
    /* best-effort cache — ignore */
  }
}

const FREEHIRE_TIMEOUT_MS = 30_000;
const FREEHIRE_MAX_BUFFER_BYTES = 8_000_000;
const FREEHIRE_DEFAULT_LIMIT = 50;
const FREEHIRE_MAX_LIMIT = 200;

// Closed enums the CLI validates strictly — a typo here would make the whole
// `freehire search` invocation fail, so we drop unknown values (with a warning)
// instead of forwarding them. category/skills/company are open-ended (slugs /
// free text), so they pass through as trimmed strings.
const REGIONS = new Set(['global', 'ru', 'cis', 'central_asia', 'eu', 'us']);
const SENIORITIES = new Set([
  'intern', 'junior', 'middle', 'senior', 'staff', 'principal', 'lead', 'c_level',
]);

/** @param {unknown} value */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

/**
 * Append a repeatable facet flag, validating against a closed enum when given.
 * @param {string[]} args
 * @param {string} flag
 * @param {unknown} value
 * @param {Set<string>} [allowed]
 */
function pushFacet(args, flag, value, allowed) {
  for (const raw of asList(value)) {
    const s = String(raw).trim();
    if (!s) continue;
    if (allowed && !allowed.has(s)) {
      console.error(`⚠️  freehire: ignoring invalid ${flag} value "${s}"`);
      continue;
    }
    args.push(flag, s);
  }
}

/** @param {Record<string, unknown>} cfg */
function buildSearchArgs(cfg) {
  const query = String(cfg.query ?? '').trim();
  const args = ['search'];
  if (query) args.push(query);

  const rawLimit = Number(cfg.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), FREEHIRE_MAX_LIMIT)
    : FREEHIRE_DEFAULT_LIMIT;
  args.push('--limit', String(limit));

  const rawOffset = Number(cfg.offset);
  if (Number.isFinite(rawOffset) && rawOffset > 0) {
    args.push('--offset', String(Math.floor(rawOffset)));
  }

  if (cfg.remote === true) args.push('--remote');

  pushFacet(args, '--region', cfg.region, REGIONS);
  pushFacet(args, '--seniority', cfg.seniority, SENIORITIES);
  pushFacet(args, '--category', cfg.category);
  pushFacet(args, '--skills', cfg.skills);
  pushFacet(args, '--company', cfg.company);

  if (cfg.api_url) args.push('--api-url', String(cfg.api_url));
  args.push('--json');
  return { args, query };
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {any} job @param {import('./_types.js').PortalEntry} entry */
function normalizeJob(job, entry) {
  if (!job || typeof job !== 'object') return null;
  if (job.closed_at) return null; // skip postings freehire marks closed
  const title = String(job.title || '').trim();
  const url = String(job.url || '').trim();
  if (!title || !url) return null;
  return {
    title,
    url,
    company: String(job.company || job.company_slug || entry.name || '').trim(),
    location: String(job.location || '').trim(),
    postedAt: toEpochMs(job.posted_at),
    // Carried for the JD cache (see writeJdCache); scan.mjs ignores extra keys.
    slug: String(job.public_slug || '').trim(),
  };
}

/** @type {Provider} */
export default {
  id: 'freehire',

  detect(entry) {
    // Claim entries carrying a `freehire:` config block, or a freehire.dev
    // careers_url. Explicit `provider: freehire` skips detect() entirely.
    if (entry.freehire && typeof entry.freehire === 'object') return { url: 'freehire-cli' };
    const url = entry.careers_url || '';
    try {
      if (url && new URL(url).hostname.endsWith('freehire.dev')) return { url };
    } catch {
      /* not a URL — fall through */
    }
    return null;
  },

  async fetch(entry) {
    const cfg = entry.freehire && typeof entry.freehire === 'object'
      ? /** @type {Record<string, unknown>} */ (entry.freehire)
      : {};
    const { args, query } = buildSearchArgs(cfg);

    // A search needs at least a query or one filtering facet — otherwise the
    // CLI returns an unbounded firehose. Fail loud with a fixable message.
    const hasFacet = args.some(a => a.startsWith('--') && a !== '--limit' && a !== '--json');
    if (!query && !hasFacet) {
      throw new Error(
        `freehire: entry "${entry.name}" has no query or facets — set freehire.query (or a facet)`,
      );
    }

    const bin = String(cfg.bin || process.env.FREEHIRE_BIN || 'freehire');

    let stdout;
    try {
      ({ stdout } = await execFileAsync(bin, args, {
        timeout: FREEHIRE_TIMEOUT_MS,
        maxBuffer: FREEHIRE_MAX_BUFFER_BYTES,
        windowsHide: true,
      }));
    } catch (err) {
      const detail = (err && (err.stderr || err.message)) ? String(err.stderr || err.message).trim() : '';
      if (err && err.code === 'ENOENT') {
        throw new Error(`freehire: "${bin}" not found on PATH — install the CLI or set freehire.bin`);
      }
      throw new Error(`freehire: search failed${detail ? ` — ${detail}` : ''}`);
    }

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error('freehire: CLI returned invalid JSON (is it up to date? did `--json` work?)');
    }

    const rawJobs = Array.isArray(payload) ? payload : payload?.jobs || payload?.results;
    if (!Array.isArray(rawJobs)) {
      throw new Error('freehire: expected a JSON array (or {jobs:[]}/{results:[]})');
    }

    const jobs = rawJobs.map(job => normalizeJob(job, entry)).filter(Boolean);

    // Persist url → slug so freehire-jd.mjs can fetch the FULL JD later.
    writeJdCache(
      jobs
        .filter(j => j.slug)
        .map(j => ({ url: j.url, slug: j.slug, title: j.title, company: j.company })),
    );

    return jobs;
  },
};
