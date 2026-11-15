'use strict';

const assert = require('node:assert/strict');
const { parseCron, cronMatches, parseTime, normalizeSchedule, runsAt, nextRun } = require('../../lib/schedule');
const { HELP } = require('../../lib/help');
const { NAMES } = require('../../lib/names');

/**
 * @param {string} text - Local time `YYYY-MM-DD HH:MM`
 * @returns {Date} The date
 */
const at = text => {
    const [d, t] = text.split(' ');
    const [y, mo, day] = d.split('-').map(Number);
    const [h, mi] = t.split(':').map(Number);
    return new Date(y, mo - 1, day, h, mi, 0, 0);
};

/**
 * @param {Record<string, unknown>} raw - States
 * @returns {ReturnType<typeof normalizeSchedule>} Checked schedule, enabled
 */
const sched = raw => normalizeSchedule({ enabled: true, ...raw });

describe('schedule', () => {
    it('reads cron patterns with lists, ranges, steps and names', () => {
        const c = parseCron('*/15 7-9,18 * * mon-fri');
        assert.deepEqual([...c.minutes], [0, 15, 30, 45]);
        assert.deepEqual([...c.hours], [7, 8, 9, 18]);
        assert.deepEqual([...c.weekdays], [1, 2, 3, 4, 5]);
        // 2026-11-16 is a Monday, 2026-11-15 a Sunday
        assert.ok(cronMatches(c, at('2026-11-16 08:30')));
        assert.ok(!cronMatches(c, at('2026-11-15 08:30')));
        assert.ok(!cronMatches(c, at('2026-11-16 10:00')));
        // 7 is Sunday too, months by name
        assert.ok(cronMatches(parseCron('0 12 * nov 7'), at('2026-11-15 12:00')));
        // the admin dialog may write seconds first
        assert.ok(cronMatches(parseCron('0 0 7 * * *'), at('2026-11-15 07:00')));
    });

    it('runs on a day of the month or a weekday when both are restricted, as cron does', () => {
        const c = parseCron('0 9 1 * sun');
        assert.ok(cronMatches(c, at('2026-12-01 09:00')), 'the 1st, a Tuesday');
        assert.ok(cronMatches(c, at('2026-11-15 09:00')), 'a Sunday');
        assert.ok(!cronMatches(c, at('2026-11-16 09:00')));
    });

    it('refuses wrong patterns with the reason', () => {
        assert.throws(() => parseCron('0 7 * *'), /five fields/);
        assert.throws(() => parseCron('61 * * * *'), /out of range 0-59/);
        assert.throws(() => parseCron('* 9-7 * * *'), /backwards/);
        assert.throws(() => parseCron('*/0 * * * *'), /step/);
        const { cron, problems } = sched({ cron: '0 25 * * *' });
        assert.equal(cron, null);
        assert.match(problems[0], /cron "0 25 \* \* \*": "25" is out of range 0-23/);
    });

    it('runs an interval counted from midnight, only inside its window, also over midnight', () => {
        const { schedule, cron } = sched({ interval: 30, from: '22:00', to: '06:00' });
        assert.ok(runsAt(schedule, cron, at('2026-11-15 22:00')));
        assert.ok(runsAt(schedule, cron, at('2026-11-16 05:30')));
        assert.ok(!runsAt(schedule, cron, at('2026-11-16 06:00')), 'the end is not included');
        assert.ok(!runsAt(schedule, cron, at('2026-11-15 12:00')));
        assert.ok(!runsAt(schedule, cron, at('2026-11-15 22:15')));
        const day = sched({ interval: 45 });
        assert.ok(runsAt(day.schedule, day.cron, at('2026-11-15 00:45')));
        assert.ok(runsAt(day.schedule, day.cron, at('2026-11-15 01:30')));
    });

    it('runs nothing when switched off, and interval and plan together', () => {
        const off = normalizeSchedule({ interval: 5, cron: '* * * * *' });
        assert.ok(!runsAt(off.schedule, off.cron, at('2026-11-15 10:00')));
        assert.equal(nextRun(off.schedule, off.cron), 0);
        const both = sched({ interval: 60, cron: '30 7 * * *' });
        assert.ok(runsAt(both.schedule, both.cron, at('2026-11-15 07:00')));
        assert.ok(runsAt(both.schedule, both.cron, at('2026-11-15 07:30')));
        assert.ok(!runsAt(both.schedule, both.cron, at('2026-11-15 07:15')));
    });

    it('finds the next run after now, at the next full minute at the earliest', () => {
        const { schedule, cron } = sched({ cron: '0 7,19 * * *' });
        assert.equal(nextRun(schedule, cron, at('2026-11-15 07:00').getTime()), at('2026-11-15 19:00').getTime());
        assert.equal(
            nextRun(schedule, cron, at('2026-11-15 20:00').getTime() + 30_000),
            at('2026-11-16 07:00').getTime(),
        );
        const yearly = sched({ cron: '0 0 29 2 *' });
        // the next 29 February is more than a year away: no next run is shown
        assert.equal(nextRun(yearly.schedule, yearly.cron, at('2026-11-15 10:00').getTime()), 0);
        assert.equal(
            nextRun(yearly.schedule, yearly.cron, at('2027-11-15 10:00').getTime()),
            at('2028-02-29 00:00').getTime(),
        );
        assert.equal(nextRun(sched({}).schedule, null), 0, 'enabled without interval and plan');
    });

    it('checks the values and keeps the good parts', () => {
        const { schedule, problems } = normalizeSchedule({
            enabled: 'true',
            interval: '15',
            from: '25:00',
            to: '06:00',
            action: 'video',
            profiles: ' Alex, Family ',
        });
        assert.deepEqual(schedule, {
            enabled: true,
            interval: 15,
            cron: '',
            from: '',
            to: '06:00',
            action: 'snapshot',
            profiles: 'Alex, Family',
        });
        assert.deepEqual(problems, [
            'action "video" must be snapshot, record or both',
            'from "25:00" must be a time HH:MM',
            'from and to are needed together, the interval runs all day',
        ]);
        assert.equal(parseTime('7:05'), 425);
        assert.equal(parseTime('07:60'), null);
        assert.deepEqual(normalizeSchedule({ interval: 2000 }).problems, ['interval "2000" must be 0 to 1440 minutes']);
    });

    it('is described for agents and named in all languages', () => {
        assert.match(HELP, /schedule\.\), write the states/);
        for (const key of ['schedule', 'schedule_enabled', 'schedule_interval', 'schedule_cron', 'schedule_next']) {
            assert.equal(Object.keys(NAMES[key]).length, 11, key);
        }
    });
});
