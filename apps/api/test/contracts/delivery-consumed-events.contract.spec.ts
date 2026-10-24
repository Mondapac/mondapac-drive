import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describeEventDefinition, type EventDescription } from '@mondapac-drive/shared-kernel';
import { CONSUMED_DISPATCH_EVENTS } from '../../src/modules/delivery/presentation/subscribers/dispatch-contract';

// Delivery declares the dispatch events it consumes itself (it does not import dispatch). Each
// declaration must equal dispatch's entry in the checked-in catalogue snapshot, which the
// catalogue contracts test holds equal to what dispatch registers: a change on either side fails.

const SNAPSHOT = path.join(__dirname, 'event-catalogue.snapshot.json');

describe("delivery's declarations of the dispatch events it consumes", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as EventDescription[];

  it.each(CONSUMED_DISPATCH_EVENTS.map((definition) => [definition.type, definition] as const))(
    '%s matches the catalogue snapshot',
    (type, definition) => {
      expect(describeEventDefinition(definition)).toEqual(
        snapshot.find((entry) => entry.type === type),
      );
    },
  );
});
