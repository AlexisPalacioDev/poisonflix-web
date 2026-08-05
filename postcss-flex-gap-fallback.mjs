// PostCSS plugin: emit margin fallbacks for `gap` in flex containers.
//
// Flex `gap` needs Chrome 84+; the 2018 LG TV browser (Chromium ~53) drops it
// silently, collapsing every row to zero spacing. Rewriting all 84 `gap`
// declarations by hand would be both huge and a standing trap - the next `gap`
// someone writes would regress the TV with no visible signal on a dev machine.
// Generating the fallback keeps the source idiomatic and self-maintaining.
//
// Emitted rules are scoped under `.no-flex-gap`, a class set at runtime only
// when detection fails (src/lib/tv/flexGapFallback.ts), so browsers with real
// gap support never see them and can never be double-spaced.
//
// Direction matters: in a flex row only the horizontal (column-gap) component
// separates items, in a column only the vertical one. Applying both would
// shove every row item down by the gap amount.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const LENGTH = /^-?[\d.]+(px|rem|em|%|vw|vh|ch)$/;
const VAR_REF = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)$/;

const THEME_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'src/styles/theme.css',
);

/**
 * Reads the top-level `--*` custom property declarations out of a `:root`
 * block, skipping any `:root` nested inside an at-rule (e.g.
 * `@supports (...) { :root { ... } }`). Chrome 53/webOS 2018 - the browser
 * this fallback exists for - never evaluates the `@supports` branch, so only
 * the flat, static declarations are a valid source of truth for what that
 * browser will actually compute (design.md D2). Accepts a CSS string so it
 * stays a pure, directly-testable function independent of the filesystem.
 */
export function loadStaticTokens(css) {
  const tokens = new Map();
  const root = postcss.parse(css);
  root.walkRules(':root', (rule) => {
    if (rule.parent?.type === 'atrule') return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) tokens.set(decl.prop, decl.value.trim());
    });
  });
  return tokens;
}

/**
 * Resolves a `gap`/`row-gap`/`column-gap` declaration value to a flat length
 * string the fallback margin rule can use, or `null` if it can't be resolved
 * to one. Handles three shapes: a literal length (`12px`), a `var()`
 * reference into `tokens` (recursively, so a token that itself references
 * another token still resolves), and a `var()` with an inline fallback
 * (`var(--unknown, 8px)`) when the token isn't in the map at all. Anything
 * else (an unresolvable var, or a token resolving to a non-length value like
 * a color) returns `null` so the caller skips emitting a fallback rather than
 * emitting a broken one.
 */
export function resolveLength(value, tokens, seen = new Set()) {
  const trimmed = value.trim();
  if (LENGTH.test(trimmed)) return trimmed;

  const match = trimmed.match(VAR_REF);
  if (!match) return null;

  const [, name, fallback] = match;
  if (tokens.has(name) && !seen.has(name)) {
    return resolveLength(tokens.get(name), tokens, new Set(seen).add(name));
  }
  if (fallback) return resolveLength(fallback, tokens, seen);
  return null;
}

let cachedTokens = null;

function getStaticTokens() {
  if (cachedTokens) return cachedTokens;
  try {
    cachedTokens = loadStaticTokens(readFileSync(THEME_PATH, 'utf8'));
  } catch {
    // theme.css missing/unreadable (e.g. a standalone unit test feeding this
    // plugin isolated CSS) - degrade to literal-length-only resolution.
    cachedTokens = new Map();
  }
  return cachedTokens;
}

/** `gap: 8px 16px` -> { row: '8px', column: '16px' }; `gap: 8px` -> both. */
function parseGap(value) {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1) return { row: parts[0], column: parts[0] };
  if (parts.length === 2) return { row: parts[0], column: parts[1] };
  return null;
}

export default function flexGapFallback() {
  return {
    postcssPlugin: 'flex-gap-fallback',
    OnceExit(root, { Rule, Declaration }) {
      const additions = [];

      root.walkRules((rule) => {
        // Never recurse into what we generate, and skip keyframes (no children
        // to space) and rules already scoped to the fallback class.
        if (rule.selector.includes('.no-flex-gap')) return;
        if (rule.parent?.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;

        let gap = null;
        let display = null;
        let direction = 'row';
        let rowGap = null;
        let columnGap = null;

        rule.walkDecls((decl) => {
          const prop = decl.prop.toLowerCase();
          if (prop === 'gap') gap = decl.value;
          else if (prop === 'row-gap') rowGap = decl.value;
          else if (prop === 'column-gap') columnGap = decl.value;
          else if (prop === 'display') display = decl.value.trim();
          else if (prop === 'flex-direction') direction = decl.value.trim();
        });

        // Grid gap works from Chrome 57, well below our floor - only flex
        // containers need help. `inline-flex` counts too.
        if (!display || !/^(inline-)?flex$/.test(display)) return;

        let row = rowGap;
        let column = columnGap;
        if (gap) {
          const parsed = parseGap(gap);
          if (parsed) {
            row = row ?? parsed.row;
            column = column ?? parsed.column;
          }
        }

        const isColumn = direction.startsWith('column');
        const rawValue = isColumn ? row : column;
        if (!rawValue) return;
        // `gap: var(--pf-space-md)` doesn't match LENGTH directly - resolve
        // it against theme.css's static (non-`@supports`) branch first, the
        // same branch Chrome 53 itself would compute (design.md D2).
        const value = resolveLength(rawValue, getStaticTokens());
        if (!value) return;

        // `> * + *` targets every child after the first, which is exactly the
        // set of internal gaps - no trailing margin on the last item.
        const selector = rule.selectors
          .map((s) => `.no-flex-gap ${s} > * + *`)
          .join(',\n');
        const fallback = new Rule({ selector });
        const reverse = direction.includes('reverse');
        let prop;
        if (isColumn) prop = reverse ? 'margin-bottom' : 'margin-top';
        else prop = reverse ? 'margin-right' : 'margin-left';
        fallback.append(new Declaration({ prop, value }));
        additions.push({ rule, fallback });
      });

      // Insert after the walk so the tree is not mutated mid-iteration. Each
      // fallback goes next to its source rule, preserving cascade order.
      for (const { rule, fallback } of additions) {
        rule.after(fallback);
      }
    },
  };
}

flexGapFallback.postcss = true;
