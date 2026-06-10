// Web implementation of AudioPlayer - falls back to browser audio
// For Capacitor native app, the native plugin is used instead

const AudioPlayerWeb = {
  async play({ url, title, artist, thumb }) {
    console.log('[AudioPlayer] Web play:', url);
    // In web browser, this falls back to YouTube IFrame
    // The native implementation handles background audio
    return { success: true };
  },
  
  async pause() {
    console.log('[AudioPlayer] Web pause');
    return { success: true };
  },
  
  async resume() {
    console.log('[AudioPlayer] Web resume');
    return { success: true };
  },
  
  async stop() {
    console.log('[AudioPlayer] Web stop');
    return { success: true };
  },
  
  async isPlaying() {
    return { isPlaying: false };
  }
};

module.exports = AudioPlayerWeb;