'use strict';

/**
 * Schedule of a camera: the states `cameras.<camera>.schedule.*` that the card of the Device Manager, scripts, scenes
 * and AI agents write. Every N minutes (counted from midnight, so 30 = :00 and :30), optionally only between two
 * times, and/or by a cron pattern; each run takes a snapshot, a clip or both and sends them through the named
 * profiles, like a trigger.
 *
 * @typedef {object} Schedule
 * @property {boolean} enabled - Main switch
 * @property {number} interval - Minutes, 0 = off
 * @property {string} cron - Five fields `minute hour day month weekday`, empty = off
 * @property {string} from - `HH:MM`, empty = all day (the interval only)
 * @property {string} to - `HH:MM`, empty = all day (the interval only)
 * @property {'snapshot' | 'record' | 'both'} action - What a run takes
 * @property {string} profiles - Names of the send profiles, empty = only saved
 * @property {boolean} aiOnly - Send only to the profiles whose criteria of the tab AI check the picture meets
 * @property {string} onlyIfState - Run only while this state meets the condition, empty = always
 * @property {'eq' | 'ne' | 'gt' | 'lt'} onlyIfOp - Operator of the condition
 * @property {string} onlyIfValue - Value of the condition
 */

/** The writable states and their defaults; `next` is written by the adapter. */
const SCHEDULE_DEFAULTS = Object.freeze({
    enabled: false,
    interval: 0,
    cron: '',
    from: '',
    to: '',
    action: 'snapshot',
    profiles: '',
    aiOnly: false,
    onlyIfState: '',
    onlyIfOp: 'eq',
    onlyIfValue: '',
});

const OPS = ['eq', 'ne', 'gt', 'lt'];

const ACTIONS = ['snapshot', 'record', 'both'];

/** Field limits of a cron pattern: minute, hour, day of month, month, day of week (0 and 7 = Sunday). */
const CRON_FIELDS = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12 },
    { min: 0, max: 7 },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * @param {string} text - One field, e.g. `*`, `5`, `1-5`, `*\/15`, `mon-fri`, `0,30`
 * @param {number} index - Position of the field
 * @returns {Set<number>} The allowed values
 */
function parseField(text, index) {
    const { min, max } = CRON_FIELDS[index];
    const names = index === 3 ? MONTHS : index === 4 ? DAYS : null;
    /** @param {string} v - Number or name */
    const value = v => {
        const lower = v.toLowerCase();
        const named = names ? names.indexOf(lower) : -1;
        const n = named >= 0 ? named + (index === 3 ? 1 : 0) : /^\d+$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(n) || n < min || n > max) {
            throw new Error(`"${v}" is out of range ${min}-${max}`);
        }
        return n;
    };
    const values = new Set();
    for (const part of text.split(',')) {
        const [range, stepText] = part.split('/');
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1) {
            throw new Error(`"${part}" has no valid step`);
        }
        let from;
        let to;
        if (range === '*') {
            from = min;
            to = max;
        } else if (range.includes('-')) {
            const [a, b] = range.split('-');
            from = value(a);
            to = value(b);
            if (from > to) {
                throw new Error(`"${range}" runs backwards`);
            }
        } else {
            from = value(range);
            to = stepText === undefined ? from : max;
        }
        for (let n = from; n <= to; n += step) {
            values.add(index === 4 && n === 7 ? 0 : n);
        }
    }
    return values;
}

/**
 * @param {string} pattern - Cron pattern with five fields
 * @returns {{minutes: Set<number>, hours: Set<number>, days: Set<number>, months: Set<number>, weekdays: Set<number>, anyDay: boolean, anyWeekday: boolean}} The parsed pattern
 * @throws {Error} With the reason when the pattern is invalid
 */
function parseCron(pattern) {
    let fields = String(pattern ?? '')
        .trim()
        .split(/\s+/);
    // the cron dialog of the admin may write six fields with the seconds first: runs are per minute
    if (fields.length === 6) {
        fields = fields.slice(1);
    }
    if (fields.length !== 5) {
        throw new Error('a cron pattern needs five fields: minute hour day month weekday');
    }
    const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, i));
    return { minutes, hours, days, months, weekdays, anyDay: fields[2] === '*', anyWeekday: fields[4] === '*' };
}

/**
 * @param {ReturnType<typeof parseCron>} cron - Parsed pattern
 * @param {Date} date - Minute to test (local time)
 * @returns {boolean} Whether the pattern runs in this minute; day and weekday both restricted = either matches, as in
 *   the classic cron
 */
function cronMatches(cron, date) {
    if (!cron.minutes.has(date.getMinutes()) || !cron.hours.has(date.getHours())) {
        return false;
    }
    if (!cron.months.has(date.getMonth() + 1)) {
        return false;
    }
    const day = cron.days.has(date.getDate());
    const weekday = cron.weekdays.has(date.getDay());
    if (cron.anyDay || cron.anyWeekday) {
        return day && weekday;
    }
    return day || weekday;
}

/**
 * @param {unknown} text - `HH:MM` or `H:MM`
 * @returns {number | null} Minutes after midnight, null for empty or invalid
 */
function parseTime(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
    if (!match) {
        return null;
    }
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

/**
 * A schedule as the adapter runs it, with the problems of its values.
 *
 * @param {Partial<Record<keyof Schedule, unknown>>} raw - Values of the states
 * @returns {{schedule: Schedule, cron: ReturnType<typeof parseCron> | null, problems: string[]}} Checked schedule
 */
function normalizeSchedule(raw) {
    const r = raw || {};
    const problems = [];
    const interval = Number(r.interval ?? 0);
    /** @type {Schedule} */
    const schedule = {
        enabled: r.enabled === true || r.enabled === 'true',
        interval: Number.isFinite(interval) ? Math.min(1440, Math.max(0, Math.round(interval))) : 0,
        cron: String(r.cron ?? '').trim(),
        from: String(r.from ?? '').trim(),
        to: String(r.to ?? '').trim(),
        action: ACTIONS.includes(String(r.action)) ? /** @type {Schedule['action']} */ (String(r.action)) : 'snapshot',
        profiles: String(r.profiles ?? '').trim(),
        aiOnly: r.aiOnly === true || r.aiOnly === 'true',
        onlyIfState: String(r.onlyIfState ?? '').trim(),
        onlyIfOp: OPS.includes(String(r.onlyIfOp)) ? /** @type {Schedule['onlyIfOp']} */ (String(r.onlyIfOp)) : 'eq',
        onlyIfValue: String(r.onlyIfValue ?? '').trim(),
    };
    if (r.onlyIfOp !== undefined && r.onlyIfOp !== null && r.onlyIfOp !== '' && !OPS.includes(String(r.onlyIfOp))) {
        problems.push(`onlyIfOp "${String(r.onlyIfOp)}" must be eq, ne, gt or lt`);
    }
    if (!Number.isFinite(interval) || interval < 0 || interval > 1440) {
        problems.push(`interval "${String(r.interval)}" must be 0 to 1440 minutes`);
    }
    if (r.action !== undefined && r.action !== null && r.action !== '' && !ACTIONS.includes(String(r.action))) {
        problems.push(`action "${String(r.action)}" must be snapshot, record or both`);
    }
    for (const key of /** @type {const} */ (['from', 'to'])) {
        if (schedule[key] && parseTime(schedule[key]) === null) {
            problems.push(`${key} "${schedule[key]}" must be a time HH:MM`);
            schedule[key] = '';
        }
    }
    if (Boolean(schedule.from) !== Boolean(schedule.to)) {
        problems.push('from and to are needed together, the interval runs all day');
    }
    let cron = null;
    if (schedule.cron) {
        try {
            cron = parseCron(schedule.cron);
        } catch (err) {
            problems.push(`cron "${schedule.cron}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { schedule, cron, problems };
}

/**
 * @param {Schedule} schedule - Checked schedule
 * @param {ReturnType<typeof parseCron> | null} cron - Its parsed pattern
 * @param {Date} date - Minute to test (local time)
 * @returns {boolean} Whether the schedule runs in this minute
 */
function runsAt(schedule, cron, date) {
    if (!schedule.enabled) {
        return false;
    }
    const minute = date.getHours() * 60 + date.getMinutes();
    if (schedule.interval > 0 && minute % schedule.interval === 0 && inWindow(schedule, minute)) {
        return true;
    }
    return Boolean(cron && cronMatches(cron, date));
}

/**
 * @param {Schedule} schedule - Checked schedule
 * @param {number} minute - Minutes after midnight
 * @returns {boolean} Whether the interval may run now; a window over midnight (22:00 to 06:00) works
 */
function inWindow(schedule, minute) {
    const from = parseTime(schedule.from);
    const to = parseTime(schedule.to);
    if (from === null || to === null || from === to) {
        return true;
    }
    return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/**
 * @param {Schedule} schedule - Checked schedule
 * @param {ReturnType<typeof parseCron> | null} cron - Its parsed pattern
 * @param {number} [after] - Time in ms; the search starts at the next full minute
 * @returns {number} Time of the next run in ms, 0 = none within a year
 */
function nextRun(schedule, cron, after = Date.now()) {
    if (!schedule.enabled || (!(schedule.interval > 0) && !cron)) {
        return 0;
    }
    const date = new Date(after);
    date.setSeconds(0, 0);
    for (let i = 0; i < 366 * 24 * 60; i++) {
        date.setMinutes(date.getMinutes() + 1);
        if (runsAt(schedule, cron, date)) {
            return date.getTime();
        }
    }
    return 0;
}

module.exports = {
    SCHEDULE_DEFAULTS,
    ACTIONS,
    parseCron,
    cronMatches,
    parseTime,
    normalizeSchedule,
    runsAt,
    nextRun,
};
