'use strict';

const { spawn, execFile } = require('node:child_process');
const { maskSecrets } = require('./mask');

const STDERR_LIMIT = 4096;

/**
 * @typedef {import('./types').Timers} Timers
 * @typedef {import('./types').RunOptions} RunOptions
 */

/**
 * Starts ffmpeg processes without a shell, limits how many run at the same time and
 * kills a process that hangs. Error messages are masked before they leave this class.
 */
class FfmpegRunner {
    /**
     * @param {object} options - Options
     * @param {string} options.ffmpegPath - Path of the ffmpeg binary
     * @param {number} options.maxParallel - Processes at the same time
     * @param {Timers} options.timers - Timer functions
     */
    constructor({ ffmpegPath, maxParallel, timers }) {
        this.ffmpegPath = ffmpegPath;
        this.maxParallel = Math.max(1, maxParallel);
        this.timers = timers;
        /** @type {Set<import('node:child_process').ChildProcess>} */
        this.active = new Set();
        /** @type {Array<{start: () => void, cancel: (err: Error) => void}>} */
        this.queue = [];
        this.running = 0;
        this.stopped = false;
    }

    /**
     * Runs ffmpeg with the given arguments.
     *
     * @param {string[]} args - Arguments
     * @param {RunOptions} options - Limits
     * @returns {Promise<void>} Resolves when ffmpeg exits with code 0
     */
    run(args, options) {
        if (this.stopped) {
            return Promise.reject(new Error('The adapter is stopping'));
        }
        return new Promise((resolve, reject) => {
            const job = {
                start: () => this._start(args, options, resolve, reject),
                cancel: reject,
            };
            if (this.running < this.maxParallel) {
                job.start();
            } else {
                this.queue.push(job);
            }
        });
    }

    /**
     * @param {string[]} args - Arguments
     * @param {RunOptions} options - Limits
     * @param {() => void} resolve - Success
     * @param {(err: Error) => void} reject - Failure
     */
    _start(args, options, resolve, reject) {
        this.running++;
        let stderr = '';
        let timedOut = false;
        let finished = false;
        const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        this.active.add(child);
        const timer = this.timers.setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, options.timeoutMs);

        /** @param {Error | null} err - Failure or null */
        const done = err => {
            if (finished) {
                return;
            }
            finished = true;
            this.timers.clearTimeout(timer);
            this.active.delete(child);
            this.running--;
            this._next();
            if (err) {
                reject(new Error(maskSecrets(err.message, options.secrets)));
            } else {
                resolve();
            }
        };

        child.stderr?.on('data', chunk => {
            stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
        });
        child.on('error', err => done(new Error(`ffmpeg could not be started: ${err.message}`)));
        child.on('close', (code, signal) => {
            if (code === 0) {
                done(null);
            } else if (timedOut) {
                done(
                    new Error(`ffmpeg did not finish within ${Math.round(options.timeoutMs / 1000)} s and was stopped`),
                );
            } else if (this.stopped) {
                done(new Error('ffmpeg was stopped because the adapter is stopping'));
            } else {
                const lines = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
                // Windows reports negative exit codes as unsigned 32-bit numbers
                const exit = typeof code === 'number' && code > 0x7fffffff ? code - 0x100000000 : code;
                done(new Error(`ffmpeg failed (${signal || `exit code ${exit}`})${lines ? `: ${lines}` : ''}`));
            }
        });
    }

    /** Starts waiting jobs while there is room. */
    _next() {
        if (this.stopped) {
            return;
        }
        while (this.running < this.maxParallel && this.queue.length) {
            const job = this.queue.shift();
            job?.start();
        }
    }

    /** Kills every running process and rejects every waiting job. */
    stopAll() {
        this.stopped = true;
        for (const job of this.queue.splice(0)) {
            job.cancel(new Error('The adapter is stopping'));
        }
        for (const child of this.active) {
            child.kill('SIGKILL');
        }
    }
}

/**
 * Checks that the binary starts and reads its version.
 *
 * @param {string} ffmpegPath - Path of the binary
 * @returns {Promise<string>} First line of `ffmpeg -version`
 */
function probeFfmpeg(ffmpegPath) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, ['-hide_banner', '-version'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
            if (err) {
                reject(new Error(`ffmpeg at "${ffmpegPath}" does not start: ${err.message}`));
                return;
            }
            const first = String(stdout).split(/\r?\n/)[0] || '';
            resolve(first.replace(/\s*Copyright.*$/i, '').trim());
        });
    });
}

/**
 * @param {string} configured - Path from the settings, empty = bundled binary
 * @returns {string | null} The path to use
 */
function resolveFfmpegPath(configured) {
    if (configured && configured.trim()) {
        return configured.trim();
    }
    try {
        const bundled = require('ffmpeg-static');
        return typeof bundled === 'string' ? bundled : null;
    } catch {
        return null;
    }
}

/**
 * Reads the length of a media file from the banner of ffmpeg.
 *
 * @param {string} ffmpegPath - Path of the binary
 * @param {string} file - Media file
 * @returns {Promise<number | null>} Seconds, null when ffmpeg names no duration
 */
function mediaDuration(ffmpegPath, file) {
    return new Promise(resolve => {
        // without an output ffmpeg exits with an error after printing the input information
        execFile(
            ffmpegPath,
            ['-hide_banner', '-i', file],
            { timeout: 15_000, windowsHide: true },
            (_err, _out, stderr) => {
                const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr));
                resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
            },
        );
    });
}

module.exports = { FfmpegRunner, probeFfmpeg, resolveFfmpegPath, mediaDuration };
