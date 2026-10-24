// The new-order sound of the panels (in-app notifications plan 6b). It is synthesised with the
// Web Audio API: no audio file, so nothing to license, load or allow in the page's CSP, and it is
// under a second. Browsers keep audio suspended until the user has clicked or typed on the page;
// `play` then reports `false`, and the panel shows its "enable sound" control.

type AudioContextClass = new () => AudioContext;

export interface Chime {
  /** Whether the browser lets the page play sound now (false until a click on most browsers). */
  ready(): boolean;
  /** Call from a click or key handler: lets later sounds play. True when sound is now allowed. */
  unlock(): Promise<boolean>;
  /** Plays the chime once; false when the browser does not allow sound yet, or has no audio. */
  play(): Promise<boolean>;
}

/** How long `resume` may take before the browser is taken to be blocking sound. */
const RESUME_WAIT_MILLISECONDS = 250;

/** Two short rising notes (E6 then A6), about half a second, soft enough not to startle. */
const NOTES: readonly { readonly hz: number; readonly at: number }[] = [
  { hz: 1318.5, at: 0 },
  { hz: 1760, at: 0.14 },
];
const NOTE_SECONDS = 0.32;
const PEAK_GAIN = 0.18;

function audioClass(): AudioContextClass | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export function createChime(): Chime {
  let context: AudioContext | null = null;

  function ensure(): AudioContext | null {
    if (context !== null) return context;
    const Audio = audioClass();
    if (Audio === null) return null;
    try {
      context = new Audio();
    } catch {
      return null;
    }
    return context;
  }

  async function resume(audio: AudioContext): Promise<boolean> {
    if (audio.state === 'running') return true;
    // Without a user gesture some browsers leave `resume` pending instead of rejecting it.
    await Promise.race([
      audio.resume().catch(() => undefined),
      new Promise((done) => setTimeout(done, RESUME_WAIT_MILLISECONDS)),
    ]);
    return (audio.state as string) === 'running';
  }

  return {
    ready() {
      return context?.state === 'running';
    },
    async unlock() {
      const audio = ensure();
      return audio === null ? false : resume(audio);
    },
    async play() {
      const audio = ensure();
      if (audio === null || !(await resume(audio))) return false;
      const start = audio.currentTime + 0.01;
      for (const note of NOTES) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = note.hz;
        const at = start + note.at;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_SECONDS);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(at);
        oscillator.stop(at + NOTE_SECONDS + 0.02);
      }
      return true;
    },
  };
}
