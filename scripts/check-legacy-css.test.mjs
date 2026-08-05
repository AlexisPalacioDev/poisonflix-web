// RED -> GREEN for the Chrome 53/webOS 2018 baseline contract (design.md D2
// rule 1-4 + D7 layer 1 "invariantes estáticos"). Each rule below is the
// mechanical, CI-checkable version of a fact about how old Chrome's CSS
// parser/cascade behaves - see design.md's D2 support table for the "why".
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  checkBackdropFilterBudget,
  checkDeclarationMixing,
  checkFocusVisibleInList,
  checkMissingStaticFallback,
  checkTokensOnlyInSupports,
  checkStylesheet,
} from './check-legacy-css.mjs';

function parseRule(css) {
  const root = postcss.parse(css);
  let rule;
  root.walkRules((r) => {
    rule = r;
  });
  return rule;
}

describe('checkDeclarationMixing (rule a: var() + clamp()/min()/max() in one declaration)', () => {
  it('flags a declaration that mixes var() with a literal clamp()', () => {
    const rule = parseRule('.x { padding: 0 var(--pf-gutter) clamp(40px, 7vh, 88px); }');
    const decl = rule.nodes[0];
    expect(checkDeclarationMixing(decl)).toBe(true);
  });

  it('does not flag a declaration that only uses var() (no fluid function)', () => {
    const rule = parseRule('.x { padding: 0 var(--pf-gutter); }');
    const decl = rule.nodes[0];
    expect(checkDeclarationMixing(decl)).toBe(false);
  });

  it('does not flag a declaration that only uses a literal clamp() (no var())', () => {
    const rule = parseRule('.x { font-size: clamp(2rem, 3.6vw, 3rem); }');
    const decl = rule.nodes[0];
    expect(checkDeclarationMixing(decl)).toBe(false);
  });

  it('flags var() mixed with min()/max() too, not only clamp()', () => {
    const rule = parseRule('.x { width: min(var(--pf-space-lg), 40vw); }');
    const decl = rule.nodes[0];
    expect(checkDeclarationMixing(decl)).toBe(true);
  });
});

describe('checkMissingStaticFallback (rule b: literal clamp() needs a prior static declaration)', () => {
  it('flags a rule with only a literal clamp(), no static fallback declared first', () => {
    const rule = parseRule('.x { font-size: clamp(2rem, 3.6vw, 3rem); }');
    const violations = checkMissingStaticFallback(rule);
    expect(violations).toHaveLength(1);
    expect(violations[0].prop).toBe('font-size');
  });

  it('does not flag when a plain static declaration of the same property precedes the clamp()', () => {
    const rule = parseRule('.x { font-size: 32px; font-size: clamp(2rem, 3.6vw, 3rem); }');
    expect(checkMissingStaticFallback(rule)).toHaveLength(0);
  });

  it('does not flag a static-only declaration (nothing fluid to guard)', () => {
    const rule = parseRule('.x { font-size: 32px; }');
    expect(checkMissingStaticFallback(rule)).toHaveLength(0);
  });

  it('exempts --custom-property declarations (their fallback lives at the token level - rule e, not declaration doubling)', () => {
    const rule = parseRule(':root { --pf-font-title: clamp(2rem, 3.6vw, 3rem); }');
    expect(checkMissingStaticFallback(rule)).toHaveLength(0);
  });
});

describe('checkFocusVisibleInList (rule c: :focus-visible must never share a selector list)', () => {
  it('flags a rule combining :focus-visible with another selector in a comma list', () => {
    const rule = parseRule('.x:hover, .x:focus-visible { color: red; }');
    expect(checkFocusVisibleInList(rule)).toBe(true);
  });

  it('does not flag an isolated single-selector :focus-visible rule', () => {
    const rule = parseRule('.x:focus-visible { color: red; }');
    expect(checkFocusVisibleInList(rule)).toBe(false);
  });

  it('does not flag a multi-selector list that never mentions :focus-visible', () => {
    const rule = parseRule('.x:hover, .x:active { color: red; }');
    expect(checkFocusVisibleInList(rule)).toBe(false);
  });
});

describe('checkBackdropFilterBudget (rule d: no backdrop-filter on row/card/chip/badge/poster/episode/season)', () => {
  it('flags backdrop-filter on a selector matching the restricted pattern', () => {
    const rule = parseRule('.pf-poster-card { backdrop-filter: blur(4px); }');
    expect(checkBackdropFilterBudget(rule)).toBe(true);
  });

  it('flags it case-insensitively and for any of the restricted words (badge)', () => {
    const rule = parseRule('.pf-status-badge { backdrop-filter: blur(2px); }');
    expect(checkBackdropFilterBudget(rule)).toBe(true);
  });

  it('does not flag backdrop-filter on a surface outside the restricted list', () => {
    const rule = parseRule('.pf-glass--blur { backdrop-filter: blur(28px); }');
    expect(checkBackdropFilterBudget(rule)).toBe(false);
  });

  it('does not flag a restricted selector with no backdrop-filter at all', () => {
    const rule = parseRule('.pf-poster-card { background: red; }');
    expect(checkBackdropFilterBudget(rule)).toBe(false);
  });
});

describe('checkTokensOnlyInSupports (rule e: theme.css token defined only inside @supports)', () => {
  it('flags a token that only exists inside an @supports-gated :root', () => {
    const css = `
      @supports (width: clamp(1px, 1vw, 2px)) {
        :root { --pf-broken: clamp(1px, 2vw, 3px); }
      }
    `;
    expect(checkTokensOnlyInSupports(css)).toContain('--pf-broken');
  });

  it('does not flag a token with a top-level static declaration plus an @supports override', () => {
    const css = `
      :root { --pf-gutter: 24px; }
      @supports (width: clamp(1px, 1vw, 2px)) {
        :root { --pf-gutter: clamp(16px, 4.5vw, 60px); }
      }
    `;
    expect(checkTokensOnlyInSupports(css)).not.toContain('--pf-gutter');
  });

  it('does not flag a token that only ever appears at the top level', () => {
    const css = `:root { --pf-gold: #f2c14e; }`;
    expect(checkTokensOnlyInSupports(css)).toHaveLength(0);
  });
});

describe('checkStylesheet (aggregate: runs all applicable rules over one file)', () => {
  it('collects one violation per broken rule, tagged with the violated rule id', () => {
    const css = `
      .pf-row-card { backdrop-filter: blur(4px); }
      .x:hover, .x:focus-visible { color: red; }
      .y { padding: var(--pf-gutter) clamp(1px, 2vw, 3px); }
    `;
    const violations = checkStylesheet(css, 'fixture.css');
    const rules = violations.map((v) => v.rule).sort();
    expect(rules).toEqual(['backdrop-filter-budget', 'focus-visible-in-list', 'mixed-var-fluid']);
  });

  it('reports zero violations for a clean stylesheet', () => {
    const css = `
      .pf-glass--blur { backdrop-filter: blur(28px); }
      .x:focus-visible { color: red; }
      .y { padding: var(--pf-gutter); }
    `;
    expect(checkStylesheet(css, 'fixture.css')).toHaveLength(0);
  });
});
