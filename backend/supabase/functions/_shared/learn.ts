// Learn from corrections: when the user edits what PromptFlow pasted, the
// words they changed are candidates for their dictionary. Only edits that
// look like a misheard word (similar spelling, a name or a term) are kept;
// ordinary rewording is ignored.

const tokenize = (t: string) =>
  t.match(/[\p{L}\p{N}][\p{L}\p{N}'’.+#-]*/gu) ?? [];

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Word-level alignment; returns replaced spans (original words → edited words). */
function substitutions(
  orig: string[],
  edit: string[],
): Array<[string[], string[]]> {
  const n = orig.length;
  const m = edit.length;
  const lcs = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        orig[i].toLowerCase() === edit[j].toLowerCase()
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<[string[], string[]]> = [];
  let i = 0;
  let j = 0;
  let a: string[] = [];
  let b: string[] = [];
  const flush = () => {
    if (a.length && b.length) out.push([a, b]);
    a = [];
    b = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && orig[i].toLowerCase() === edit[j].toLowerCase()) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      b.push(edit[j++]);
    } else {
      a.push(orig[i++]);
    }
  }
  flush();
  return out;
}

const COMMON = new Set(
  "the a an and or but to of in on at for with from by is are was were be been it this that these those i you he she we they me my your our their not no yes so if then than as do does did have has had will would can could should just also very really".split(
    " ",
  ),
);

/** Words worth adding to the dictionary from one correction. */
export function learnFromEdit(
  original: string,
  edited: string,
  known: string[] = [],
): string[] {
  const knownSet = new Set(known.map((w) => w.toLowerCase()));
  const found = new Map<string, string>();
  for (const [from, to] of substitutions(
    tokenize(original),
    tokenize(edited),
  )) {
    // Only small, local fixes: a rewritten sentence is not a misheard word.
    if (from.length > 3 || to.length > 3) continue;
    const said = from.join(" ");
    const meant = to.join(" ");
    const a = said.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const b = meant.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (!b || a === b || b.length < 3) continue;
    const similar = levenshtein(a, b) / Math.max(a.length, b.length) <= 0.6;
    const looksLikeTerm =
      /[A-Z]/.test(meant.slice(1)) ||
      /^[A-Z]/.test(meant) ||
      /\d/.test(meant) ||
      /[.+#-]/.test(meant);
    if (!similar && !looksLikeTerm) continue;
    if (to.every((w) => COMMON.has(w.toLowerCase()))) continue;
    if (knownSet.has(meant.toLowerCase())) continue;
    found.set(meant.toLowerCase(), meant);
  }
  return [...found.values()];
}
