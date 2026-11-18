/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/** A single inbound world event (chat, system message, join notices...). */
export interface WorldEvent {
  /** Monotonic sequence number, used as a polling cursor. */
  seq: number;
  /** Milliseconds since the epoch. */
  time: number;
  /** The rendered message text. */
  text: string;
}

/**
 * Bounded ring buffer of inbound messages, so an external agent can poll
 * `/events?after=<seq>` and never miss a message within the buffer window.
 *
 * Chat is pull-only in this design: the bot does not push events anywhere,
 * the agent asks for what happened since its last cursor.
 */
export class EventLog {
  private readonly events: WorldEvent[] = [];
  private head = 0;

  private readonly capacity: number;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  /** Append a message to the log, evicting the oldest when full. */
  record(text: string): void {
    this.events.push({ seq: ++this.head, time: Date.now(), text });
    if (this.events.length > this.capacity) this.events.shift();
  }

  /** Return events newer than `after`, plus the current head cursor. */
  since(after: number): { events: WorldEvent[]; head: number } {
    return {
      events: this.events.filter((event) => event.seq > after),
      head: this.head,
    };
  }
}
