'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const utils = require('@iobroker/adapter-core');

const { normalizeCameras, normalizeTriggers, normalizeSettings, findCamera } = require('./lib/config');
const { protectCameras, revealPassword } = require('./lib/secrets');
const { FfmpegRunner, probeFfmpeg, resolveFfmpegPath } = require('./lib/ffmpeg-runner');
const { Recorder } = require('./lib/recorder');
const { Prebuffer } = require('./lib/prebuffer');
const { removePartials } = require('./lib/storage');
const { shouldFire, formatCaption } = require('./lib/triggers');
const { maskSecrets } = require('./lib/mask');
const { NAMES } = require('./lib/names');

/**
 * @param {number} bytes - File size
 * @returns {string} Size for a log line, e.g. `850 kB` or `1.4 MB`
 */
function formatSize(bytes) {
    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/** Files larger than this are not copied into the ioBroker file storage. */
const MAX_COPY_BYTES = 25 * 1024 * 1024;

/**
 * @typedef {import('./lib/types').Camera} Camera
 * @typedef {import('./lib/types').Trigger} Trigger
 * @typedef {import('./lib/types').RecordRequest} RecordRequest
 * @typedef {import('./lib/types').RecordResult} RecordResult
 */

/** @type {Array<{id: string, common: Partial<ioBroker.StateCommon>}>} */
const CAMERA_STATES = [
    { id: 'record', common: { type: 'boolean', role: 'button', read: false, write: true, def: false } },
    { id: 'snapshot', common: { type: 'boolean', role: 'button', read: false, write: true, def: false } },
    { id: 'lastVideo', common: { type: 'string', role: 'text', read: true, write: false, def: '' } },
    { id: 'lastVideoTime', common: { type: 'number', role: 'value.time', read: true, write: false, def: 0 } },
    { id: 'lastSnapshot', common: { type: 'string', role: 'text', read: true, write: false, def: '' } },
    { id: 'lastSnapshotTime', common: { type: 'number', role: 'value.time', read: true, write: false, def: 0 } },
    {
        id: 'status',
        common: {
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: 'idle',
            states: { idle: 'idle', recording: 'recording', snapshot: 'snapshot', error: 'error' },
        },
    },
    { id: 'lastError', common: { type: 'string', role: 'text', read: true, write: false, def: '' } },
    {
        id: 'prebuffer',
        common: {
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: 'off',
            states: { off: 'off', starting: 'starting', running: 'running', restarting: 'restarting' },
        },
    },
];

class CamRecorder extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'cam-recorder',
        });
        /** @type {Camera[]} */
        this.cameras = [];
        /** @type {Map<string, Trigger[]>} */
        this.triggers = new Map();
        /** @type {Map<Trigger, number>} */
        this.lastFired = new Map();
        /** @type {Map<string, number>} */
        this.busy = new Map();
        /** @type {FfmpegRunner | null} */
        this.runner = null;
        /** @type {Recorder | null} */
        this.recorder = null;
        /** @type {Map<string, Prebuffer>} */
        this.prebuffers = new Map();
        this.settings = normalizeSettings({});
        this.storageId = '';
        this.dateFormat = 'DD.MM.YYYY';
        /** @type {(value?: unknown) => void} */
        this._resolveReady = () => undefined;
        this.ready = new Promise(resolve => {
            this._resolveReady = resolve;
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        try {
            await this.setState('info.connection', false, true);
            await this._protectStoredCameras();

            this.settings = normalizeSettings(this.config);
            const cams = normalizeCameras(this.config.cameras);
            this.cameras = cams.cameras;
            const trig = normalizeTriggers(this.config.triggers, this.cameras);
            for (const problem of [...cams.problems, ...trig.problems]) {
                this.log.warn(problem);
            }
            for (const trigger of trig.triggers) {
                const list = this.triggers.get(trigger.stateId) || [];
                list.push(trigger);
                this.triggers.set(trigger.stateId, list);
            }

            await this._createObjects();
            await this._readDateFormat();

            const silent = trig.triggers.filter(t => t.telegram);
            if (silent.length && !this.settings.telegramInstance) {
                this.log.warn(
                    `${silent.length} trigger(s) should send to Telegram, but no Telegram instance is selected (tab Telegram): ${silent
                        .map(t => t.stateId)
                        .join(', ')}`,
                );
            }

            const outputDir = String(this.config.outputDir || '').trim()
                ? path.resolve(String(this.config.outputDir).trim())
                : path.join(utils.getAbsoluteInstanceDataDir(this), 'media');
            await fs.mkdir(outputDir, { recursive: true });
            const leftovers = await removePartials(outputDir);
            if (leftovers) {
                this.log.debug(`Removed ${leftovers} unfinished file(s) of an earlier run`);
            }

            const ffmpegPath = resolveFfmpegPath(String(this.config.ffmpegPath || ''));
            if (!ffmpegPath) {
                this.log.error(
                    'No ffmpeg binary found: the bundled ffmpeg is missing for this platform. Install ffmpeg and enter its path in the settings (Advanced).',
                );
                return;
            }
            let version;
            try {
                version = await probeFfmpeg(ffmpegPath);
            } catch (err) {
                this.log.error(`${err.message}. Check the ffmpeg path in the settings (Advanced).`);
                return;
            }
            await this.setState('info.ffmpegVersion', version, true);

            this.runner = new FfmpegRunner({
                ffmpegPath,
                maxParallel: this.settings.maxParallel,
                timers: {
                    setTimeout: (cb, ms) => this.setTimeout(cb, ms),
                    clearTimeout: handle => this.clearTimeout(handle),
                },
            });
            this.recorder = new Recorder({
                runner: this.runner,
                outputDir,
                settings: this.settings,
                withPassword: camera => this._withPassword(camera),
                getPrebuffer: cameraId => this.prebuffers.get(cameraId),
                onWarning: message => this.log.warn(message),
            });
            await this._startPrebuffers(ffmpegPath);

            await this.subscribeStatesAsync('cameras.*.record');
            await this.subscribeStatesAsync('cameras.*.snapshot');
            for (const stateId of this.triggers.keys()) {
                await this.subscribeForeignStatesAsync(stateId);
            }

            await this.setState('info.connection', true, true);
            this.log.info(
                `${version} ready: ${this.cameras.length} camera(s), ${trig.triggers.length} trigger(s), files in ${outputDir}`,
            );
        } catch (err) {
            this.log.error(`Start failed: ${maskSecrets(err.message)}`);
        } finally {
            this._resolveReady();
        }
    }

    /**
     * Encrypts plain camera passwords in the instance object and moves a login typed into a
     * URL into the user and password fields. The js-controller restarts the instance after
     * the write; this run already uses the new values.
     */
    async _protectStoredCameras() {
        const id = `system.adapter.${this.namespace}`;
        try {
            const obj = await this.getForeignObjectAsync(id);
            const stored = obj?.native?.cameras;
            const result = protectCameras(stored, value => this.encrypt(value));
            if (!result.changed) {
                return;
            }
            this.config.cameras = result.cameras;
            await this.extendForeignObjectAsync(id, { native: { cameras: result.cameras } });
            this.log.info(
                'Camera passwords are now stored encrypted (a login in a URL was moved into the user and password fields). The adapter restarts once.',
            );
        } catch (err) {
            this.log.warn(`Could not store the camera passwords encrypted: ${maskSecrets(err.message)}`);
        }
    }

    /**
     * @param {Camera} camera - Camera as configured
     * @returns {Camera} The camera with the plain password, only for ffmpeg
     */
    _withPassword(camera) {
        return { ...camera, password: revealPassword(camera.password, value => this.decrypt(value)) };
    }

    /**
     * Starts the pre-recording of every camera that has seconds set, if the main switch is on.
     *
     * @param {string} ffmpegPath - Path of ffmpeg
     */
    async _startPrebuffers(ffmpegPath) {
        const wanted = this.cameras.filter(c => c.prebuffer > 0);
        if (!wanted.length) {
            return;
        }
        if (!this.settings.prebufferEnabled) {
            this.log.info(
                `Pre-recording is set for ${wanted.length} camera(s) but switched off (tab Recording), clips start at the event`,
            );
            return;
        }
        const base = this.settings.prebufferDir
            ? path.resolve(this.settings.prebufferDir)
            : path.join(os.tmpdir(), `iobroker-${this.namespace}-prebuffer`);
        for (const camera of wanted) {
            const buffer = new Prebuffer({
                camera: this._withPassword(camera),
                settings: this.settings,
                seconds: camera.prebuffer,
                dir: path.join(base, camera.id),
                ffmpegPath,
                timers: {
                    setTimeout: (cb, ms) => this.setTimeout(cb, ms),
                    clearTimeout: handle => this.clearTimeout(handle),
                },
                onStatus: status => void this.setState(`cameras.${camera.id}.prebuffer`, status, true),
                onWarning: message => this.log.warn(message),
            });
            this.prebuffers.set(camera.id, buffer);
            try {
                await buffer.start();
                this.log.info(
                    `Pre-recording of camera "${camera.name}": ${camera.prebuffer} s, segments in ${buffer.dir}`,
                );
            } catch (err) {
                this.log.warn(`Pre-recording of camera "${camera.name}" could not start: ${err.message}`);
            }
        }
    }

    /** Reads the date format of the system settings for `{date}` in captions. */
    async _readDateFormat() {
        try {
            const config = await this.getForeignObjectAsync('system.config');
            const format = config?.common?.dateFormat;
            if (typeof format === 'string' && format.trim()) {
                this.dateFormat = format.trim();
            }
        } catch {
            // keep the default
        }
    }

    /** Creates the objects of the active cameras and removes those of deleted cameras. */
    async _createObjects() {
        await this.extendObjectAsync('cameras', { type: 'folder', common: { name: NAMES.cameras }, native: {} });
        const wanted = new Set(this.cameras.map(c => `${this.namespace}.cameras.${c.id}`));
        const existing = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.cameras.`,
            endkey: `${this.namespace}.cameras.香`,
        });
        for (const row of existing.rows) {
            if (!wanted.has(row.id)) {
                await this.delForeignObjectAsync(row.id, { recursive: true });
                this.log.info(`Removed the objects of the deleted camera ${row.id}`);
            }
        }
        for (const camera of this.cameras) {
            await this.extendObjectAsync(`cameras.${camera.id}`, {
                type: 'channel',
                common: { name: camera.name },
                native: {},
            });
            for (const state of CAMERA_STATES) {
                await this.extendObjectAsync(`cameras.${camera.id}.${state.id}`, {
                    type: 'state',
                    common: { name: NAMES[state.id], ...state.common },
                    native: {},
                });
            }
            await this.setState(`cameras.${camera.id}.status`, 'idle', true);
            await this.setState(`cameras.${camera.id}.prebuffer`, 'off', true);
        }
        if (this.settings.copyToFiles) {
            this.storageId = `${this.namespace}.storage`;
            await this.setForeignObjectNotExistsAsync(this.storageId, {
                type: 'meta',
                common: { name: NAMES.storage, type: 'meta.folder' },
                native: {},
            });
        }
    }

    /**
     * @param {Camera} camera - Camera
     * @param {'record' | 'snapshot'} kind - What to take
     * @param {RecordRequest} request - Options
     * @param {boolean} telegram - Send the result to Telegram
     * @returns {Promise<RecordResult>} The finished file
     */
    async _take(camera, kind, request, telegram) {
        if (!this.recorder) {
            throw new Error('ffmpeg is not available, see the log of the adapter start');
        }
        const base = `cameras.${camera.id}`;
        this.busy.set(camera.id, (this.busy.get(camera.id) || 0) + 1);
        await this.setState(`${base}.status`, kind === 'record' ? 'recording' : 'snapshot', true);
        let failed = false;
        try {
            const result =
                kind === 'record'
                    ? await this.recorder.record(camera, request)
                    : await this.recorder.snapshot(camera, request);
            const prefix = kind === 'record' ? 'lastVideo' : 'lastSnapshot';
            await this.setState(`${base}.${prefix}`, result.file, true);
            await this.setState(`${base}.${prefix}Time`, result.time, true);
            await this.setState(`${base}.lastError`, '', true);
            const seconds = result.pre
                ? `${result.pre} s before + ${Math.round((result.duration - result.pre) * 10) / 10} s`
                : `${result.duration} s`;
            const what = kind === 'record' ? `${result.format} clip (${seconds})` : 'snapshot';
            const took = ((Date.now() - result.time) / 1000).toFixed(1);
            this.log.info(
                `Camera "${camera.name}": ${what} saved, ${formatSize(result.size)} in ${took} s: ${path.basename(result.file)}`,
            );
            this.log.debug(`Camera "${camera.name}": full path ${result.file}`);
            await this._copyToFiles(camera, result);
            if (telegram) {
                await this._sendTelegram(result);
            }
            return result;
        } catch (err) {
            failed = true;
            const message = maskSecrets(err.message, [camera.username]);
            await this.setState(`${base}.lastError`, message, true);
            this.log.warn(
                `Camera "${camera.name}": ${kind === 'record' ? 'recording' : 'snapshot'} failed: ${message}`,
            );
            throw new Error(message);
        } finally {
            const left = (this.busy.get(camera.id) || 1) - 1;
            this.busy.set(camera.id, left);
            if (left === 0) {
                await this.setState(`${base}.status`, failed ? 'error' : 'idle', true);
            }
        }
    }

    /**
     * Puts the newest file of each kind into the ioBroker file storage, where the admin
     * (tab Files) and a web instance can hand it out.
     *
     * @param {Camera} camera - Camera
     * @param {RecordResult} result - Finished file
     */
    async _copyToFiles(camera, result) {
        if (!this.storageId || result.size > MAX_COPY_BYTES) {
            return;
        }
        try {
            const data = await fs.readFile(result.file);
            await this.writeFileAsync(this.storageId, `${camera.id}.${result.format}`, data);
        } catch (err) {
            this.log.warn(`Could not copy ${path.basename(result.file)} into the file storage: ${err.message}`);
        }
    }

    /**
     * @param {RecordResult} result - Finished file
     */
    async _sendTelegram(result) {
        const { telegramInstance, telegramUser, telegramCaption } = this.settings;
        if (!telegramInstance) {
            return;
        }
        /** @type {Record<string, string>} */
        const payload = { text: result.file };
        const caption = formatCaption(telegramCaption, result.camera, new Date(result.time), this.dateFormat).trim();
        if (caption) {
            payload.caption = caption;
        }
        if (telegramUser) {
            payload.user = telegramUser;
        }
        try {
            await this.sendToAsync(telegramInstance, 'send', payload, { timeout: 60_000 });
            this.log.info(
                `Sent ${path.basename(result.file)} to ${telegramInstance}${telegramUser ? ` (${telegramUser})` : ''}`,
            );
        } catch (err) {
            this.log.warn(`Could not send ${path.basename(result.file)} to ${telegramInstance}: ${err.message}`);
        }
    }

    /**
     * @param {Trigger} trigger - Trigger that fired
     */
    async _fire(trigger) {
        const { camera } = trigger;
        this.log.info(`Trigger ${trigger.stateId}: ${trigger.action} on camera "${camera.name}"`);
        /** @type {RecordRequest} */
        const request = {};
        if (trigger.duration) {
            request.duration = trigger.duration;
        }
        if (trigger.format) {
            request.format = trigger.format;
        }
        const jobs = [];
        if (trigger.action !== 'record') {
            jobs.push(this._take(camera, 'snapshot', {}, trigger.telegram));
        }
        if (trigger.action !== 'snapshot') {
            jobs.push(this._take(camera, 'record', request, trigger.telegram));
        }
        await Promise.allSettled(jobs);
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    onStateChange(id, state) {
        const triggers = this.triggers.get(id);
        if (triggers) {
            const now = Date.now();
            for (const trigger of triggers) {
                if (shouldFire(trigger, state, this.lastFired.get(trigger) || 0, now)) {
                    this.lastFired.set(trigger, now);
                    void this._fire(trigger);
                }
            }
        }
        if (!state || state.ack || !id.startsWith(`${this.namespace}.cameras.`)) {
            return;
        }
        const match = /\.cameras\.([^.]+)\.(record|snapshot)$/.exec(id);
        const camera = match && this.cameras.find(c => c.id === match[1]);
        if (!match || !camera || !state.val) {
            return;
        }
        void this.setState(id, false, true);
        this._take(camera, match[2] === 'record' ? 'record' : 'snapshot', {}, false).catch(() => undefined);
    }

    /**
     * Commands: `record` and `snapshot` with `{camera, duration, format, width, fps, telegram}`,
     * `listCameras` for the trigger table of the admin.
     *
     * @param {ioBroker.Message} obj - Message
     */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        /** @param {ioBroker.MessagePayload} answer - Answer for the caller */
        const reply = answer => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, answer, obj.callback);
            }
        };
        await this.ready;
        try {
            if (obj.command === 'listCameras') {
                reply(this.cameras.map(c => ({ value: c.name, label: c.name })));
                return;
            }
            if (obj.command !== 'record' && obj.command !== 'snapshot') {
                reply({ error: `Unknown command "${obj.command}"` });
                return;
            }
            /** @type {RecordRequest & {camera?: string, telegram?: boolean}} */
            const message =
                typeof obj.message === 'string'
                    ? { camera: obj.message }
                    : obj.message && typeof obj.message === 'object'
                      ? obj.message
                      : {};
            const camera = findCamera(this.cameras, message.camera);
            if (!camera) {
                reply({ error: `Unknown camera "${message.camera ?? ''}"` });
                return;
            }
            const result = await this._take(camera, obj.command, message, message.telegram === true);
            reply(result);
        } catch (err) {
            reply({ error: err.message });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.runner?.stopAll();
            for (const buffer of this.prebuffers.values()) {
                void buffer.stop();
            }
            this.prebuffers.clear();
            this.runner = null;
            this.recorder = null;
            void this.setState('info.connection', false, true);
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new CamRecorder(options);
} else {
    // otherwise start the instance directly
    new CamRecorder();
}
