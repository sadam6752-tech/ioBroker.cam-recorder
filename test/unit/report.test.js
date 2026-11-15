'use strict';

const assert = require('node:assert/strict');
const {
    MAX_ENTRIES,
    MAX_TEXT,
    normalizeReport,
    reportDue,
    addEntry,
    parseJournal,
    reportEntries,
    plainReport,
    reportQuestion,
    reportTitle,
    reportText,
} = require('../../lib/report');
const { normalizeSettings } = require('../../lib/config');
const { HELP } = require('../../lib/help');
const { NAMES } = require('../../lib/names');

/**
 * @param {string} text - Local time `YYYY-MM-DD HH:MM`
 * @returns {Date} The date
 */
function at(text) {
    const [day, clock] = text.split(' ');
    const [y, m, d] = day.split('-').map(Number);
    const [h, min] = clock.split(':').map(Number);
    return new Date(y, m - 1, d, h, min);
}

/**
 * @param {string} time - Local time
 * @param {string} camera - Camera name
 * @param {string} description - Description
 * @param {string[]} [matches] - Criteria seen
 * @returns {import('../../lib/report').ReportEntry} A line
 */
function entry(time, camera, description, matches = []) {
    return { time: at(time).getTime(), camera, cameraId: camera.toLowerCase(), description, matches };
}

describe('report', () => {
    it('reads the settings, 21:00 when the time is empty or wrong', () => {
        const { report, problems } = normalizeReport({
            reportEnabled: true,
            reportTime: '7:05',
            reportProfiles: 'Alex, Family',
            reportCameras: ' Door ',
            reportInstructions: ' no animals ',
        });
        assert.deepEqual(report, {
            enabled: true,
            at: 7 * 60 + 5,
            time: '7:05',
            profiles: ['Alex', 'Family'],
            cameras: ['Door'],
            instructions: 'no animals',
        });
        assert.deepEqual(problems, []);
        assert.equal(normalizeReport({}).report.at, 21 * 60);
        assert.equal(normalizeReport({}).report.enabled, false);
        const wrong = normalizeReport({ reportTime: '25:00' });
        assert.equal(wrong.report.at, 21 * 60);
        assert.equal(wrong.problems.length, 1);
        assert.equal(normalizeSettings({ reportEnabled: true }).report.enabled, true);
    });

    it('is due only in its minute and when switched on', () => {
        const { report } = normalizeReport({ reportEnabled: true, reportTime: '21:00' });
        assert.equal(reportDue(report, at('2026-11-15 21:00')), true);
        assert.equal(reportDue(report, at('2026-11-15 21:01')), false);
        assert.equal(reportDue({ ...report, enabled: false }, at('2026-11-15 21:00')), false);
    });

    it('keeps the journal sorted and short, and skips broken lines', () => {
        let journal = [entry('2026-11-15 10:00', 'Door', 'b')];
        journal = addEntry(journal, entry('2026-11-15 09:00', 'Door', 'a'));
        assert.deepEqual(
            journal.map(e => e.description),
            ['a', 'b'],
        );
        for (let i = 0; i < MAX_ENTRIES + 5; i++) {
            journal = addEntry(journal, {
                ...entry('2026-11-15 11:00', 'Door', `n${i}`),
                time: at('2026-11-15 11:00').getTime() + i,
            });
        }
        assert.equal(journal.length, MAX_ENTRIES);
        assert.equal(journal.at(-1)?.description, `n${MAX_ENTRIES + 4}`);
        assert.deepEqual(parseJournal('nonsense'), []);
        const parsed = parseJournal([{ time: 5, camera: 'Door', description: 'x' }, { time: 'x' }, null]);
        assert.deepEqual(parsed, [{ time: 5, camera: 'Door', cameraId: '', description: 'x', matches: [] }]);
    });

    it('takes the cameras of the report by name or id', () => {
        const journal = [entry('2026-11-15 10:00', 'Door', 'a'), entry('2026-11-15 11:00', 'Yard', 'b')];
        const { report } = normalizeReport({ reportCameras: 'door' });
        assert.deepEqual(
            reportEntries(journal, report).map(e => e.camera),
            ['Door'],
        );
        assert.equal(reportEntries(journal, normalizeReport({}).report).length, 2);
    });

    it('lists the lines by camera, with the date of an earlier day', () => {
        const now = at('2026-11-15 21:00');
        const text = plainReport(
            [
                entry('2026-11-14 22:30', 'Door', 'a fox'),
                entry('2026-11-15 10:12', 'Door', 'the postman', ['a person']),
                entry('2026-11-15 11:00', 'Yard', 'a car'),
            ],
            now,
            'DD.MM.YYYY',
        );
        assert.equal(text, 'Door:\n14.11.2026 22:30 a fox\n10:12 the postman (a person)\n\nYard:\n11:00 a car');
    });

    it('asks pi-agent in the system language with the wishes', () => {
        const now = at('2026-11-15 21:00');
        const question = reportQuestion(
            [entry('2026-11-15 10:12', 'Door', 'the postman')],
            'German',
            'no animals',
            now,
        );
        assert.match(question, /in German/);
        assert.match(question, /Wishes of the residents: no animals/);
        assert.match(question, /Door:\n10:12 the postman/);
        assert.doesNotMatch(reportQuestion([], 'German', '', now), /Wishes/);
    });

    it('builds the title and cuts a long text', () => {
        assert.equal(reportTitle('de', at('2026-11-15 21:00'), 'DD.MM.YYYY'), '📋 Bericht 15.11.2026');
        assert.equal(reportTitle('xx', at('2026-11-15 21:00'), 'YYYY-MM-DD'), '📋 Report 2026-11-15');
        assert.equal(reportText('T', ' body \n'), 'T\nbody');
        const long = reportText('T', 'x'.repeat(MAX_TEXT * 2));
        assert.equal(long.length, MAX_TEXT);
        assert.ok(long.endsWith('…'));
    });

    it('is in the help and has names for its states', () => {
        assert.match(HELP, /report \{send\?\}/);
        for (const key of ['report', 'report_send', 'report_text', 'report_lastTime']) {
            assert.equal(Object.keys(NAMES[key]).length, 11, key);
        }
    });
});
