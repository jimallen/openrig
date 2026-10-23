// Invisible characters that must never appear raw in a security-relevant source file: format controls
// (bidi embeddings, overrides, isolates, LRM/RLM/ALM, zero-width), line and paragraph separators, and C0/C1
// controls other than LF, CR and TAB. Returns "line:U+XXXX" for each one found.
export function unicodeInvisiblesIn(text: string): string[] {
  const found: string[] = [];
  const pattern = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      found.push(`${i + 1}:U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  });
  return found;
}
