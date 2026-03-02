const channels = new Map();

/**
 * Subscribe a socket to a channel
 */
function subscribe(channel, socket) {
    if (!channels.has(channel)) {
        channels.set(channel, new Set());
    }

    const subscribers = channels.get(channel);
    subscribers.add(socket);

    // Send proper RESP subscribe acknowledgement
    const response =
        `*3\r\n` +
        `$9\r\nsubscribe\r\n` +
        `$${channel.length}\r\n${channel}\r\n` +
        `:${subscribers.size}\r\n`;

    socket.write(response);
}


/**
 * Publish message to channel
 * Returns number of subscribers message was delivered to
 */
function publish(channel, message) {
    if (!channels.has(channel)) {
        return 0;
    }

    const subscribers = channels.get(channel);

    const payload =
        `*3\r\n` +
        `$7\r\nmessage\r\n` +
        `$${channel.length}\r\n${channel}\r\n` +
        `$${message.length}\r\n${message}\r\n`;

    let delivered = 0;

    for (const socket of subscribers) {
        if (!socket.destroyed) {
            socket.write(payload);
            delivered++;
        }
    }

    return delivered;
}


/**
 * Remove socket from all channels
 */
function unsubscribe(socket) {
    for (const [channel, subscribers] of channels.entries()) {
        subscribers.delete(socket);

        if (subscribers.size === 0) {
            channels.delete(channel);
        }
    }
}

module.exports = {
    subscribe,
    publish,
    unsubscribe
};
