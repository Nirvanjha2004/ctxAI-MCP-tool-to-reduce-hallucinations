import { distance } from "fastest-levenshtein";

export function getClosestMatch(target: string, options: string[]): string | null {
  if (options.length === 0) return null;
  
  let minDistance = Infinity;
  let closest = null;

  for (const option of options) {
    const d = distance(target, option);
    if (d < minDistance) {
      minDistance = d;
      closest = option;
    }
  }

  // Only suggest if it's reasonably close (max 40% difference)
  return minDistance < target.length * 0.4 ? closest : null;
}