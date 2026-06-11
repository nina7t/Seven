// Capacitor Audio Player Plugin with built-in YouTube extraction
// Extracts audio URLs directly on device using Invidious API

const { registerPlugin } = require('@capacitor/core');

const AudioPlayer = registerPlugin('AudioPlayer', {
  web: () => require('./AudioPlayerPluginImpl'),
});

module.exports = AudioPlayer;