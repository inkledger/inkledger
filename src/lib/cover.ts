/** Stable 0..n-1 bucket for a string (cover/avatar variety per project). */
export function hashIndex(value: string, n: number): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** Warm grainy cover class for an issue or project. */
export function coverClass(seed: string): string {
  return `cover-${hashIndex(seed, 6)}`;
}
