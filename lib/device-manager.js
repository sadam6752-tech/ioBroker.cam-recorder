'use strict';

const path = require('node:path');
const { DeviceManagement } = require('@iobroker/dm-utils');
const { DM_TEXTS, fillText } = require('./dm-texts');
const { formatCaption } = require('./triggers');

/**
 * @typedef {import('./types').Camera} Camera
 * @typedef {import('./types').RecordResult} RecordResult
 * @typedef {import('@iobroker/dm-utils').ActionContext} ActionContext
 * @typedef {import('@iobroker/dm-utils').DeviceInfo<string>} DeviceInfo
 * @typedef {import('@iobroker/dm-utils').DeviceRefreshResponse<string>} DeviceRefreshResponse
 */

/**
 * What the Device Manager needs of the adapter: the cameras, a few settings, its states and
 * the same function that the buttons `cameras.<camera>.record` and `.snapshot` use.
 *
 * @typedef {object} CameraHost
 * @property {string} namespace - e.g. `cam-recorder.0`
 * @property {Camera[]} cameras - Active cameras
 * @property {{prebufferEnabled: boolean, profiles: {name: string}[], agentInstance: string}} settings - Settings
 * @property {string} storageId - Meta object of the file storage, empty = no copies
 * @property {string} dateFormat - System date format
 * @property {Promise<unknown>} ready - Resolves when the start of the adapter is done
 * @property {(id: string) => Promise<ioBroker.State | null | undefined>} getStateAsync - Own state
 * @property {(id: string, file: string) => Promise<boolean>} fileExistsAsync - File in the storage
 * @property {(camera: Camera, kind: 'record' | 'snapshot', request: object, notify: string[]) => Promise<RecordResult>} _take - Records or takes a snapshot; notify = names of the profiles, empty = none
 * @property {(camera: Camera, values: Record<string, unknown>) => Promise<string[]>} _setSchedule - Writes and applies the schedule, answers its problems
 */

/** Full width in every breakpoint of a form. */
const FULL = { xs: 12, sm: 12, md: 12, lg: 12, xl: 12 };
/** Half width from the breakpoint sm on. */
const HALF = { xs: 12, sm: 6, md: 6, lg: 6, xl: 6 };

/** A red dot for the indicator "Recording". */
const REC_ICON = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="#d32f2f"/></svg>',
).toString('base64')}`;

/**
 * Online or offline: the state `reachable`, written by the check of the camera on the network.
 *
 * @type {Record<string, 'connected' | 'disconnected'>}
 */
const REACHABLE_CONNECTION = { true: 'connected', false: 'disconnected' };

/**
 * One card per configured camera in the Device Manager (tab Devices of the admin): status,
 * time of the last clip and snapshot, the last snapshot as picture, and the actions
 * "Record now" and "Snapshot". The configuration stays in the settings of the instance.
 */
class CameraDeviceManagement extends DeviceManagement {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter - The adapter instance (a {@link CameraHost})
     */
    constructor(adapter) {
        super(adapter);
        /** @type {CameraHost} */
        this.host = /** @type {CameraHost} */ (/** @type {unknown} */ (adapter));
    }

    /**
     * @param {{addDevice: (device: DeviceInfo) => void, setTotalDevices: (count: number) => void}} context - Load context
     */
    async loadDevices(context) {
        await this.host.ready;
        const cameras = this.host.cameras;
        context.setTotalDevices(cameras.length);
        for (const camera of cameras) {
            context.addDevice(await this.cameraInfo(camera));
        }
    }

    /**
     * @param {string} deviceId - Camera id
     * @returns {Promise<DeviceInfo>} The card of the camera
     */
    async getDeviceInfo(deviceId) {
        const camera = this.host.cameras.find(c => c.id === deviceId);
        if (!camera) {
            throw new Error(`Unknown camera "${deviceId}"`);
        }
        return this.cameraInfo(camera);
    }

    /**
     * @param {Camera} camera - Camera
     * @returns {Promise<DeviceInfo>} The card: name, status, indicators, last times, picture and actions
     */
    async cameraInfo(camera) {
        const base = `${this.host.namespace}.cameras.${camera.id}`;
        const buffered = this.host.settings.prebufferEnabled && camera.prebuffer > 0;
        const [videoTime, snapshotTime] = await Promise.all([
            this._number(`cameras.${camera.id}.lastVideoTime`),
            this._number(`cameras.${camera.id}.lastSnapshotTime`),
        ]);
        const lines = [
            fillText(DM_TEXTS.lastClip, { time: this._time(videoTime) }),
            fillText(DM_TEXTS.lastSnapshot, { time: this._time(snapshotTime) }),
        ];
        if (buffered) {
            lines.push(fillText(DM_TEXTS.preRecording, { seconds: String(camera.prebuffer) }));
        }
        // an offline camera cannot record: its buttons are greyed out (an action without handler is disabled)
        const offline = await this._offline(camera);
        const next = await this._number(`cameras.${camera.id}.schedule.next`);
        if (next) {
            lines.push(fillText(DM_TEXTS.scheduleNext, { time: this._time(next) }));
        }
        /** @type {DeviceInfo} */
        const info = {
            id: camera.id,
            identifier: `cameras.${camera.id}`,
            name: camera.name,
            status: {
                connection: { stateId: `${base}.reachable`, mapping: REACHABLE_CONNECTION },
                warning: { stateId: `${base}.lastError` },
            },
            indicators: [
                {
                    id: 'activity',
                    value: {
                        stateId: `${base}.status`,
                        mapping: { idle: '', error: '', recording: 'recording', snapshot: 'snapshot' },
                    },
                    icon: REC_ICON,
                    levels: [
                        { value: 'recording', color: 'error', text: DM_TEXTS.recording },
                        { value: 'snapshot', color: 'info', text: DM_TEXTS.takingSnapshot },
                    ],
                },
            ],
            customInfo: {
                id: camera.id,
                schema: {
                    type: 'panel',
                    items: Object.fromEntries(
                        lines.map((text, i) => [
                            `_line${i}`,
                            { type: 'staticText', text, newLine: i > 0, xs: 12, sm: 12, md: 12, lg: 12, xl: 12 },
                        ]),
                    ),
                },
            },
            actions: [
                // two columns on the card: the admin wraps the buttons, so the order makes the rows
                // [Record video] [Interval] / [Snapshot] [Schedule]
                {
                    id: 'record',
                    title: DM_TEXTS.recordNow,
                    description: offline ? DM_TEXTS.offlineHint : DM_TEXTS.recordNowHint,
                    variant: 'outlined',
                    timeout: 180_000,
                    handler: offline
                        ? undefined
                        : (/** @type {string} */ id, /** @type {ActionContext} */ ctx) => this.take(id, 'record', ctx),
                },
                {
                    id: 'interval',
                    title: DM_TEXTS.interval,
                    description: DM_TEXTS.intervalHint,
                    variant: 'outlined',
                    handler: (/** @type {string} */ id, /** @type {ActionContext} */ ctx) =>
                        this.editSchedule(id, 'interval', ctx),
                },
                {
                    id: 'snapshot',
                    title: DM_TEXTS.snapshot,
                    description: offline ? DM_TEXTS.offlineHint : DM_TEXTS.snapshotHint,
                    variant: 'outlined',
                    timeout: 60_000,
                    handler: offline
                        ? undefined
                        : (/** @type {string} */ id, /** @type {ActionContext} */ ctx) =>
                              this.take(id, 'snapshot', ctx),
                },
                {
                    id: 'plan',
                    title: DM_TEXTS.plan,
                    description: DM_TEXTS.planHint,
                    variant: 'outlined',
                    handler: (/** @type {string} */ id, /** @type {ActionContext} */ ctx) =>
                        this.editSchedule(id, 'plan', ctx),
                },
            ],
        };
        const picture = await this._picture(camera, snapshotTime);
        if (picture) {
            info.icon = picture;
        }
        return info;
    }

    /**
     * Action "Record now" or "Snapshot": the same path as the buttons of the camera states,
     * without notifications. Shows the file name or the error, then updates the card.
     *
     * @param {string} deviceId - Camera id
     * @param {'record' | 'snapshot'} kind - What to take
     * @param {ActionContext} context - Dialogs of the Device Manager
     * @returns {Promise<DeviceRefreshResponse>} Refresh of the card
     */
    async take(deviceId, kind, context) {
        const camera = this.host.cameras.find(c => c.id === deviceId);
        if (!camera) {
            await context.showMessage(fillText(DM_TEXTS.failed, { error: `unknown camera "${deviceId}"` }));
            return { refresh: 'devices' };
        }
        if (await this._offline(camera)) {
            // a card loaded while the camera was online: the admin does not update the buttons by itself
            await context.showMessage(DM_TEXTS.offlineHint);
            return { update: await this.cameraInfo(camera) };
        }
        const progress = await context.openProgress(kind === 'record' ? DM_TEXTS.recording : DM_TEXTS.takingSnapshot, {
            indeterminate: true,
            label: camera.name,
        });
        /** @type {ioBroker.Translated} */
        let message;
        try {
            const result = await this.host._take(camera, kind, {}, []);
            message = fillText(DM_TEXTS.saved, { file: path.basename(result.file) });
        } catch (err) {
            message = fillText(DM_TEXTS.failed, { error: err instanceof Error ? err.message : String(err) });
        } finally {
            await progress.close();
        }
        await context.showMessage(message);
        return { update: await this.cameraInfo(camera) };
    }

    /**
     * Actions "Interval" and "Schedule": a form with the schedule states of the camera; both forms share the switch,
     * the action and the profiles. Saving writes the states, as a script or an agent would.
     *
     * @param {string} deviceId - Camera id
     * @param {'interval' | 'plan'} kind - Which form
     * @param {ActionContext} context - Dialogs of the Device Manager
     * @returns {Promise<DeviceRefreshResponse>} Refresh of the card
     */
    async editSchedule(deviceId, kind, context) {
        const camera = this.host.cameras.find(c => c.id === deviceId);
        if (!camera) {
            await context.showMessage(fillText(DM_TEXTS.failed, { error: `unknown camera "${deviceId}"` }));
            return { refresh: 'devices' };
        }
        const base = `cameras.${camera.id}.schedule`;
        /** @type {import("@iobroker/dm-utils").JsonFormData} */
        const data = {};
        for (const key of [
            'enabled',
            'interval',
            'from',
            'to',
            'cron',
            'action',
            'profiles',
            'aiOnly',
            'onlyIfState',
            'onlyIfOp',
            'onlyIfValue',
        ]) {
            data[key] = (await this.host.getStateAsync(`${base}.${key}`).catch(() => null))?.val ?? '';
        }
        data.enabled = data.enabled === true;
        data.interval = Number(data.interval) || 0;
        data.action = data.action || 'snapshot';
        data.aiOnly = data.aiOnly === true;
        data.onlyIfOp = data.onlyIfOp || 'eq';
        const agent = Boolean(this.host.settings.agentInstance);
        data.profiles = String(data.profiles)
            .split(',')
            .map(n => n.trim())
            .filter(Boolean);
        const names = this.host.settings.profiles.map(p => p.name);
        /** @type {Record<string, object>} */
        const fields =
            kind === 'interval'
                ? {
                      interval: {
                          type: 'number',
                          label: DM_TEXTS.everyMinutes,
                          min: 0,
                          max: 1440,
                          newLine: true,
                          ...FULL,
                      },
                      from: { type: 'text', label: DM_TEXTS.from, placeholder: '22:00', newLine: true, ...HALF },
                      to: { type: 'text', label: DM_TEXTS.to, placeholder: '06:00', ...HALF },
                  }
                : { cron: { type: 'cron', label: DM_TEXTS.cronLabel, newLine: true, ...FULL } };
        const schema = {
            type: 'panel',
            items: {
                enabled: { type: 'checkbox', label: DM_TEXTS.active, ...FULL },
                ...fields,
                action: {
                    type: 'select',
                    label: DM_TEXTS.action,
                    newLine: true,
                    options: [
                        { label: DM_TEXTS.snapshot, value: 'snapshot' },
                        { label: DM_TEXTS.clip, value: 'record' },
                        { label: DM_TEXTS.both, value: 'both' },
                    ],
                    ...HALF,
                },
                profiles: {
                    type: 'select',
                    label: DM_TEXTS.profiles,
                    multiple: true,
                    noTranslation: true,
                    options: [...new Set([...names, ...data.profiles])].map(name => ({ label: name, value: name })),
                    ...HALF,
                },
                aiOnly: {
                    type: 'checkbox',
                    label: DM_TEXTS.aiOnly,
                    help: agent ? DM_TEXTS.aiOnlyHelp : DM_TEXTS.aiOnlyNoAgent,
                    disabled: agent ? 'false' : 'true',
                    newLine: true,
                    ...FULL,
                },
                onlyIfState: { type: 'objectId', label: DM_TEXTS.onlyIf, newLine: true, ...HALF },
                onlyIfOp: {
                    type: 'select',
                    label: ' ',
                    noTranslation: true,
                    options: [
                        { label: '=', value: 'eq' },
                        { label: '≠', value: 'ne' },
                        { label: '>', value: 'gt' },
                        { label: '<', value: 'lt' },
                    ],
                    xs: 4,
                    sm: 2,
                    md: 2,
                    lg: 2,
                    xl: 2,
                },
                onlyIfValue: { type: 'text', label: DM_TEXTS.value, xs: 8, sm: 4, md: 4, lg: 4, xl: 4 },
                _shared: { type: 'staticText', text: DM_TEXTS.sharedHint, newLine: true, ...FULL },
            },
        };
        const result = await context.showForm(
            /** @type {import("@iobroker/dm-utils").JsonFormSchema} */ (/** @type {unknown} */ (schema)),
            {
                data,
                title: fillText(kind === 'interval' ? DM_TEXTS.interval : DM_TEXTS.plan, {}),
                maxWidth: 'sm',
            },
        );
        if (!result) {
            return { refresh: 'none' };
        }
        /** @type {Record<string, unknown>} */
        const values = {
            enabled: result.enabled === true,
            aiOnly: agent && result.aiOnly === true,
            onlyIfState: String(result.onlyIfState ?? '').trim(),
            onlyIfOp: result.onlyIfOp || 'eq',
            onlyIfValue: String(result.onlyIfValue ?? '').trim(),
            action: result.action,
            profiles: (Array.isArray(result.profiles) ? result.profiles : [result.profiles ?? ''])
                .map(n => String(n).trim())
                .filter(Boolean)
                .join(', '),
        };
        if (kind === 'interval') {
            values.interval = Number(result.interval) || 0;
            values.from = String(result.from ?? '').trim();
            values.to = String(result.to ?? '').trim();
        } else {
            values.cron = String(result.cron ?? '').trim();
        }
        const problems = await this.host._setSchedule(camera, values);
        const next = await this._number(`${base}.next`);
        await context.showMessage(
            problems.length
                ? fillText(DM_TEXTS.scheduleProblems, { problems: problems.join('; ') })
                : fillText(DM_TEXTS.scheduleSaved, { next: next ? this._time(next) : DM_TEXTS.scheduleOff }),
        );
        return { update: await this.cameraInfo(camera) };
    }

    /**
     * @param {Camera} camera - Camera
     * @returns {Promise<boolean>} True when the online check found the camera offline (unknown counts as online)
     */
    async _offline(camera) {
        try {
            return (await this.host.getStateAsync(`cameras.${camera.id}.reachable`))?.val === false;
        } catch {
            return false;
        }
    }

    /**
     * @param {string} id - Own state id
     * @returns {Promise<number>} Its number value, 0 when missing
     */
    async _number(id) {
        try {
            const state = await this.host.getStateAsync(id);
            return typeof state?.val === 'number' ? state.val : 0;
        } catch {
            return 0;
        }
    }

    /**
     * @param {number} ms - Time stamp, 0 = never
     * @returns {string | ioBroker.Translated} Date and time in the system date format, or "none yet"
     */
    _time(ms) {
        return ms ? formatCaption('{date} {time}', '', new Date(ms), this.host.dateFormat) : DM_TEXTS.never;
    }

    /**
     * The newest snapshot from the ioBroker file storage, as URL of the admin. Only when the
     * copy into the file storage is on and a snapshot exists; the time stamp makes the browser
     * load a new picture.
     *
     * @param {Camera} camera - Camera
     * @param {number} snapshotTime - Time of the last snapshot
     * @returns {Promise<string>} URL or empty
     */
    async _picture(camera, snapshotTime) {
        const storage = this.host.storageId;
        if (!storage) {
            return '';
        }
        try {
            if (!(await this.host.fileExistsAsync(storage, `${camera.id}.jpg`))) {
                return '';
            }
        } catch {
            return '';
        }
        return `files/${storage}/${camera.id}.jpg?t=${snapshotTime}`;
    }
}

module.exports = { CameraDeviceManagement, REACHABLE_CONNECTION };
