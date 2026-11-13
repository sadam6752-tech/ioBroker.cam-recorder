'use strict';

/**
 * States that turn true for a while, like a motion sensor: `fire` sets the state true and false again after the hold
 * time; a further `fire` before that keeps it true and starts the hold time anew. Used for the states of the tab AI
 * check (`cameras.<camera>.ai.<criterion>`).
 */
class Pulses {
    /**
     * @param {object} options - Options
     * @param {import('./types').Timers} options.timers - Timer functions of the adapter
     * @param {(id: string, value: boolean) => void} options.set - Writes the state (ack)
     */
    constructor({ timers, set }) {
        this.timers = timers;
        this.set = set;
        /** @type {Map<string, unknown>} id → timer that turns it false */
        this.pending = new Map();
    }

    /**
     * @param {string} id - State id
     * @param {number} holdMs - Time until it turns false again
     */
    fire(id, holdMs) {
        const running = this.pending.get(id);
        if (running) {
            this.timers.clearTimeout(running);
        } else {
            this.set(id, true);
        }
        this.pending.set(
            id,
            this.timers.setTimeout(() => {
                this.pending.delete(id);
                this.set(id, false);
            }, holdMs),
        );
    }

    /**
     * @param {string} id - State id
     * @returns {boolean} Whether the state is true now
     */
    isOn(id) {
        return this.pending.has(id);
    }

    /** Stops the timers; the states keep their values (the start of the adapter sets them false). */
    stop() {
        for (const timer of this.pending.values()) {
            this.timers.clearTimeout(timer);
        }
        this.pending.clear();
    }
}

module.exports = { Pulses };
