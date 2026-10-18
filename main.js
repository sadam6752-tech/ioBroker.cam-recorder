'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const utils = require('@iobroker/adapter-core');

const {
    normalizeCameras,
    normalizeTriggers,
    normalizeSettings,
    normalizeTimelapses,
    findCamera,
} = require('./lib/config');
const { protectCameras, revealPassword } = require('./lib/secrets');
const { FfmpegRunner, probeFfmpeg, resolveFfmpegPath } = require('./lib/ffmpeg-runner');
const { Recorder } = require('./lib/recorder');
const { Prebuffer } = require('./lib/prebuffer');
const { removePartials } = require('./lib/storage');
const { triggerDecision, formatCaption } = require('./lib/triggers');
const { maskSecrets } = require('./lib/mask');
const { NAMES } = require('./lib/names');
const { conditionMet, opSymbol } = require('./lib/conditions');
const { KNOWN, buildMessage, parseNames, selectTargets } = require('./lib/notify');
const { Timelapse } = require('./lib/timelapse');
const {
    copyFileToRemote,
    remoteSettingsProblems,
    settingsForConnectionTest,
    testRemoteConnection,
} = require('./lib/remote-copy');
const { connectSsh2 } = require('./lib/sftp-ssh2');

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
    { id: 'timelapse', common: { type: 'boolean', role: 'button', read: false, write: true, def: false } },
    { id: 'lastTimelapse', common: { type: 'string', role: 'text', read: true, write: false, def: '' } },
    { id: 'lastTimelapseTime', common: { type: 'number', role: 'value.time', read: true, write: false, def: 0 } },
    { id: 'timelapseFrames', common: { type: 'number', role: 'value', read: true, write: false, def: 0 } },
    { id: 'timelapseNextVideo', common: { type: 'number', role: 'value.time', read: true, write: false, def: 0 } },
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
        /** @type {Map<string, Timelapse>} */
        this.timelapses = new Map();
        /** copies to the SFTP server run one after the other */
        this.remoteQueue = Promise.resolve();
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
            this._checkTargets();
            for (const trigger of trig.triggers) {
                this._checkNames(`Trigger ${trigger.stateId}`, trigger.telegram ? trigger.recipients : []);
            }
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
            await this._startTimelapses(outputDir);
            if (this.settings.remote.enabled) {
                for (const problem of remoteSettingsProblems(this.settings.remote)) {
                    this.log.warn(`Copy to the SFTP server: ${problem}`);
                }
            }

            await this.subscribeStatesAsync('cameras.*.record');
            await this.subscribeStatesAsync('cameras.*.snapshot');
            await this.subscribeStatesAsync('cameras.*.timelapse');
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

    /** @returns {import('./lib/types').Timers} Timers of the adapter, cleared at the stop */
    _ownTimers() {
        return {
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: handle => this.clearTimeout(handle),
        };
    }

    /**
     * Starts the timelapses of the settings.
     *
     * @param {string} outputDir - Media folder
     */
    async _startTimelapses(outputDir) {
        const { jobs, problems } = normalizeTimelapses(this.config.timelapses, this.cameras);
        for (const problem of problems) {
            this.log.warn(problem);
        }
        if (!this.recorder) {
            return;
        }
        for (const job of jobs) {
            if (job.notify) {
                this._checkNames(`Timelapse of camera "${job.camera.name}"`, job.recipients);
            }
            const timelapse = new Timelapse({
                camera: job.camera,
                job,
                settings: this.settings,
                outputDir,
                recorder: this.recorder,
                timers: this._ownTimers(),
                onVideo: result => void this._deliverTimelapse(job.camera, result, job.notify ? job.recipients : false),
                onWarning: message => this.log.warn(message),
                onProgress: ({ frames, nextVideo }) => {
                    void this.setState(`cameras.${job.camera.id}.timelapseFrames`, frames, true);
                    void this.setState(`cameras.${job.camera.id}.timelapseNextVideo`, nextVideo, true);
                },
            });
            this.timelapses.set(job.camera.id, timelapse);
            await timelapse.start();
            const at = `${String(job.at.hour).padStart(2, '0')}:${String(job.at.minute).padStart(2, '0')}`;
            this.log.info(
                `Timelapse of camera "${job.camera.name}": a picture every ${job.interval} min, video daily at ${at}`,
            );
        }
    }

    /**
     * Builds the timelapse video of a camera now.
     *
     * @param {Camera} camera - Camera
     * @returns {Promise<RecordResult | null>} The video, null when fewer than two frames wait
     */
    async _buildTimelapse(camera) {
        const timelapse = this.timelapses.get(camera.id);
        if (!timelapse) {
            this.log.warn(`Camera "${camera.name}" has no timelapse in the settings`);
            return null;
        }
        try {
            const result = await timelapse.build();
            if (!result) {
                this.log.info(`Timelapse of camera "${camera.name}": fewer than two frames, no video`);
            }
            return result;
        } catch (err) {
            this.log.warn(`Timelapse of camera "${camera.name}": ${maskSecrets(err.message)}`);
            throw err;
        }
    }

    /**
     * Publishes a finished timelapse video: states, log, SFTP copy and notifications.
     *
     * @param {Camera} camera - Camera
     * @param {RecordResult} result - Video
     * @param {false | string[]} notify - false, or the names to send to (empty = all)
     */
    async _deliverTimelapse(camera, result, notify) {
        const base = `cameras.${camera.id}`;
        await this.setState(`${base}.lastTimelapse`, result.file, true);
        await this.setState(`${base}.lastTimelapseTime`, Date.now(), true);
        this.log.info(
            `Camera "${camera.name}": timelapse saved, ${result.duration} s, ${formatSize(result.size)}: ${path.basename(result.file)}`,
        );
        this._queueRemote(camera, result);
        if (notify) {
            await this._notify(result, notify);
        }
    }

    /**
     * Copies a finished file to the SFTP server in the background, one copy after the other.
     *
     * @param {Camera} camera - Camera
     * @param {RecordResult} result - Finished file
     */
    _queueRemote(camera, result) {
        const remote = this.settings.remote;
        if (!remote.enabled) {
            return;
        }
        this.remoteQueue = this.remoteQueue
            .then(async () => {
                const copy = await copyFileToRemote(
                    connectSsh2,
                    remote,
                    { file: result.file, cameraId: camera.id },
                    this.log,
                    this._ownTimers(),
                );
                if (copy.ok) {
                    await this.setState('info.lastRemoteCopy', Date.now(), true);
                    await this.setState('info.remoteError', '', true);
                    this.log.debug(`Copied ${path.basename(result.file)} to the SFTP server: ${copy.remoteFile}`);
                } else {
                    const message = maskSecrets(copy.message, [remote.password]);
                    await this.setState('info.remoteError', message, true);
                    this.log.warn(`Could not copy ${path.basename(result.file)} to the SFTP server: ${message}`);
                }
            })
            .catch(() => undefined);
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
            endkey: `${this.namespace}.cameras.\u9999`,
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
     * @param {false | string[]} notify - false, or the names to send the result to (empty = all)
     * @returns {Promise<RecordResult>} The finished file
     */
    async _take(camera, kind, request, notify) {
        if (!this.recorder) {
            throw new Error('ffmpeg is not available, see the log of the adapter start');
        }
        const base = `cameras.${camera.id}`;
        const began = Date.now();
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
            const real = result.realDuration === null ? '' : `, file ${result.realDuration.toFixed(1)} s`;
            const extended = result.extended ? `, extended ${result.extended}x` : '';
            const what =
                kind === 'record'
                    ? `${result.format} clip (${seconds}${real}${extended})`
                    : `snapshot${result.fromBuffer ? ' from the pre-recording' : ''}`;
            const took = ((Date.now() - began) / 1000).toFixed(1);
            this.log.info(
                `Camera "${camera.name}": ${what} saved, ${formatSize(result.size)} in ${took} s: ${path.basename(result.file)}`,
            );
            this.log.debug(`Camera "${camera.name}": full path ${result.file}`);
            await this._copyToFiles(camera, result);
            this._queueRemote(camera, result);
            if (notify) {
                await this._notify(result, notify);
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
    /**
     * Sends the file to the Telegram instance of the Notifications tab and the further targets,
     * or only to the named ones.
     *
     * @param {RecordResult} result - Finished file
     * @param {string[]} [names] - Names to send to, empty = all
     */
    async _notify(result, names = []) {
        const caption = formatCaption(
            this.settings.telegramCaption,
            result.camera,
            new Date(result.time),
            this.dateFormat,
        ).trim();
        const choice = selectTargets(names, this.settings.notifyTargets);
        const jobs = choice.telegram ? [this._sendTelegram(result)] : [];
        for (const target of choice.targets) {
            jobs.push(this._sendToTarget(target, result, caption));
        }
        await Promise.all(jobs);
    }

    /**
     * @param {import('./lib/types').NotifyTarget} target - Target
     * @param {RecordResult} result - Finished file
     * @param {string} caption - Caption
     */
    async _sendToTarget(target, result, caption) {
        const name = path.basename(result.file);
        try {
            const { command, message } = buildMessage(target, result, caption);
            await this.sendToAsync(target.instance, command, message, { timeout: 60_000 });
            this.log.info(`Sent ${name} to ${target.instance}${target.recipient ? ` (${target.recipient})` : ''}`);
        } catch (err) {
            this.log.warn(`Could not send ${name} to ${target.instance}: ${err.message}`);
        }
    }

    /**
     * Warns about recipient names that match no target.
     *
     * @param {string} where - Trigger or timelapse, for the message
     * @param {string[]} names - Names it sends to
     */
    _checkNames(where, names) {
        const { unknown } = selectTargets(names, this.settings.notifyTargets);
        if (unknown.length) {
            this.log.warn(
                `${where}: no notification target is named ${unknown.map(n => `"${n}"`).join(', ')} (tab Notifications, column Name)`,
            );
        }
    }

    /** Names problems of the notification targets once at the start. */
    _checkTargets() {
        for (const target of this.settings.notifyTargets) {
            const adapter = target.instance.split('.')[0];
            if (target.template) {
                try {
                    JSON.parse(target.template);
                } catch (err) {
                    this.log.warn(
                        `Notification target ${target.instance}: the template is no valid JSON (${err.message})`,
                    );
                }
            } else if (!KNOWN.includes(adapter)) {
                this.log.warn(
                    `Notification target ${target.instance}: no built-in message format for "${adapter}", enter a template`,
                );
            }
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
     * @returns {Promise<boolean>} False when the condition of the trigger was not met
     */
    async _fire(trigger) {
        const { camera } = trigger;
        if (trigger.onlyIf) {
            const { stateId, op, value } = trigger.onlyIf;
            const current = await this.getForeignStateAsync(stateId).catch(() => null);
            if (!conditionMet(op, value, current?.val)) {
                this.log.info(
                    `Trigger ${trigger.stateId}: skipped, ${stateId} is ${JSON.stringify(current?.val ?? null)} (needs ${opSymbol(op)} ${value})`,
                );
                return false;
            }
        }
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
            jobs.push(this._take(camera, 'snapshot', {}, trigger.telegram ? trigger.recipients : false));
        }
        if (trigger.action !== 'snapshot') {
            jobs.push(this._take(camera, 'record', request, trigger.telegram ? trigger.recipients : false));
        }
        await Promise.allSettled(jobs);
        return true;
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
                const decision = triggerDecision(trigger, state, this.lastFired.get(trigger) || 0, now);
                if (decision === 'fire') {
                    const before = this.lastFired.get(trigger) || 0;
                    this.lastFired.set(trigger, now);
                    // a trigger whose condition is not met starts no cooldown
                    void this._fire(trigger).then(fired => {
                        if (fired === false && this.lastFired.get(trigger) === now) {
                            this.lastFired.set(trigger, before);
                        }
                    });
                } else if (decision === 'cooldown' && trigger.action !== 'snapshot') {
                    // a further ring while the clip is still being cut makes the clip longer
                    const seconds = trigger.duration || this.settings.recordDuration;
                    if (this.recorder?.extend(trigger.camera.id, seconds)) {
                        this.log.info(`Trigger ${trigger.stateId}: clip of camera "${trigger.camera.name}" extended`);
                    }
                }
            }
        }
        if (!state || state.ack || !id.startsWith(`${this.namespace}.cameras.`)) {
            return;
        }
        const match = /\.cameras\.([^.]+)\.(record|snapshot|timelapse)$/.exec(id);
        const camera = match && this.cameras.find(c => c.id === match[1]);
        if (!match || !camera || !state.val) {
            return;
        }
        void this.setState(id, false, true);
        if (match[2] === 'timelapse') {
            void this._buildTimelapse(camera).catch(() => undefined);
            return;
        }
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
            if (obj.command === 'testRemote') {
                // an empty password field means the saved password, but only for the saved server
                const form = obj.message && typeof obj.message === 'object' ? obj.message : {};
                const settings = settingsForConnectionTest(form, this.settings.remote);
                const result = await testRemoteConnection(connectSsh2, settings, this._ownTimers());
                const hint =
                    result.ok && !settings.hostKey && result.fingerprint
                        ? ` Fingerprint of the server (enter it to trust only this server): ${result.fingerprint}`
                        : '';
                reply(result.ok ? { result: `OK: ${result.message}.${hint}` } : { error: result.message });
                return;
            }
            if (obj.command === 'timelapse') {
                const name = typeof obj.message === 'string' ? obj.message : obj.message?.camera;
                const camera = findCamera(this.cameras, name);
                if (!camera) {
                    reply({ error: `Unknown camera "${name ?? ''}"` });
                    return;
                }
                const result = await this._buildTimelapse(camera);
                reply(result || { error: 'fewer than two frames are waiting' });
                return;
            }
            if (obj.command !== 'record' && obj.command !== 'snapshot') {
                reply({ error: `Unknown command "${obj.command}"` });
                return;
            }
            /** @type {RecordRequest & {camera?: string, telegram?: boolean, recipients?: string | string[]}} */
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
            const notify = message.telegram === true ? parseNames(message.recipients) : false;
            const result = await this._take(camera, obj.command, message, notify);
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
            for (const timelapse of this.timelapses.values()) {
                timelapse.stop();
            }
            this.timelapses.clear();
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
