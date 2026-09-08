import { SUGGEST_THRESHOLD, TRAIL_BUFFER_METRES } from "@/lib/trails";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface NamedWay {
  name: string;
  nodes: LatLon[];
}

export interface NameCandidate {
  name: string;
  coverage: number;
  textBoost: number;
  score: number;
}

export interface SuggestNameResult {
  name: string;
  confidence: number;
  candidates: NameCandidate[];
}

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_TIMEOUT_MS = 20_000;
// No contact address: Overpass's usage policy asks for one, but this string
// is sent to a third-party service outside our control, and putting a
// person's email in a header that leaves our infrastructure is exactly the
// kind of unrelated-service exposure to avoid. A descriptive, non-personal
// agent string is what the policy actually needs to identify abusive
// clients by.
const USER_AGENT = "waypoint-trail-naming/1.0 (+https://github.com/waypoint-app/waypoint)";

interface OverpassElement {
  type?: string;
  tags?: { name?: string };
  geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function overpassQuery(bbox: BoundingBox): string {
  return (
    `[out:json][timeout:40];` +
    `way[highway~"^(path|footway|track|bridleway)$"][name]` +
    `(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});` +
    `out geom;`
  );
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OVERPASS_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Queries Overpass for every named path/footway/track/bridleway intersecting
 * `bbox`. Never throws: naming is a nice-to-have layered on top of a trail
 * that already exists from the activity's own name (see trail-match.ts), so
 * any failure here -- a timeout, a non-200, a malformed body -- must lose
 * the caller only a label, never bubble into ingest. Returns null on any
 * failure; an empty array is a legitimate "no named ways here" result.
 */
export async function fetchNamedWays(bbox: BoundingBox, signal?: AbortSignal): Promise<NamedWay[] | null> {
  try {
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: `data=${encodeURIComponent(overpassQuery(bbox))}`,
      signal: combinedSignal(signal),
    });

    if (!response.ok) {
      console.error(`Overpass request failed: HTTP ${response.status}`);
      return null;
    }

    const body = (await response.json()) as OverpassResponse;
    const elements = body.elements ?? [];
    return elements
      .filter(
        (element): element is OverpassElement & { tags: { name: string }; geometry: LatLon[] } =>
          element.type === "way" &&
          typeof element.tags?.name === "string" &&
          Array.isArray(element.geometry) &&
          element.geometry.length > 0,
      )
      .map((element) => ({ name: element.tags.name, nodes: element.geometry }));
  } catch (error) {
    console.error("Overpass fetch failed:", error);
    return null;
  }
}

// Stop words for the text-overlap boost. Trail vocabulary ("trail", "loop",
// "basin") and this author's own recurring activity names ("hike", "morning",
// "evening", "afternoon") would otherwise create token overlap against nearly
// every OSM candidate, manufacturing false confidence. "the" is the one
// general English stop word needed for names like "Mount Harvard/Horn Fork
// Trail" written with connective words.
const STOP_WORDS = new Set(["trail", "hike", "the", "morning", "evening", "afternoon", "basin", "loop"]);

function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(tokens.filter((token) => !STOP_WORDS.has(token)));
}

const EARTH_RADIUS_M = 6_371_000;

function haversineMetres(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// A real track runs to 15,000 points; testing every point against every way
// node is O(points * ways * nodes) and not worth paying for. Capped, evenly
// spaced sampling is safe under the 40 m buffer because consecutive GPS
// points a few metres apart are almost always on the same side of that
// buffer as their neighbours -- coverage is a spatially smooth quantity, not
// one that flips point-to-point. 300 samples keeps the inner loop fast for
// any bbox Overpass returns.
const MAX_SAMPLE_POINTS = 300;

function sampleTrackPoints(points: LatLon[]): LatLon[] {
  if (points.length <= MAX_SAMPLE_POINTS) return points;
  const step = points.length / MAX_SAMPLE_POINTS;
  const sampled: LatLon[] = [];
  for (let i = 0; i < MAX_SAMPLE_POINTS; i++) {
    const index = Math.min(points.length - 1, Math.floor(i * step));
    sampled.push(points[index] as LatLon);
  }
  return sampled;
}

function isWithinBuffer(point: LatLon, nodes: LatLon[]): boolean {
  return nodes.some((node) => haversineMetres(point, node) <= TRAIL_BUFFER_METRES);
}

/**
 * Pure and network-free, so it is unit-testable against recorded Overpass
 * fixtures. Scores each distinct way *name* (OSM often splits one trail into
 * several ways at junctions; pooling by name keeps a long trail from
 * appearing as several weak fragments instead of one strong candidate) by
 * the fraction of sampled track points lying within `TRAIL_BUFFER_METRES` of
 * any node belonging to a way with that name, then adds a small boost for
 * token overlap with the activity's own name/notes text.
 *
 * The boost weight (0.25) and its normalisation (overlap / activity token
 * count) were measured against the Mount Harvard near-tie: two candidates at
 * 49.7% and 49.0% raw coverage, activity named "Mount Harvard". The
 * activity's tokens {mount, harvard} both appear in "Mount Harvard/Horn Fork
 * Trail" (boost 0.25) and neither appears in "Horn Fork Basin Trail" (boost
 * 0), giving final scores 0.747 vs 0.490 -- a decisive, correct win that the
 * raw coverage numbers alone do not provide.
 */
export function scoreNameCandidates(
  trackPoints: LatLon[],
  ways: NamedWay[],
  activityText: string,
): NameCandidate[] {
  const sampled = sampleTrackPoints(trackPoints);
  const activityTokens = tokenize(activityText);

  const nodesByName = new Map<string, LatLon[]>();
  for (const way of ways) {
    const existing = nodesByName.get(way.name);
    if (existing) {
      existing.push(...way.nodes);
    } else {
      nodesByName.set(way.name, [...way.nodes]);
    }
  }

  const candidates: NameCandidate[] = [];
  for (const [name, nodes] of nodesByName) {
    const withinCount = sampled.filter((point) => isWithinBuffer(point, nodes)).length;
    const coverage = sampled.length > 0 ? withinCount / sampled.length : 0;

    const candidateTokens = tokenize(name);
    let overlap = 0;
    for (const token of activityTokens) {
      if (candidateTokens.has(token)) overlap += 1;
    }
    const textBoost = activityTokens.size > 0 ? 0.25 * (overlap / activityTokens.size) : 0;

    candidates.push({ name, coverage, textBoost, score: Math.min(1, coverage + textBoost) });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

const METRES_PER_DEGREE_LAT = 111_320;

/** A fixed metre pad around the track's own extent, so a named way whose
 *  nodes sit just outside the tightest bounding box (common right at a
 *  trailhead) is still returned by Overpass and considered. */
function padBoundingBox(points: LatLon[], padMetres: number): BoundingBox {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const midLat = (minLat + maxLat) / 2;
  const padLat = padMetres / METRES_PER_DEGREE_LAT;
  const padLon = padMetres / (METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180));
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLon: Math.min(...lons) - padLon,
    maxLon: Math.max(...lons) + padLon,
  };
}

// A winner needs a real majority of the sampled track on one named way
// (>= SUGGEST_THRESHOLD, the same 35% floor trails.ts already uses to call
// two geometries related at all) so the text boost alone -- worth at most
// 0.25 -- can never rescue a way the track barely brushes; the measured
// Dallas Trail #200 runner-up at 1.4% coverage sits nowhere near this floor
// with or without a boost. The final score (coverage + boost, capped at 1.0)
// must also clear 0.5: a bare majority of the track, which every measured
// real winner above (49.7% to 92.7% coverage, boosted where applicable)
// clears comfortably, while a weak, ambiguous match does not.
export const MIN_COVERAGE_FOR_ACCEPTANCE = SUGGEST_THRESHOLD;
export const MIN_SCORE_FOR_ACCEPTANCE = 0.5;

/**
 * Orchestrates fetchNamedWays + scoreNameCandidates and applies the
 * acceptance threshold. Returns null whenever there is nothing to suggest --
 * Overpass failed, returned no named ways, or its best candidate does not
 * clear the acceptance bar -- so the caller's only job is "apply this, or
 * leave the activity-seeded name alone."
 */
export async function suggestTrailName(
  trackPoints: LatLon[],
  activityText: string,
  signal?: AbortSignal,
): Promise<SuggestNameResult | null> {
  if (trackPoints.length === 0) return null;

  const bbox = padBoundingBox(trackPoints, TRAIL_BUFFER_METRES);
  const ways = await fetchNamedWays(bbox, signal);
  if (!ways || ways.length === 0) return null;

  const candidates = scoreNameCandidates(trackPoints, ways, activityText);
  const winner = candidates[0];
  if (!winner) return null;
  if (winner.coverage < MIN_COVERAGE_FOR_ACCEPTANCE || winner.score < MIN_SCORE_FOR_ACCEPTANCE) {
    return null;
  }

  return { name: winner.name, confidence: winner.score, candidates };
}
