// Token/fuzzy matching for the command palette — kept tiny and deterministic so results feel
// instant and predictable: exact substring beats word-prefix beats subsequence.
// Returns a score (lower is better) or null when there is no match.
export function tokenize(text) { return text.trim().toLowerCase().split(/\s+/).filter(Boolean); }
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at === 0) return 0;
  if (at > 0) return 10 + at / 100;
  // Every query token must hit some word boundary or substring.
  const tokens = q.split(/\s+/).filter(Boolean);
  const words = t.split(/[\s—·\-_:/]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(token => words.some(word => word.startsWith(token) || word.includes(token)))) return 20;
  // Subsequence fallback ("lkbt" → "lock keybit"): cheap and forgiving.
  let i = 0, gaps = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return 30 + gaps;
  }
  return null;
}
export function fuzzyFilter(query, entries, labelOf) {
  const scored = entries.map(entry => ({ entry, score: fuzzyScore(query, labelOf(entry)) }))
    .filter(item => item.score != null)
    .sort((a, b) => a.score - b.score);
  return scored.map(item => item.entry);
}
