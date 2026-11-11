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
 * @property {{prebufferEnabled: boolean}} settings - Settings
 * @property {string} storageId - Meta object of the file storage, empty = no copies
 * @property {string} dateFormat - System date format
 * @property {Promise<unknown>} ready - Resolves when the start of the adapter is done
 * @property {(id: string) => Promise<ioBroker.State | null | undefined>} getStateAsync - Own state
 * @property {(id: string, file: string) => Promise<boolean>} fileExistsAsync - File in the storage
 * @property {(camera: Camera, kind: 'record' | 'snapshot', request: object, notify: string[]) => Promise<RecordResult>} _take - Records or takes a snapshot; notify = names of the profiles, empty = none
 */

/** A red dot for the indicator "Recording". */
const REC_ICON = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="#d32f2f"/></svg>',
).toString('base64')}`;

/**
 * Status of a camera that counts as reachable (no pre-recording: the last recording worked).
 *
 * @type {Record<string, 'connected' | 'disconnected'>}
 */
const STATUS_CONNECTION = { idle: 'connected', recording: 'connected', snapshot: 'connected', error: 'disconnected' };
/**
 * With pre-recording the camera is online while the buffer runs.
 *
 * @type {Record<string, 'connected' | 'disconnected'>}
 */
const PREBUFFER_CONNECTION = {
    running: 'connected',
    starting: 'disconnected',
    restarting: 'disconnected',
    off: 'disconnected',
};

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
        /** @type {DeviceInfo} */
        const info = {
            id: camera.id,
            identifier: `cameras.${camera.id}`,
            name: camera.name,
            status: {
                connection: buffered
                    ? { stateId: `${base}.prebuffer`, mapping: PREBUFFER_CONNECTION }
                    : { stateId: `${base}.status`, mapping: STATUS_CONNECTION },
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
                {
                    id: 'record',
                    title: DM_TEXTS.recordNow,
                    description: DM_TEXTS.recordNowHint,
                    variant: 'outlined',
                    timeout: 180_000,
                    handler: (/** @type {string} */ id, /** @type {ActionContext} */ ctx) =>
                        this.take(id, 'record', ctx),
                },
                {
                    id: 'snapshot',
                    title: DM_TEXTS.snapshot,
                    description: DM_TEXTS.snapshotHint,
                    variant: 'outlined',
                    timeout: 60_000,
                    handler: (/** @type {string} */ id, /** @type {ActionContext} */ ctx) =>
                        this.take(id, 'snapshot', ctx),
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

module.exports = { CameraDeviceManagement, STATUS_CONNECTION, PREBUFFER_CONNECTION };
