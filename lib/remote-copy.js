'use strict';

/**
 * Copy of the recorded files to an external server (a NAS) over SFTP.
 *
 * The adapter opens an SSH connection itself (library ssh2, see `sftp-ssh2.js`): no mount, no
 * `sudo`, no shell command. The pattern is the one of ioBroker.fingerprint and
 * ioBroker.e-invoices, adapted to camera files:
 *
 * - the local file is never touched; a failed copy is reported and not retried (the next file is
 *   copied again);
 * - a file appears under its final name only when it is complete (upload as `.part`, compare the
 *   size, rename);
 * - each camera gets its own folder `<directory>/<camera id>/`;
 * - old files on the server are deleted only when a maximum age is set, and only files whose name
 *   this adapter writes.
 *
 * This file works against a small session interface (`makeDirectories`, `writeFile`, `size`,
 * `rename`, `list`, `remove`, `close`) and is therefore tested without a server.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * @typedef {import('./types').Timers} Timers
 * @typedef {import('./types').RemoteSettings} RemoteSettings
 */

/**
 * @typedef {object} SftpSession
 * @property {(dir: string) => Promise<void>} makeDirectories - Create a directory and its parents
 * @property {(file: string, data: Buffer) => Promise<void>} writeFile - Write a file
 * @property {(file: string) => Promise<number>} size - Size of a file
 * @property {(from: string, to: string) => Promise<void>} rename - Rename a file
 * @property {(dir: string) => Promise<string[]>} list - File names in a directory
 * @property {(file: string) => Promise<void>} remove - Delete a file
 * @property {() => void} close - Close the connection
 */

/**
 * @typedef {object} Connection
 * @property {string} host - Server
 * @property {number} port - SSH port
 * @property {string} username - User
 * @property {string} password - Password
 * @property {string} hostKey - Expected fingerprint, empty = not verified
 * @property {(fingerprint: string) => void} onHostKey - Hears the fingerprint of the server
 */

/** @typedef {(connection: Connection) => Promise<SftpSession>} Connector */

/** Default SSH port. */
const DEFAULT_PORT = 22;

/** The whole copy of one file must not take longer than this. */
const REMOTE_COPY_TIMEOUT_MS = 10 * 60_000;

/** Ending of a file while it is uploaded. */
const PARTIAL_SUFFIX = '.part';

/** Clips and snapshots: `door_2026-10-18_09-00-00.mp4`, timelapses: `door_timelapse_2026-10-18.mp4`. */
const OWN_FILE =
    /^[a-z0-9_-]+?_(?:(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}|timelapse_(\d{4})-(\d{2})-(\d{2}))(?:-\d+)?\.(?:mp4|gif|jpg)$/;

/**
 * @param {string} name - File name
 * @returns {boolean} True for a file name this adapter writes
 */
function isOwnFile(name) {
    return OWN_FILE.test(name);
}

/**
 * Normalizes the target directory: forward slashes, no trailing slash, no `.` or empty parts.
 *
 * @param {string | undefined} directory - Directory as typed by the user
 * @returns {string | null} The directory; null when it holds a `..` part
 */
function normalizeRemoteDirectory(directory) {
    const text = String(directory ?? '')
        .trim()
        .replace(/\\/g, '/');
    const absolute = text.startsWith('/');
    const parts = [];
    for (const part of text.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            return null;
        }
        parts.push(part);
    }
    const joined = parts.join('/');
    return absolute ? `/${joined}` : joined;
}

/**
 * @param {string} directory - Normalized directory, may be empty or `/`
 * @param {string} name - Name inside it
 * @returns {string} The joined path with forward slashes
 */
function join(directory, name) {
    if (directory === '/') {
        return `/${name}`;
    }
    return directory ? `${directory}/${name}` : name;
}

/**
 * Names what is wrong with the settings, so the user sees it before a copy fails.
 *
 * @param {Partial<RemoteSettings>} settings - Settings of the copy
 * @returns {string[]} One text per problem, empty when a copy can be tried
 */
function remoteSettingsProblems(settings) {
    const problems = [];
    if (!String(settings.host ?? '').trim()) {
        problems.push('the host is missing');
    }
    if (!String(settings.username ?? '').trim()) {
        problems.push('the user name is missing');
    }
    if (!settings.password) {
        problems.push('the password is missing');
    }
    const port = !settings.port ? DEFAULT_PORT : Number(settings.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push('the port must be between 1 and 65535');
    }
    if (normalizeRemoteDirectory(settings.directory) === null) {
        problems.push('the directory must not contain ".."');
    }
    return problems;
}

/**
 * Writes a hex digest the way OpenSSH and the Synology show it: `SHA256:` and base64 without padding.
 *
 * @param {string} hexHash - SHA-256 digest as hex
 * @returns {string} `SHA256:…`
 */
function hexToFingerprint(hexHash) {
    return `SHA256:${Buffer.from(hexHash, 'hex').toString('base64').replace(/=+$/, '')}`;
}

/**
 * Checks the fingerprint of a server against the one the user entered.
 *
 * @param {string} expected - `SHA256:…` or the hex digest with or without colons; empty = no check
 * @param {string} hexHash - SHA-256 of the host key as hex, as ssh2 delivers it
 * @returns {boolean} True when it is the same key
 */
function hostKeyMatches(expected, hexHash) {
    const wanted = String(expected ?? '').trim();
    if (!wanted) {
        return true;
    }
    const hex = hexHash.toLowerCase();
    const asHex = wanted.replace(/^sha256:/i, '').replace(/:/g, '');
    if (/^[0-9a-f]{64}$/i.test(asHex)) {
        return asHex.toLowerCase() === hex;
    }
    return wanted.replace(/^sha256:/i, '').replace(/=+$/, '') === hexToFingerprint(hex).replace(/^SHA256:/, '');
}

/**
 * Picks the files of this adapter that are older than the maximum age (by the date in the name).
 *
 * @param {string[]} names - File names in a camera folder on the server
 * @param {number} keepDays - Maximum age in days, 0 = keep all
 * @param {number} [now] - Current time in ms
 * @returns {string[]} The names to delete
 */
function selectExpired(names, keepDays, now = Date.now()) {
    if (!Number.isFinite(keepDays) || keepDays <= 0) {
        return [];
    }
    const limit = now - keepDays * 86_400_000;
    return names.filter(name => {
        const m = OWN_FILE.exec(name);
        if (!m) {
            return false;
        }
        // the end of that day counts, so a file is kept for at least `keepDays` full days
        // groups 1-3: clip or snapshot, groups 4-6: timelapse
        const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
        const endOfDay = new Date(Number(y), Number(mo) - 1, Number(d) + 1).getTime();
        return endOfDay < limit;
    });
}

/**
 * Picks the leftovers of interrupted uploads of this adapter.
 *
 * @param {string[]} names - File names
 * @returns {string[]} The names to delete
 */
function selectStalePartials(names) {
    return names.filter(name => name.endsWith(PARTIAL_SUFFIX) && isOwnFile(name.slice(0, -PARTIAL_SUFFIX.length)));
}

/**
 * Fails a promise that takes too long (a server that accepts the connection and then says nothing).
 *
 * @template T
 * @param {Timers} timers - Timers of the adapter
 * @param {Promise<T>} work - The work
 * @param {number} ms - Time limit
 * @param {string} what - Name for the message
 * @param {() => void} onTimeout - Called when the time is up
 * @returns {Promise<T>} The result of the work
 */
async function withTimeout(timers, work, ms, what, onTimeout) {
    let timer;
    const limit = new Promise((_resolve, reject) => {
        timer = timers.setTimeout(() => {
            onTimeout();
            reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`));
        }, ms);
    });
    try {
        return await Promise.race([work, limit]);
    } finally {
        timers.clearTimeout(timer);
    }
}

/**
 * @param {RemoteSettings} settings - Checked settings
 * @param {(fingerprint: string) => void} onHostKey - Hears the fingerprint of the server
 * @returns {Connection} Connection data for the connector
 */
function connectionOf(settings, onHostKey) {
    return {
        host: String(settings.host).trim(),
        port: settings.port ? Number(settings.port) : DEFAULT_PORT,
        username: String(settings.username).trim(),
        password: String(settings.password),
        hostKey: String(settings.hostKey ?? '').trim(),
        onHostKey,
    };
}

/**
 * Copies one file into the folder of its camera on the server.
 *
 * @param {Connector} connect - Opens the SFTP connection
 * @param {RemoteSettings} settings - Settings of the copy
 * @param {{file: string, cameraId: string}} item - Local file and its camera
 * @param {{warn: (msg: string) => void}} log - Logger
 * @param {Timers} timers - Timers of the adapter
 * @param {number} [limitMs] - Longest time for the whole copy
 * @returns {Promise<{ok: boolean, message: string, remoteFile?: string, deleted: string[]}>} Never throws
 */
async function copyFileToRemote(connect, settings, item, log, timers, limitMs = REMOTE_COPY_TIMEOUT_MS) {
    const problems = remoteSettingsProblems(settings);
    if (problems.length) {
        return { ok: false, message: `settings incomplete: ${problems.join(', ')}`, deleted: [] };
    }
    const base = normalizeRemoteDirectory(settings.directory) ?? '';
    const directory = join(base, item.cameraId);
    const name = path.basename(item.file);
    const target = join(directory, name);
    /** @type {SftpSession | undefined} */
    let session;
    let expired = false;
    /** @type {string[]} */
    const deleted = [];
    try {
        const data = await fs.readFile(item.file);
        const work = (async () => {
            const opened = await connect(
                connectionOf(settings, fingerprint => {
                    if (!String(settings.hostKey ?? '').trim()) {
                        log.warn(
                            `The host key of the SFTP server is not verified. To trust only this server, enter its fingerprint in the settings: ${fingerprint}`,
                        );
                    }
                }),
            );
            session = opened;
            // the time ran out while connecting: close at once instead of uploading after the failure was reported
            if (expired) {
                opened.close();
                return;
            }
            await opened.makeDirectories(directory);
            const partial = `${target}${PARTIAL_SUFFIX}`;
            try {
                await opened.writeFile(partial, data);
                const written = await opened.size(partial);
                if (written !== data.length) {
                    throw new Error(`the upload is incomplete (${written} of ${data.length} bytes)`);
                }
                await opened.rename(partial, target);
            } catch (error) {
                if (!expired) {
                    await opened.remove(partial).catch(() => undefined);
                }
                throw error;
            }
            const names = await opened.list(directory);
            for (const old of [...selectStalePartials(names), ...selectExpired(names, settings.keepDays)]) {
                try {
                    await opened.remove(join(directory, old));
                    deleted.push(old);
                } catch (error) {
                    log.warn(`Cannot delete ${old} on the SFTP server: ${error.message}`);
                }
            }
        })();
        await withTimeout(timers, work, limitMs, 'The copy to the SFTP server', () => {
            expired = true;
            session?.close();
        });
        return { ok: true, message: `copied ${name}`, remoteFile: target, deleted };
    } catch (error) {
        return { ok: false, message: error.message, deleted };
    } finally {
        session?.close();
    }
}

/**
 * Settings for the connection test of the admin page, from the values of the form.
 *
 * The form may hold unsaved values. An empty password field means "the saved one" — but only for
 * the saved server, user and port: otherwise any script could send this message with its own host
 * and receive the stored password at the login.
 *
 * @param {Record<string, unknown>} form - Values of the form (`native` as the admin sends it)
 * @param {RemoteSettings} saved - Saved settings
 * @returns {RemoteSettings} Settings for the test
 */
function settingsForConnectionTest(form, saved) {
    const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : undefined);
    const host = text(form.remoteHost) ?? saved.host;
    const username = text(form.remoteUser) ?? saved.username;
    const port = Number(form.remotePort ?? saved.port) || DEFAULT_PORT;
    const sameServer =
        host.trim() === saved.host.trim() &&
        username.trim() === saved.username.trim() &&
        port === (Number(saved.port) || DEFAULT_PORT);
    return {
        ...saved,
        enabled: true,
        host,
        port,
        username,
        password: text(form.remotePassword) || (sameServer ? saved.password : ''),
        directory: text(form.remoteDirectory) ?? saved.directory,
        hostKey: text(form.remoteHostKey) ?? saved.hostKey,
    };
}

/**
 * Tries the connection: connects, creates the directory and writes and deletes a small test file,
 * so a wrong password or a directory without permission shows up now and not at the first clip.
 *
 * @param {Connector} connect - Opens the SFTP connection
 * @param {RemoteSettings} settings - Settings of the copy
 * @param {Timers} timers - Timers of the adapter
 * @param {number} [limitMs] - Longest time
 * @returns {Promise<{ok: boolean, message: string, fingerprint?: string}>} Never throws
 */
async function testRemoteConnection(connect, settings, timers, limitMs = 60_000) {
    const problems = remoteSettingsProblems(settings);
    if (problems.length) {
        return { ok: false, message: `settings incomplete: ${problems.join(', ')}` };
    }
    const directory = normalizeRemoteDirectory(settings.directory) ?? '';
    /** @type {SftpSession | undefined} */
    let session;
    let expired = false;
    /** @type {string | undefined} */
    let fingerprint;
    try {
        const work = (async () => {
            const opened = await connect(
                connectionOf(settings, found => {
                    fingerprint = found;
                }),
            );
            session = opened;
            if (expired) {
                opened.close();
                return;
            }
            if (directory) {
                await opened.makeDirectories(directory);
            }
            const probe = join(directory, '.cam-recorder-connection-test');
            await opened.writeFile(probe, Buffer.from('ok'));
            await opened.remove(probe);
        })();
        await withTimeout(timers, work, limitMs, 'The connection test', () => {
            expired = true;
            session?.close();
        });
        return { ok: true, message: 'connected, the directory is writable', fingerprint };
    } catch (error) {
        return { ok: false, message: error.message, fingerprint };
    } finally {
        session?.close();
    }
}

module.exports = {
    REMOTE_COPY_TIMEOUT_MS,
    isOwnFile,
    normalizeRemoteDirectory,
    remoteSettingsProblems,
    hexToFingerprint,
    hostKeyMatches,
    selectExpired,
    selectStalePartials,
    copyFileToRemote,
    settingsForConnectionTest,
    testRemoteConnection,
};
