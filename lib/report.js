'use strict';

/**
 * The report ("Bericht", tab AI check): every AI check of a snapshot leaves a line in a journal (time, camera, what
 * pi-agent saw); at the set time pi-agent turns the lines since the last report into a short text that goes out
 * through the chosen profiles. Without an answer of pi-agent the plain lines go out instead.
 */

const { parseNames } = require('./notify');
const { parseTime } = require('./schedule');
const { formatDay } = require('./triggers');

/**
 * @typedef {import('./types').ReportSettings} ReportSettings
 */

/**
 * @typedef {object} ReportEntry
 * @property {number} time - Time of the picture in ms
 * @property {string} camera - Camera name
 * @property {string} cameraId - Camera id
 * @property {string} description - What pi-agent saw
 * @property {string[]} matches - Criteria it saw
 */

/** Most lines kept in the journal; the oldest go first. */
const MAX_ENTRIES = 500;

/** Longest text sent, in characters (Telegram allows 4096). */
const MAX_TEXT = 3800;

/** Title of the report in the languages of ioBroker. */
const TITLES = {
    en: 'Report',
    de: 'Bericht',
    ru: 'Отчёт',
    pt: 'Relatório',
    nl: 'Verslag',
    fr: 'Rapport',
    it: 'Rapporto',
    es: 'Informe',
    pl: 'Raport',
    uk: 'Звіт',
    'zh-cn': '报告',
};

/** Instructions of the conversation of the report in pi-agent. */
const REPORT_INSTRUCTIONS =
    'You write short reports from the events of security cameras for the ioBroker adapter cam-recorder. ' +
    'Do not call any tools. Answer with the text of the report and nothing else.';

/**
 * @param {Record<string, unknown>} native - Adapter configuration
 * @returns {{report: ReportSettings, problems: string[]}} Report settings and problems of the values
 */
function normalizeReport(native) {
    const n = native || {};
    const problems = [];
    const time = String(n.reportTime ?? '').trim() || '21:00';
    let at = parseTime(time);
    if (at === null) {
        problems.push(`Report: the time "${time}" is not HH:MM, 21:00 is used`);
        at = 21 * 60;
    }
    const report = {
        enabled: n.reportEnabled === true,
        at,
        time,
        profiles: parseNames(n.reportProfiles),
        cameras: parseNames(n.reportCameras),
        instructions: String(n.reportInstructions ?? '').trim(),
    };
    return { report, problems };
}

/**
 * @param {ReportSettings} report - Report settings
 * @param {Date} now - Current time, at a full minute
 * @returns {boolean} Whether the report is due in this minute
 */
function reportDue(report, now) {
    return report.enabled && now.getHours() * 60 + now.getMinutes() === report.at;
}

/**
 * Adds a line to the journal.
 *
 * @param {ReportEntry[]} journal - Lines so far, oldest first
 * @param {ReportEntry} entry - New line
 * @returns {ReportEntry[]} The journal with the line, at most {@link MAX_ENTRIES}
 */
function addEntry(journal, entry) {
    const list = [...journal, entry].sort((a, b) => a.time - b.time);
    return list.slice(-MAX_ENTRIES);
}

/**
 * @param {unknown} data - Content of the journal file
 * @returns {ReportEntry[]} The valid lines, oldest first
 */
function parseJournal(data) {
    if (!Array.isArray(data)) {
        return [];
    }
    return data
        .filter(e => e && typeof e === 'object' && Number.isFinite(e.time) && typeof e.description === 'string')
        .map(e => ({
            time: Number(e.time),
            camera: String(e.camera ?? ''),
            cameraId: String(e.cameraId ?? ''),
            description: e.description,
            matches: Array.isArray(e.matches) ? e.matches.map(String) : [],
        }))
        .sort((a, b) => a.time - b.time)
        .slice(-MAX_ENTRIES);
}

/**
 * @param {ReportEntry[]} journal - All lines
 * @param {ReportSettings} report - Report settings
 * @returns {ReportEntry[]} The lines of the cameras of the report
 */
function reportEntries(journal, report) {
    if (!report.cameras.length) {
        return journal;
    }
    const wanted = report.cameras.map(c => c.toLowerCase());
    return journal.filter(e => wanted.includes(e.camera.toLowerCase()) || wanted.includes(e.cameraId.toLowerCase()));
}

/**
 * @param {number} time - Time in ms
 * @param {Date} now - Time of the report
 * @param {string} [dateFormat] - System date format
 * @returns {string} `HH:MM`, with the date in front when it is not the day of the report
 */
function entryTime(time, now, dateFormat) {
    const date = new Date(time);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return date.toDateString() === now.toDateString() ? clock : `${formatDay(date, dateFormat)} ${clock}`;
}

/**
 * The lines of the report as plain text, by camera: what goes out when pi-agent does not answer, and what pi-agent
 * gets to read.
 *
 * @param {ReportEntry[]} entries - Lines of the report
 * @param {Date} now - Time of the report
 * @param {string} [dateFormat] - System date format
 * @returns {string} One block per camera, one line per check
 */
function plainReport(entries, now, dateFormat) {
    /** @type {Map<string, string[]>} */
    const byCamera = new Map();
    for (const e of entries) {
        const lines = byCamera.get(e.camera) || [];
        const found = e.matches.length ? ` (${e.matches.join(', ')})` : '';
        lines.push(`${entryTime(e.time, now, dateFormat)} ${e.description}${found}`);
        byCamera.set(e.camera, lines);
    }
    return [...byCamera].map(([camera, lines]) => `${camera}:\n${lines.join('\n')}`).join('\n\n');
}

/**
 * @param {ReportEntry[]} entries - Lines of the report
 * @param {string} language - Language name for the answer, e.g. `German`
 * @param {string} instructions - Extra wishes of the user
 * @param {Date} now - Time of the report
 * @param {string} [dateFormat] - System date format
 * @returns {string} The question to pi-agent
 */
function reportQuestion(entries, language, instructions, now, dateFormat) {
    return [
        'Below are the events of the security cameras since the last report: time, then what was seen in the ' +
            'picture, the criteria that matched in brackets.',
        `Write a short report in ${language} for a message to the residents: per camera one short paragraph with ` +
            'the times and what happened. Put similar events together (e.g. "three times a cat"), keep what matters ' +
            '(people, parcels, vehicles, anything unusual). Plain text, no Markdown, no title, no greeting.',
        ...(instructions ? [`Wishes of the residents: ${instructions}`] : []),
        '',
        plainReport(entries, now, dateFormat),
    ].join('\n');
}

/**
 * @param {string} language - System language
 * @param {Date} now - Time of the report
 * @param {string} [dateFormat] - System date format
 * @returns {string} First line of the message, e.g. `📋 Bericht 15.11.2026`
 */
function reportTitle(language, now, dateFormat) {
    const title = TITLES[/** @type {keyof typeof TITLES} */ (language)] || TITLES.en;
    return `📋 ${title} ${formatDay(now, dateFormat)}`;
}

/**
 * @param {string} title - First line
 * @param {string} body - Text of pi-agent or the plain lines
 * @returns {string} The message, cut to {@link MAX_TEXT}
 */
function reportText(title, body) {
    const text = `${title}\n${String(body).trim()}`;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text;
}

module.exports = {
    MAX_ENTRIES,
    MAX_TEXT,
    TITLES,
    REPORT_INSTRUCTIONS,
    normalizeReport,
    reportDue,
    addEntry,
    parseJournal,
    reportEntries,
    plainReport,
    reportQuestion,
    reportTitle,
    reportText,
};
