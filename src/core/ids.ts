import { monotonicFactory, ulid as randomUlid } from "ulid";

/**
 * Process-local monotonic ULID factory.
 *
 * ULIDs are 26 chars, time-prefixed, lexicographically sortable. Using the
 * monotonic factory guarantees that two ULIDs generated in the same
 * millisecond from this process still strictly increase, which we rely on
 * for `cursor < event.id` comparisons.
 *
 * Cross-process collisions in the same millisecond are still possible but
 * extremely rare and are caught at the storage layer (file name uniqueness).
 */
const factory = monotonicFactory();

export function newId(now?: number): string {
  return factory(now);
}

/** Random non-monotonic ULID, used for one-off session ids / ack tokens. */
export function freshId(): string {
  return randomUlid();
}

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}
