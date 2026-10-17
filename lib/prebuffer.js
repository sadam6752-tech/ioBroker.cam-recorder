'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inputArgs } = require('./ffmpeg-args');
const { maskSecrets } = require('./mask');
const { SEGMENT_SECONDS, parseSegments, selectSegments, expiredSegments, restartDelay } = require('./prebuffer-plan');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Settings} Settings
 * @typedef {import('./types').Timers} Timers
 * @typedef {import('./prebuffer-plan').Segment} Segment
 * @typedef {'off' | 'starting' | 'running' | 'restarting'} PrebufferStatus
 */

/** Housekeeping interval in ms: status, stall check, deleting old segments. */
const TICK_MS = 2000;
/** A buffer that wrote no data for this long is restarted. */
const STALL_MS = 20_000;

/**
 * Keeps the last seconds of one camera on disk: one ffmpeg process copies the stream
 * (no re-encoding) into segments, old segments are deleted, a failed or stalled process is
 * restarted with a growing pause.
 */
class Prebuffer {
    /**
     * @param {object} options - Options
     * @param {Camera} options.camera - Camera with the plain password
     * @param {Settings} options.settings - Adapter settings
     * @param {number} options.seconds - Seconds to keep before an event
     * @param {string} options.dir - Folder of this camera's segments (emptied at start and stop)
     * @param {string} options.ffmpegPath - Path of ffmpeg
     * @param {Timers} options.timers - Timer functions of the adapter
     * @param {(status: PrebufferStatus) => void} [options.onStatus] - Called when the status changes
     * @param {(message: string) => void} [options.onWarning] - Called with a masked message on a failure
     */
    constructor({ camera, settings, seconds, dir, ffmpegPath, timers, onStatus, onWarning }) {
        this.camera = camera;
        this.settings = settings;
        this.seconds = seconds;
        this.dir = dir;
        this.ffmpegPath = ffmpegPath;
        this.timers = timers;
        this.onStatus = onStatus || (() => undefined);
        this.onWarning = onWarning || (() => undefined);
        /** @type {PrebufferStatus} */
        this.status = 'off';
        /** @type {import('node:child_process').ChildProcess | null} */
        this.child = null;
        this.stopped = true;
        this.attempt = 0;
        this.startedAt = 0;
        /** Time of the last growth of the buffer in ms, and what was seen then */
        this.lastGrowth = 0;
        this.lastSeen = '';
        this.stalled = false;
        /** @type {ReturnType<Timers['setTimeout']>} */
        this.tickTimer = null;
        /** @type {ReturnType<Timers['setTimeout']>} */
        this.restartTimer = null;
        /** @type {Set<number>} start times of windows that clips still need */
        this.holds = new Set();
    }

    /** Starts the buffer. */
    async start() {
        this.stopped = false;
        await fs.rm(this.dir, { recursive: true, force: true });
        await fs.mkdir(this.dir, { recursive: true });
        this._spawn();
        this._tick();
    }

    /** Stops the process and the timers; the segment folder is removed. */
    async stop() {
        this.stopped = true;
        this.timers.clearTimeout(this.tickTimer);
        this.timers.clearTimeout(this.restartTimer);
        this.child?.kill('SIGKILL');
        this.child = null;
        this._setStatus('off');
        await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    }

    /** @returns {boolean} True when complete segments are being written */
    isRunning() {
        return this.status === 'running';
    }

    /** @param {PrebufferStatus} status - New status */
    _setStatus(status) {
        if (this.status !== status) {
            this.status = status;
            this.onStatus(status);
        }
    }

    /** Starts the ffmpeg process that writes the segments. */
    _spawn() {
        if (this.stopped) {
            return;
        }
        this._setStatus(this.attempt ? 'restarting' : 'starting');
        this.startedAt = Date.now();
        this.lastGrowth = this.startedAt;
        this.stalled = false;
        const args = [
            ...inputArgs(this.camera, this.settings, { live: true }),
            '-an',
            '-c:v',
            'copy',
            '-f',
            'segment',
            // Matroska, not MPEG-TS: the static Linux build of ffmpeg crashed (SIGSEGV) reading
            // MPEG-TS segments copied from a DoorBird stream, already when opening a single one.
            '-segment_format',
            'matroska',
            // write every second: the growing file is the sign of life for the stall check,
            // also for cameras with a low bit rate
            '-segment_format_options',
            'flush_packets=1:cluster_time_limit=1000',
            '-segment_time',
            String(SEGMENT_SECONDS),
            '-reset_timestamps',
            '1',
            '-strftime',
            '1',
            path.join(this.dir, '%Y%m%d%H%M%S.mkv'),
        ];
        let stderr = '';
        const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        this.child = child;
        child.stderr?.on('data', chunk => {
            stderr = (stderr + chunk.toString()).slice(-2048);
        });
        child.on('error', err => this._failed(child, `could not be started: ${err.message}`));
        child.on('close', code => {
            const lines = stderr.trim().split(/\r?\n/).slice(-2).join(' | ');
            const why = this.stalled ? `received no data for ${STALL_MS / 1000} s` : `stopped (exit code ${code})`;
            this._failed(child, `${why}${lines ? `: ${lines}` : ''}`);
        });
    }

    /**
     * @param {import('node:child_process').ChildProcess} child - The process that ended
     * @param {string} reason - Why
     */
    _failed(child, reason) {
        if (this.child !== child) {
            return;
        }
        this.child = null;
        if (this.stopped) {
            return;
        }
        this.attempt++;
        const delay = restartDelay(this.attempt);
        this.onWarning(
            maskSecrets(`Pre-recording of camera "${this.camera.name}" ${reason}. Next start in ${delay / 1000} s`, [
                this.camera.password,
                this.camera.username,
            ]),
        );
        this._setStatus('restarting');
        this.timers.clearTimeout(this.restartTimer);
        this.restartTimer = this.timers.setTimeout(() => this._spawn(), delay);
    }

    /** @returns {Promise<Segment[]>} Segments on disk, oldest first */
    async segments() {
        try {
            return parseSegments(await fs.readdir(this.dir));
        } catch {
            return [];
        }
    }

    /** Updates the status, restarts a stalled process and deletes old segments. */
    async _housekeeping() {
        const segments = await this.segments();
        const newest = segments.length ? segments[segments.length - 1] : null;
        if (newest) {
            // the newest segment grows while data arrives; with a long key frame interval a new
            // segment may take longer than the stall limit, so the size counts, not the count
            const size = await fs
                .stat(path.join(this.dir, newest.name))
                .then(st => st.size)
                .catch(() => 0);
            const seen = `${newest.name}:${size}`;
            if (seen !== this.lastSeen) {
                this.lastSeen = seen;
                this.lastGrowth = Date.now();
            }
        }
        if (this.child && segments.length >= 2 && newest && newest.start >= this.startedAt - 1000) {
            this.attempt = 0;
            this._setStatus('running');
        }
        // a process that delivers nothing is restarted (the camera may hang without closing the connection)
        if (this.child && isStalled(this.lastGrowth, Date.now())) {
            this.stalled = true;
            this.child.kill('SIGKILL');
        }
        const keepFrom = Math.min(
            Date.now() - (this.seconds + 2 * SEGMENT_SECONDS) * 1000,
            ...[...this.holds].map(h => h - SEGMENT_SECONDS * 1000),
        );
        for (const segment of expiredSegments(segments, keepFrom)) {
            await fs.unlink(path.join(this.dir, segment.name)).catch(() => undefined);
        }
    }

    /** Runs the housekeeping and arms the next run. */
    _tick() {
        if (this.stopped) {
            return;
        }
        this._housekeeping()
            .catch(() => undefined)
            .finally(() => {
                if (!this.stopped) {
                    this.tickTimer = this.timers.setTimeout(() => this._tick(), TICK_MS);
                }
            });
    }

    /**
     * Waits until the window `from`..`to` is on disk and keeps those segments until
     * `release` is called.
     *
     * @param {number} from - Window start in ms
     * @param {() => number} to - Window end in ms; read again on every check, so a clip can be extended
     * @param {number} graceMs - Longest wait after the window end
     * @returns {Promise<{files: string[], first: number, offset: number, complete: boolean, release: () => void}>}
     *   The segment files, start of the first one in ms, seconds to skip, whether the window is complete
     */
    async collect(from, to, graceMs) {
        this.holds.add(from);
        const release = () => this.holds.delete(from);
        try {
            for (;;) {
                const end = to();
                const picked = selectSegments(await this.segments(), from, end);
                if (picked.complete || Date.now() >= end + graceMs || this.stopped) {
                    return {
                        files: picked.segments.map(s => path.join(this.dir, s.name)),
                        first: picked.segments.length ? picked.segments[0].start : from,
                        offset: picked.offset,
                        complete: picked.complete,
                        release,
                    };
                }
                await new Promise(resolve => this.timers.setTimeout(() => resolve(undefined), 500));
            }
        } catch (err) {
            release();
            throw err;
        }
    }
}

/**
 * @param {number} lastGrowth - Time of the last growth of the buffer in ms
 * @param {number} now - Current time in ms
 * @returns {boolean} True when no data arrived for longer than the stall limit
 */
function isStalled(lastGrowth, now) {
    return now - lastGrowth > STALL_MS;
}

module.exports = { Prebuffer, TICK_MS, STALL_MS, isStalled };
