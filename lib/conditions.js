'use strict';

const { isTruthy } = require('./triggers');

/**
 * Compares the current value of a condition state with the configured value.
 *
 * - Numbers are compared as numbers (`>`, `<` only make sense there).
 * - A boolean state matches `true`/`false` as well as `1`/`0`, `on`/`off`, `yes`/`no`.
 * - Everything else is compared as text, case does not matter.
 *
 * @param {'eq' | 'ne' | 'gt' | 'lt'} op - Operator
 * @param {string} expected - Value from the settings
 * @param {unknown} actual - Current state value; null or undefined never matches
 * @returns {boolean} True when the condition holds
 */
function conditionMet(op, expected, actual) {
    if (actual === null || actual === undefined) {
        return false;
    }
    const want = String(expected ?? '').trim();
    if (op === 'gt' || op === 'lt') {
        const a = Number(actual);
        const b = Number(want.replace(',', '.'));
        if (!Number.isFinite(a) || !Number.isFinite(b) || want === '') {
            return false;
        }
        return op === 'gt' ? a > b : a < b;
    }
    let equal;
    if (typeof actual === 'boolean') {
        equal = actual === isTruthy(want);
    } else if (typeof actual === 'number' && want !== '' && Number.isFinite(Number(want.replace(',', '.')))) {
        equal = actual === Number(want.replace(',', '.'));
    } else {
        equal = String(actual).trim().toLowerCase() === want.toLowerCase();
    }
    return op === 'ne' ? !equal : equal;
}

/**
 * @param {'eq' | 'ne' | 'gt' | 'lt'} op - Operator
 * @returns {string} Symbol for log lines
 */
function opSymbol(op) {
    return { eq: '=', ne: '≠', gt: '>', lt: '<' }[op] || '=';
}

module.exports = { conditionMet, opSymbol };
