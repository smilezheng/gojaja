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

/**
 * Crockford base32 alphabet used by ULID. The "time" portion of a ULID
 * is the first 10 characters, encoding 48 bits of Unix-millis.
 *
 * We do NOT pull in `ulid`'s `decodeTime` because it throws on a
 * marginal-but-still-parseable input; we want a strict "decode or treat
 * as 0" behaviour, since invalid event ids are caught upstream by
 * `isUlid`.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function decodeUlidTimestamp(id: string): number {
  // Caller is responsible for ensuring `id` already passed isUlid.
  // Worth noting: the first character of a ULID can encode at most 0..7
  // (3 bits) before the timestamp overflows JavaScript's safe-integer
  // range; we ignore that overflow concern since real timestamps in our
  // lifetime fit comfortably within the encoding.
  let ts = 0;
  for (let i = 0; i < 10; i++) {
    const idx = CROCKFORD.indexOf(id[i]);
    if (idx < 0) return 0;
    ts = ts * 32 + idx;
  }
  return ts;
}
