// Deployment settings for the scanner page.
// SIGNAL_URL: the signalling relay (worker/, a Cloudflare Worker), e.g. 'wss://dockdrop-signal.<account>.workers.dev'.
// Empty: the page still scans and shows what it read, but cannot pair (useful to test the camera and the decoder).
export const SIGNAL_URL = '';
