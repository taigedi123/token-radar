// Token Radar's model, second generation: one sealed snapshot in, one ranked board out.
//
// The board ranks every protocol that records no token and is not a wrapped, staked, bridged or
// versioned product of one that already trades: the snapshot's 40-slug watchlist (the floor, never
// the ceiling) plus every early protocol below that floor the same product rule keeps. Protocols
// whose token already trades are set aside as live comparables, never ranked: the market has
// already priced them, and their prices are what calibrate this model.
//
// Implied value follows only from the snapshot's own figures, in three factors:
//
//   peer multiple  the median market-cap / TVL ratio of the live-token protocols in the same
//                  DefiLlama category (each ratio winsorised to [0.02, 1.5] first, so one
//                  micro-cap outlier cannot price a whole category), shrunk toward the global
//                  live median with a prior weight of 4, and clamped to [0.04, 1.25]. A category
//                  with no live peers takes the
//                  global median. This is the snapshot pricing its own pre-token protocols the
//                  way it prices the ones that already launched.
//   growth         1 + clamp(change_7d, -60, 120) / 100 x 0.5: a week of TVL momentum, damped.
//   maturity       0.6 + min(age_days, 1095) / 1095 x 0.4: the longer a protocol has run with no
//                  token, the more of its record a launch would capitalise. Unknown age: 365.
//
//   implied = max(1, round(tvl_usd x peer_multiple x growth x maturity))
//
// No protocol name is ever special-cased: one function scores every row, and the dashboard
// recomputes each row from the same figures and shows the board's number beside its own.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  prior_weight: number;
  ratio_floor: number;
  ratio_cap: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  prior_weight: 4,
  ratio_floor: 0.02,
  ratio_cap: 1.5,
  multiple_floor: 0.04,
  multiple_cap: 1.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live comparables view carries, by market cap. */
export const LIVE_ROWS = 36;

/** One category's calibration: how the snapshot's live protocols price a dollar of TVL. */
export interface PeerStat {
  category: string;
  peers: number;
  median_multiple: number;
  multiple: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  signals: string[];
  model: {
    peer_multiple: number;
    peer_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  peer_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  signals: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  peers: PeerStat[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are products of a token that already trades, never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a product may begin with (the watchlist's own rule). */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word wrapped, staked or staking in a name marks a product of another token. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether a protocol is a wrapped, staked, bridged or versioned product of a token that already
 * trades (the watchlist's product rule, applied at every size): such a protocol is no launch
 * candidate, however large it is.
 */
export function isProduct(p: SnapshotProtocol): boolean {
  if (VERSIONED.test(p.name)) return true;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (PRODUCT_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

/** Whether a protocol is one the board may rank: pre-token and not a product of a live token. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isProduct(p);
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * The calibration: for every category, the live-token protocols' market-cap / TVL ratios, their
 * median, and the multiple the model uses after shrinking toward the global median and clamping.
 * Deterministic: ratios are gathered in snapshot order and medians are order-free.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; peers: PeerStat[]; byCategory: Map<string, PeerStat> } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    // Winsorised: one micro-cap outlier (a live peer at 400x its TVL) cannot price a whole
    // category; every ratio counts, but inside [ratio_floor, ratio_cap].
    const ratio = clamp(p.mcap_usd / p.tvl_usd, model.ratio_floor, model.ratio_cap);
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const global = all.length > 0 ? median(all) : 0.2;
  const peers: PeerStat[] = [];
  const byCategory = new Map<string, PeerStat>();
  for (const [category, ratios] of [...ratiosByCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const med = median(ratios);
    const shrunk = (ratios.length * med + model.prior_weight * global) / (ratios.length + model.prior_weight);
    const stat: PeerStat = {
      category,
      peers: ratios.length,
      median_multiple: round4(med),
      multiple: round4(clamp(shrunk, model.multiple_floor, model.multiple_cap)),
    };
    peers.push(stat);
    byCategory.set(category, stat);
  }
  return { global: round4(global), peers, byCategory };
}

/** The peer multiple one protocol is priced with: its category's, or the global median. */
function multipleFor(p: SnapshotProtocol, cal: { global: number; byCategory: Map<string, PeerStat> }): { multiple: number; peers: number } {
  const stat = p.category === null ? undefined : cal.byCategory.get(p.category);
  if (stat === undefined) return { multiple: cal.global, peers: 0 };
  return { multiple: stat.multiple, peers: stat.peers };
}

/** The three factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  cal: { global: number; byCategory: Map<string, PeerStat> },
  model: ModelConstants,
): { implied: number; multiple: number; peers: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, peers } = multipleFor(protocol, cal);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, peers, growthPct, growthMult, maturityMult, age };
}

/** The short signal tags a row earns from its own figures: momentum, tenure and scale. */
export function signalsFor(p: SnapshotProtocol, age: number | null, watchlist: boolean): string[] {
  const signals: string[] = [];
  if (watchlist) signals.push('Watchlist');
  if (p.change_7d !== null && p.change_7d >= 15) signals.push('Surging TVL');
  else if (p.change_7d !== null && p.change_7d >= 5) signals.push('Rising TVL');
  else if (p.change_7d !== null && p.change_7d <= -15) signals.push('Cooling TVL');
  if (age !== null && age >= 730) signals.push('2y+ tokenless');
  if (p.chains.length >= 5) signals.push('Multichain');
  return signals;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const onWatchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the product rule would set aside (there is
  // none on this snapshot, but coverage is the gate's row and is never gambled on a rule change).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, at every size. The floor is where
  // the house's reading started; a radar that stops there finds nothing early.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const cal = calibrate(snapshot, model);
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, cal, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: onWatchlist.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    signals: signalsFor(s.p, s.age, onWatchlist.has(s.p.slug)),
    model: {
      peer_multiple: s.multiple,
      peer_count: s.peers,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain: mainnet gas, an L2's cents, Solana's fraction of a cent. */
function gasFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $8 of mainnet gas';
  if (chain === 'Solana') return 'under $0.10 of fees';
  if (['Base', 'Arbitrum', 'Optimism', 'Ink', 'Linea', 'Scroll', 'zkSync Era', 'Mode', 'Blast', 'Mantle'].includes(chain)) return 'about $0.30 of L2 gas';
  if (chain === 'Polygon' || chain === 'Binance' || chain === 'BSC' || chain === 'Avalanche' || chain === 'Tron') return 'about $0.20 of gas';
  return 'about $1 of gas';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 250_000_000) return 100;
  if (p.tvl_usd >= 50_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's two working actions: what a farmer actually does in this kind of protocol. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): [string, string] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('risk curator') || c.includes('curator') || c.includes('allocator'))
    return [
      `Deposit $${capital} of USDC into a ${name} curated vault on ${chain} and keep the vault shares in the wallet.`,
      `Split a second $${Math.round(capital / 2)} into a different ${name} vault so the position is not riding on one strategy.`,
    ];
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return [
      `Supply $${capital} of USDC to ${name} on ${chain} and leave the supplied balance untouched.`,
      `Borrow about $${Math.round(capital / 3)} against the supply, swap it back to USDC and re-supply it once, then stop: one loop is activity, more is leverage risk.`,
    ];
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual'))
    return [
      `Trade $${capital} of volume on ${name} on ${chain}, in a few swaps across different days rather than one block.`,
      `Provide $${Math.round(capital / 2)} of liquidity to ${name}'s main pool and keep the position open between sessions.`,
    ];
  if (c.includes('yield'))
    return [
      `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the receipt token.`,
      `Claim and re-deposit the yield once, so the wallet shows both a claim and a second deposit.`,
    ];
  if (c.includes('rwa'))
    return [
      `Complete ${name}'s onboarding on ${chain} and mint $${capital} of its yield asset.`,
      `Hold the minted asset and make one small second mint of $${Math.round(capital / 4)} a few weeks later.`,
    ];
  if (c.includes('basis') || c.includes('stable'))
    return [
      `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the wallet.`,
      `Use the stable asset once inside ${name}: a swap, a supply or a redemption quote you actually settle.`,
    ];
  if (c.includes('prediction'))
    return [
      `Fund $${capital} and take one position in a liquid market on ${name}.`,
      `Settle the position at resolution and take a second, smaller position the following week.`,
    ];
  if (c.includes('chain'))
    return [
      `Bridge $${capital} of USDC to the ${name} chain and make the wallet's first transactions there.`,
      `Use two native apps on the chain in the same week, so the wallet reads as a resident, not a passer-by.`,
    ];
  if (c.includes('staking') || c.includes('restak'))
    return [
      `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`,
      `Claim staking rewards once and restake them, so the wallet shows a full staking cycle.`,
    ];
  return [
    `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`,
    `Make one second, smaller deposit of $${Math.round(capital / 2)} two weeks later, so the wallet shows returning activity.`,
  ];
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, first chain, TVL, age), never from a hand-written
 * list of names: the same derivation writes board.json and renders the dashboard's detail view.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const [first, second] = actionsFor(p, capital, chain);
  return [
    {
      text: `Open a fresh wallet for ${p.name} alone, fund it from an exchange withdrawal, and keep its seed phrase offline on paper.`,
      cost: 'the withdrawal fee only, and never pay anyone to set a wallet up',
      time: '10 minutes',
    },
    {
      text: first,
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `${gas} again, no new capital beyond the $${Math.round(capital / 2)} named`,
      time: '10 minutes',
    },
    {
      text: `Repeat one qualifying action every week on the same weekday: a deposit, a swap, a claim or a vote inside ${p.name}.`,
      cost: 'about the same gas each week, under $10 a month on most chains',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one weekly snapshot of the protocol.`,
      cost: `the $${capital} stays in the position and cannot be spent meanwhile`,
      time: `${hold} days`,
    },
    {
      text: `Check ${p.name}'s own points or rewards page from the link on its official site, and claim only there; a claim never asks for a fee or a seed phrase.`,
      cost: 'nothing to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Log the wallet, the dates and every transaction hash in a farm log, and set a monthly reminder to repeat or unwind the position.`,
      cost: 'nothing but the log itself',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live comparables view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    peer_multiple: row.model.peer_multiple,
    peer_count: row.model.peer_count,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    signals: row.signals,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const cal = calibrate(snapshot, model);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: cal.global,
    peers: cal.peers,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows: the gate asks for at least 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
