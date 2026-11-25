importScripts('./vendor/jsQR.js');

self.onmessage = ({ data: frame }) => {
  const result = self.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
  self.postMessage(result?.data || '');
};
