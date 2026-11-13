'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('../../lib/config');
const { eventConditions, matchedStates, parseVerdict, conditionsOf } = require('../../lib/agent-check');
const { Pulses } = require('../../lib/pulse');

/** Rows of the tab AI check as the admin stores them. */
const rows = [
    { enabled: true, criterion: 'eine Person', profiles: 'Alex', state: true, hold: 30 },
    { enabled: true, criterion: 'ein Tier', profiles: '', state: true },
    { enabled: true, criterion: 'ein Auto', profiles: 'Alex' },
    { enabled: true, criterion: 'человек', profiles: '', state: true, hold: 1 },
    { enabled: true, criterion: 'Eine Person!', profiles: '', state: true },
    { enabled: true, criterion: 'nur Profil fehlt', profiles: '' },
    { enabled: false, criterion: 'aus', profiles: '', state: true },
];
const settings = normalizeSettings({
    profiles: [{ name: 'Alex', instance: 'telegram.0' }],
    agentChecks: rows,
});

/**
 * Timers that run when the test says so.
 *
 * @returns {any} The timers and a clock
 */
function fakeTimers() {
    let now = 0;
    let next = 1;
    /** @type {Map<number, {at: number, cb: () => void}>} */
    const timers = new Map();
    return {
        setTimeout: (/** @type {() => void} */ cb, /** @type {number} */ ms) => {
            const id = next++;
            timers.set(id, { at: now + ms, cb });
            return id;
        },
        clearTimeout: (/** @type {number} */ id) => timers.delete(id),
        advance(/** @type {number} */ ms) {
            now += ms;
            for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
                if (t.at <= now) {
                    timers.delete(id);
                    t.cb();
                }
            }
        },
        get count() {
            return timers.size;
        },
    };
}

describe('states of the AI check', () => {
    it('reads the columns State and Hold and makes a unique id of each criterion', () => {
        assert.deepEqual(
            settings.agentChecks.map(c => [c.criterion, c.state, c.hold, c.id]),
            [
                ['eine Person', true, 30, 'eine_person'],
                ['ein Tier', true, 60, 'ein_tier'],
                // a row of 0.6 without the column: no state, as before
                ['ein Auto', false, 60, 'ein_auto'],
                // nothing left of Cyrillic letters: the row number
                ['человек', true, 5, 'criterion_4'],
                ['Eine Person!', true, 60, 'eine_person_2'],
            ],
        );
    });

    it('asks a trigger also for the criteria with a state, a script only for its profiles', () => {
        const alex = settings.profiles;
        assert.deepEqual(conditionsOf(alex), ['eine Person', 'ein Auto']);
        assert.deepEqual(eventConditions(alex, settings.agentChecks, true), [
            'eine Person',
            'ein Auto',
            'ein Tier',
            'человек',
            'Eine Person!',
        ]);
        assert.deepEqual(eventConditions(alex, settings.agentChecks, false), ['eine Person', 'ein Auto']);
        // a trigger without profiles still asks when a criterion has a state
        assert.deepEqual(eventConditions([], settings.agentChecks, true), [
            'eine Person',
            'ein Tier',
            'человек',
            'Eine Person!',
        ]);
        assert.deepEqual(eventConditions([], normalizeSettings({}).agentChecks, true), []);
    });

    it('turns on the states whose criterion the picture meets', () => {
        const conditions = eventConditions([], settings.agentChecks, true);
        const verdict = parseVerdict('{"description": "Ein Mann", "matches": [true, false, false, true]}', conditions);
        assert.deepEqual(
            matchedStates(settings.agentChecks, verdict).map(c => c.id),
            ['eine_person', 'eine_person_2'],
        );
        // "ein Auto" has no state: it never turns one on
        const car = parseVerdict('{"matches": [true]}', ['ein Auto']);
        assert.deepEqual(matchedStates(settings.agentChecks, car), []);
    });

    it('keeps a state true for the hold time, a further match starts it anew', () => {
        const timers = fakeTimers();
        /** @type {[string, boolean][]} */
        const writes = [];
        const pulses = new Pulses({ timers, set: (id, value) => writes.push([id, value]) });
        pulses.fire('cameras.door.ai.eine_person', 30_000);
        assert.deepEqual(writes, [['cameras.door.ai.eine_person', true]]);
        timers.advance(20_000);
        pulses.fire('cameras.door.ai.eine_person', 30_000);
        // no second true, the hold time starts anew
        assert.equal(writes.length, 1);
        timers.advance(20_000);
        assert.ok(pulses.isOn('cameras.door.ai.eine_person'));
        timers.advance(10_000);
        assert.deepEqual(writes[1], ['cameras.door.ai.eine_person', false]);
        assert.ok(!pulses.isOn('cameras.door.ai.eine_person'));

        pulses.fire('cameras.door.ai.ein_tier', 60_000);
        pulses.stop();
        assert.equal(timers.count, 0);
    });

    it('offers the columns in the admin and names the channel in all languages', () => {
        const root = path.join(__dirname, '..', '..');
        const config = JSON.parse(fs.readFileSync(path.join(root, 'admin', 'jsonConfig.json'), 'utf8'));
        const columns = config.items._aiTab.items.agentChecks.items;
        assert.deepEqual(
            columns.map(c => c.attr),
            ['enabled', 'criterion', 'profiles', 'state', 'hold'],
        );
        assert.equal(
            columns.reduce((sum, c) => sum + parseInt(c.width, 10), 0),
            100,
        );
        assert.equal(columns.find(c => c.attr === 'state').default, false);
        const { NAMES } = require('../../lib/names');
        assert.equal(NAMES.ai.de, 'KI-Prüfung');
    });
});
