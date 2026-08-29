/**
 * Aho-Corasick multi-pattern matcher (SPEC §4 `intent`).
 *
 * One pass over the text regardless of lexicon size, which is what keeps the
 * whole of Tier 2 inside the latency budget as lexicons grow. Built once at
 * module load and reused; no dependencies.
 */

export interface AhoMatch {
  term: string;
  start: number;
  end: number;
  /** Which lexicon family the term came from. */
  tag: string;
}

interface Node {
  next: Map<string, number>;
  fail: number;
  /** Terms ending at this node, as [term, tag] pairs. */
  outputs: Array<{ term: string; tag: string }>;
}

export class AhoCorasick {
  private nodes: Node[] = [{ next: new Map(), fail: 0, outputs: [] }];
  private built = false;

  add(term: string, tag: string): void {
    if (term.length === 0) return;
    let node = 0;
    for (const ch of term) {
      const next = this.nodes[node]!.next.get(ch);
      if (next === undefined) {
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        const created = this.nodes.length - 1;
        this.nodes[node]!.next.set(ch, created);
        node = created;
      } else {
        node = next;
      }
    }
    this.nodes[node]!.outputs.push({ term, tag });
    this.built = false;
  }

  addAll(terms: readonly string[], tag: string): void {
    for (const term of terms) this.add(term.toLowerCase(), tag);
  }

  /** Build failure links (BFS). Idempotent. */
  build(): void {
    if (this.built) return;

    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) {
      this.nodes[child]!.fail = 0;
      queue.push(child);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [ch, child] of this.nodes[current]!.next) {
        let fail = this.nodes[current]!.fail;
        while (fail !== 0 && !this.nodes[fail]!.next.has(ch)) {
          fail = this.nodes[fail]!.fail;
        }
        const candidate = this.nodes[fail]!.next.get(ch);
        this.nodes[child]!.fail = candidate !== undefined && candidate !== child ? candidate : 0;
        // Merge outputs along the failure chain so every suffix match reports.
        this.nodes[child]!.outputs.push(...this.nodes[this.nodes[child]!.fail]!.outputs);
        queue.push(child);
      }
    }

    this.built = true;
  }

  /**
   * Find all matches. `wholeWord` (default true) requires non-alphanumeric
   * boundaries, so "ig" does not fire inside "big" and "mc" not inside "mcdonalds".
   */
  search(text: string, wholeWord = true): AhoMatch[] {
    this.build();

    const matches: AhoMatch[] = [];
    const chars = [...text];
    let node = 0;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      while (node !== 0 && !this.nodes[node]!.next.has(ch)) {
        node = this.nodes[node]!.fail;
      }
      node = this.nodes[node]!.next.get(ch) ?? 0;

      for (const output of this.nodes[node]!.outputs) {
        const length = [...output.term].length;
        const start = i - length + 1;
        const end = i + 1;
        if (wholeWord && !isWholeWord(chars, start, end)) continue;
        matches.push({ term: output.term, start, end, tag: output.tag });
      }
    }

    return matches;
  }
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWholeWord(chars: string[], start: number, end: number): boolean {
  const before = start > 0 ? chars[start - 1] : undefined;
  const after = end < chars.length ? chars[end] : undefined;
  const startsWithWordChar = WORD_CHAR.test(chars[start] ?? "");
  const endsWithWordChar = WORD_CHAR.test(chars[end - 1] ?? "");

  if (startsWithWordChar && before !== undefined && WORD_CHAR.test(before)) return false;
  if (endsWithWordChar && after !== undefined && WORD_CHAR.test(after)) return false;
  return true;
}

/** Drop matches fully contained inside a longer match at the same position. */
export function keepLongest(matches: AhoMatch[]): AhoMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: AhoMatch[] = [];
  for (const match of sorted) {
    const covered = kept.some((k) => k.start <= match.start && k.end >= match.end);
    if (!covered) kept.push(match);
  }
  return kept;
}
