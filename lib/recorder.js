'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inputArgs, clipArgs, snapshotArgs } = require('./ffmpeg-args');
const { uniqueFile, pruneFiles } = require('./storage');
const { clampInt } = require('./config');
const { SEGMENT_SECONDS, concatList } = require('./prebuffer-plan');
const { mediaDuration } = require('./ffmpeg-runner');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Settings} Settings
 * @typedef {import('./types').ClipOptions} ClipOptions
 * @typedef {import('./types').RecordRequest} RecordRequest
 * @typedef {import('./types').RecordResult} RecordResult
 * @typedef {import('./ffmpeg-runner').FfmpegRunner} FfmpegRunner
 * @typedef {import('./prebuffer').Prebuffer} Prebuffer
 */

/**
 * @param {Settings} settings - Adapter settings
 * @param {RecordRequest} request - Request
 * @returns {ClipOptions} Options with limits applied
 */
function resolveClip(settings, request) {
    const format = request.format === 'gif' || request.format === 'mp4' ? request.format : settings.recordFormat;
    const gif = format === 'gif';
    return {
        format,
        mode: settings.videoMode,
        duration: clampInt(request.duration, 1, 60, settings.recordDuration),
        width: clampInt(request.width, 0, 3840, gif ? settings.gifWidth : settings.videoWidth),
        fps: clampInt(request.fps, 0, 60, gif ? settings.gifFps : settings.videoFps),
    };
}

/**
 * Records clips and snapshots into one folder. Two requests for the same camera and kind
 * that overlap (a doorbell pressed twice) share one ffmpeg run and one file.
 */
class Recorder {
    /**
     * @param {object} options - Options
     * @param {FfmpegRunner} options.runner - Process runner
     * @param {string} options.outputDir - Folder for the files
     * @param {Settings} options.settings - Adapter settings
     * @param {(camera: Camera) => Camera} options.withPassword - Returns the camera with the plain password
     * @param {(cameraId: string) => Prebuffer | undefined} [options.getPrebuffer] - Pre-recording of a camera
     * @param {(message: string) => void} [options.onWarning] - Called when a clip falls back to live recording
     */
    constructor({ runner, outputDir, settings, withPassword, getPrebuffer, onWarning }) {
        this.runner = runner;
        this.outputDir = outputDir;
        this.settings = settings;
        this.withPassword = withPassword;
        this.getPrebuffer = getPrebuffer || (() => undefined);
        this.onWarning = onWarning || (() => undefined);
        /** @type {Map<string, Promise<RecordResult>>} */
        this.inflight = new Map();
        /** @type {Map<string, (seconds: number) => boolean>} buffered clips of a camera that can still grow */
        this.extenders = new Map();
    }

    /**
     * @param {Camera} camera - Camera
     * @param {RecordRequest} [request] - Clip options
     * @returns {Promise<RecordResult>} The finished clip
     */
    record(camera, request = {}) {
        const clip = resolveClip(this.settings, request);
        const buffer = this.getPrebuffer(camera.id);
        if (buffer && !buffer.isRunning() && request.pre !== 0) {
            // the buffer needs some seconds after a start until the first segments are on disk
            this.onWarning(
                `Camera "${camera.name}": the pre-recording is not ready (${buffer.status}), the clip starts at the event`,
            );
        }
        const pre = buffer && buffer.isRunning() ? clampInt(request.pre, 0, buffer.seconds, buffer.seconds) : 0;
        const key = `${camera.id}:${clip.format}:${pre}`;
        const running = this.inflight.get(key);
        if (running) {
            // the same clip is still being cut: a buffered clip grows, a live one is shared
            this.extend(camera.id, clip.duration);
            return running;
        }
        return this._once(key, () =>
            buffer && pre > 0 ? this._recordBuffered(camera, clip, pre, buffer) : this._recordClip(camera, clip),
        );
    }

    /**
     * Extends a buffered clip of the camera that is still waiting for its window: the window
     * then ends `seconds` from now, at most at the maximum clip length.
     *
     * @param {string} cameraId - Camera id
     * @param {number} seconds - Seconds after now
     * @returns {boolean} True if a clip was extended
     */
    extend(cameraId, seconds) {
        const extender = this.extenders.get(cameraId);
        return extender ? extender(seconds) : false;
    }

    /**
     * Takes a snapshot. With a running pre-recording the picture comes from the buffer: no
     * second stream, and it shows the moment of the event instead of a few seconds later.
     *
     * @param {Camera} camera - Camera
     * @param {{width?: number, live?: boolean}} [request] - Snapshot options; `live` skips the buffer
     * @returns {Promise<RecordResult>} The finished picture
     */
    snapshot(camera, request = {}) {
        const width = clampInt(request.width, 0, 3840, this.settings.snapshotWidth);
        const buffer = this.getPrebuffer(camera.id);
        return this._once(`${camera.id}:jpg`, () =>
            buffer && buffer.isRunning() && request.live !== true
                ? this._snapshotFromBuffer(camera, width, buffer)
                : this._takeSnapshot(camera, width),
        );
    }

    /**
     * @param {string} key - Camera and kind
     * @param {() => Promise<RecordResult>} work - The recording
     * @returns {Promise<RecordResult>} The shared result
     */
    _once(key, work) {
        const running = this.inflight.get(key);
        if (running) {
            return running;
        }
        const promise = work().finally(() => this.inflight.delete(key));
        this.inflight.set(key, promise);
        return promise;
    }

    /**
     * @param {Camera} camera - Camera
     * @param {ClipOptions} clip - Clip options
     * @returns {Promise<RecordResult>} The finished clip
     */
    async _recordClip(camera, clip) {
        const started = Date.now();
        const open = this.withPassword(camera);
        const file = await this._target(camera, clip.format, started);
        // gif needs a second pass over the frames (palette), so it gets more time
        const extra = clip.format === 'gif' ? 60 : 30;
        await this._produce(file, [...inputArgs(open, this.settings), ...clipArgs(clip, `${file}.part`)], {
            timeoutMs: (clip.duration + this.settings.rtspTimeout + extra) * 1000,
            secrets: [open.password, open.username],
        });
        const size = (await fs.stat(file)).size;
        await this._prune(camera, clip.format);
        const realDuration = await mediaDuration(this.runner.ffmpegPath, file);
        return {
            file,
            size,
            format: clip.format,
            duration: clip.duration,
            pre: 0,
            extended: 0,
            fromBuffer: false,
            realDuration,
            camera: camera.name,
            time: started,
        };
    }

    /**
     * Cuts a clip from the pre-recording: `pre` seconds before the event plus the clip length
     * after it. Waits until the time after the event is on disk; when the buffer delivers
     * nothing, the clip is recorded live instead.
     *
     * @param {Camera} camera - Camera
     * @param {ClipOptions} clip - Clip options (duration = seconds after the event)
     * @param {number} pre - Seconds before the event
     * @param {Prebuffer} buffer - Pre-recording of the camera
     * @returns {Promise<RecordResult>} The finished clip
     */
    async _recordBuffered(camera, clip, pre, buffer) {
        const event = Date.now();
        const from = event - pre * 1000;
        const window = { to: event + clip.duration * 1000, extended: 0 };
        const latest = from + this.settings.maxClipLength * 1000;
        let waiting = true;
        this.extenders.set(camera.id, seconds => {
            if (!waiting) {
                return false;
            }
            const to = Math.min(latest, Math.max(window.to, Date.now() + seconds * 1000));
            if (to > window.to) {
                window.to = to;
                window.extended++;
            }
            return true;
        });
        let got;
        try {
            got = await buffer.collect(from, () => window.to, (2 * SEGMENT_SECONDS + 15) * 1000);
        } finally {
            waiting = false;
            this.extenders.delete(camera.id);
        }
        if (!got.files.length) {
            got.release();
            this.onWarning(`Camera "${camera.name}": the pre-recording had no segments, the clip starts at the event`);
            return this._recordClip(camera, clip);
        }
        const file = await this._target(camera, clip.format, event);
        const list = path.join(buffer.dir, `${path.basename(file)}.txt`);
        // the window may be shorter when the buffer only just started or the wait timed out
        const actualPre = Math.max(0, (event - Math.max(from, got.first)) / 1000);
        const total = Math.round((actualPre + (window.to - event) / 1000) * 10) / 10;
        const seek = got.offset.toFixed(2);
        const input = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'concat', '-safe', '0'];
        // a copied stream can only start at a key frame, so it seeks on the input side
        const args =
            clip.format === 'mp4' && clip.mode === 'copy'
                ? [...input, '-ss', seek, '-i', list, ...clipArgs({ ...clip, duration: total }, `${file}.part`)]
                : [...input, '-i', list, '-ss', seek, ...clipArgs({ ...clip, duration: total }, `${file}.part`)];
        try {
            await fs.writeFile(list, concatList(got.files));
            await this._produce(file, args, { timeoutMs: (total + 60) * 1000 });
        } catch (err) {
            if (this.runner.stopped) {
                throw err;
            }
            // a damaged segment must not cost the clip: record from now on instead
            this.onWarning(
                `Camera "${camera.name}": the pre-recording could not be joined (${err.message}), recording live instead`,
            );
            return this._recordClip(camera, clip);
        } finally {
            got.release();
            await fs.unlink(list).catch(() => undefined);
        }
        const size = (await fs.stat(file)).size;
        await this._prune(camera, clip.format);
        const realDuration = await mediaDuration(this.runner.ffmpegPath, file);
        return {
            file,
            size,
            format: clip.format,
            duration: total,
            realDuration,
            pre: Math.round(actualPre * 10) / 10,
            extended: window.extended,
            fromBuffer: true,
            camera: camera.name,
            time: event - actualPre * 1000,
        };
    }

    /**
     * @param {Camera} camera - Camera
     * @param {number} width - Width, 0 = original
     * @returns {Promise<RecordResult>} The finished picture
     */
    async _takeSnapshot(camera, width) {
        const started = Date.now();
        const open = this.withPassword(camera);
        const file = await this._target(camera, 'jpg', started);
        await this._produce(
            file,
            [...inputArgs(open, this.settings, { snapshot: true }), ...snapshotArgs(width, `${file}.part`)],
            { timeoutMs: (this.settings.rtspTimeout + 20) * 1000, secrets: [open.password, open.username] },
        );
        const size = (await fs.stat(file)).size;
        await this._prune(camera, 'jpg');
        return {
            file,
            size,
            format: 'jpg',
            duration: 0,
            pre: 0,
            extended: 0,
            fromBuffer: false,
            realDuration: null,
            camera: camera.name,
            time: started,
        };
    }

    /**
     * Takes the newest picture of the pre-recording: the last frame of the segment that is
     * being written (at most about a second old), or of the newest complete one. Falls back to
     * a live snapshot when neither can be read.
     *
     * @param {Camera} camera - Camera
     * @param {number} width - Width, 0 = original
     * @param {Prebuffer} buffer - Pre-recording of the camera
     * @returns {Promise<RecordResult>} The finished picture
     */
    async _snapshotFromBuffer(camera, width, buffer) {
        const started = Date.now();
        const candidates = (await buffer.segments()).slice(-2).reverse();
        const file = await this._target(camera, 'jpg', started);
        for (const segment of candidates) {
            const scale = width > 0 ? ['-vf', `scale=${width}:-2`] : [];
            // every frame overwrites the picture (-update 1), so the last one remains
            const args = [
                ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path.join(buffer.dir, segment.name)],
                ...['-an', ...scale, '-q:v', '3', '-update', '1', '-f', 'image2', '-y', `${file}.part`],
            ];
            try {
                await this._produce(file, args, { timeoutMs: 20_000 });
                const size = (await fs.stat(file)).size;
                await this._prune(camera, 'jpg');
                return {
                    file,
                    size,
                    format: 'jpg',
                    duration: 0,
                    pre: 0,
                    extended: 0,
                    fromBuffer: true,
                    realDuration: null,
                    camera: camera.name,
                    time: started,
                };
            } catch {
                // the segment that is being written may end in a half frame: try the complete one
            }
        }
        this.onWarning(`Camera "${camera.name}": no picture in the pre-recording, taking the snapshot live`);
        return this._takeSnapshot(camera, width);
    }

    /**
     * @param {Camera} camera - Camera
     * @param {string} ext - Extension
     * @param {number} time - Start time
     * @returns {Promise<string>} Free target path
     */
    async _target(camera, ext, time) {
        await fs.mkdir(this.outputDir, { recursive: true });
        return uniqueFile(this.outputDir, camera.id, ext, new Date(time));
    }

    /**
     * Runs ffmpeg into `<file>.part` and renames it when the result is not empty, so a file
     * under its final name is always complete.
     *
     * @param {string} file - Final path
     * @param {string[]} args - ffmpeg arguments writing `<file>.part`
     * @param {import('./types').RunOptions} options - Limits
     */
    async _produce(file, args, options) {
        const part = `${file}.part`;
        try {
            await this.runner.run(args, options);
            const stat = await fs.stat(part).catch(() => null);
            if (!stat || stat.size === 0) {
                throw new Error('ffmpeg finished, but wrote no data (no picture from the camera?)');
            }
            await fs.rename(part, file);
        } catch (err) {
            await fs.unlink(part).catch(() => undefined);
            throw err;
        }
    }

    /**
     * @param {Camera} camera - Camera
     * @param {string} ext - Extension
     */
    async _prune(camera, ext) {
        await pruneFiles(this.outputDir, camera.id, ext, this.settings.keepFiles, this.settings.maxAgeDays).catch(
            () => [],
        );
    }
}

module.exports = { Recorder, resolveClip };
