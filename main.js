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
const { supportsDisplayMatrix } = require('./lib/orientation');
const { CHECK_INTERVAL_MS, probeTarget, isReachable } = require('./lib/reachability');
const { triggerDecision, formatCaption } = require('./lib/triggers');
const { maskSecrets } = require('./lib/mask');
const { NAMES } = require('./lib/names');
const { conditionMet, opSymbol } = require('./lib/conditions');
const { KNOWN, parseNames, buildMessage } = require('./lib/notify');
const {
    pickProfiles,
    planNotify,
    profileMessage,
    needsMigration,
    migrateNotify,
    profileProblems,
    silentTriggerHint,
} = require('./lib/profiles');
const { Timelapse } = require('./lib/timelapse');
const {
    INSTRUCTIONS,
    needsAgent,
    eventConditions,
    matchedStates,
    buildQuestion,
    parseVerdict,
    matchesOf,
    matchText,
} = require('./lib/agent-check');
const { HELP } = require('./lib/help');
const { CameraDeviceManagement } = require('./lib/device-manager');
const { Pulses } = require('./lib/pulse');
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
 * @typedef {import('./lib/types').NotifyProfile} NotifyProfile
 * @typedef {import('./lib/agent-check').Verdict} Verdict
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
    { id: 'description', common: { type: 'string', role: 'text', read: true, write: false, def: '' } },
    { id: 'reachable', common: { type: 'boolean', role: 'indicator.reachable', read: true, write: false } },
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
        /** @type {ioBroker.Interval | undefined} check of the cameras on the network */
        this.reachTimer = undefined;
        this.reachRunning = false;
        /** copies to the SFTP server run one after the other */
        this.remoteQueue = Promise.resolve();
        this.settings = normalizeSettings({});
        this.storageId = '';
        this.dateFormat = 'DD.MM.YYYY';
        this.systemLanguage = 'en';
        /** @type {(value?: unknown) => void} */
        this._resolveReady = () => undefined;
        this.ready = new Promise(resolve => {
            this._resolveReady = resolve;
        });

        // one card per camera in the Device Manager; it answers the messages starting with "dm:"
        this.deviceManagement = new CameraDeviceManagement(this);
        /** states of the tab AI check that are true for a while after a match */
        this.pulses = new Pulses({
            timers: { setTimeout: (cb, ms) => this.setTimeout(cb, ms), clearTimeout: h => this.clearTimeout(h) },
            set: (id, value) => void this.setState(id, value, true),
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
            if (await this._migrateProfiles()) {
                return;
            }

            this.settings = normalizeSettings(this.config);
            const cams = normalizeCameras(this.config.cameras);
            this.cameras = cams.cameras;
            const trig = normalizeTriggers(this.config.triggers, this.cameras);
            this._checkProfiles();
            const feedsStates = !!this.settings.agentInstance && this.settings.agentChecks.some(c => c.state);
            for (const trigger of trig.triggers) {
                this._checkNames(`Trigger ${trigger.stateId}`, trigger.profiles);
                const hint = silentTriggerHint(trigger, feedsStates);
                if (hint) {
                    this.log.info(hint);
                }
            }
            for (const problem of [...cams.problems, ...trig.problems, ...profileProblems(this.config.profiles)]) {
                this.log.warn(problem);
            }
            for (const trigger of trig.triggers) {
                const list = this.triggers.get(trigger.stateId) || [];
                list.push(trigger);
                this.triggers.set(trigger.stateId, list);
            }

            await this._createObjects();
            await this._readDateFormat();

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
            this.settings.displayMatrix = supportsDisplayMatrix(version);
            const turned = this.cameras.filter(c => c.orientation && c.orientation !== '0').map(c => c.name);
            if (!this.settings.displayMatrix && this.settings.videoMode === 'copy' && turned.length) {
                this.log.info(
                    `ffmpeg before 6.0 cannot mark a copied mp4 as turned: the clips of ${turned.join(', ')} are re-encoded`,
                );
            }

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
     * Turns the notification settings of the versions before 0.5 (Telegram instance, further
     * targets, columns Notify and Send to) into profiles of the tab Send, once. The js-controller
     * restarts the instance after the write.
     *
     * @returns {Promise<boolean>} True when the settings were written and the instance restarts
     */
    async _migrateProfiles() {
        const id = `system.adapter.${this.namespace}`;
        try {
            const obj = await this.getForeignObjectAsync(id);
            const native = obj?.native;
            if (!native || !needsMigration(native)) {
                return false;
            }
            const changes = migrateNotify(native);
            Object.assign(this.config, changes);
            await this.extendForeignObjectAsync(id, { native: changes });
            this.log.info(
                `Notifications are now profiles of the tab Send (${changes.profiles.length} profile(s): ${changes.profiles
                    .map(p => p.name)
                    .join(', ')}). The adapter restarts once.`,
            );
            return true;
        } catch (err) {
            this.log.warn(`Could not turn the notification settings into profiles: ${maskSecrets(err.message)}`);
            if (needsMigration(this.config)) {
                // run with the profiles in memory, the next start tries the write again
                Object.assign(this.config, migrateNotify(this.config));
            }
            return false;
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
    /**
     * Checks every camera on the network: a TCP connection to the host and port of its URL,
     * without login and without ffmpeg. The result goes into `cameras.<camera>.reachable`.
     */
    async _checkReachable() {
        if (this.reachRunning) {
            return;
        }
        this.reachRunning = true;
        try {
            await Promise.all(
                this.cameras.map(async camera => {
                    const target = probeTarget(camera.url);
                    if (!target) {
                        return;
                    }
                    const ok = await isReachable(target, this.settings.rtspTimeout * 1000);
                    const id = `cameras.${camera.id}.reachable`;
                    const before = await this.getStateAsync(id);
                    if (before?.val !== ok) {
                        if (before && before.val !== null) {
                            const how = ok ? 'is reachable again' : `is not reachable (${target.host}:${target.port})`;
                            this.log[ok ? 'info' : 'warn'](`Camera "${camera.name}" ${how}`);
                        }
                        await this.setState(id, ok, true);
                    }
                }),
            );
        } catch (err) {
            this.log.debug(`Check of the cameras failed: ${err.message}`);
        } finally {
            this.reachRunning = false;
        }
    }

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
            this._checkNames(`Timelapse of camera "${job.camera.name}"`, job.profiles);
            const timelapse = new Timelapse({
                camera: job.camera,
                job,
                settings: this.settings,
                outputDir,
                recorder: this.recorder,
                timers: this._ownTimers(),
                onVideo: result => void this._deliverTimelapse(job.camera, result, job.profiles),
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
     * @param {string[]} notify - Names of the profiles to send to, empty = none
     */
    async _deliverTimelapse(camera, result, notify) {
        const base = `cameras.${camera.id}`;
        await this.setState(`${base}.lastTimelapse`, result.file, true);
        await this.setState(`${base}.lastTimelapseTime`, Date.now(), true);
        this.log.info(
            `Camera "${camera.name}": timelapse saved, ${result.duration} s, ${formatSize(result.size)}: ${path.basename(result.file)}`,
        );
        this._queueRemote(camera, result);
        await this._notify(result, notify);
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
                    { file: result.file, cameraId: camera.id, time: result.time },
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
            const language = config?.common?.language;
            if (typeof language === 'string' && language) {
                this.systemLanguage = language;
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
            await this._createAiStates(camera);
        }
        // online or offline on the cards: a TCP connection to the camera, at once and every minute
        await this._checkReachable();
        this.reachTimer = this.setInterval(() => void this._checkReachable(), CHECK_INTERVAL_MS);
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
     * The states of the tab AI check of one camera, `cameras.<camera>.ai.<criterion>`: one per row with State, false
     * at the start; states of rows that are gone or have State off are removed.
     *
     * @param {Camera} camera - Camera
     */
    async _createAiStates(camera) {
        const channel = `cameras.${camera.id}.ai`;
        const checks = this.settings.agentChecks.filter(c => c.state);
        const wanted = new Set(checks.map(c => `${this.namespace}.${channel}.${c.id}`));
        const existing = await this.getObjectViewAsync('system', 'state', {
            startkey: `${this.namespace}.${channel}.`,
            endkey: `${this.namespace}.${channel}.\u9999`,
        });
        for (const row of existing.rows) {
            if (!wanted.has(row.id)) {
                await this.delForeignObjectAsync(row.id);
                this.log.info(`Removed the state ${row.id} of a criterion that is gone (tab AI check)`);
            }
        }
        if (!checks.length) {
            await this.delObjectAsync(channel).catch(() => undefined);
            return;
        }
        await this.extendObjectAsync(channel, { type: 'channel', common: { name: NAMES.ai }, native: {} });
        for (const check of checks) {
            await this.extendObjectAsync(`${channel}.${check.id}`, {
                type: 'state',
                common: {
                    name: check.criterion,
                    desc: `true for ${check.hold} s after pi-agent saw this in a snapshot of a trigger`,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                    def: false,
                },
                native: { criterion: check.criterion, hold: check.hold },
            });
            await this.setState(`${channel}.${check.id}`, false, true);
        }
    }

    /**
     * @param {Camera} camera - Camera
     * @param {'record' | 'snapshot'} kind - What to take
     * @param {RecordRequest} request - Options
     * @param {string[]} notify - Names of the profiles to send the result to, empty = none
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
            await this._notify(result, notify);
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
     * Sends the file through the named profiles of the tab Send. A profile sends only the kinds
     * of files of its column Attachment; a profile "Text only" sends the caption without file.
     *
     * @param {RecordResult} result - Finished file
     * @param {string[]} names - Names of the profiles, empty = none
     */
    async _notify(result, names) {
        const time = new Date(result.time);
        await Promise.all(
            planNotify(names, this.settings.profiles, result).map(send =>
                this._sendProfile(send.profile, send.result, result.camera, time),
            ),
        );
    }

    /**
     * After the check of the AI agent: each profile whose criteria the picture meets gets an extra message with what
     * was found. The files of the event do not wait for it and go out anyway.
     *
     * @param {Camera} camera - Camera
     * @param {NotifyProfile[]} profiles - Profiles of the event
     * @param {Promise<Verdict | null> | null} verdict - Check of the AI agent, null = none
     */
    async _sendMatches(camera, profiles, verdict) {
        const checked = verdict ? await verdict : null;
        if (!checked) {
            return;
        }
        await Promise.all(
            profiles.map(async profile => {
                const matched = matchesOf(profile, checked);
                if (!matched.length) {
                    return;
                }
                const text = matchText(camera.name, matched, checked.description);
                try {
                    const { command, message } = buildMessage(profile, null, text, camera.name);
                    await this.sendToAsync(profile.instance, command, message, { timeout: 60_000 });
                    this.log.info(
                        `Camera "${camera.name}": match for profile "${profile.name}": ${matched.join(', ')}`,
                    );
                } catch (err) {
                    this.log.warn(
                        `Could not send the match of "${camera.name}" through profile "${profile.name}": ${err.message}`,
                    );
                }
            }),
        );
    }

    /**
     * Asks the AI agent (ioBroker.pi-agent) about a snapshot of the event: what it shows and which criteria of the
     * profiles it meets. A failed check only costs the extra messages, the files go out anyway.
     *
     * @param {Camera} camera - Camera
     * @param {NotifyProfile[]} profiles - Profiles of the event
     * @param {boolean} [trigger] - The event is a trigger: the criteria with a state are asked too, also without a profile
     * @returns {Promise<Verdict | null> | null} The verdict, null when there is nothing to ask
     */
    _checkPicture(camera, profiles, trigger = false) {
        const agent = this.settings.agentInstance;
        const conditions = eventConditions(profiles, this.settings.agentChecks, trigger);
        if (!agent || !conditions.length) {
            return null;
        }
        const check = async () => {
            const began = Date.now();
            try {
                if (!this.recorder) {
                    throw new Error('ffmpeg is not available');
                }
                const snapshot = await this.recorder.snapshot(camera, {});
                const data = (await fs.readFile(snapshot.file)).toString('base64');
                const answer = /** @type {{answer?: unknown, error?: unknown} | undefined} */ (
                    await this.sendToAsync(
                        agent,
                        'ask',
                        {
                            text: buildQuestion(
                                camera.name,
                                conditions,
                                this.systemLanguage,
                                formatCaption('{date} {time}', '', new Date(snapshot.time), this.dateFormat),
                            ),
                            images: [{ data, mimeType: 'image/jpeg' }],
                            conversation: `cam-recorder-${camera.id}`,
                            instructions: INSTRUCTIONS,
                        },
                        { timeout: this.settings.agentTimeout * 1000 },
                    )
                );
                if (answer?.error) {
                    throw new Error(String(answer.error));
                }
                const verdict = parseVerdict(answer?.answer, conditions);
                const took = ((Date.now() - began) / 1000).toFixed(1);
                const decided = conditions
                    .filter(c => verdict.matches.has(c))
                    .map(c => `"${c}" ${verdict.matches.get(c) ? 'yes' : 'no'}`);
                this.log.info(
                    `Camera "${camera.name}": ${agent} in ${took} s: ${verdict.description || '(no description)'}${decided.length ? ` (${decided.join(', ')})` : ''}`,
                );
                if (verdict.error) {
                    this.log.warn(`Camera "${camera.name}": ${agent}: ${verdict.error}, no match for it`);
                }
                await this.setState(`cameras.${camera.id}.description`, verdict.description, true);
                for (const check of trigger ? matchedStates(this.settings.agentChecks, verdict) : []) {
                    this.pulses.fire(`cameras.${camera.id}.ai.${check.id}`, check.hold * 1000);
                }
                return verdict;
            } catch (err) {
                this.log.warn(
                    `Camera "${camera.name}": the check by ${agent} failed (${maskSecrets(err.message, [camera.username])}), no match messages`,
                );
                return null;
            }
        };
        return check();
    }

    /**
     * @param {NotifyProfile} profile - Profile
     * @param {RecordResult | null} result - Finished file, null for a text without file
     * @param {string} camera - Camera name
     * @param {Date} time - Time of the event
     */
    async _sendProfile(profile, result, camera, time) {
        const what = result ? path.basename(result.file) : `the text of "${camera}"`;
        try {
            const { command, message } = profileMessage(profile, result, camera, time, this.dateFormat);
            await this.sendToAsync(profile.instance, command, message, { timeout: 60_000 });
            this.log.info(
                `Sent ${what} through profile "${profile.name}" to ${profile.instance}${profile.recipient ? ` (${profile.recipient})` : ''}`,
            );
        } catch (err) {
            this.log.warn(
                `Could not send ${what} through profile "${profile.name}" to ${profile.instance}: ${err.message}`,
            );
        }
    }

    /**
     * Warns about profile names that match no profile.
     *
     * @param {string} where - Trigger or timelapse, for the message
     * @param {string[]} names - Names it sends to
     */
    _checkNames(where, names) {
        const { unknown } = pickProfiles(names, this.settings.profiles);
        if (unknown.length) {
            this.log.warn(
                `${where}: no active profile is named ${unknown.map(n => `"${n}"`).join(', ')} (tab Send, column Name)`,
            );
        }
    }

    /** Names problems of the profiles once at the start. */
    _checkProfiles() {
        const needing = this.settings.profiles.filter(needsAgent).map(p => `"${p.name}"`);
        if (needing.length && !this.settings.agentInstance) {
            this.log.warn(
                `Profiles ${needing.join(', ')} have criteria, but no pi-agent instance is chosen (tab AI check): no snapshot is checked`,
            );
        }
        const withState = this.settings.agentChecks.filter(c => c.state).map(c => `"${c.criterion}"`);
        if (withState.length && !this.settings.agentInstance) {
            this.log.warn(
                `Criteria ${withState.join(', ')} have a state, but no pi-agent instance is chosen (tab AI check): the states stay false`,
            );
        }
        for (const check of this.settings.agentChecks) {
            this._checkNames(`AI check "${check.criterion}"`, check.profiles);
        }
        for (const profile of this.settings.profiles) {
            const adapter = profile.instance.split('.')[0];
            if (profile.template) {
                try {
                    JSON.parse(profile.template);
                } catch (err) {
                    this.log.warn(`Profile "${profile.name}": the template is no valid JSON (${err.message})`);
                }
            } else if (!KNOWN.includes(adapter)) {
                this.log.warn(
                    `Profile "${profile.name}": no built-in message format for "${adapter}", enter a template`,
                );
            }
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
        // profiles "Text only" send their text at once, the others get the files when they are ready
        const { chosen } = pickProfiles(trigger.profiles, this.settings.profiles);
        const fileProfiles = chosen.filter(p => p.attach !== 'none').map(p => p.name);
        // one check of the AI agent for the whole event; the files do not wait for it
        const verdict = this._checkPicture(camera, chosen, true);
        /** @type {Promise<unknown>[]} */
        const jobs = chosen
            .filter(p => p.attach === 'none')
            .map(p => this._sendProfile(p, null, camera.name, new Date()));
        if (trigger.action !== 'record') {
            jobs.push(this._take(camera, 'snapshot', {}, fileProfiles));
        }
        if (trigger.action !== 'snapshot') {
            jobs.push(this._take(camera, 'record', request, fileProfiles));
        }
        jobs.push(this._sendMatches(camera, chosen, verdict));
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
        this._take(camera, match[2] === 'record' ? 'record' : 'snapshot', {}, []).catch(() => undefined);
    }

    /**
     * Commands: `record` and `snapshot` with `{camera, duration, format, width, fps, profiles}`
     * (`telegram: true` with `recipients` of the versions before 0.5 still works), `listCameras` and
     * `listProfiles` for the tables of the admin.
     *
     * @param {ioBroker.Message} obj - Message
     */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object' || String(obj.command).startsWith('dm:')) {
            // messages of the Device Manager are answered by this.deviceManagement
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
            if (obj.command === 'help') {
                reply({ help: HELP });
                return;
            }
            if (obj.command === 'listCameras') {
                reply(this.cameras.map(c => ({ value: c.name, label: c.name })));
                return;
            }
            if (obj.command === 'listProfiles') {
                reply(this.settings.profiles.map(p => ({ value: p.name, label: p.name })));
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
            /** @type {RecordRequest & {camera?: string, profiles?: string | string[], telegram?: boolean, recipients?: string | string[]}} */
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
            const names = this._scriptProfiles(message);
            const { chosen } = pickProfiles(names, this.settings.profiles);
            const verdict = this._checkPicture(camera, chosen);
            const [result] = await Promise.all([
                this._take(camera, obj.command, message, names),
                this._sendMatches(camera, chosen, verdict),
            ]);
            const checked = verdict ? await verdict : null;
            reply(checked ? { ...result, description: checked.description } : result);
        } catch (err) {
            reply({ error: err.message });
        }
    }

    /**
     * Profiles a script asks for: `profiles: 'Alex, Father'`, or the way of the versions before
     * 0.5, `telegram: true` with `recipients` (empty = every active profile).
     *
     * @param {{profiles?: unknown, telegram?: unknown, recipients?: unknown}} message - Message of the script
     * @returns {string[]} Names of the profiles, empty = none
     */
    _scriptProfiles(message) {
        if (message.profiles !== undefined) {
            return parseNames(message.profiles);
        }
        if (message.telegram !== true) {
            return [];
        }
        const names = parseNames(message.recipients);
        return names.length ? names : this.settings.profiles.map(p => p.name);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            if (this.reachTimer) {
                this.clearInterval(this.reachTimer);
                this.reachTimer = undefined;
            }
            this.pulses.stop();
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
