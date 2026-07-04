/**
 * Compact 5-of-7 card evaluator for the poker baseline. Display-grade, not a
 * lookup-table monster: categories + kicker ordering, enough to rank two
 * showdown hands and to grade "how strong am I" postflop.
 *
 * Cards use the same wire format as blackjack: rank + suit, e.g. "AH", "TD",
 * "9S" ("10D" is tolerated too).
 */

export type HandCategory =
  | "high"
  | "pair"
  | "twoPair"
  | "trips"
  | "straight"
  | "flush"
  | "fullHouse"
  | "quads"
  | "straightFlush";

const CATEGORY_ORDER: HandCategory[] = [
  "high",
  "pair",
  "twoPair",
  "trips",
  "straight",
  "flush",
  "fullHouse",
  "quads",
  "straightFlush",
];

export interface HandRank {
  category: HandCategory;
  /** 0 (high card) … 8 (straight flush). */
  categoryIndex: number;
  /** Tiebreak ranks, most significant first (2=2 … 14=A). */
  tiebreak: number[];
  /** Single comparable number: higher wins. */
  score: number;
}

const RANK_VALUE: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** "AH" → { rank: 14, suit: "H" }. Throws on garbage. */
export function parseCard(card: string): { rank: number; suit: string } {
  const suit = card.slice(-1).toUpperCase();
  const rank = RANK_VALUE[card.slice(0, -1).toUpperCase()];
  if (!rank || !"SHDC".includes(suit)) throw new Error(`unparseable card: ${JSON.stringify(card)}`);
  return { rank, suit };
}

/** Highest straight's top rank in a rank set, or 0. Handles the wheel (A-5). */
function straightHigh(ranks: Set<number>): number {
  const r = new Set(ranks);
  if (r.has(14)) r.add(1); // ace plays low in A-2-3-4-5
  for (let high = 14; high >= 5; high--) {
    let run = true;
    for (let v = high; v > high - 5; v--) if (!r.has(v)) { run = false; break; }
    if (run) return high;
  }
  return 0;
}

/** Rank the best 5-card hand out of 5–7 cards. */
export function evaluateHand(cards: string[]): HandRank {
  if (cards.length < 5) throw new Error(`need at least 5 cards, got ${cards.length}`);
  const parsed = cards.map(parseCard);

  const bySuit = new Map<string, number[]>();
  const counts = new Map<number, number>();
  for (const c of parsed) {
    bySuit.set(c.suit, [...(bySuit.get(c.suit) ?? []), c.rank]);
    counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  }
  const allRanks = [...counts.keys()];
  const desc = (a: number, b: number) => b - a;

  // Straight flush
  let bestSF = 0;
  for (const ranks of bySuit.values()) {
    if (ranks.length >= 5) bestSF = Math.max(bestSF, straightHigh(new Set(ranks)));
  }
  if (bestSF) return finish("straightFlush", [bestSF]);

  // Group ranks by multiplicity, high rank first within each group.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ofAKind = (n: number) => groups.filter(([, c]) => c === n).map(([r]) => r).sort(desc);

  const quads = ofAKind(4);
  if (quads.length) {
    const kicker = allRanks.filter((r) => r !== quads[0]).sort(desc)[0];
    return finish("quads", [quads[0], kicker]);
  }

  const trips = ofAKind(3);
  const pairs = ofAKind(2);
  if (trips.length && (pairs.length || trips.length > 1)) {
    const over = trips[0];
    const under = trips.length > 1 ? trips[1] : pairs[0];
    return finish("fullHouse", [over, under]);
  }

  for (const ranks of bySuit.values()) {
    if (ranks.length >= 5) return finish("flush", ranks.sort(desc).slice(0, 5));
  }

  const str = straightHigh(new Set(allRanks));
  if (str) return finish("straight", [str]);

  if (trips.length) {
    const kickers = allRanks.filter((r) => r !== trips[0]).sort(desc).slice(0, 2);
    return finish("trips", [trips[0], ...kickers]);
  }

  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    const kicker = allRanks.filter((r) => r !== p1 && r !== p2).sort(desc)[0];
    return finish("twoPair", [p1, p2, kicker]);
  }

  if (pairs.length === 1) {
    const kickers = allRanks.filter((r) => r !== pairs[0]).sort(desc).slice(0, 3);
    return finish("pair", [pairs[0], ...kickers]);
  }

  return finish("high", allRanks.sort(desc).slice(0, 5));

  function finish(category: HandCategory, tiebreak: number[]): HandRank {
    const categoryIndex = CATEGORY_ORDER.indexOf(category);
    // Pack category + up to 5 tiebreak ranks into one comparable number (base 15).
    let score = categoryIndex;
    for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] ?? 0);
    return { category, categoryIndex, tiebreak, score };
  }
}

/**
 * Rough [0,1] strength of hole+board right now — the postflop heuristic the
 * baseline bets with. Category-driven with draw bumps; deliberately simple.
 */
export function handStrength(hole: string[], board: string[]): number {
  const cards = [...hole, ...board];
  if (cards.length < 5) {
    // Flop not out yet shouldn't reach here, but grade the pair/high-card case.
    const [a, b] = hole.map(parseCard);
    if (a.rank === b.rank) return 0.5 + a.rank / 60; // pocket pair
    return (a.rank + b.rank) / 60; // ~0.13 (23o) … ~0.45 (AKs)
  }
  const rank = evaluateHand(cards);
  const boardOnly = board.length >= 5 ? evaluateHand(board) : null;

  // Base strength by category, nudged by top tiebreak rank.
  const base = [0.1, 0.35, 0.55, 0.65, 0.75, 0.8, 0.9, 0.97, 1.0][rank.categoryIndex];
  let s = base + ((rank.tiebreak[0] ?? 0) / 14) * 0.08;

  // If the board alone already makes our "hand", we're playing the board — weak.
  if (boardOnly && boardOnly.score === rank.score) s = Math.min(s, 0.3);

  // Draw bumps only matter before the river.
  if (board.length < 5) {
    if (flushDrawOuts(hole, board)) s = Math.max(s, 0.45);
    if (openEndedDraw(hole, board)) s = Math.max(s, 0.4);
  }
  return Math.min(1, s);
}

/** True if hole+board has exactly 4 of a suit including a hole card. */
function flushDrawOuts(hole: string[], board: string[]): boolean {
  const suits = new Map<string, number>();
  for (const c of [...hole, ...board]) {
    const { suit } = parseCard(c);
    suits.set(suit, (suits.get(suit) ?? 0) + 1);
  }
  for (const [suit, n] of suits) {
    if (n === 4 && hole.some((c) => parseCard(c).suit === suit)) return true;
  }
  return false;
}

/** True on an open-ended straight draw (4 consecutive ranks using a hole card). */
function openEndedDraw(hole: string[], board: string[]): boolean {
  const holeRanks = new Set(hole.map((c) => parseCard(c).rank));
  const all = new Set([...hole, ...board].map((c) => parseCard(c).rank));
  for (let low = 2; low <= 10; low++) {
    let run = true;
    let usesHole = false;
    for (let v = low; v < low + 4; v++) {
      if (!all.has(v)) { run = false; break; }
      if (holeRanks.has(v)) usesHole = true;
    }
    if (run && usesHole && low > 2 && low + 4 <= 14) return true; // open on both ends
  }
  return false;
}
