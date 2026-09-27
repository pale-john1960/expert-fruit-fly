/**
 * Loader for the real MaleCNS connectome bundle (public/connectome/, 29
 * files ≈ 76 MB): manifest + neurons.json.gz + CSR offsets/sources/counts
 * parts, gzipped, sha256-verified.
 *
 * Pattern ported from `src/data-loader.js` of Xenova's fruit-fly-simulation
 * (MIT): each part is fetched as raw bytes, checksummed against
 * manifest.json, gunzipped with DecompressionStream and cached — in
 * CacheStorage, keyed by the file's sha256 — so the 76 MB download happens
 * once; later sessions reuse the cached chunks (still sha-verified).
 *
 * Data: MaleCNS v1.0 (Janelia/HHMI + Google + Cambridge/MRC LMB), CC BY 4.0.
 */

/** One row of neurons.json: [bodyId, type, superclass, side, nt, sign, pos|null] */
export type NeuronRow = [
  number,
  string,
  string,
  string | null,
  string,
  number,
  [number, number, number] | null,
];

export interface ConnectomeGraph {
  n: number;
  edges: number;
  /** parsed neurons.json rows — released (set to []) once the circuit is
   *  derived, to keep resident memory near the ~410 MB graph itself */
  neurons: NeuronRow[];
  /** neurotransmitter fast-sign per neuron (ACh +1, GABA/Glut −1, other 0) */
  sign: Int32Array;
  /** target-major CSR row pointers (len n+1) */
  offsets: Uint32Array;
  /** edge source indices (len = edges) */
  sources: Uint32Array;
  /** per-edge synapse counts (len = edges) */
  counts: Uint32Array;
}

export interface LoadProgress {
  /** data files completed (manifest counts as the first) */
  done: number;
  /** total data files (29 for this bundle) */
  total: number;
  file: string;
  phase: "download" | "verify" | "decompress" | "parse" | "wire";
}

type ProgressCb = (p: LoadProgress) => void;

const ASSET_ROOT = "/connectome";
const CACHE_NAME = "malecns-verified-data-v1";
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function digest(bytes: ArrayBuffer): Promise<string | null> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (x) =>
      x.toString(16).padStart(2, "0")
    ).join("");
  } catch {
    return null; // non-secure context — proceed without verification
  }
}

/** Fetch one file as raw bytes with a timeout + transient-status retries. */
async function requestBytes(url: string): Promise<ArrayBuffer> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return await response.arrayBuffer();
      await response.body?.cancel();
      if (!TRANSIENT.has(response.status)) {
        throw new Error(
          `Data download failed (HTTP ${response.status}) for ${url}`
        );
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      if (error instanceof Error && /HTTP \d+/.test(error.message)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
    await sleep(Math.min(4000, 500 * 2 ** attempt));
  }
  throw new Error(
    `The download was interrupted (${lastError?.message ?? "network error"}). Retry — completed chunks are kept.`
  );
}

interface ManifestPart {
  file: string;
  bytes: number;
  sha256: string;
}
interface ManifestArray {
  name: string;
  length: number;
  parts: ManifestPart[];
}
interface Manifest {
  neurons: number;
  edges: number;
  arrays: ManifestArray[];
  metadata: string;
}

/** Fetch → sha-verify → gunzip one part, through the sha-keyed cache. */
async function unpack(
  file: string,
  sha: string | null,
  onProgress: ProgressCb,
  countFile: () => void
): Promise<ArrayBuffer> {
  const url = `${ASSET_ROOT}/${file}`;
  const key = new URL(url, (globalThis.location?.href ?? "http://localhost/"));
  if (sha) key.searchParams.set("content", sha);
  let cache: Cache | null = null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME) : null;
  } catch {
    cache = null; // private browsing / storage restrictions
  }

  let bytes: ArrayBuffer | null = null;
  try {
    const saved = await cache?.match(key.href);
    if (saved) bytes = await saved.arrayBuffer();
  } catch {
    /* cache is optional */
  }
  // cached chunk must still checksum — corrupt entries are evicted
  if (bytes && sha) {
    onProgress({ done: 0, total: 29, file, phase: "verify" });
    if ((await digest(bytes)) !== sha) {
      await cache?.delete(key.href).catch(() => {});
      bytes = null;
    }
  }
  if (!bytes) {
    bytes = await requestBytes(url);
    if (sha) {
      const got = await digest(bytes);
      if (got !== null && got !== sha) {
        try {
          await cache?.delete(key.href);
        } catch {
          /* ignore */
        }
        throw new Error(
          `A downloaded data file failed its checksum (${file}). Please retry loading.`
        );
      }
    }
    try {
      if (cache && !(await cache.match(key.href))) {
        await cache.put(key.href, new Response(bytes));
      }
    } catch {
      /* storage quota — proceed without persisting */
    }
  }
  countFile();
  onProgress({ done: 0, total: 29, file, phase: "decompress" });
  try {
    return await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer();
  } catch {
    try {
      await cache?.delete(key.href);
    } catch {
      /* ignore */
    }
    throw new Error(
      `A data file could not be decompressed (${file}). Retry loading to download it again.`
    );
  }
}

/** total data files: manifest + metadata + every CSR part */
function totalFiles(manifest: Manifest): number {
  return (
    1 +
    1 +
    manifest.arrays.reduce((sum, a) => sum + a.parts.length, 0)
  );
}

async function loadGraph(onProgress: ProgressCb): Promise<ConnectomeGraph> {
  onProgress({ done: 0, total: 29, file: "manifest.json", phase: "download" });
  const manifestBytes = await requestBytes(`${ASSET_ROOT}/manifest.json`);
  const manifest: Manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const total = totalFiles(manifest);
  let done = 1; // manifest fetched
  const countFile = () => {
    done += 1;
  };
  const prog = (p: LoadProgress) => onProgress({ ...p, done, total });

  prog({ done: 0, total, file: manifest.metadata, phase: "download" });
  const neuronBytes = await unpack(manifest.metadata, null, prog, countFile);
  prog({ done, total, file: manifest.metadata, phase: "parse" });
  const neurons: NeuronRow[] = JSON.parse(new TextDecoder().decode(neuronBytes));
  if (!Array.isArray(neurons) || neurons.length !== manifest.neurons) {
    throw new Error("neurons.json is malformed (wrong row count)");
  }
  const graph: ConnectomeGraph = {
    n: manifest.neurons,
    edges: manifest.edges,
    neurons,
    sign: Int32Array.from(neurons, (row) => row[5]),
    offsets: new Uint32Array(0),
    sources: new Uint32Array(0),
    counts: new Uint32Array(0),
  };

  for (const array of manifest.arrays) {
    const values = new Uint32Array(array.length);
    let offset = 0;
    for (const part of array.parts) {
      prog({ done: 0, total, file: part.file, phase: "download" });
      const chunk = new Uint32Array(
        await unpack(part.file, part.sha256, prog, countFile)
      );
      if (offset + chunk.length > values.length) {
        throw new Error(`Invalid data length for ${array.name}`);
      }
      values.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== values.length) throw new Error(`Invalid data length for ${array.name}`);
    if (array.name === "offsets") graph.offsets = values;
    else if (array.name === "sources") graph.sources = values;
    else if (array.name === "counts") graph.counts = values;
  }

  if (
    graph.offsets.length !== graph.n + 1 ||
    graph.offsets[graph.n] !== graph.sources.length ||
    graph.counts.length !== graph.sources.length
  ) {
    throw new Error("Invalid CSR structure");
  }
  return graph;
}

/**
 * Load (or reuse) the connectome. The 76 MB download + decompression is
 * memoised per page session: the promise is cached at module scope, so
 * remounting the tab (or switching tabs and back) never re-downloads —
 * CacheStorage additionally persists it across sessions.
 * The FIRST caller's progress callback drives the loading UI.
 */
let cached: Promise<ConnectomeGraph> | null = null;

export function getConnectome(onProgress?: ProgressCb): Promise<ConnectomeGraph> {
  if (!cached) {
    cached = loadGraph(onProgress ?? (() => {})).catch((error: unknown) => {
      cached = null; // allow retry after a failure
      throw error;
    });
  }
  return cached;
}
