#!/usr/bin/env node
/**
 * Keeps docs/PANEL_WORKFLOWS.md from drifting away from server.ts.
 *
 * The inventory is only useful while it is true, and prose about 104 routes rots
 * the moment a route is renamed, added or moved to another line. So the appendix
 * table is *generated* from server.ts rather than maintained by hand, and this
 * verifies the document against the source it describes:
 *
 *  1. Appendix — the table between the GENERATED markers matches the routes in
 *     server.ts exactly: same method+path set, no stale row, and every
 *     `#L<n>` anchor still points at the line that defines that route.
 *  2. Endpoints — every `/api/...` path named in the prose is a real route, and
 *     any method written next to it is a method that route actually answers.
 *  3. Links — every relative link in the doc resolves on disk.
 *  4. Numbers — the "N route definitions" summary and the "N of the M routes"
 *     entitlement count match what the source contains.
 *
 * What it deliberately does not check: whether the prose *describes* the route
 * correctly. That needs a reviewer, not a regex. The markers are the boundary —
 * everything inside them is machine-owned, everything outside is editorial.
 *
 * Usage:
 *   node scripts/check-workflows-doc.mjs          # verify, exit 1 on drift
 *   node scripts/check-workflows-doc.mjs --fix    # regenerate the appendix
 *
 * Exit: 0 in sync, 1 drift found (or the file could not be read).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'PANEL_WORKFLOWS.md');
const SERVER = path.join(ROOT, 'server.ts');

const BEGIN = '<!-- BEGIN GENERATED: routes -->';
const END = '<!-- END GENERATED: routes -->';

function fail(problems) {
  console.error(`[docs] FAILED — ${problems.length} problem(s) between the doc and server.ts:`);
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  if (problems.length > 40) console.error(`  … ${problems.length - 40} more`);
  console.error(
    '\nThe appendix is generated, not hand-written: run ' +
      '`npm run check:docs -- --fix` to rebuild it, then fix the prose, links and ' +
      'counts it reports above.',
  );
  process.exit(1);
}

/**
 * Every route definition, with the 1-based line it starts on so the appendix can
 * link straight to it. Definitions are single-line here (app.get('/x', ...));
 * a multi-line reformat would simply drop out of this list and fail the diff,
 * which is the loud failure we want rather than a silently shorter appendix.
 */
function readRoutes(source) {
  const routes = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const match = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(line);
    if (!match) return;
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      line: index + 1,
      gated: line.includes('requireAdvancedPanel'),
    });
  });
  return routes;
}

const key = (route) => `${route.method} ${route.path}`;

function sortRoutes(routes) {
  return [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function renderTable(routes) {
  const rows = ['| Method | Path | Defined at |', '| --- | --- | --- |'];
  for (const route of sortRoutes(routes)) {
    rows.push(
      `| ${route.method} | \`${route.path}\` | [server.ts:${route.line}](../server.ts#L${route.line}) |`
    );
  }
  return rows.join('\n');
}

/** Rows of the generated table, parsed back out of the document. */
function parseTable(block) {
  const rows = [];
  for (const line of block.split(/\r?\n/)) {
    const match =
      /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|\s*\[server\.ts:(\d+)\]\(\.\.\/server\.ts#L(\d+)\)\s*\|$/.exec(
        line.trim()
      );
    if (match) rows.push({ method: match[1], path: match[2], line: Number(match[3]) });
  }
  return rows;
}

/* ---------------------------------------------------------------- appendix */

function checkAppendix(doc, routes, sourceLines) {
  const problems = [];
  const beginAt = doc.indexOf(BEGIN);
  const endAt = doc.indexOf(END);

  if (beginAt === -1 || endAt === -1) {
    return [
      `the generated table is no longer wrapped in ${BEGIN} … ${END}, so it cannot be ` +
        'regenerated or compared safely',
    ];
  }
  if (endAt < beginAt) return ['the END marker appears before the BEGIN marker'];
  if (doc.indexOf(BEGIN, beginAt + 1) !== -1 || doc.indexOf(END, endAt + 1) !== -1) {
    return ['only one GENERATED block is supported, but the markers appear more than once'];
  }

  const actual = parseTable(doc.slice(beginAt + BEGIN.length, endAt));
  const expected = sortRoutes(routes);
  const byKey = new Map(expected.map((route) => [key(route), route]));
  const seen = new Set();

  for (const row of actual) {
    const route = byKey.get(key(row));
    if (!route) {
      problems.push(`stale row: ${key(row)} is not defined in server.ts any more`);
      continue;
    }
    if (seen.has(key(row))) {
      problems.push(`duplicate row: ${key(row)} is listed more than once`);
      continue;
    }
    seen.add(key(row));
    if (row.line !== route.line) {
      problems.push(
        `moved anchor: ${key(row)} is linked at server.ts:${row.line} but is defined at line ${route.line}`
      );
      continue;
    }
    const definition = sourceLines[row.line - 1] ?? '';
    if (!definition.includes(`${route.method.toLowerCase()}('${route.path}'`)) {
      problems.push(
        `wrong anchor: server.ts:${row.line} does not define ${route.method} ${route.path}`
      );
    }
  }

  const missing = expected.filter((route) => !seen.has(key(route)));
  for (const route of missing) {
    problems.push(`missing row: ${key(route)} (server.ts:${route.line}) is not in the appendix`);
  }

  if (problems.length === 0) {
    const block = doc.slice(beginAt + BEGIN.length, endAt).trim();
    if (block !== renderTable(routes)) {
      problems.push(
        'the table content differs from a fresh generation (row order, spacing or header)',
      );
    }
  }
  return problems;
}

/* --------------------------------------------------------------- endpoints */

/** `/api/...` paths named in backticks, with whatever methods precede them. */
function checkEndpoints(doc, routes) {
  const problems = [];
  const appendixAt = doc.indexOf(BEGIN);
  const body = appendixAt === -1 ? doc : doc.slice(0, appendixAt);
  const routePaths = new Set(routes.map((route) => route.path));
  const pairs = new Set(routes.map(key));

  for (const span of body.match(/`[^`\n]+`/g) ?? []) {
    const inner = span.slice(1, -1);
    const pattern =
      /((?:(?:GET|POST|PUT|PATCH|DELETE)[\s/]+)+)?(\/api\/[A-Za-z0-9_\-:./]+)/g;
    for (const match of inner.matchAll(pattern)) {
      const methods = match[1] ? match[1].match(/GET|POST|PUT|PATCH|DELETE/g) : [];
      const route = match[2].replace(/[.,)]+$/, '');
      if (!routePaths.has(route)) {
        problems.push(
          `unknown endpoint: ${route}${methods.length ? ` (written as ${methods.join('/')})` : ''} in ${span}`
        );
        continue;
      }
      for (const method of methods) {
        if (!pairs.has(`${method} ${route}`)) {
          const actual = routes
            .filter((candidate) => candidate.path === route)
            .map((candidate) => candidate.method)
            .join(', ');
          problems.push(
            `wrong method: ${method} ${route} is not defined; server.ts has ${actual} for that path`
          );
        }
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------- links */

function checkLinks(doc) {
  const problems = new Set();
  for (const [, target] of doc.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const relative = target.split('#')[0];
    if (!relative) continue;
    if (!existsSync(path.resolve(path.dirname(DOC), relative))) {
      problems.add(`broken link: ${target} (${doc.split(target).length - 1} occurrence(s))`);
    }
  }
  return [...problems];
}

/* ----------------------------------------------------------------- numbers */

function checkNumbers(doc, routes) {
  const problems = [];
  const countOf = (method) => routes.filter((route) => route.method === method).length;

  const summary = new RegExp(
    `(\\d+) route definitions[^\\n]*?(\\d+)\\s*\`POST\`[^\\n]*?(\\d+)\\s*\`GET\`[^\\n]*?(\\d+)\\s*\`DELETE\``
  ).exec(doc);
  if (!summary) {
    problems.push(
      'the route summary is missing or reworded; expected "<N> route definitions — <N> `POST`, ' +
        '<N> `GET`, <N> `DELETE`" so those numbers can be checked against server.ts'
    );
  } else {
    const stated = {
      total: Number(summary[1]),
      POST: Number(summary[2]),
      GET: Number(summary[3]),
      DELETE: Number(summary[4]),
    };
    if (stated.total !== routes.length) {
      problems.push(`the doc claims ${stated.total} routes, server.ts defines ${routes.length}`);
    }
    for (const method of ['POST', 'GET', 'DELETE']) {
      if (stated[method] !== countOf(method)) {
        problems.push(
          `the doc claims ${stated[method]} ${method} routes, server.ts defines ${countOf(method)}`
        );
      }
    }
  }

  const other = countOf('PUT') + countOf('PATCH');
  if (other > 0 && /\(no `PUT`\/`PATCH`\)/.test(doc)) {
    problems.push(
      `the doc says there are no PUT/PATCH routes, but server.ts defines ${other} — update that claim`
    );
  }

  const gated = new RegExp(`(\\d+) of the (\\d+) routes`).exec(doc);
  if (!gated) {
    problems.push(
      'the entitlement sentence is missing or reworded; expected "<N> of the <M> routes" so the ' +
        'requireAdvancedPanel count can be checked'
    );
  } else {
    const statedGated = Number(gated[1]);
    const statedTotal = Number(gated[2]);
    const actualGated = routes.filter((route) => route.gated).length;
    if (statedTotal !== routes.length) {
      problems.push(`that sentence says ${statedTotal} routes, server.ts defines ${routes.length}`);
    }
    if (statedGated !== actualGated) {
      problems.push(
        `the doc says requireAdvancedPanel guards ${statedGated} routes, server.ts applies it to ${actualGated}`
      );
    }
  }
  return problems;
}

/* -------------------------------------------------------------------- main */

function main() {
  const fix = process.argv.includes('--fix');
  if (!existsSync(DOC)) {
    console.error(`[docs] ${path.relative(ROOT, DOC)} does not exist`);
    process.exit(1);
  }

  const source = readFileSync(SERVER, 'utf8');
  const sourceLines = source.split(/\r?\n/);
  const routes = readRoutes(source);
  if (routes.length === 0) {
    console.error(
      '[docs] found no app.get/post/… definitions in server.ts — the extractor no longer ' +
        'matches how routes are written, so this check would pass on a wrong document'
    );
    process.exit(1);
  }

  let doc = readFileSync(DOC, 'utf8');
  if (fix) {
    const beginAt = doc.indexOf(BEGIN);
    const endAt = doc.indexOf(END);
    if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
      console.error(`[docs] cannot --fix without the ${BEGIN} … ${END} markers`);
      process.exit(1);
    }
    const rebuilt = `${doc.slice(0, beginAt + BEGIN.length)}\n${renderTable(routes)}\n${doc.slice(endAt)}`;
    if (rebuilt !== doc) {
      writeFileSync(DOC, rebuilt);
      doc = rebuilt;
      console.log('[docs] appendix regenerated from server.ts');
    } else {
      console.log('[docs] appendix already current');
    }
  }

  const problems = [
    ...checkAppendix(doc, routes, sourceLines),
    ...checkEndpoints(doc, routes),
    ...checkLinks(doc),
    ...checkNumbers(doc, routes),
  ];
  if (problems.length) fail(problems);

  const gated = routes.filter((route) => route.gated).length;
  console.log(
    `[docs] OK  ${routes.length} routes match the appendix, prose endpoints and links resolve, ` +
      `${gated} entitlement-gated`
  );
}

try {
  main();
} catch (err) {
  console.error(`[docs] could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
