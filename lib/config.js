'use strict';

const { splitCredentials } = require('./camera-url');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Trigger} Trigger
 * @typedef {import('./types').Settings} Settings
 */

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', å: 'a', é: 'e', è: 'e', ê: 'e', á: 'a', à: 'a', ó: 'o', ñ: 'n' };

/**
 * Turns a camera name into an object id part (`Zürich Gate` → `zuerich_gate`).
 *
 * @param {unknown} name - Camera name
 * @returns {string} Id with only `a-z0-9_-`, empty when nothing is left
 */
function cameraId(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/[äöüßåéèêáàóñ]/g, c => UMLAUTS[c] || c)
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * @param {unknown} value - Raw value
 * @param {number} min - Lower limit
 * @param {number} max - Upper limit
 * @param {number} fallback - Value for empty or invalid input
 * @returns {number} Integer within the limits
 */
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {unknown} list - `native.cameras`
 * @returns {{cameras: Camera[], problems: string[]}} Active cameras and the reasons for skipped rows
 */
function normalizeCameras(list) {
    /** @type {Camera[]} */
    const cameras = [];
    const problems = [];
    const rows = Array.isArray(list) ? list : [];
    rows.forEach((row, index) => {
        if (!row || row.enabled === false) {
            return;
        }
        const name = String(row.name ?? '').trim();
        const id = cameraId(name);
        if (!id) {
            problems.push(`Camera in row ${index + 1} has no name and is skipped`);
            return;
        }
        if (cameras.some(c => c.id === id)) {
            problems.push(`Camera "${name}" is configured twice (id "${id}"), the second row is skipped`);
            return;
        }
        const split = splitCredentials(row.url);
        if (!split.url || /^rtsps?:\/\/$/i.test(split.url)) {
            problems.push(`Camera "${name}" has no URL and is skipped`);
            return;
        }
        cameras.push({
            id,
            name,
            url: split.url,
            username: String(row.username || split.username || ''),
            password: String(row.password || split.password || ''),
            transport: row.transport === 'udp' ? 'udp' : 'tcp',
            keyframesOnly: row.keyframesOnly === true,
            prebuffer: clampInt(row.prebuffer, 0, 30, 0),
        });
    });
    return { cameras, problems };
}

/**
 * @param {Camera[]} cameras - Active cameras
 * @param {unknown} nameOrId - Name or id of a camera, case does not matter
 * @returns {Camera | undefined} The camera
 */
function findCamera(cameras, nameOrId) {
    const id = cameraId(nameOrId);
    return id ? cameras.find(c => c.id === id) : undefined;
}

/**
 * @param {unknown} list - `native.triggers`
 * @param {Camera[]} cameras - Active cameras
 * @returns {{triggers: Trigger[], problems: string[]}} Active triggers and the reasons for skipped rows
 */
function normalizeTriggers(list, cameras) {
    /** @type {Trigger[]} */
    const triggers = [];
    const problems = [];
    const rows = Array.isArray(list) ? list : [];
    rows.forEach((row, index) => {
        if (!row || row.enabled === false) {
            return;
        }
        const stateId = String(row.stateId ?? '').trim();
        if (!stateId) {
            problems.push(`Trigger in row ${index + 1} has no state and is skipped`);
            return;
        }
        const camera = findCamera(cameras, row.camera);
        if (!camera) {
            problems.push(
                `Trigger "${stateId}" names the unknown or inactive camera "${row.camera ?? ''}" and is skipped`,
            );
            return;
        }
        triggers.push({
            stateId,
            camera,
            action: row.action === 'snapshot' || row.action === 'both' ? row.action : 'record',
            duration: clampInt(row.duration, 0, 60, 0),
            format: row.format === 'mp4' || row.format === 'gif' ? row.format : '',
            condition: row.condition === 'any' ? 'any' : 'truthy',
            cooldown: clampInt(row.cooldown, 0, 3600, 10),
            telegram: row.telegram !== false,
        });
    });
    return { triggers, problems };
}

/**
 * @param {Record<string, unknown>} native - Adapter configuration
 * @returns {Settings} Settings with limits applied
 */
function normalizeSettings(native) {
    const n = native || {};
    return {
        recordDuration: clampInt(n.recordDuration, 1, 60, 5),
        recordFormat: n.recordFormat === 'gif' ? 'gif' : 'mp4',
        videoMode: n.videoMode === 'copy' ? 'copy' : 'transcode',
        videoWidth: clampInt(n.videoWidth, 0, 3840, 640),
        videoFps: clampInt(n.videoFps, 0, 60, 10),
        gifWidth: clampInt(n.gifWidth, 64, 1280, 480),
        gifFps: clampInt(n.gifFps, 1, 25, 8),
        snapshotWidth: clampInt(n.snapshotWidth, 0, 3840, 0),
        rtspTimeout: clampInt(n.rtspTimeout, 2, 60, 10),
        maxParallel: clampInt(n.maxParallel, 1, 10, 2),
        keepFiles: clampInt(n.keepFiles, 0, 10000, 20),
        maxAgeDays: clampInt(n.maxAgeDays, 0, 3650, 7),
        copyToFiles: n.copyToFiles !== false,
        telegramInstance: String(n.telegramInstance ?? '').trim(),
        telegramUser: String(n.telegramUser ?? '').trim(),
        telegramCaption: String(n.telegramCaption ?? '{camera} {date} {time}'),
        prebufferEnabled: n.prebufferEnabled === true,
        prebufferDir: String(n.prebufferDir ?? '').trim(),
        maxClipLength: clampInt(n.maxClipLength, 5, 300, 30),
    };
}

module.exports = { cameraId, clampInt, normalizeCameras, normalizeTriggers, normalizeSettings, findCamera };
