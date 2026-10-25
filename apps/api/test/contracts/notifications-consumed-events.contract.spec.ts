import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describeEventDefinition, type EventDescription } from '@mondapac-drive/shared-kernel';
import { CONSUMED_PUSH_EVENTS } from '../../src/modules/notifications/presentation/subscribers/consumed-events';

// Notifications declares the dispatch and identity events it consumes for push itself (it imports
// neither module). Each declaration must equal the publisher's entry in the checked-in catalogue
// snapshot, which the catalogue contracts test holds equal to what the publisher registers.

const SNAPSHOT = path.join(__dirname, 'event-catalogue.snapshot.json');

describe("notifications' declarations of the events it consumes for push", () => {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as EventDescription[];

  it.each(CONSUMED_PUSH_EVENTS.map((definition) => [definition.type, definition] as const))(
    '%s matches the catalogue snapshot',
    (type, definition) => {
      expect(describeEventDefinition(definition)).toEqual(
        snapshot.find((entry) => entry.type === type),
      );
    },
  );
});
