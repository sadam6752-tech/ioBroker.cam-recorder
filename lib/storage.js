'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const EXTENSIONS = ['mp4', 'gif', 'jpg'];

/**
 * @param {number} n - Number
 * @returns {string} Two digits
 */
const pad = n => String(n).padStart(2, '0');

/**
 * @param {Date} date - Time
 * @returns {string} Local time as `YYYY-MM-DD_HH-MM-SS`, so the alphabetical order is the age order
 */
function timeStamp(date) {
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
        `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
    );
}

/**
 * @param {string} file - Path
 * @returns {Promise<boolean>} True if the file exists
 */
async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Finds a free file name `<camera>_<time>.<ext>`; a second file in the same second gets `-2`, `-3`, …
 *
 * @param {string} dir - Directory
 * @param {string} cameraId - Camera id
 * @param {string} ext - Extension without dot
 * @param {Date} [date] - Time of the recording
 * @returns {Promise<string>} Full path
 */
async function uniqueFile(dir, cameraId, ext, date = new Date()) {
    const base = `${cameraId}_${timeStamp(date)}`;
    let candidate = path.join(dir, `${base}.${ext}`);
    for (let i = 2; (await exists(candidate)) || (await exists(`${candidate}.part`)); i++) {
        candidate = path.join(dir, `${base}-${i}.${ext}`);
    }
    return candidate;
}

/**
 * Deletes old files of one camera and one kind. Only names written by this adapter are
 * touched (`<camera>_<time>.<ext>`), so foreign files in the folder survive.
 *
 * @param {string} dir - Directory
 * @param {string} cameraId - Camera id
 * @param {string} ext - Extension without dot
 * @param {number} keep - Newest files to keep, 0 = no limit
 * @param {number} maxAgeDays - Maximum age in days, 0 = no limit
 * @param {number} [now] - Current time in ms
 * @returns {Promise<string[]>} Deleted file names
 */
async function pruneFiles(dir, cameraId, ext, keep, maxAgeDays, now = Date.now()) {
    if (!EXTENSIONS.includes(ext)) {
        return [];
    }
    let names;
    try {
        names = await fs.readdir(dir);
    } catch {
        return [];
    }
    const pattern = new RegExp(`^${cameraId}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}(-\\d+)?\\.${ext}$`);
    const own = names
        .filter(n => pattern.test(n))
        .sort()
        .reverse();
    const deleted = [];
    for (let i = 0; i < own.length; i++) {
        const file = path.join(dir, own[i]);
        let remove = keep > 0 && i >= keep;
        if (!remove && maxAgeDays > 0) {
            try {
                const stat = await fs.stat(file);
                remove = now - stat.mtimeMs > maxAgeDays * 86_400_000;
            } catch {
                continue;
            }
        }
        if (remove) {
            try {
                await fs.unlink(file);
                deleted.push(own[i]);
            } catch {
                // already gone or locked - try again after the next recording
            }
        }
    }
    return deleted;
}

/**
 * Removes `.part` files that a crash or a stop left behind.
 *
 * @param {string} dir - Directory
 * @returns {Promise<number>} Number of removed files
 */
async function removePartials(dir) {
    let names;
    try {
        names = await fs.readdir(dir);
    } catch {
        return 0;
    }
    let count = 0;
    for (const name of names) {
        if (/^[a-z0-9_-]+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.(mp4|gif|jpg)\.part$/.test(name)) {
            try {
                await fs.unlink(path.join(dir, name));
                count++;
            } catch {
                // ignore
            }
        }
    }
    return count;
}

module.exports = { timeStamp, uniqueFile, pruneFiles, removePartials };
