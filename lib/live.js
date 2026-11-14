'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pictureFilter } = require('./ffmpeg-args');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').Timers} Timers
 * @typedef {import('./prebuffer').Prebuffer} Prebuffer
 * @typedef {import('./ffmpeg-runner').FfmpegRunner} FfmpegRunner
 */

/**
 * The live picture of a camera: every few seconds the newest key frame of the pre-recording becomes a JPEG, for an
 * image widget of vis or a web page. No second connection to the camera and almost no CPU: ffmpeg decodes only the
 * key frames of one segment (`-skip_frame nokey`), so the picture is at most one key frame interval old. Only for
 * cameras with a running pre-recording.
 */
class LivePicture {
    /**
     * @param {object} options - Options
     * @param {Camera} options.camera - Camera
     * @param {Prebuffer} options.buffer - Its pre-recording
     * @param {FfmpegRunner} options.runner - Runner of its own, so the pictures never wait for or delay a recording
     * @param {number} options.seconds - Interval
     * @param {number} options.width - Width in pixels, 0 = original
     * @param {Timers} options.timers - Timers of the adapter
     * @param {(data: Buffer) => Promise<void>} options.write - Stores a new picture
     * @param {(message: string) => void} [options.onError] - A picture failed
     * @param {boolean} [options.passthrough] - ffmpeg knows `-fps_mode` (5.1+); else the older `-vsync 0`
     */
    constructor({ camera, buffer, runner, seconds, width, timers, write, onError, passthrough = true }) {
        this.passthrough = passthrough;
        this.camera = camera;
        this.buffer = buffer;
        this.runner = runner;
        this.intervalMs = seconds * 1000;
        this.width = width;
        this.timers = timers;
        this.write = write;
        this.onError = onError || (() => undefined);
        /** @type {Buffer | null} last written picture: the same key frame is not written again */
        this.last = null;
        /** @type {unknown} */
        this.timer = null;
        this.stopped = false;
    }

    /** Takes the first picture at once, then one per interval. */
    start() {
        this.stopped = false;
        this._schedule(0);
    }

    /** Stops the pictures; the last one stays in the file storage. */
    stop() {
        this.stopped = true;
        this.timers.clearTimeout(this.timer);
        this.timer = null;
    }

    /** @param {number} ms - Wait */
    _schedule(ms) {
        if (this.stopped) {
            return;
        }
        this.timer = this.timers.setTimeout(() => {
            this.timer = null;
            void this.tick().finally(() => this._schedule(this.intervalMs));
        }, ms);
    }

    /**
     * Takes one picture and writes it when it is new.
     *
     * @returns {Promise<boolean>} True when a new picture was written
     */
    async tick() {
        if (!this.buffer.isRunning()) {
            return false;
        }
        const data = await this.grab();
        if (!data || this.stopped || (this.last && this.last.equals(data))) {
            return false;
        }
        this.last = data;
        try {
            await this.write(data);
            return true;
        } catch (err) {
            this.onError(`Camera "${this.camera.name}": the live picture could not be stored: ${err.message}`);
            return false;
        }
    }

    /**
     * Each segment starts with a key frame, so the segment that is being written already holds a complete one; the
     * one before is the fallback.
     *
     * @returns {Promise<Buffer | null>} The newest key frame as JPEG, null when none could be read
     */
    async grab() {
        const file = path.join(this.buffer.dir, 'live.jpg');
        for (const segment of (await this.buffer.segments()).slice(-2).reverse()) {
            const args = [
                ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-skip_frame', 'nokey'],
                ...['-i', path.join(this.buffer.dir, segment.name), '-an'],
                ...pictureFilter(this.width, this.camera.orientation),
                // only the decoded key frames, without repeating them up to the frame rate
                ...(this.passthrough ? ['-fps_mode', 'passthrough'] : ['-vsync', '0']),
                ...['-q:v', '4', '-update', '1', '-f', 'image2', '-y', file],
            ];
            try {
                await this.runner.run(args, { timeoutMs: 15_000 });
                const data = await fs.readFile(file);
                if (data.length) {
                    return data;
                }
            } catch (err) {
                if (this.stopped || this.runner.stopped) {
                    return null;
                }
                this.onError(`Camera "${this.camera.name}": no live picture from ${segment.name}: ${err.message}`);
            } finally {
                await fs.unlink(file).catch(() => undefined);
            }
        }
        return null;
    }
}

module.exports = { LivePicture };
