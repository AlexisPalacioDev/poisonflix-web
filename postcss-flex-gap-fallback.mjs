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

const LENGTH = /^-?[\d.]+(px|rem|em|%|vw|vh|ch)$/;

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
        const value = isColumn ? row : column;
        if (!value || !LENGTH.test(value)) return;

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
