'use strict';

/**
 * @param {unknown} val - State value
 * @returns {boolean} True for `true`, a number other than 0 and a text other than `false`, `0`, `off`, `no`
 */
function isTruthy(val) {
    if (typeof val === 'boolean') {
        return val;
    }
    if (typeof val === 'number') {
        return val !== 0 && Number.isFinite(val);
    }
    if (typeof val === 'string') {
        const text = val.trim().toLowerCase();
        return text !== '' && !['false', '0', 'off', 'no'].includes(text);
    }
    return false;
}

/**
 * Decides whether a write of a trigger state starts the action. Every write counts, also
 * the same value again (a doorbell writes `true` at each ring), and the cooldown keeps a
 * burst of writes to one action.
 *
 * @param {import('./config').Trigger} trigger - Trigger
 * @param {ioBroker.State | null | undefined} state - New state
 * @param {number} lastFired - Time of the last action in ms, 0 = never
 * @param {number} now - Current time in ms
 * @returns {boolean} True if the action should run
 */
function shouldFire(trigger, state, lastFired, now) {
    return triggerDecision(trigger, state, lastFired, now) === 'fire';
}

/**
 * Like `shouldFire`, but tells a write inside the cooldown apart: such an event may extend a
 * clip that is still being cut.
 *
 * @param {import('./config').Trigger} trigger - Trigger
 * @param {ioBroker.State | null | undefined} state - New state
 * @param {number} lastFired - Time of the last action in ms, 0 = never
 * @param {number} now - Current time in ms
 * @returns {'fire' | 'cooldown' | 'skip'} What to do
 */
function triggerDecision(trigger, state, lastFired, now) {
    if (!state) {
        return 'skip';
    }
    if (trigger.condition === 'truthy' && !isTruthy(state.val)) {
        return 'skip';
    }
    return !lastFired || now - lastFired >= trigger.cooldown * 1000 ? 'fire' : 'cooldown';
}

/**
 * Formats a date like the ioBroker system setting `dateFormat` (`DD.MM.YYYY`, `YYYY-MM-DD`,
 * `MM/DD/YYYY`, …): `YYYY`/`JJJJ`, `YY`/`JJ`, `MM`, `DD`/`TT` are replaced.
 *
 * @param {Date} date - Date
 * @param {string} [format] - System date format, default `DD.MM.YYYY`
 * @returns {string} The date
 */
function formatDay(date, format) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const year = String(date.getFullYear());
    return String(format || 'DD.MM.YYYY')
        .replace(/YYYY|JJJJ/g, year)
        .replace(/YY|JJ/g, year.slice(-2))
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/DD|TT/g, pad(date.getDate()));
}

/**
 * @param {string} template - Caption with `{camera}`, `{date}` and `{time}`
 * @param {string} camera - Camera name
 * @param {Date} time - Time of the recording
 * @param {string} [dateFormat] - System date format
 * @returns {string} The caption
 */
function formatCaption(template, camera, time, dateFormat) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
    return String(template ?? '')
        .replace(/\{camera\}/g, camera)
        .replace(/\{date\}/g, formatDay(time, dateFormat))
        .replace(/\{time\}/g, clock);
}

module.exports = { isTruthy, shouldFire, triggerDecision, formatCaption, formatDay };
