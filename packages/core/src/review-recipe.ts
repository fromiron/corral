import { canonicalJson, type ReviewRecipeRevision } from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function reviewCriteriaHash(criteria: readonly string[]): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(criteria))));
}
export function recipeAttempts(recipe: ReviewRecipeRevision): number {
  return Math.min(recipe.maxAttempts, recipe.maxRepairs + 1);
}
