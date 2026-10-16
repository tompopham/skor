// Sound (v2 3.3): the gong at the end of a countdown and the short tone at the end of a timeout, made
// with Web Audio. There is no sound file. Every function here does nothing, and throws nothing, when the
// browser has no audio, when it has refused to start it, or when nobody has tapped yet: an iPhone plays
// nothing until a tap has unlocked sound, and its ring/silent switch silences a page, so the banner on
// the screen is the signal that counts and the sound is only a help.

let context = null;

// Called on the first tap of the scoring screen (and again on later ones, which cost nothing once the
// sound is running): makes the audio context, and asks it to run if the browser has it waiting.
export function unlockSound() {
  try {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof Context !== 'function') return;
    context ??= new Context();
    if (context.state !== 'running') Promise.resolve(context.resume?.()).catch(() => {});
  } catch {
    // No sound on this device; the screen still says everything.
  }
}

// One tone: it comes in over a hundredth of a second (so there is no click) and dies away over `length`.
function partial(ctx, { hz, length, level, at }) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(hz, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(level, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.05);
}

// Plays only while the sound is running: a tone scheduled on a context still waiting for its first tap
// would sound later, out of place, when it was let go.
function play(tones) {
  try {
    if (context === null || context.state !== 'running') return;
    const at = context.currentTime;
    for (const tone of tones) partial(context, { ...tone, at });
  } catch {
    // No sound this time.
  }
}

// A low gong: a note with two overtones that are not whole multiples of it, as a bell has.
export function gong() {
  play([{ hz: 196, length: 3, level: 0.5 }, { hz: 196 * 2.76, length: 1.8, level: 0.25 }, { hz: 196 * 5.4, length: 0.9, level: 0.12 }]);
}

// A short, high tone: the end of a timeout.
export function beep() {
  play([{ hz: 880, length: 0.4, level: 0.4 }]);
}
