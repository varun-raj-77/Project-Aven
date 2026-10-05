import type { EventId } from '@aven/contracts';
import type { EventInput, Ledger } from '../src/index.ts';

function boundary(ledger: Ledger, event: EventInput, id: EventId) {
  // @ts-expect-error Canonical sequence cannot be supplied by the caller.
  ledger.appendEvent({ ...event, sequence: 100 });
  // @ts-expect-error Recording timestamp belongs to the Ledger.
  ledger.appendEvent({ ...event, recordedAt: '2026-10-04T12:00:00Z' });
  // @ts-expect-error No historical update API exists.
  ledger.updateEvent(id, event);
  // @ts-expect-error No historical deletion API exists.
  ledger.deleteEvent(id);
  // @ts-expect-error The public Ledger does not expose storage.
  ledger.sqlite.exec('DELETE FROM experience_events');
  // @ts-expect-error Filters cannot select a different owner.
  ledger.listEvents({ ownerId: 'owner_other' });
}
void boundary;
