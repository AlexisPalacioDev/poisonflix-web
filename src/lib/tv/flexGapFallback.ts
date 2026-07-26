// Feature-detects flexbox `gap` and marks the document when it is missing.
//
// The whole layout spaces itself with `gap` inside `display:flex` (84
// declarations, versus 2 grid containers). Flex gap landed in Chrome 84; the
// 2018 LG TV browser is Chromium ~53, which parses the property and drops it,
// so every row rendered with zero spacing - "apeñuscado" on the TV only, while
// every dev machine looked fine.
//
// The `no-flex-gap` class this sets is what the generated margin fallbacks in
// the stylesheet key off (see the postcss-flex-gap-fallback plugin in
// vite.config.ts). Detection rather than UA sniffing: the same TV browser
// string is used by models whose engines do support gap.

export function markFlexGapSupport(doc: Document = document): boolean {
  const probe = doc.createElement('div');
  probe.style.display = 'flex';
  probe.style.flexDirection = 'column';
  probe.style.rowGap = '1px';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.appendChild(doc.createElement('div'));
  probe.appendChild(doc.createElement('div'));

  const host = doc.body ?? doc.documentElement;
  host.appendChild(probe);
  // With gap honoured the two zero-height children are pushed 1px apart.
  const supported = probe.scrollHeight === 1;
  host.removeChild(probe);

  if (!supported) doc.documentElement.classList.add('no-flex-gap');
  return supported;
}
