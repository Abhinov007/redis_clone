const fs = require("fs");

const AOF_FILE = "database.aof";

/**
 * Append a single command string to the AOF file.
 * Fire-and-forget — errors are logged but not thrown.
 *
 * @param {string} command - The raw command string, e.g. "SET foo bar"
 *
 * @example
 * appendToAOF("SET session:1 active");
 */
function appendToAOF(command) {
    fs.appendFile(AOF_FILE, command + "\n", (err) => {
        if (err) console.error("[AOF] Failed to append:", err);
    });
}

/**
 * Replay all commands in the AOF file at startup to rebuild in-memory state.
 *
 * Uses dependency injection for the replay function so this module stays
 * decoupled from commands/command.js (prevents a circular require cycle):
 *
 *   aof.js  →  command.js  →  aof.js   ← circular ✗
 *
 * Instead, server.js wires them together:
 *
 *   loadAOF(require("./commands/command").replayCommand)
 *
 * @param {Function} replayFn - `replayCommand(args)` from commands/command.js
 *
 * @example
 * // In server.js startup:
 * const { replayCommand } = require("./commands/command");
 * loadAOF(replayCommand);
 */
function loadAOF(replayFn) {
    if (!fs.existsSync(AOF_FILE)) return;

    const raw   = fs.readFileSync(AOF_FILE, "utf-8");
    const lines = raw.split(/\r?\n/);
    console.log(`[AOF] Replaying ${lines.length} lines from ${AOF_FILE}…`);

    for (const line of lines) {
        const commandString = line.trim();
        if (!commandString) continue;

        // Simple whitespace split — good enough because AOF is written by us
        // using args.join(" ") and values never contain internal spaces from
        // inline commands (RESP binary-safe paths use multi-bulk encoding).
        const args = commandString.split(" ");
        if (!args[0]) continue;

        try {
            replayFn(args);
        } catch (err) {
            console.error(`[AOF] Error replaying command "${commandString}":`, err.message);
            // Continue with the next line — one bad entry shouldn't stop the replay
        }
    }

    console.log("[AOF] Replay complete.");
}

module.exports = { appendToAOF, loadAOF };
