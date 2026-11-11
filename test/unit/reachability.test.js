'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { probeTarget, isReachable } = require('../../lib/reachability');

describe('reachability of a camera', () => {
    it('takes host and port from the camera URL, with the default port of the scheme', () => {
        assert.deepEqual(probeTarget('rtsp://192.168.1.20/mpeg/media.amp'), { host: '192.168.1.20', port: 554 });
        assert.deepEqual(probeTarget('rtsp://cam.local:8554/live'), { host: 'cam.local', port: 8554 });
        assert.deepEqual(probeTarget('rtsps://cam'), { host: 'cam', port: 322 });
        assert.deepEqual(probeTarget('http://u:p@10.0.0.5/video.mjpg'), { host: '10.0.0.5', port: 80 });
        assert.deepEqual(probeTarget('rtsp://[fe80::1]:554/x'), { host: 'fe80::1', port: 554 });
        // a local file or an unknown scheme without port is not checked
        assert.equal(probeTarget('C:/videos/test.mp4'), null);
        assert.equal(probeTarget('udp://127.0.0.1'), null);
        assert.deepEqual(probeTarget('udp://127.0.0.1:5000'), { host: '127.0.0.1', port: 5000 });
    });

    it('is true while something listens on the port and false when nothing does', async () => {
        const server = net.createServer(socket => socket.destroy());
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
        const port = /** @type {net.AddressInfo} */ (server.address()).port;
        try {
            assert.equal(await isReachable({ host: '127.0.0.1', port }, 2000), true);
        } finally {
            await new Promise(resolve => server.close(() => resolve(undefined)));
        }
        assert.equal(await isReachable({ host: '127.0.0.1', port }, 2000), false);
    });

    it('is false when the connection does not come in time', async () => {
        /** @type {any} */
        const silent = () => {
            const socket = new net.Socket();
            const original = socket.setTimeout.bind(socket);
            socket.setTimeout = (ms, cb) => original(1, cb);
            return socket;
        };
        assert.equal(await isReachable({ host: '127.0.0.1', port: 9 }, 50, silent), false);
    });
});
