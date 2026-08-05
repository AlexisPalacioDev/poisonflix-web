#!/usr/bin/env node
// Static, deterministic guard for the Chrome 53/webOS 2018 baseline contract
// (design.md D2 "reglas derivadas" + D7 layer 1 "invariantes estáticos").
// Turns a support-table hypothesis into something CI enforces, so a future
// `gap`/`clamp()`/`:focus-visible` regression fails loudly instead of
// silently shipping a blank margin or an invisible focus ring to the TV.
//
// Five rules, each mapped to a concrete Chrome 53 failure mode:
//   (a) mixed-var-fluid        - var() combined with a literal clamp()/min()/
//                                 max() in ONE declaration fails at COMPUTED-
//                                 value time; no declaration-order fallback
//                                 can rescue it - the whole value must live
//                                 as a single token instead.
//   (b) missing-static-fallback - a literal clamp()/min()/max() with no prior
//                                 static declaration of the same property in
//                                 the same rule fails to PARSE on Chrome 53
//                                 and is dropped outright (no fallback at
//                                 all) - CSS Variables spec: this braIS
//                                 fixable via declaration doubling, but only
//                                 if the doubling actually exists.
//   (c) focus-visible-in-list  - an unsupported pseudo-class inside a comma-
//                                 separated selector list invalidates the
//                                 WHOLE rule under CSS Selectors Level 3
//                                 error handling (no forgiving-selector-list,
//                                 that's Level 4) - so a valid sibling
//                                 selector (:hover) gets silently killed too.
//   (d) backdrop-filter-budget - GPU-costly `backdrop-filter` on a per-item
//                                 surface (row/card/chip/badge/poster/
//                                 episode/season) - spec's backdrop-filter
//                                 performance budget.
//   (e) token-only-in-supports - a theme.css custom property with no
//                                 top-level (non-`@supports`) declaration:
//                                 Chrome 53 would never see ANY value for it.
//
// Usage: `node scripts/check-legacy-css.mjs` - scans `src/**/*.css`, prints
// every violation, exits 1 if any are found (0 otherwise).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const FLUID_FN = /\b(?:clamp|min|max)\(/;
const HAS_VAR = /var\(/;
const RESTRICTED_SELECTOR = /row|card|chip|badge|poster|episode|season/i;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rule (a): does this ONE declaration mix a var() reference with a literal
 * clamp()/min()/max()? Strips out var(...) spans first (single-level, no
 * nested function-call fallbacks - not a pattern used in this codebase) so a
 * clamp() living purely inside a var()'s own fallback isn't double-counted
 * as "the declaration's own" fluid function. */
export function checkDeclarationMixing(decl) {
  if (!HAS_VAR.test(decl.value)) return false;
  const withoutVar = decl.value.replace(/var\([^)]*\)/g, '');
  return FLUID_FN.test(withoutVar);
}

/** Rule (b): within a single rule, every literal (non-var()) clamp()/min()/
 * max() declaration must be preceded by a plain static declaration of the
 * SAME property (the "declaration doubling" pattern Chrome 53 can actually
 * use, since it fails at PARSE time and simply keeps whichever declaration
 * it understood). Returns the list of offending declarations.
 *
 * `--custom-property` declarations are exempt: custom property VALUES are an
 * unparsed token stream per the CSS Custom Properties spec, so a literal
 * `clamp()` inside one never fails to PARSE on old Chrome the way it would
 * inside a real property's value - declaration doubling doesn't defend
 * against anything there. The applicable technique for a token is a
 * SEPARATE `@supports`-gated `:root` override (see `--pf-gutter` in
 * theme.css), which rule (e) below verifies exists. */
export function checkMissingStaticFallback(rule) {
  const hasPriorStatic = new Set();
  const violations = [];

  rule.each((decl) => {
    if (decl.type !== 'decl') return;
    if (decl.prop.startsWith('--')) return;
    const isFluidLiteral = FLUID_FN.test(decl.value) && !HAS_VAR.test(decl.value);
    const isPlainStatic = !FLUID_FN.test(decl.value) && !HAS_VAR.test(decl.value);

    if (isFluidLiteral && !hasPriorStatic.has(decl.prop)) {
      violations.push(decl);
    }
    if (isPlainStatic) hasPriorStatic.add(decl.prop);
  });

  return violations;
}

/** Rule (c): `:focus-visible` must never appear in a rule with more than one
 * comma-separated selector - see the header comment for why. */
export function checkFocusVisibleInList(rule) {
  return rule.selectors.length > 1 && rule.selectors.some((s) => s.includes(':focus-visible'));
}

/** Rule (d): `backdrop-filter`/`-webkit-backdrop-filter` on a selector that
 * matches a per-item surface pattern (row/card/chip/badge/poster/episode/
 * season) - spec's backdrop-filter performance budget forbids per-item
 * blur. */
export function checkBackdropFilterBudget(rule) {
  if (!rule.selectors.some((s) => RESTRICTED_SELECTOR.test(s))) return false;
  let found = false;
  rule.walkDecls(/^(-webkit-)?backdrop-filter$/, () => {
    found = true;
  });
  return found;
}

/** Rule (e): a `--custom-property` declared ONLY inside an `@supports`-gated
 * `:root` block, with no top-level (unconditional) declaration - Chrome 53
 * would never see the `@supports` branch, so it would never see ANY value
 * for that token at all. Accepts a CSS string, not a path, so it's directly
 * unit-testable. */
export function checkTokensOnlyInSupports(css) {
  const root = postcss.parse(css);
  const topLevel = new Set();
  const gated = new Set();

  root.walkRules(':root', (rule) => {
    const target = rule.parent?.type === 'atrule' ? gated : topLevel;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) target.add(decl.prop);
    });
  });

  return [...gated].filter((name) => !topLevel.has(name));
}

/** Runs rules (a)-(d) over every rule in one stylesheet, plus rule (e) when
 * the file looks like `theme.css` (only file with `:root` token
 * declarations in this codebase). Returns a flat violation list. */
export function checkStylesheet(css, filePath) {
  const violations = [];
  const root = postcss.parse(css, { from: filePath });

  root.walkRules((rule) => {
    // Skip whatever we might be handed that isn't a real selector-bearing
    // rule (defensive - postcss only emits Rule nodes here anyway).
    if (!rule.selector) return;

    rule.each((decl) => {
      if (decl.type !== 'decl') return;
      if (checkDeclarationMixing(decl)) {
        violations.push({
          rule: 'mixed-var-fluid',
          file: filePath,
          line: decl.source?.start?.line,
          detail: `${decl.prop}: ${decl.value}`,
        });
      }
    });

    for (const decl of checkMissingStaticFallback(rule)) {
      violations.push({
        rule: 'missing-static-fallback',
        file: filePath,
        line: decl.source?.start?.line,
        detail: `${decl.prop}: ${decl.value}`,
      });
    }

    if (checkFocusVisibleInList(rule)) {
      violations.push({
        rule: 'focus-visible-in-list',
        file: filePath,
        line: rule.source?.start?.line,
        detail: rule.selector,
      });
    }

    if (checkBackdropFilterBudget(rule)) {
      violations.push({
        rule: 'backdrop-filter-budget',
        file: filePath,
        line: rule.source?.start?.line,
        detail: rule.selector,
      });
    }
  });

  if (path.basename(filePath) === 'theme.css') {
    for (const token of checkTokensOnlyInSupports(css)) {
      violations.push({
        rule: 'token-only-in-supports',
        file: filePath,
        line: null,
        detail: token,
      });
    }
  }

  return violations;
}

/** Recursively collects every `.css` file under `dir` (no glob dependency -
 * this repo's `src/` tree is small enough that a plain walk is instant). */
function walkCssFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkCssFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.css')) results.push(full);
  }
  return results;
}

async function main() {
  const files = walkCssFiles(path.join(ROOT, 'src'));
  const allViolations = [];

  for (const file of files.sort()) {
    const css = readFileSync(file, 'utf8');
    const relPath = path.relative(ROOT, file);
    allViolations.push(...checkStylesheet(css, relPath));
  }

  if (allViolations.length === 0) {
    console.log(`check-legacy-css: clean (${files.length} files scanned).`);
    return 0;
  }

  console.error(`check-legacy-css: ${allViolations.length} violation(s) in ${files.length} files:\n`);
  for (const v of allViolations) {
    const at = v.line ? `${v.file}:${v.line}` : v.file;
    console.error(`  [${v.rule}] ${at} - ${v.detail}`);
  }
  return 1;
}

// Only run as a CLI when invoked directly (`node scripts/check-legacy-css.mjs`),
// not when imported for its exported pure functions by the test file above.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
