'use strict';

/* eslint-disable jsdoc/reject-any-type -- rows are raw admin values, every function checks each field */

const { tableRows } = require('./table');
const { parseNames, TELEGRAM_NAME, buildMessage } = require('./notify');
const { formatCaption } = require('./triggers');

/**
 * @typedef {import('./types').NotifyProfile} NotifyProfile
 * @typedef {import('./types').RecordResult} RecordResult
 */

/** Caption of a new profile and of profiles made from the settings before 0.5. */
const DEFAULT_TEXT = '{camera} {date} {time}';

/** What a profile sends. */
const ATTACH = ['all', 'snapshot', 'clip', 'none'];

/**
 * @param {unknown} list - `native.profiles`
 * @returns {NotifyProfile[]} Active profiles with a name and an instance; the first of equal names wins
 */
function normalizeProfiles(list) {
    /** @type {NotifyProfile[]} */
    const profiles = [];
    for (const row of tableRows(list)) {
        if (!row || row.enabled === false) {
            continue;
        }
        const name = String(row.name ?? '').trim();
        const instance = String(row.instance ?? '').trim();
        if (!name || !instance || profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) {
            continue;
        }
        profiles.push({
            name,
            instance,
            recipient: String(row.recipient ?? '').trim(),
            attach: ATTACH.includes(row.attach) ? row.attach : 'all',
            text: String(row.text ?? ''),
            template: String(row.template ?? '').trim(),
        });
    }
    return profiles;
}

/**
 * Problems of the profile table, for the log at the start.
 *
 * @param {unknown} list - `native.profiles`
 * @returns {string[]} One line per problem
 */
function profileProblems(list) {
    const problems = [];
    /** @type {string[]} */
    const seen = [];
    tableRows(list).forEach((row, index) => {
        if (!row || row.enabled === false) {
            return;
        }
        const name = String(row.name ?? '').trim();
        if (!name) {
            problems.push(`Profile in row ${index + 1} of the tab Send has no name and is skipped`);
            return;
        }
        if (!String(row.instance ?? '').trim()) {
            problems.push(`Profile "${name}" has no instance and is skipped`);
            return;
        }
        if (seen.includes(name.toLowerCase())) {
            problems.push(`Profile "${name}" exists twice, the second row is skipped`);
            return;
        }
        seen.push(name.toLowerCase());
    });
    return problems;
}

/**
 * Chooses the profiles of a list of names; names are compared without case.
 *
 * @param {string[]} names - Names of the trigger, timelapse or script
 * @param {NotifyProfile[]} profiles - Active profiles
 * @returns {{chosen: NotifyProfile[], unknown: string[]}} Profiles in the order of the names, and names that match none
 */
function pickProfiles(names, profiles) {
    /** @type {NotifyProfile[]} */
    const chosen = [];
    const unknown = [];
    for (const name of names) {
        const profile = profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (!profile) {
            unknown.push(name);
        } else if (!chosen.includes(profile)) {
            chosen.push(profile);
        }
    }
    return { chosen, unknown };
}

/**
 * @param {NotifyProfile} profile - Profile
 * @param {'jpg' | 'mp4' | 'gif'} format - Format of the finished file
 * @returns {boolean} Whether the profile sends a file of this format
 */
function wantsFile(profile, format) {
    if (profile.attach === 'all') {
        return true;
    }
    if (profile.attach === 'snapshot') {
        return format === 'jpg';
    }
    return profile.attach === 'clip' && format !== 'jpg';
}

/**
 * What goes out for a finished file: each named profile that sends this kind of file gets
 * it, a profile "Text only" gets its text without the file.
 *
 * @param {string[]} names - Names of the profiles, empty = none
 * @param {NotifyProfile[]} profiles - Active profiles
 * @param {RecordResult} result - Finished file
 * @returns {{profile: NotifyProfile, result: RecordResult | null}[]} One entry per message
 */
function planNotify(names, profiles, result) {
    return pickProfiles(names, profiles)
        .chosen.filter(profile => profile.attach === 'none' || wantsFile(profile, result.format))
        .map(profile => ({ profile, result: profile.attach === 'none' ? null : result }));
}

/**
 * The `sendTo` command and message of one profile, with its text as caption.
 *
 * @param {NotifyProfile} profile - Profile
 * @param {RecordResult | null} result - Finished file, null for a text without file
 * @param {string} camera - Camera name
 * @param {Date} time - Time of the event
 * @param {string} [dateFormat] - System date format
 * @returns {{command: string, message: unknown}} What to send to `profile.instance`
 */
function profileMessage(profile, result, camera, time, dateFormat) {
    const caption = formatCaption(profile.text, camera, time, dateFormat).trim();
    return buildMessage(profile, result, caption, camera);
}

/**
 * @param {Record<string, any>} row - Trigger or timelapse row
 * @param {'telegram' | 'notify'} flag - Column that switched the notification on
 * @returns {boolean} Whether the row still has the columns of the settings before 0.5
 */
function isLegacyRow(row, flag) {
    if (!row || typeof row !== 'object' || 'profiles' in row) {
        return false;
    }
    // a trigger without the column notified (default true), a timelapse only when checked
    return flag === 'telegram' ? row.telegram !== false : row.notify === true;
}

/**
 * Whether the settings still have the notification columns of the versions before 0.5 and
 * were not migrated yet.
 *
 * @param {Record<string, any>} native - Instance settings
 * @returns {boolean} True when {@link migrateNotify} has work to do
 */
function needsMigration(native) {
    const n = native || {};
    if (n.profilesMigrated === true) {
        return false;
    }
    return (
        Boolean(String(n.telegramInstance ?? '').trim()) ||
        tableRows(n.notifyTargets).some(row => row && String(row.instance ?? '').trim()) ||
        tableRows(n.triggers).some(row => isLegacyRow(row, 'telegram')) ||
        tableRows(n.timelapses).some(row => isLegacyRow(row, 'notify'))
    );
}

/**
 * Turns the notification settings of the versions before 0.5 into profiles: the Telegram
 * instance of the Notifications tab becomes the profile "Telegram", every further target a
 * profile of its own (identical ones only once), and each trigger and timelapse names its
 * profiles in the column `profiles`. The old keys stay as they are, so a downgrade still works.
 *
 * @param {Record<string, any>} native - Instance settings
 * @returns {{profiles: Record<string, any>[], triggers: Record<string, any>[], timelapses: Record<string, any>[], profilesMigrated: true}} The changed keys of `native`
 */
function migrateNotify(native) {
    const n = native || {};
    const caption = String(n.telegramCaption ?? DEFAULT_TEXT);
    /** @type {Record<string, any>[]} */
    const profiles = tableRows(n.profiles).map(row => ({ ...row }));
    const taken = (/** @type {string} */ name) =>
        profiles.some(p => String(p.name ?? '').toLowerCase() === name.toLowerCase());
    /**
     * @param {string} base - Wished name
     * @returns {string} The name, with " 2", " 3" … when it is taken
     */
    const freeName = base => {
        let name = base;
        for (let i = 2; taken(name); i++) {
            name = `${base} ${i}`;
        }
        return name;
    };
    /**
     * Adds a profile, or finds an identical one.
     *
     * @param {string} wished - Name
     * @param {Record<string, any>} values - instance, recipient, template, enabled
     * @returns {string} Name of the profile
     */
    const add = (wished, values) => {
        const same = profiles.find(
            p =>
                String(p.instance ?? '').trim() === values.instance &&
                String(p.recipient ?? '').trim() === values.recipient &&
                String(p.template ?? '').trim() === values.template &&
                (p.attach ?? 'all') === 'all' &&
                String(p.text ?? '') === caption &&
                (p.enabled !== false) === values.enabled,
        );
        if (same) {
            return String(same.name);
        }
        const name = freeName(wished);
        profiles.push({ enabled: values.enabled, name, ...values, attach: 'all', text: caption });
        return name;
    };

    /** old name in lower case → profile name */
    const rename = new Map();
    /** names that an empty "Send to" reached: Telegram and every active target */
    const everybody = [];

    const telegramInstance = String(n.telegramInstance ?? '').trim();
    if (telegramInstance) {
        const name = add(TELEGRAM_NAME, {
            enabled: true,
            instance: telegramInstance,
            recipient: String(n.telegramUser ?? '').trim(),
            template: '',
        });
        rename.set(TELEGRAM_NAME.toLowerCase(), name);
        everybody.push(name);
    }
    for (const row of tableRows(n.notifyTargets)) {
        const instance = String(row?.instance ?? '').trim();
        if (!instance) {
            continue;
        }
        const oldName = String(row.name ?? '').trim();
        const recipient = String(row.recipient ?? '').trim();
        const enabled = row.enabled !== false;
        const name = add(oldName || (recipient ? `${instance} ${recipient}` : instance), {
            enabled,
            instance,
            recipient,
            template: String(row.template ?? '').trim(),
        });
        if (oldName && !rename.has(oldName.toLowerCase())) {
            rename.set(oldName.toLowerCase(), name);
        }
        if (enabled && !everybody.includes(name)) {
            everybody.push(name);
        }
    }

    /**
     * @param {Record<string, any>} row - Trigger or timelapse row
     * @param {'telegram' | 'notify'} flag - Column that switched the notification on
     * @returns {Record<string, any>} The row with the column `profiles`
     */
    const convert = (row, flag) => {
        if (!row || typeof row !== 'object' || 'profiles' in row) {
            return row;
        }
        if (!isLegacyRow(row, flag)) {
            return { ...row, profiles: '' };
        }
        const names = parseNames(row.recipients);
        const chosen = names.length ? names.map(name => rename.get(name.toLowerCase())).filter(Boolean) : everybody;
        return { ...row, profiles: [...new Set(chosen)].join(', ') };
    };

    return {
        profiles,
        triggers: tableRows(n.triggers).map(row => convert(row, 'telegram')),
        timelapses: tableRows(n.timelapses).map(row => convert(row, 'notify')),
        profilesMigrated: true,
    };
}

module.exports = {
    ATTACH,
    DEFAULT_TEXT,
    normalizeProfiles,
    profileProblems,
    pickProfiles,
    wantsFile,
    planNotify,
    profileMessage,
    needsMigration,
    migrateNotify,
};
