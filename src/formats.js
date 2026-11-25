// Regional formats for dates and numbers.
//
// The region defaults to the first language in the browser's preferences and
// can be changed in the toolbar; the choice is kept in localStorage.

const STORE_KEY = "paraphe.formats";
const COMMON = ["fr-FR", "fr-CA", "fr-BE", "fr-CH", "en-US", "en-GB", "en-CA", "de-DE", "es-ES", "it-IT", "nl-NL", "pt-PT"];
export const DATE_STYLES = ["numeric", "long", "iso"];

function canonical(tag) {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return null;
  }
}

// Set by the Windows app: the system's regional format, which wins over the
// browser language (Windows often has an English UI with French formats).
let systemLocale = null;

export function setSystemLocale(tag) {
  systemLocale = canonical(tag);
  if (formats.auto && systemLocale) formats.locale = systemLocale;
}

export function detectLocale() {
  if (systemLocale) return systemLocale;
  for (const tag of navigator.languages || [navigator.language]) {
    const c = tag && canonical(tag);
    if (c) return c;
  }
  return "en-US";
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s && canonical(s.locale) && DATE_STYLES.includes(s.date)) return { locale: s.locale, date: s.date, auto: false };
  } catch {
    // fall through to detection
  }
  return { locale: detectLocale(), date: "numeric", auto: true };
}

export const formats = load();

export function setFormats(change) {
  Object.assign(formats, change, { auto: false });
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ locale: formats.locale, date: formats.date }));
  } catch {
    // Not persisted, still applies to this session.
  }
}

export function resetFormats() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
  Object.assign(formats, { locale: detectLocale(), date: "numeric", auto: true });
}

/** Regions to offer: the browser's preferences first, then common ones. */
export function regionChoices() {
  const seen = new Set();
  const out = [];
  for (const tag of [...(navigator.languages || []), formats.locale, ...COMMON]) {
    const c = canonical(tag);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    let label = c;
    try {
      const name = new Intl.DisplayNames([c], { type: "language" }).of(c);
      label = name.charAt(0).toLocaleUpperCase(c) + name.slice(1);
    } catch {}
    out.push({ tag: c, label });
  }
  return out;
}

/**
 * PDF form text uses Helvetica with WinAnsi encoding, which lacks the narrow
 * and thin spaces and the minus sign that Intl uses in some regions (French
 * grouping is U+202F). pdf.js also can't draw U+00A0 in field appearances.
 * Swap them all for plain equivalents.
 */
function pdfSafe(s) {
  return s.replace(/[    ]/g, " ").replace(/−/g, "-");
}

export function formatDate(date = new Date(), style = formats.date, locale = formats.locale) {
  if (style === "iso") {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }
  const opts = style === "long"
    ? { day: "numeric", month: "long", year: "numeric" }
    : { day: "2-digit", month: "2-digit", year: "numeric" };
  return pdfSafe(new Intl.DateTimeFormat(locale, opts).format(date));
}

function separators(locale) {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

/**
 * Read a number typed in any common style: "1234,5", "1 234,50 €", "1,234.50",
 * "-12.5%". Returns NaN when the text isn't a number.
 */
export function parseNumber(text, locale = formats.locale) {
  let s = String(text).trim();
  if (!s) return NaN;
  const negative = /^\(.*\)$/.test(s) || /^[^\d]*[-−]/.test(s) || /[-−][^\d]*$/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (!/\d/.test(s)) return NaN;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimal = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? "." : ",";
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const count = s.split(sep).length - 1;
    const after = s.length - s.lastIndexOf(sep) - 1;
    // "12,5" or "1,25" is a decimal. "1,234" is a decimal only where "," is
    // the region's decimal mark. Repeated marks ("1.234.567") are grouping.
    if (count === 1 && (after !== 3 || separators(locale).decimal === sep)) decimal = sep;
  }
  const normalised = decimal
    ? s.split(decimal).map((part, i, all) => (i === all.length - 1 ? part : part.replace(/[.,]/g, ""))).join(".")
    : s.replace(/[.,]/g, "");
  const n = Number(normalised);
  return Number.isFinite(n) ? (negative ? -n : n) : NaN;
}

/**
 * Number format declared by a form field through Acrobat's standard format
 * functions (AFNumber_Format / AFPercent_Format). Only the arguments are read;
 * no script is run.
 */
export function numberSpecFromActions(actions) {
  const list = actions instanceof Map ? actions.get("Format") : actions?.Format;
  const js = Array.isArray(list) ? list.join("\n") : typeof list === "string" ? list : "";
  let m = js.match(/AFNumber_Format\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(true|false)\s*\)/);
  if (m) {
    return {
      kind: "number",
      decimals: Math.min(10, Number(m[1])),
      grouping: m[2] === "0" || m[2] === "2" || m[2] === "4",
      currency: m[5].replace(/\\(.)/g, "$1"),
      prepend: m[6] === "true",
    };
  }
  m = js.match(/AFPercent_Format\s*\(\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    return { kind: "percent", decimals: Math.min(10, Number(m[1])), grouping: m[2] === "0" || m[2] === "2" || m[2] === "4" };
  }
  return null;
}

/**
 * Format a typed value for a number field.
 * Returns { value, formatted } where `value` is the plain number stored in the
 * field (as Acrobat would) and `formatted` is what is shown and printed.
 */
export function formatForField(text, spec, locale = formats.locale) {
  const n = parseNumber(text, locale);
  return Number.isNaN(n) ? null : formatValue(n, spec, locale);
}

/** Same as formatForField, from a number (percent fields take the percentage, e.g. 15). */
export function formatValue(n, spec, locale = formats.locale) {
  const digits = { minimumFractionDigits: spec.decimals, maximumFractionDigits: spec.decimals, useGrouping: spec.grouping };
  if (spec.kind === "percent") {
    const ratio = n / 100;
    return {
      value: String(Number(ratio.toFixed(spec.decimals + 2))),
      formatted: pdfSafe(new Intl.NumberFormat(locale, { ...digits, style: "percent" }).format(ratio)),
    };
  }
  const abs = pdfSafe(new Intl.NumberFormat(locale, digits).format(Math.abs(n)));
  const sign = n < 0 && Number(Math.abs(n).toFixed(spec.decimals)) !== 0 ? "-" : "";
  const cur = spec.currency;
  return {
    value: String(Number(n.toFixed(spec.decimals))),
    // "-$99.90" and "-99,90 EUR": the sign always leads.
    formatted: sign + (cur ? (spec.prepend ? cur + abs : abs + cur) : abs),
  };
}
