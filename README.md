# @bimb/record

Record the current tab (or a screen) from inside your web app, and get back the **unedited video plus every click and
shortcut, already lined up to the video's timeline**. Everything happens in the browser: no upload, no server, no
account.

Built for bug-report widgets, feedback tools, onboarding recorders and anything else that needs "show me what
happened" without sending the user to a separate screen recorder.

```ts
import { startRecording } from '@bimb/record';

button.onclick = async () => {
  // Must run inside a user gesture: getDisplayMedia requires one.
  const ctl = await startRecording({ target: 'tab', mic: true });

  // ...the user reproduces the bug...

  const rec = await ctl.stop();
  rec.video;      // Blob, WebM (VP9/VP8 + Opus)
  rec.events;     // [{ kind: 'click', t: 1840, x: 412, y: 96, button: 0 }, { kind: 'key', t: 2210, key: 'Ctrl+K' }, ...]
  rec.durationMs; // pauses excluded
  rec.viewport;   // { w, h, dpr } to map x/y onto the video
};
```

## Why not just `getDisplayMedia` + `MediaRecorder`?

You can, and for many apps that's enough. This package is the part you'd end up writing next:

- **Events on the video's clock.** `MediaRecorder`'s `start` event fires 100–150 ms after the first frame, so naive
  timestamps drift. `@bimb/record` reads the first frame's real time (`MediaStreamTrackProcessor` where available) and
  maps every event to milliseconds into the video, with paused time removed.
- **Privacy-safe input capture.** Clicks and pointer moves (throttled to ~60 Hz), and keyboard *shortcuts* only
  (modifier combos, Esc, Enter, Tab). Plain typing is never recorded, and nothing from password fields.
- **The tab you meant.** In tab mode Chrome offers the current tab first, and the recording is refused if the user
  shares a window or screen instead, because click coordinates wouldn't match the video.
- **Mic mixing** into one audio track with the page audio, without feeding the page's sound back into itself.
- **Sensible encoding.** Bitrate scaled to the capture size (capped at 40 Mbps), a keyframe every second for fast
  seeking, up to 4K / 60 fps.
- **Crash safety, your way.** `onChunk` hands you each ~1 s chunk as it's encoded, so you can persist it (IndexedDB,
  OPFS, an upload) and lose at most a second if the tab dies.

## API

### `startRecording(options?) => Promise<RecordingController>`

| option    | default | what                                                                                  |
| --------- | ------- | ------------------------------------------------------------------------------------- |
| `target`  | `'tab'` | `'tab'`: this tab only. `'screen'`: any screen or window the user picks.              |
| `mic`     | `false` | Mix in the microphone. If permission is refused, recording continues (`micError`).    |
| `fps`     | `60`    | Max capture frame rate.                                                               |
| `onChunk` |         | `(chunk: Blob, index: number) => void`, called for each encoded chunk.                |
| `onEnded` |         | Capture ended on its own (the browser's "Stop sharing" button). Call `stop()` next.   |

The controller has `pause()`, `resume()` and `stop()`. `stop()` resolves to a `Recording`, and calling it again
returns the same result.

### Helpers

`listenInput(send, target?)`, `toVideoTime(events, t0, pauses)` and `keyLabel(event, isMac)` are exported too, if you
only need the input-tracking part.

## Browser support

Chrome and Edge are fully supported. Firefox and Safari can record (`getDisplayMedia` + `MediaRecorder`), but
`preferCurrentTab` and `MediaStreamTrackProcessor` are Chromium-only, so there the user picks the tab themselves and
event times fall back to the moment recording started. Cross-browser parity is the next milestone.

## Where it comes from

This is the capture layer of [Bimb](https://bimb.dev), a Chrome extension that turns tab recordings into auto-zoomed
demo videos. The editing and auto-zoom engine is not part of this package. See it running at
[bimb.dev/sdk-demo](https://bimb.dev/sdk-demo/).

## License

MIT © Sahil Nasariwala
