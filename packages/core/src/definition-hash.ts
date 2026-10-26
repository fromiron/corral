import type { CorralDefinition } from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from './canonical-json.ts';

/**
 * SHA-256 (hex) of the RFC 8785 canonical form of a definition.
 * Layout is a separate document, so moving nodes never changes this value.
 */
export function definitionHash(definition: CorralDefinition): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(definition))));
}
