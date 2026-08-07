/**
 * WCAG contrast, so "is that legible?" has an answer rather than an opinion.
 *
 * Written because it was not obvious. The teal in the first mockup measured **4.88:1** against
 * white — legal for body text, and muddy on a Save button. And white on the *dark* theme's
 * lifted teal measures **2.56:1**, which is a plain failure: exactly the kind of thing a
 * hardcoded `color: #fff` produces the moment a theme flips.
 *
 * `styles.test.ts` reads the real values out of `styles.css` with this, so the stylesheet stays
 * the single source of truth and no pair can quietly drop below its threshold.
 */

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

function channels(hex: string): [number, number, number] {
  const cleaned = hex.trim().replace('#', '');
  // Both `#abc` and `#aabbcc`, because a stylesheet may use either.
  const full = cleaned.length === 3
    ? cleaned.split('').map((c) => c + c).join('')
    : cleaned;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);

  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
