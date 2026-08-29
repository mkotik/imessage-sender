/**
 * Phone-number normalisation for matching Messages handles against Contacts entries.
 * No external library: we only need a stable key, not validation.
 */

export interface PhoneKeys {
  /** All digits, with a leading country code when it can be inferred (E.164 without "+"). */
  full: string;
  /** Last 10 digits — NANP fallback so "(555) 123-4567" matches "+1 555 123 4567". */
  last10?: string;
}

const DEFAULT_COUNTRY_CODE = "1";

export function isEmailHandle(handle: string): boolean {
  return handle.includes("@");
}

/** Numeric-only handles of 3–8 digits are carrier short codes, not phone numbers. */
export function isShortCode(handle: string): boolean {
  return /^\d{3,8}$/.test(handle.trim());
}

export function phoneKeys(raw: string, defaultCountryCode = DEFAULT_COUNTRY_CODE): PhoneKeys | undefined {
  let s = raw.trim();
  if (!s || s.includes("@")) return undefined;
  // strip extensions like "x123" / "ext. 4"
  s = s.replace(/\s*(?:x|ext\.?|extension)\s*\d+$/i, "");
  const hadPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (digits.length < 3) return undefined;
  // International dialling prefix "00" → treat like "+"
  if (!hadPlus && digits.startsWith("00") && digits.length > 11) digits = digits.slice(2);
  let full: string;
  if (hadPlus) {
    full = digits;
  } else if (digits.length === 10) {
    full = defaultCountryCode + digits;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    full = digits;
  } else {
    full = digits;
  }
  const keys: PhoneKeys = { full };
  if (full.length >= 10) keys.last10 = full.slice(-10);
  return keys;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
