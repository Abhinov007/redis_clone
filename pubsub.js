const channels = {}; // Stores channel subscribers

function subscribe(channel, socket) {
    if (!channels[channel]) {
        channels[channel] = new Set();
    }
    channels[channel].add(socket);
}

function publish(channel, message) {
    if (channels[channel]) {
        channels[channel].forEach(socket => {
            socket.write(`+${message}\r\n`);
        });
    }
}

function unsubscribe(socket) {
    for (const channel in channels) {
        channels[channel].delete(socket);
        if (channels[channel].size === 0) {
            delete channels[channel];
        }
    }
}

module.exports = { subscribe, publish, unsubscribe };
