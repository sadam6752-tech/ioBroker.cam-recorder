// Shared types of the adapter modules (JSDoc in the .js files refers to them with import('./types').X)

/** A camera row of the settings after normalization */
export interface Camera {
    /** Object id part */
    id: string;
    /** Name as entered */
    name: string;
    /** URL without login */
    url: string;
    /** User name */
    username: string;
    /** Password as stored (may be encrypted) or, inside the recorder, in plain text */
    password: string;
    /** RTSP transport */
    transport: 'tcp' | 'udp';
    /** Decode snapshots from key frames only */
    keyframesOnly: boolean;
    /** Seconds kept before an event (pre-recording), 0 = off */
    prebuffer: number;
}

/** A trigger row of the settings after normalization */
export interface Trigger {
    /** Foreign state that starts the action */
    stateId: string;
    /** Camera to use */
    camera: Camera;
    /** What to take */
    action: 'record' | 'snapshot' | 'both';
    /** Clip length in seconds, 0 = default */
    duration: number;
    /** Clip format, empty = default */
    format: '' | 'mp4' | 'gif';
    /** When the trigger fires */
    condition: 'truthy' | 'any';
    /** Seconds in which a further event is ignored */
    cooldown: number;
    /** Send the result to Telegram and the further notification targets */
    telegram: boolean;
    /** Only fire when this state has the given value; null = always */
    onlyIf: { stateId: string; op: 'eq' | 'ne' | 'gt' | 'lt'; value: string } | null;
}

/** A further notification target besides the Telegram tab */
export interface NotifyTarget {
    /** Instance, e.g. `email.0` */
    instance: string;
    /** Recipient in the form the adapter expects (address, user, phone, channel), empty = its default */
    recipient: string;
    /** JSON message with placeholders for adapters without a known format, empty = built-in format */
    template: string;
}

/** Adapter settings with limits applied */
export interface Settings {
    /** Default clip length in seconds */
    recordDuration: number;
    /** Default clip format */
    recordFormat: 'mp4' | 'gif';
    /** Re-encode the mp4 or copy the camera stream */
    videoMode: 'transcode' | 'copy';
    /** 0 = original */
    videoWidth: number;
    /** 0 = original */
    videoFps: number;
    /** Width of a gif in pixels */
    gifWidth: number;
    /** Frame rate of a gif */
    gifFps: number;
    /** 0 = original */
    snapshotWidth: number;
    /** Seconds until an unreachable camera counts as failed */
    rtspTimeout: number;
    /** ffmpeg processes at the same time */
    maxParallel: number;
    /** Files kept per camera and kind, 0 = no limit */
    keepFiles: number;
    /** Days a file is kept, 0 = no limit */
    maxAgeDays: number;
    /** Copy the newest result into the ioBroker file storage */
    copyToFiles: boolean;
    /** e.g. `telegram.0`, empty = off */
    telegramInstance: string;
    /** Empty = all users */
    telegramUser: string;
    /** Caption with `{camera}`, `{date}` and `{time}` */
    telegramCaption: string;
    /** Main switch of the pre-recording, off by default */
    prebufferEnabled: boolean;
    /** Folder of the segments, empty = temp folder of the system */
    prebufferDir: string;
    /** Longest clip in seconds when further events extend it */
    maxClipLength: number;
    /** Further notification targets */
    notifyTargets: NotifyTarget[];
}

/** What a clip is made of */
export interface ClipOptions {
    /** Seconds */
    duration: number;
    /** Output format */
    format: 'mp4' | 'gif';
    /** mp4 only: re-encode or copy the camera stream */
    mode: 'transcode' | 'copy';
    /** Width in pixels, 0 = original */
    width: number;
    /** Frames per second, 0 = original */
    fps: number;
}

/** Options of a record request (sendTo, trigger) */
export interface RecordRequest {
    /** Seconds after the event, default from the settings */
    duration?: number;
    /** Seconds before the event (pre-recording), default: the setting of the camera */
    pre?: number;
    /** `mp4` or `gif`, default from the settings */
    format?: string;
    /** Width in pixels */
    width?: number;
    /** Frames per second */
    fps?: number;
}

/** A finished file */
export interface RecordResult {
    /** Full path */
    file: string;
    /** Bytes */
    size: number;
    /** File type */
    format: 'mp4' | 'gif' | 'jpg';
    /** Seconds, 0 for a snapshot (with pre-recording: before plus after the event) */
    duration: number;
    /** Seconds before the event that the clip contains */
    pre: number;
    /** How often a further event extended the clip */
    extended: number;
    /** True when the file was cut from the pre-recording instead of a new connection */
    fromBuffer: boolean;
    /** Length of the written file in seconds as ffmpeg reads it, null if unknown */
    realDuration: number | null;
    /** Camera name */
    camera: string;
    /** Time of the first picture in ms (with pre-recording: before the event) */
    time: number;
}

/** Timer functions of the adapter, so a pending timer ends with the adapter */
export interface Timers {
    /** `adapter.setTimeout` */
    setTimeout: (cb: () => void, ms: number) => any;
    /** `adapter.clearTimeout` */
    clearTimeout: (handle: any) => void;
}

/** Limits of one ffmpeg run */
export interface RunOptions {
    /** The process is killed after this time */
    timeoutMs: number;
    /** Values to hide in error messages */
    secrets?: Array<string | undefined>;
}
