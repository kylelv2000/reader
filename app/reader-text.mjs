const namedEntities = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["hellip", "…"],
  ["mdash", "—"],
  ["ndash", "–"],
]);

function decodeHtmlEntities(value) {
  if (!value.includes("&")) return value;
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    return namedEntities.get(entity.toLowerCase()) ?? match;
  });
}

function stripMarkup(value) {
  return value
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|li|blockquote|section|article|h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/?[a-z][^>]{0,1000}>/gi, "");
}

/**
 * Convert source/RSS HTML (including repeatedly entity-escaped markup) into
 * stable reader text while preserving paragraph boundaries.
 */
export function normalizeReaderText(input) {
  let value = String(input ?? "").replace(/\r\n?/g, "\n");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeHtmlEntities(stripMarkup(value));
    if (next === value) break;
    value = next;
  }
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
