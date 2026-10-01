import { sha256Text } from '../integrity/integrity.ts';
import { canonicalJson } from './canonical-json.ts';
import type { WorkflowDefinition } from './definition.ts';
import { validateWorkflowDefinition, type WorkflowValidationError } from './validator.ts';

/**
 * `definitionHash` = SHA-256 (hex) of the canonical JSON of a validated definition
 * (docs/36 §3.5). It is what a workflow instance pins (ADR-018): the same definition, with
 * its keys in any order and any whitespace, always yields the same hash; any change to a
 * value, to array order, or to a `$comment` yields a different one. Reuses the project's
 * existing `sha256Text` (core/integrity).
 */

export function canonicalizeDefinition(definition: WorkflowDefinition): string {
  return canonicalJson(definition);
}

export function hashDefinition(definition: WorkflowDefinition): string {
  return sha256Text(canonicalizeDefinition(definition));
}

export type WorkflowDefinitionHashResult =
  | { valid: true; definition: WorkflowDefinition; canonical: string; definitionHash: string; errors: [] }
  | { valid: false; definition: null; canonical: null; definitionHash: null; errors: WorkflowValidationError[] };

/** Validates, and hashes only an accepted definition — an invalid one never gets a hash. */
export function validateAndHashWorkflowDefinition(input: unknown): WorkflowDefinitionHashResult {
  const result = validateWorkflowDefinition(input);
  if (!result.valid) return { valid: false, definition: null, canonical: null, definitionHash: null, errors: result.errors };
  const canonical = canonicalizeDefinition(result.definition);
  return { valid: true, definition: result.definition, canonical, definitionHash: sha256Text(canonical), errors: [] };
}
