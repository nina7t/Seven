// Capacitor Audio Player Plugin - JS Interface
// This bridges to the native AudioService for background playback

const { registerPlugin } = require('@capacitor/core');

const AudioPlayer = registerPlugin('AudioPlayer', {
  web: () => import('./AudioPlayerPluginImpl'),
});

module.exports = AudioPlayer;