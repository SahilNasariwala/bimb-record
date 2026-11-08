// @bimb/record: record the current tab (or a screen) from inside a web page, with the clicks and shortcuts that
// happened during it, lined up to the video's timeline. Everything stays in the browser; nothing is uploaded.

export interface StartOptions {
  /** 'tab': this tab only (click coordinates line up with the video). 'screen': any screen/window the user picks. */
  target?: 'tab' | 'screen';
  /** Mix the microphone into the recording. A refused permission is not an error: see `Recording.micError`. */
  mic?: boolean;
  /** Max capture frame rate (default 60). */
  fps?: number;
  /** Each encoded chunk (about 1 s) as it is produced, e.g. to persist it so a crash loses at most a second. */
  onChunk?: (chunk: Blob, index: number) => void;
  /** Capture ended on its own (the browser's "Stop sharing" button, tab closed). Call stop() to collect the result. */
  onEnded?: () => void;
}

export interface RecordedEvent {
  kind: 'click' | 'move' | 'key';
  /** Milliseconds into the video (pauses already removed). */
  t: number;
  /** CSS px in the page's viewport (0 for keys). */
  x: number;
  y: number;
  button?: number;
  /** For 'key': a shortcut label like "Ctrl+K". Plain typing is never recorded, and nothing from password fields. */
  key?: string;
}

export interface Recording {
  /** The unedited recording, WebM. */
  video: Blob;
  events: RecordedEvent[];
  durationMs: number;
  /** The page's viewport when recording started, to map event x/y onto the video. */
  viewport: { w: number; h: number; dpr: number };
  /** Encoded video size in px. */
  size: { w: number; h: number };
  micError?: string;
}

export interface RecordingController {
  pause(): void;
  resume(): void;
  /** Stops capture and returns the recording. Safe to call more than once. */
  stop(): Promise<Recording>;
}

const now = () => performance.timeOrigin + performance.now();

/** getDisplayMedia options. Tab mode asks Chrome to offer the current tab first. */
export const displayOptions = (target: 'tab' | 'screen', fps = 60) =>
  ({
    audio: true,
    video: { frameRate: { max: fps }, width: { max: 3840 }, height: { max: 2160 } },
    ...(target === 'tab' && { preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' }),
  }) as DisplayMediaStreamOptions;

/** First supported WebM type. */
export const pickMime = (audio: boolean, supported: (t: string) => boolean = t => MediaRecorder.isTypeSupported(t)) =>
  (audio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'])
    .concat('video/webm')
    .find(supported);

/** Epoch event times -> ms into the video. Events before t0 or inside a pause are dropped. */
export function toVideoTime<E extends { t: number }>(events: E[], t0: number, pauses: [number, number][]): E[] {
  const out: E[] = [];
  for (const e of events) {
    if (e.t < t0) continue;
    let off = 0,
      inPause = false;
    for (const [a, b] of pauses) {
      if (e.t >= b) off += b - a;
      else if (e.t >= a) inPause = true;
    }
    if (!inPause) out.push({ ...e, t: e.t - t0 - off });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Shortcut label for a keydown, or undefined when it should not be recorded (plain typing, password fields). */
export function keyLabel(ev: KeyboardEvent, mac: boolean): string | undefined {
  const t = ev.target as { type?: string } | null;
  if (ev.repeat || t?.type === 'password') return;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) return;
  if (!(ev.ctrlKey || ev.metaKey || ev.altKey) && !['Escape', 'Enter', 'Tab'].includes(ev.key)) return;
  // macOS Option composes symbols (Option+Z types "Ω"): name the physical key instead.
  const phys = /^Key[A-Z]$/.test(ev.code) ? ev.code.slice(3) : /^Digit\d$/.test(ev.code) ? ev.code.slice(5) : null;
  const composed = (ev.key.length === 1 && !/[\p{L}\p{N}]/u.test(ev.key)) || ev.key.charCodeAt(0) > 0x7f;
  const k =
    ev.key === ' '
      ? 'Space'
      : ev.altKey && phys && composed
        ? phys
        : ev.key.length === 1
          ? ev.key.toUpperCase()
          : ev.key.replace('Escape', 'Esc');
  return [ev.ctrlKey && 'Ctrl', ev.altKey && (mac ? '⌥' : 'Alt'), ev.shiftKey && (mac ? '⇧' : 'Shift'), ev.metaKey && (mac ? '⌘' : 'Win'), k]
    .filter(Boolean)
    .join(mac ? '' : '+');
}

/** Pointer + shortcut listeners (capture phase). Returns the function that removes them. */
export function listenInput(send: (e: RecordedEvent) => void, target: EventTarget = window): () => void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  let last = 0;
  const on: [string, (e: Event) => void][] = [
    ['pointerdown', e => { const p = e as PointerEvent; send({ kind: 'click', t: now(), x: p.clientX, y: p.clientY, button: p.button }); }],
    ['pointermove', e => {
      const p = e as PointerEvent, t = now();
      if (t - last < 16) return; // ~60 Hz is plenty
      last = t;
      send({ kind: 'move', t, x: p.clientX, y: p.clientY });
    }],
    ['keydown', e => { const key = keyLabel(e as KeyboardEvent, mac); if (key) send({ kind: 'key', t: now(), x: 0, y: 0, key }); }],
  ];
  const opt = { capture: true };
  for (const [n, f] of on) target.addEventListener(n, f, opt);
  return () => on.forEach(([n, f]) => target.removeEventListener(n, f, opt));
}

// Not in TypeScript's DOM lib yet (Chromium only).
declare const MediaStreamTrackProcessor:
  | (new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<{ close(): void }> })
  | undefined;

/** Epoch time of the first video frame delivered at/after `after`, which is the video's t=0. MediaRecorder's `start`
 *  event fires 100-150 ms after that frame, so it can't be used. Without MediaStreamTrackProcessor (Firefox, Safari)
 *  this falls back to `after`. */
async function firstFrameAfter(track: MediaStreamTrack, after: number): Promise<number> {
  if (typeof MediaStreamTrackProcessor === 'undefined') return after;
  const clone = track.clone();
  const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return after;
      const t = now();
      value.close();
      if (t >= after) return t;
    }
  } finally {
    reader.cancel().catch(() => {});
    clone.stop();
  }
}

/** Starts recording. Call it from a user gesture (a click handler): getDisplayMedia requires one. */
export async function startRecording(o: StartOptions = {}): Promise<RecordingController> {
  const target = o.target ?? 'tab';
  const stream = await navigator.mediaDevices.getDisplayMedia(displayOptions(target, o.fps));
  const streams = [stream];
  const stopAll = () => streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  const [video] = stream.getVideoTracks();
  const surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  if (!video || (target === 'tab' && surface && surface !== 'browser')) {
    stopAll();
    throw new Error('Tab recording needs this tab to be shared, not a window or screen.');
  }

  let mic: MediaStream | undefined, micError: string | undefined;
  if (o.mic)
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streams.push(mic);
    } catch (e) {
      micError = e instanceof DOMException ? e.name : String(e); // keep recording without it
    }

  // Page/system audio + mic in one track. Not routed to the speakers: an in-page capture doesn't mute the tab, and
  // playing it back would feed it into its own recording.
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  if (stream.getAudioTracks().length) audio.createMediaStreamSource(stream).connect(mix);
  if (mic) audio.createMediaStreamSource(mic).connect(mix);
  const hasAudio = stream.getAudioTracks().length > 0 || !!mic;
  const { width = 0, height = 0 } = video.getSettings();
  const mimeType = pickMime(hasAudio);
  const rec = new MediaRecorder(new MediaStream([video, ...(hasAudio ? mix.stream.getAudioTracks() : [])]), {
    mimeType,
    videoBitsPerSecond: Math.min(40e6, Math.round((width || 1920) * (height || 1080) * 60 * 0.1)),
    videoKeyFrameIntervalDuration: 1000, // Chrome: a keyframe a second keeps seeking fast
  } as MediaRecorderOptions);

  const viewport = target === 'tab' ? { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } : { w: width, h: height, dpr: 1 };
  const chunks: Blob[] = [],
    raw: RecordedEvent[] = [],
    pauses: [number, number][] = [];
  let pausedAt: number | undefined, stopAt: number | undefined;
  rec.ondataavailable = e => {
    if (!e.data.size) return;
    chunks.push(e.data);
    o.onChunk?.(e.data, chunks.length - 1);
  };
  const off = listenInput(e => raw.push(e));
  video.onended = () => o.onEnded?.();

  const t0p = firstFrameAfter(video, now());
  rec.start(1000);
  const t0 = await t0p;

  let result: Promise<Recording> | undefined;
  return {
    pause() {
      if (rec.state !== 'recording') throw new Error('Not recording');
      rec.pause();
      pausedAt = now();
    },
    resume() {
      if (rec.state !== 'paused' || pausedAt === undefined) throw new Error('Not paused');
      rec.resume();
      pauses.push([pausedAt, now()]);
      pausedAt = undefined;
    },
    stop: () =>
      (result ??= (async () => {
        stopAt = now(); // the video ends when stop is called, not when teardown finishes
        off();
        if (rec.state !== 'inactive') await new Promise(r => ((rec.onstop = r), rec.stop()));
        stopAll();
        await audio.close();
        if (pausedAt !== undefined) pauses.push([pausedAt, stopAt]);
        const paused = pauses.reduce((n, [a, b]) => n + (b - a), 0);
        return {
          video: new Blob(chunks, { type: mimeType ?? 'video/webm' }),
          events: toVideoTime(raw, t0, pauses),
          durationMs: stopAt - t0 - paused,
          viewport,
          size: { w: width, h: height },
          micError,
        };
      })()),
  };
}
