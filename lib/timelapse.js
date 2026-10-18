'use strict';

/**
 * Timelapse of one camera: a picture every few minutes, once a day the pictures become a short
 * video and are deleted. Frames live in `<media>/timelapse/<camera id>/` with the local time in
 * the name, so the alphabetical order is the order of the video.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { timeStamp } = require('./storage');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Settings} Settings
 * @typedef {import('./types').Timers} Timers
 * @typedef {import('./types').TimelapseJob} TimelapseJob
 * @typedef {import('./types').RecordResult} RecordResult
 * @typedef {import('./recorder').Recorder} Recorder
 */

/** Frames above this number are not taken (about 7 days at one picture per minute). */
const MAX_FRAMES = 10_000;

/** A missed daily build is done at the start when the oldest frame is older than this. */
const CATCH_UP_MS = 26 * 3600_000;

/**
 * @param {string} hhmm - Time as `HH:MM`
 * @returns {{hour: number, minute: number} | null} The time, null when invalid
 */
function parseTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
        return null;
    }
    return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Milliseconds from `now` to the next occurrence of a local time of day.
 *
 * @param {{hour: number, minute: number}} at - Time of day
 * @param {Date} now - Current time
 * @returns {number} Milliseconds, more than 0 and at most one day
 */
function msUntil(at, now) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hour, at.minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}

/**
 * @param {string[]} names - File names in the frame folder
 * @returns {string[]} The frames, oldest first
 */
function framesOf(names) {
    return names.filter(n => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.jpg$/.test(n)).sort();
}

/**
 * @param {string} name - Frame name `YYYY-MM-DD_HH-MM-SS.jpg`
 * @returns {number} Local time in ms
 */
function frameTime(name) {
    const [d, t] = name.slice(0, -4).split('_');
    const [y, mo, day] = d.split('-').map(Number);
    const [h, mi, s] = t.split('-').map(Number);
    return new Date(y, mo - 1, day, h, mi, s).getTime();
}

/**
 * Concat list that shows every frame for `1 / fps` seconds (the last frame is repeated, as the
 * concat demuxer ignores the duration of the last entry).
 *
 * @param {string[]} files - Absolute paths, oldest first
 * @param {number} fps - Frames per second of the video
 * @returns {string} Content of the list file
 */
function frameList(files, fps) {
    const quote = (/** @type {string} */ f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const step = (1 / fps).toFixed(4);
    const lines = files.flatMap(f => [quote(f), `duration ${step}`]);
    lines.push(quote(files[files.length - 1]));
    return `${lines.join('\n')}\n`;
}

/** Takes the frames of one camera and builds the daily video. */
class Timelapse {
    /**
     * @param {object} options - Options
     * @param {Camera} options.camera - Camera
     * @param {TimelapseJob} options.job - Interval, build time, frame rate
     * @param {Settings} options.settings - Adapter settings
     * @param {string} options.outputDir - Media folder
     * @param {Recorder} options.recorder - Takes the frames and runs ffmpeg
     * @param {Timers} options.timers - Timer functions of the adapter
     * @param {(result: RecordResult) => void} options.onVideo - Called with every finished video
     * @param {(progress: {frames: number, nextVideo: number}) => void} [options.onProgress] - Called with the
     *   number of waiting frames and the time of the next video (ms) after each frame, build and start
     * @param {(message: string) => void} options.onWarning - Called with problems
     */
    constructor({ camera, job, settings, outputDir, recorder, timers, onVideo, onWarning, onProgress }) {
        this.camera = camera;
        this.job = job;
        this.settings = settings;
        this.outputDir = outputDir;
        this.dir = path.join(outputDir, 'timelapse', camera.id);
        this.recorder = recorder;
        this.timers = timers;
        this.onVideo = onVideo;
        this.onWarning = onWarning;
        this.onProgress = onProgress || (() => undefined);
        this.nextVideo = 0;
        /** @type {ReturnType<Timers['setTimeout']>} */
        this.frameTimer = null;
        /** @type {ReturnType<Timers['setTimeout']>} */
        this.buildTimer = null;
        this.stopped = true;
        /** @type {Promise<RecordResult | null> | null} */
        this.building = null;
        this.warnedFull = false;
    }

    /** Starts taking frames and the daily build; builds a missed video first. */
    async start() {
        this.stopped = false;
        await fs.mkdir(this.dir, { recursive: true });
        const frames = await this.frames();
        if (frames.length && Date.now() - frameTime(frames[0]) > CATCH_UP_MS) {
            void this.build().catch(err => this.onWarning(`Timelapse of camera "${this.camera.name}": ${err.message}`));
        }
        // the first frame comes after one interval, so a restart loop does not fill the folder
        this._armFrame(this.job.interval * 60_000);
        this._armBuild();
        await this._report();
    }

    /** Tells the adapter how many frames wait and when the next video is made. */
    async _report() {
        this.onProgress({ frames: (await this.frames()).length, nextVideo: this.nextVideo });
    }

    /** Stops the timers; frames stay for the next start. */
    stop() {
        this.stopped = true;
        this.timers.clearTimeout(this.frameTimer);
        this.timers.clearTimeout(this.buildTimer);
    }

    /** @returns {Promise<string[]>} Frame names, oldest first */
    async frames() {
        try {
            return framesOf(await fs.readdir(this.dir));
        } catch {
            return [];
        }
    }

    /** @param {number} ms - Delay */
    _armFrame(ms) {
        if (this.stopped) {
            return;
        }
        this.frameTimer = this.timers.setTimeout(() => {
            void this.takeFrame()
                .catch(err => this.onWarning(`Timelapse of camera "${this.camera.name}": no frame (${err.message})`))
                .finally(() => this._armFrame(this.job.interval * 60_000));
        }, ms);
    }

    /** Arms the daily build at the configured time. */
    _armBuild() {
        if (this.stopped) {
            return;
        }
        const now = new Date();
        const untilBuild = msUntil(this.job.at, now);
        this.nextVideo = now.getTime() + untilBuild;
        this.buildTimer = this.timers.setTimeout(() => {
            void this.build()
                .catch(err => this.onWarning(`Timelapse of camera "${this.camera.name}": ${err.message}`))
                .finally(() => {
                    this._armBuild();
                    void this._report();
                });
        }, untilBuild);
    }

    /**
     * Takes one frame.
     *
     * @returns {Promise<string | null>} The frame file, null when the folder is full
     */
    async takeFrame() {
        const frames = await this.frames();
        if (frames.length >= MAX_FRAMES) {
            if (!this.warnedFull) {
                this.warnedFull = true;
                this.onWarning(
                    `Timelapse of camera "${this.camera.name}": ${MAX_FRAMES} frames are waiting, no more are taken until the next video`,
                );
            }
            return null;
        }
        await fs.mkdir(this.dir, { recursive: true });
        const file = path.join(this.dir, `${timeStamp(new Date())}.jpg`);
        await this.recorder.grabFrame(this.camera, file, this.settings.videoWidth);
        await this._report();
        return file;
    }

    /**
     * Builds the video of all waiting frames and deletes them. Two calls at the same time share one build.
     *
     * @returns {Promise<RecordResult | null>} The video, null when there are fewer than two frames
     */
    build() {
        if (!this.building) {
            this.building = this._build().finally(() => {
                this.building = null;
            });
        }
        return this.building;
    }

    /** @returns {Promise<RecordResult | null>} The video */
    async _build() {
        const frames = await this.frames();
        if (frames.length < 2) {
            return null;
        }
        const files = frames.map(f => path.join(this.dir, f));
        const first = frameTime(frames[0]);
        const day = timeStamp(new Date(first)).slice(0, 10);
        // named by the day of its first frame; a second video of that day gets -2, -3, …
        let file = path.join(this.outputDir, `${this.camera.id}_timelapse_${day}.mp4`);
        for (let i = 2; await exists(file); i++) {
            file = path.join(this.outputDir, `${this.camera.id}_timelapse_${day}-${i}.mp4`);
        }
        const list = path.join(this.dir, 'frames.txt');
        await fs.writeFile(list, frameList(files, this.job.fps));
        const width = this.settings.videoWidth;
        const args = [
            ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list],
            ...['-an', '-vf', width > 0 ? `scale=${width}:-2` : 'null', '-r', String(this.job.fps)],
            ...['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
            ...['-f', 'mp4', '-y', `${file}.part`],
        ];
        try {
            await this.recorder.produce(file, args, { timeoutMs: 60_000 + frames.length * 200 });
        } finally {
            await fs.unlink(list).catch(() => undefined);
        }
        for (const f of files) {
            await fs.unlink(f).catch(() => undefined);
        }
        this.warnedFull = false;
        await this._report();
        await this._pruneVideos();
        const size = (await fs.stat(file)).size;
        /** @type {RecordResult} */
        const result = {
            file,
            size,
            format: 'mp4',
            duration: Math.round((frames.length / this.job.fps) * 10) / 10,
            pre: 0,
            extended: 0,
            fromBuffer: false,
            realDuration: null,
            camera: this.camera.name,
            time: first,
        };
        this.onVideo(result);
        return result;
    }

    /** Deletes timelapse videos of this camera older than the maximum age of the Storage tab. */
    async _pruneVideos() {
        const maxAge = this.settings.maxAgeDays;
        if (!maxAge) {
            return;
        }
        const own = new RegExp(`^${this.camera.id}_timelapse_\\d{4}-\\d{2}-\\d{2}(-\\d+)?\\.mp4$`);
        for (const name of await fs.readdir(this.outputDir).catch(() => [])) {
            if (!own.test(name)) {
                continue;
            }
            const file = path.join(this.outputDir, name);
            const stat = await fs.stat(file).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > maxAge * 86_400_000) {
                await fs.unlink(file).catch(() => undefined);
            }
        }
    }
}

/**
 * @param {string} file - Path
 * @returns {Promise<boolean>} True if it exists
 */
async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

module.exports = { Timelapse, parseTime, msUntil, framesOf, frameTime, frameList, MAX_FRAMES, CATCH_UP_MS };
