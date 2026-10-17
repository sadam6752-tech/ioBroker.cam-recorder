'use strict';

const fs = require('node:fs/promises');
const { inputArgs, clipArgs, snapshotArgs } = require('./ffmpeg-args');
const { uniqueFile, pruneFiles } = require('./storage');
const { clampInt } = require('./config');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Settings} Settings
 * @typedef {import('./types').ClipOptions} ClipOptions
 * @typedef {import('./types').RecordRequest} RecordRequest
 * @typedef {import('./types').RecordResult} RecordResult
 * @typedef {import('./ffmpeg-runner').FfmpegRunner} FfmpegRunner
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
     */
    constructor({ runner, outputDir, settings, withPassword }) {
        this.runner = runner;
        this.outputDir = outputDir;
        this.settings = settings;
        this.withPassword = withPassword;
        /** @type {Map<string, Promise<RecordResult>>} */
        this.inflight = new Map();
    }

    /**
     * @param {Camera} camera - Camera
     * @param {RecordRequest} [request] - Clip options
     * @returns {Promise<RecordResult>} The finished clip
     */
    record(camera, request = {}) {
        const clip = resolveClip(this.settings, request);
        const key = `${camera.id}:${clip.format}`;
        return this._once(key, () => this._recordClip(camera, clip));
    }

    /**
     * @param {Camera} camera - Camera
     * @param {{width?: number}} [request] - Snapshot options
     * @returns {Promise<RecordResult>} The finished picture
     */
    snapshot(camera, request = {}) {
        const width = clampInt(request.width, 0, 3840, this.settings.snapshotWidth);
        return this._once(`${camera.id}:jpg`, () => this._takeSnapshot(camera, width));
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
        return { file, size, format: clip.format, duration: clip.duration, camera: camera.name, time: started };
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
        return { file, size, format: 'jpg', duration: 0, camera: camera.name, time: started };
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
