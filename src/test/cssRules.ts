// Reading rules out of a stylesheet, for tests that need to assert something is
// *visible*.
//
// jsdom loads no CSS, so `getComputedStyle` in a test knows nothing about
// `music.css`. That gap is not academic: a button with `opacity: 0` still
// answers to `getByRole`, still receives clicks, and still passes every
// keyboard test — which is exactly how a play control that only appeared on
// hover shipped to phones, where nothing hovers. Asserting on the stylesheet
// text is the cheapest thing that would have caught it.
//
// Not a CSS parser: just enough brace matching to pull one rule out of one
// `@media` block, so a test can name the media query it cares about instead of
// pattern-matching a whole file with a regex that quietly matches the wrong
// block.

/** Every top-level `@media` block in `css`, as its query text and its body. */
export function mediaBlocks(css: string): { query: string; body: string }[] {
  const blocks: { query: string; body: string }[] = [];
  const opener = /@media([^{]+)\{/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(css)) !== null) {
    const start = opener.lastIndex;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ query: match[1].trim(), body: css.slice(start, i - 1) });
  }

  return blocks;
}

export interface CssRule {
  /** The selector exactly as the stylesheet spells it, so a test can hand it
   *  straight to `element.matches()` rather than paraphrasing it. */
  selector: string;
  /** The declarations between the braces, verbatim. */
  declarations: string;
}

/**
 * The first rule inside a media query whose query text matches `queryMatcher`
 * and whose selector contains `selectorNeedle`. `null` when there is none —
 * which is itself the assertion most callers want to make.
 */
export function ruleInMedia(
  css: string,
  queryMatcher: RegExp,
  selectorNeedle: string,
): CssRule | null {
  for (const block of mediaBlocks(css)) {
    if (!queryMatcher.test(block.query)) continue;
    const at = block.body.indexOf(selectorNeedle);
    if (at === -1) continue;
    const open = block.body.indexOf('{', at);
    const close = block.body.indexOf('}', open);
    if (open === -1 || close === -1) continue;
    return {
      selector: block.body.slice(at, open).trim(),
      declarations: block.body.slice(open + 1, close),
    };
  }
  return null;
}

/** Matches the media queries that describe a pointer which cannot hover. */
export const COARSE_POINTER = /hover:\s*none|pointer:\s*coarse/;
