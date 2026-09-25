/** Toolbar badge text for a blocked count; the badge fits about four characters. */
export function badgeText(n: number): string {
  if (n <= 0) return "";
  if (n < 1000) return String(n);
  return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.floor(n / 1000)}k`;
}
