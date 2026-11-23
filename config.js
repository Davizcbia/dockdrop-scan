// Deployment settings for the scanner page.
// SIGNAL_URL: the signalling relay (worker/, a Cloudflare Worker). Empty: the page still scans and shows what it read,
// but cannot pair (useful to test the camera and the decoder). ?signal=<url> overrides it (local tests).
export const SIGNAL_URL = 'wss://dockdrop-signal.dockdrop-signal.workers.dev';
