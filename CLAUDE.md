# Sicamore World

An interactive web experience that simulates decoding cassette tape audio from an Atari 800XL computer. Users hold a physical device playing FSK-encoded audio up to their microphone, and the browser decodes the signal — revealing images across 8 sequential "transmissions."

## Project Structure

```
index.html            — Splash screen; invisible portal links to thurn-and-taxis.html
thurn-and-taxis.html  — Password gate with coordinate-based hints
waste.html            — Main decoder interface ("Press Play" to start listening)
thurn.js              — Password validation and coordinate hint logic
decoder.js            — Core engine: microphone input, FSK decoding, image render, audio playback
main.css              — Shared styles (splash + decoder)
thurn.css             — Password screen styles
images/               — Pixel art assets (splash, icon, decoder overlay)
```

## Tech Stack

- Vanilla JS (ES6+), no frameworks
- Web Audio API — `AnalyserNode` (leader detection), `ScriptProcessorNode` (bit detection), `OscillatorNode` / `GainNode` (audio playback)
- `getUserMedia` — microphone access
- Canvas API — 320×192 image rendering at 2× display scale (640×384 canvas), supports portrait rotation
- File API — WAV file upload path for offline testing

## User Flow

`index.html` → `thurn-and-taxis.html` (password gate) → `waste.html` (decoder)

Passwords are hardcoded in `thurn.js` alongside coordinate hints (e.g. "kirsch" → `1.1.20`). The decoder runs 8 transmissions in sequence; after the last one, a CRT fuzz animation plays before redirecting back to `index.html`.

---

## Current State (as of 2026-06-17)

### What works
- WAV file upload path (`wav-test` input in `waste.html`): full end-to-end image decode and render confirmed
- Leader detection: reliable at any reasonable volume
- Goertzel frequency discrimination: confirmed 3–10× p0/p1 ratio at adequate volume
- Image rendering: 1-bit row-by-row reveal, landscape and portrait (90° CW) modes
- Generator (`~/Downloads/fsk_test_generator-2.html`): image upload → 1-bit conversion → WAV download

### What's on hold
- **POKEY audio soundtrack**: infrastructure exists (`startAudioLoop`, `parseAudioInstructions`, `TRANSMISSION_TIMINGS`) but not triggered by any path. Putting on hold until image decode is reliable acoustically.

### Current acoustic challenge
- Acoustic path (phone speaker → MacBook mic) requires HIGH volume — Goertzel p0/p1 values need to be in the 20–100+ range. At low volume (p0 = 3–12), signal sits at the noise gate threshold and framing fails consistently.
- UART framing (stop bits) is the main failure mode: stop bit window misaligns at low SNR, producing framing errors that cascade until signal is abandoned.

---

## Protocol — Current Implementation

### Stream format (decoder.js)
No packet headers. After the leader, the stream is:

```
[orientation: 1 byte][pixels: 7680 bytes] = 7681 bytes total
```

- Orientation: `0` = landscape (320×192), `1` = portrait (rendered 90° CW as 192×320)
- Pixels: 320×192, 1-bit row-major, MSB = leftmost pixel per byte
- Still uses UART framing (start + 8 data bits + stop = 10 bits/byte)
- Duration at 300 baud: ~256 seconds (~4.3 min)

### Proposed next step — direct per-pixel encoding (no UART)

Drop UART framing entirely. Each 147-sample bit period = one pixel directly:
- `2400 Hz` = background pixel (0)
- `3000 Hz` = ink pixel (1)
- 320×192 = 61,440 bit periods → 204 seconds (~3.4 min), saving ~50s
- No start/stop bits, no framing errors
- Sync problem: without per-byte start bits, bit clock must be locked once at the start and held. Proposed: short alternating sync preamble after the leader to lock the clock, then raw pixel stream.
- Tradeoff: one missed bit period = all subsequent pixels shifted. Acceptable for a controlled installation.

---

## How the Decoder Works (`decoder.js`)

### 1. Leader Detection

- Listens for a 3000 Hz leader tone via FFT (`AnalyserNode`, FFT size 2048)
- Confirms after 3 continuous seconds; allows 0.5s dropout grace
- Bit detection starts 4.2s after confirmation (leader total = 7s)

### 2. Bit Detection — Goertzel + Start-Bit Hunting

Hybrid zero-crossing hunt + Goertzel power comparison per bit window:

- **Hunting mode**: watches for a zero-crossing gap > `ZERO_CROSS_THRESHOLD` (8 samples), indicating a 2400 Hz space half-period (9.19 samples) — the falling edge of a start bit. `prevCrossingPos` is reset on every hunting transition to prevent stale anchoring.
- **In-byte mode**: accumulates raw samples into `windowSamples`. Every 147 samples, evaluate:
  - `p1 = goertzelPower(window, 3000)`, `p0 = goertzelPower(window, 2400)`
  - `bit = p1 > p0 ? 1 : 0`
  - If window length < BIT_SAMPLES/4 (stale anchor guard), discard and resync
- 10-bit UART frames: `0` (start) + 8 data bits LSB-first + `1` (stop)
- Framing errors > 20 consecutive → signal lost
- Bandpass filter (2683 Hz, Q=4.47) upstream of the processor

**Why 2400/3000 Hz at 300 baud**: At 147 samples/bit, 2400 Hz = exactly 8.0 cycles and 3000 Hz = exactly 10.0 cycles per window — both integers, giving zero Goertzel cross-leakage. Both frequencies confirmed strong from phone speaker.

**Why not 600 baud**: Tested and failed acoustically. At 74 samples/bit, Goertzel power drops ~4× (power scales with N²). 300 baud is the only baud rate where these frequencies give integer cycles at 44100 Hz.

### 3. Image Rendering

1-bit pixels drawn row-by-row via `setTimeout` for animated reveal. Ink: `#1a1a1a`, background: `#D2C5A0`. Portrait mode rotates 90° CW using canvas coordinate transform.

### 4. Audio Playback (on hold)

POKEY chip emulation exists — `parseAudioInstructions`, `startAudioLoop` — but not currently triggered. Will be wired up once image decode is reliable.

---

## Local Development

The project uses VS Code Live Server on port **5501** (configured in `.vscode/settings.json`). No build step.

**WAV generator**: `~/Downloads/fsk_test_generator-2.html`
- Upload any image → scales to 320×192, adjustable threshold, orientation selector
- Generates WAV: 7-second leader + orientation flag byte + 7680 image bytes
- Upload via the `wav-test` file input in `waste.html` to test decode pipeline

Constants in the generator must stay in sync with `decoder.js`.

---

## Frequency History

All pairs tested acoustically (iPhone speaker → MacBook mic):

| Pair | Outcome |
|------|---------|
| 1200 / 2400 Hz (KCS) | 1200 Hz completely absent — phone speaker can't produce it |
| 2400 / 4000 Hz | 4000 Hz absent / inaudible at mic |
| 5327 / 3995 Hz (original Atari) | 3995 Hz too weak; partial decoding only |
| **2400 / 3000 Hz (current)** | Both strong; confirmed working at high volume |

---

## Key Constants

```js
SAMPLE_RATE = 44100;
BAUD_RATE = 300;            // 300 baud — 147 samples/bit
BIT_SAMPLES = 147;          // Math.round(SAMPLE_RATE / BAUD_RATE)
LEADER_FREQ = 3000;         // Hz — mark / continuous during leader
FREQ_ONE = 3000;            // Hz — ink pixel / mark bit (10.0 cycles per 147-sample window)
FREQ_ZERO = 2400;           // Hz — background pixel / space bit (8.0 cycles per window)
ZERO_CROSS_THRESHOLD = 8;   // samples — between 7.35 (3000 Hz half-period) and 9.19 (2400 Hz)
SIGNAL_THRESHOLD = 0.05;    // amplitude noise gate
IMAGE_BYTES = 7680;         // 320 × 192 / 8
STREAM_BYTES = 7681;        // orientation flag + image bytes
IMG_WIDTH = 320;
IMG_HEIGHT = 192;
DISPLAY_SCALE = 2;          // canvas is 640×384 (landscape) or 384×640 (portrait)
```
