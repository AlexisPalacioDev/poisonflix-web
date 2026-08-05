// RED -> GREEN for the "vidrio y profundidad" redesign (design.md D2): the
// LENGTH matcher rejected `gap: var(--pf-space-md)` outright (34
// occurrences app-wide, 8 in detail.css - confirmed by design's own audit),
// silently skipping the TV fallback for every token-based `gap`. Chrome
// 53/webOS 2018 needs the resolved px value, not the var() reference.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import flexGapFallback, { loadStaticTokens, resolveLength } from './postcss-flex-gap-fallback.mjs';

async function run(css) {
  const result = await postcss([flexGapFallback()]).process(css, { from: undefined });
  return result.css;
}

describe('resolveLength (pure)', () => {
  it('passes a literal length value through unchanged', () => {
    expect(resolveLength('12px', new Map())).toBe('12px');
  });

  it('resolves a var() reference against the provided static token map', () => {
    const tokens = new Map([['--pf-space-md', '16px']]);
    expect(resolveLength('var(--pf-space-md)', tokens)).toBe('16px');
  });

  it('resolves nested var() references (a token that itself references another token)', () => {
    const tokens = new Map([
      ['--pf-space-md', 'var(--pf-space-base)'],
      ['--pf-space-base', '16px'],
    ]);
    expect(resolveLength('var(--pf-space-md)', tokens)).toBe('16px');
  });

  it("falls back to the var()'s own fallback value when the token is unknown", () => {
    expect(resolveLength('var(--pf-unknown, 8px)', new Map())).toBe('8px');
  });

  it('returns null for a token that does not resolve to a length (e.g. a color)', () => {
    const tokens = new Map([['--pf-gold', '#f2c14e']]);
    expect(resolveLength('var(--pf-gold)', tokens)).toBeNull();
  });

  it('returns null for an unresolvable var() with no fallback', () => {
    expect(resolveLength('var(--pf-unknown)', new Map())).toBeNull();
  });
});

describe('loadStaticTokens', () => {
  it('reads only the top-level :root declarations, not the @supports-gated branch', () => {
    const css = `
      :root {
        --pf-gutter: 24px;
      }
      @supports (width: clamp(1px, 1vw, 2px)) {
        :root {
          --pf-gutter: clamp(16px, 4.5vw, 60px);
        }
      }
    `;
    const tokens = loadStaticTokens(css);
    expect(tokens.get('--pf-gutter')).toBe('24px');
  });

  it('reads the real theme.css and exposes --pf-space-md as a static px length', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'src/styles/theme.css'), 'utf8');
    const tokens = loadStaticTokens(css);
    expect(tokens.get('--pf-space-md')).toBe('16px');
  });
});

describe('flex-gap-fallback plugin: var() token resolution', () => {
  it('emits a resolved-px margin fallback for gap: var(--pf-space-md)', async () => {
    const css = `
      :root { --pf-space-md: 16px; }
      .row { display: flex; gap: var(--pf-space-md); }
    `;
    const out = await run(css);
    expect(out).toContain('.no-flex-gap .row > * + *');
    expect(out).toContain('margin-left: 16px');
  });

  it('still resolves a literal length value (no regression)', async () => {
    const css = `.row { display: flex; gap: 12px; }`;
    const out = await run(css);
    expect(out).toContain('margin-left: 12px');
  });

  it('skips emitting a fallback when the var() token does not resolve to a length', async () => {
    const css = `
      :root { --pf-accent: red; }
      .row { display: flex; gap: var(--pf-accent); }
    `;
    const out = await run(css);
    expect(out).not.toContain('.no-flex-gap');
  });
});
