import { UsageError } from "./errors";

/**
 * Role ids are user-facing identifiers used as path components in many places
 * (roles/<id>.md, comms/inbox/<id>/, locks/<id>.lock). They must therefore be
 * tightly constrained.
 *
 * Whitelist: ASCII letter start, then letters/digits/underscore/hyphen. Length
 * 1..64. Reserved names are rejected to avoid collisions with framework slots.
 */

const ROLE_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED: ReadonlySet<string> = new Set([
  "SYSTEM",
  "ALL",
  "ANY",
  "*",
  "_",
  ".",
  "..",
]);

export function validateRoleId(value: string): string {
  if (typeof value !== "string" || !ROLE_REGEX.test(value)) {
    throw new UsageError(
      `Invalid role id '${value}'. Must match [A-Za-z][A-Za-z0-9_-]{0,63}.`,
    );
  }
  if (RESERVED.has(value.toUpperCase())) {
    throw new UsageError(`Role id '${value}' is reserved.`);
  }
  return value;
}

/** Same regex but stricter, for things like RFC slugs. */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateSlug(value: string): string {
  if (typeof value !== "string" || !SLUG_REGEX.test(value)) {
    throw new UsageError(
      `Invalid slug '${value}'. Must match [a-z0-9][a-z0-9-]{0,63}.`,
    );
  }
  return value;
}
