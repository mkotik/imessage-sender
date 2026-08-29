/** Mask a handle (phone/email) for logs: keep enough to recognise, never the full value. */
export function maskHandle(handle: string | undefined | null): string {
  if (!handle) return "(none)";
  const h = handle.trim();
  const at = h.indexOf("@");
  if (at > 0) {
    const local = h.slice(0, at);
    const domain = h.slice(at + 1);
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  const digits = h.replace(/\D/g, "");
  if (digits.length <= 6) return h.length <= 8 ? `short:${"•".repeat(h.length)}` : "•••";
  const prefix = h.startsWith("+") ? "+" + digits.slice(0, 1) : "";
  return `${prefix}${"•".repeat(Math.max(3, digits.length - 5))}${digits.slice(-4)}`;
}

/** Short, non-reversible tag for correlating a message across log lines. */
export function shortGuid(guid: string | undefined | null): string {
  if (!guid) return "(none)";
  return guid.slice(0, 8);
}
