#!/usr/bin/env node
/**
 * Workspace corpus ingestion.
 *
 * Indexes documents into the memory database's reference corpus. Sources come
 * from two places, and both are ordinary paths by the time they get here:
 *
 *   1. the paths named on the command line (plus the defaults), and
 *   2. the configured ingestion folder, where UI uploads land.
 *
 * Re-running is cheap: unchanged content is skipped by sha256, so the command is
 * safe to put in a script or run after an upload without re-embedding the world.
 *
 *   node scripts/ingest-corpus.mjs --collection docs docs/ README.md
 *   node scripts/ingest-corpus.mjs --dry-run --collection docs docs/
 *   node scripts/ingest-corpus.mjs --inbox --collection uploads
 *   node scripts/ingest-corpus.mjs --list
 *
 * @module dsh-memory/scripts/ingest-corpus
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { MemoryService } from '../plugins/dsh-memory/service.js';
import { ingestPaths, DEFAULT_SKIP_DIRS } from '../plugins/dsh-memory/ingest.js';
import { defaultIngestFolder } from '../plugins/dsh-memory/inbox.js';
import { buildEmbedderEngine, memoryEmbedderStatus, setModelsRootOverride } from '../plugins/dsh-memory/plugin.js';

/** Paths indexed when the caller names none. */
export const DEFAULT_PATHS = ['docs', 'corpus'];

/** Default database location, matching the plugin. */
export function defaultStoragePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'storages', 'memory.db');
}

const USAGE = `Usage: node scripts/ingest-corpus.mjs [options] [paths...]

Index documents into the memory corpus. With no paths, the defaults are used
(${DEFAULT_PATHS.join(', ')}) — a path that does not exist is reported, not fatal.

Options:
  --collection <name>  Collection to write into (default: workspace)
  --root <dir>         Report source paths relative to this directory
  --inbox              Also ingest the configured ingestion folder (UI uploads)
  --inbox-only         Ingest only the ingestion folder
  --origin <kind>      Record the origin: workspace | session | transcript | upload
  --namespace <ns>     Record a namespace on the ingested sources
  --storage <path>     Database file (default: $DSH_HOME/storages/memory.db)
  --models-path <dir>  Where the embedding model is cached
  --force              Re-ingest even when the content hash is unchanged
  --dry-run            Report what would change without writing
  --json               Print the summary as JSON
  --list               List ingested sources and exit
  --vector-status      Report which encoder produced the stored vectors, and exit
  --reembed            Regenerate vectors that the active encoder cannot use
  --purge-vectors      Drop vectors the active encoder cannot use, keeping the text
  --help               Show this message
`;

/**
 * Parse argv.
 *
 * Hand-rolled rather than pulled from a dependency: the surface is small, and a
 * corpus tool should not add a package to the profile to read its own flags.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    paths: [], collection: 'workspace', root: null, inbox: false, inboxOnly: false,
    origin: 'workspace', namespace: null, storage: null, modelsPath: null,
    force: false, dryRun: false, json: false, list: false, help: false,
    vectorStatus: false, reembed: false, purgeVectors: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--collection': options.collection = next(); break;
      case '--root': options.root = next(); break;
      case '--inbox': options.inbox = true; break;
      case '--inbox-only': options.inboxOnly = true; options.inbox = true; break;
      case '--origin': options.origin = next(); break;
      case '--namespace': options.namespace = next(); break;
      case '--storage': options.storage = next(); break;
      case '--models-path': options.modelsPath = next(); break;
      case '--force': options.force = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--json': options.json = true; break;
      case '--list': options.list = true; break;
      case '--vector-status': options.vectorStatus = true; break;
      case '--reembed': options.reembed = true; break;
      case '--purge-vectors': options.purgeVectors = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        options.paths.push(arg);
    }
  }
  return options;
}

/** Existing paths from a candidate list, preserving order. */
function existingPaths(candidates) {
  return candidates.filter((path) => {
    if (!existsSync(path)) return false;
    try { return statSync(path).isDirectory() || statSync(path).isFile(); } catch { return false; }
  });
}

/**
 * Run the command.
 *
 * @param {string[]} argv
 * @param {object} [io] Injectable stdout/stderr, so the argument handling is testable.
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`error: ${error.message}`);
    err(USAGE);
    return 2;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }

  const storagePath = options.storage ?? defaultStoragePath();
  const service = new MemoryService({
    storagePath,
    defaultNamespace: options.namespace ?? 'global',
    logger: { warn: (message) => err(message) },
  });

  // Ingest with the real encoder when one is cached. Falling back to the
  // deterministic embedder silently would fill the corpus with vectors that
  // retrieve badly, so say which one this run is using.
  if (options.modelsPath) setModelsRootOverride(options.modelsPath);
  const engine = buildEmbedderEngine();
  if (engine) {
    service.embedder = engine;
  } else {
    const status = memoryEmbedderStatus();
    err(`warning: no cached embedding model; using the deterministic embedder (${status.reason})`);
    err('         run the plugin\'s Prepare control, or POST /api/memory/prepare-embedder, to index with real vectors');
  }

  try {
    // Vector provenance comes before any walking: it answers a question about the
    // index, not about the filesystem.
    if (options.vectorStatus || options.reembed || options.purgeVectors) {
      if (options.reembed) {
        let total = 0;
        let remaining = 1;
        // Bounded steps, repeated until nothing is left; one call never holds a
        // whole corpus in flight.
        while (remaining > 0) {
          const round = await service.reembedMissing({ limit: 200 });
          if (!round.ok) { err(`error: ${round.error}`); return 1; }
          total += round.embedded;
          remaining = round.remaining;
          if (options.json) out(JSON.stringify(round));
          else out(`  embedded ${round.embedded} · skipped ${round.skipped} · failed ${round.failed} · remaining ${round.remaining}`);
          if (round.embedded === 0 && round.failed === 0) break;
        }
        if (!options.json) out(`re-embedded ${total} item(s) for ${service.activeModel()}`);
      }
      if (options.purgeVectors) {
        const purged = service.purgeForeignVectors();
        if (!purged.ok) { err(`error: ${purged.error}`); return 1; }
        if (options.json) out(JSON.stringify(purged));
        else out(`purged ${purged.purged.total} vector(s) the active encoder cannot use; the text is untouched`);
      }
      const vectors = service.vectorStatus();
      if (options.json) out(JSON.stringify(vectors, null, 2));
      else {
        out(`active encoder: ${vectors.activeModel ?? '(none declared)'}`);
        for (const entry of vectors.byModel) out(`  ${String(entry.count).padStart(5)}  ${entry.kind.padEnd(8)} ${entry.model}`);
        if (vectors.stale) {
          out(`  stale: ${vectors.stale.total} (${vectors.foreign?.total ?? 0} from another encoder, ${vectors.missing?.total ?? 0} with no vector)`);
        }
      }
      return 0;
    }

    if (options.list) {
      const sources = service.listCorpusSources({ collection: options.collection, limit: 500 });
      if (options.json) {
        out(JSON.stringify({ collection: options.collection, count: sources.length, sources }, null, 2));
      } else {
        out(`${sources.length} source(s) in collection "${options.collection}"`);
        for (const source of sources) {
          out(`  ${source.chunk_count.toString().padStart(4)} chunks  ${source.content_hash.slice(0, 8)}  ${source.origin.padEnd(10)} ${source.source_path}`);
        }
      }
      return 0;
    }

    const candidates = [];
    if (!options.inboxOnly) {
      candidates.push(...(options.paths.length > 0 ? options.paths : DEFAULT_PATHS));
    }
    if (options.inbox) candidates.push(defaultIngestFolder());

    const usable = existingPaths(candidates);
    const missing = candidates.filter((path) => !usable.includes(path));
    // A default that is absent is normal — a workspace without `corpus/` is not a
    // failure. A path the caller named is a mistake worth reporting.
    const namedMissing = options.paths.filter((path) => missing.includes(path));
    for (const path of namedMissing) err(`warning: ${path} does not exist; skipped`);

    if (usable.length === 0) {
      err('nothing to ingest: no existing source paths');
      return 1;
    }

    const { records, summary } = await ingestPaths(service, {
      paths: usable,
      collection: options.collection,
      root: options.root,
      origin: options.origin,
      namespace: options.namespace ?? null,
      force: options.force,
      dryRun: options.dryRun,
    });

    if (options.json) {
      out(JSON.stringify({ summary, records }, null, 2));
    } else {
      out(`${options.dryRun ? 'dry run: ' : ''}collection "${summary.collection}"`);
      const changed = records.filter((r) => r.status === 'ingested' || r.status === 'would-ingest');
      for (const record of changed) {
        const verb = record.status === 'ingested' ? 'indexed' : 'would index';
        out(`  ${verb} ${record.chunkCount ?? '?'} chunk(s)  ${record.sourcePath}`);
      }
      out(`  scanned ${summary.scanned} · ${options.dryRun ? 'would index' : 'indexed'} ${summary.ingested + summary.wouldIngest} · skipped ${summary.skipped} · unsupported ${summary.unsupported} · failed ${summary.failed} · chunks ${summary.chunks}`);
      if (summary.truncated) out('  note: the file walk hit its ceiling; re-run to continue');
    }

    return summary.failed > 0 || namedMissing.length > 0 ? 1 : 0;
  } finally {
    service.close();
  }
}

// Run only when invoked directly, so the module can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`error: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}

export { DEFAULT_SKIP_DIRS, defaultIngestFolder };
