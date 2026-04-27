const database = require("./database");

const expiryStore = new Map();

// ── Active sweep config ───────────────────────────────────────────────────────
// Mirrors Redis's probabilistic expiry strategy:
// Every SWEEP_INTERVAL_MS, sample up to SAMPLE_SIZE random keys.
// If more than RESWEEP_THRESHOLD fraction were expired, sweep again
// immediately (via setImmediate) to handle expiry bursts without blocking.
const SWEEP_INTERVAL_MS  = 100;
const SAMPLE_SIZE        = 20;
const RESWEEP_THRESHOLD  = 0.25;  // resweep if >25% of sample expired

function setExpiry(key, ttl) {
    expiryStore.set(key, Date.now() + ttl * 1000);
}

function isExpired(key) {
    if (!expiryStore.has(key)) return false;
    if (Date.now() > expiryStore.get(key)) {
        expiryStore.delete(key);
        database.deleteKey(key);
        return true;
    }
    return false;
}

function clearExpiry() {
    expiryStore.clear();
}

/** Remove the expiry entry for a single key (called by DEL). */
function clearEntryExpiry(key) {
    expiryStore.delete(key);
}

/**
 * Start the active expiry sweep interval.
 * Without this, keys with TTLs that are never read stay in memory forever
 * (lazy-only expiry). This sweep proactively frees them in the background.
 *
 * Returns the interval handle — pass it to clearInterval() on shutdown.
 *
 * @example
 * const sweepHandle = startExpirySweep();
 * // … on shutdown:
 * clearInterval(sweepHandle);
 */
function startExpirySweep() {
    function sweep() {
        if (expiryStore.size === 0) return;

        // Draw a random sample using a partial Fisher-Yates shuffle
        const keys    = [...expiryStore.keys()];
        const n       = Math.min(SAMPLE_SIZE, keys.length);

        for (let i = 0; i < n; i++) {
            const j    = i + Math.floor(Math.random() * (keys.length - i));
            const tmp  = keys[i]; keys[i] = keys[j]; keys[j] = tmp;
        }

        let expiredCount = 0;
        for (let i = 0; i < n; i++) {
            if (isExpired(keys[i])) expiredCount++;
        }

        // If the sample was heavily expired, keep sweeping this tick
        if (n > 0 && expiredCount / n > RESWEEP_THRESHOLD) {
            setImmediate(sweep);
        }
    }

    const handle = setInterval(sweep, SWEEP_INTERVAL_MS);
    handle.unref(); // don't prevent the process from exiting naturally
    return handle;
}

module.exports = { setExpiry, isExpired, clearExpiry, clearEntryExpiry, startExpirySweep };
