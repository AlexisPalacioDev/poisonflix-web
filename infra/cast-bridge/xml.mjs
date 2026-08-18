// The four lines of XML this service needs, and not one more.
//
// No parser dependency: a UPnP device descriptor and a DIAL app resource are
// flat documents we read a handful of fields out of. What matters is that BOTH
// readers behave the same — the DIAL adapter had its own private regexes that
// neither tolerated a namespace prefix nor decoded entities, so a TV answering
// `<dial:state>running</dial:state>` would have reported "estado: desconocido"
// forever while the descriptor path handled the identical shape correctly.

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/** XML entities, including the numeric forms a few firmwares emit instead. */
export function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    // `&amp;` last would double-decode `&amp;lt;` into `<`; the map is applied
    // in one pass precisely so it cannot.
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity]);
}

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The first `<tag>` in the document, decoded, or null.
 *
 * FIRST, not "the one in the root device": a UPnP root descriptor may carry a
 * `<deviceList>` of embedded devices, each with its own friendlyName, and the
 * root's own always comes before them. Taking the last would name a TV after
 * its tuner.
 *
 * The optional `[\w.-]+:` prefix is what makes this work on namespaced
 * documents, which the spec allows and firmwares actually ship.
 */
export function firstTag(xml, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i');
  const match = re.exec(String(xml));
  if (!match) return null;
  const value = decodeXmlEntities(match[1]).trim();
  return value || null;
}
