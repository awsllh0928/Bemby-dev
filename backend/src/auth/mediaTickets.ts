import { randomBytes } from 'crypto';

// An <img src> cannot carry an Authorization header, so a URL the browser loads directly has
// to carry its own credential. That used to be the session token itself, which put a
// seven-day key to the whole API into every image address: written to the server's access
// log, kept in the browser's history and memory cache, and handed to anything that later
// reads either.
//
// A media ticket stands in for it. It authorises one thing -- fetching inline chat media --
// for a short while, and it is not the session token, so a leaked one is worth very little
// and expires by itself.

type MediaTicket = { expiresAt: number };

const TTL_MS = 15 * 60_000;

/** Bounds the map on a long messenger session; oldest go first. */
const MAX_TICKETS = 100;

const tickets = new Map<string, MediaTicket>();

function sweep(): void {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
}

export function issueMediaTicket(): { ticket: string; expiresAt: number } {
  sweep();
  const ticket = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  tickets.set(ticket, { expiresAt });
  return { ticket, expiresAt };
}

/** Unlike the captcha, this is not consumed: one page renders many images from one ticket. */
export function isValidMediaTicket(ticket: string | undefined): boolean {
  if (!ticket) return false;
  const found = tickets.get(ticket);
  if (!found) return false;
  if (found.expiresAt <= Date.now()) {
    tickets.delete(ticket);
    return false;
  }
  return true;
}

/** Test hook: drops every outstanding ticket. */
export function resetMediaTickets(): void {
  tickets.clear();
}
