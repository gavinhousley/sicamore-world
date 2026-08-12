# Sicamore World

An interactive web experience that simulates decoding cassette tape audio from an Atari 800XL computer. Users hold a physical device playing FSK-encoded audio up to their microphone, and the browser decodes the signal — revealing images across 8 sequential "transmissions."

The piece is a ritual: sound becomes image, the way software once loaded from cassette. Vanilla JS + Web Audio API, no frameworks, no build step.

## Project Structure

```
index.html            — Splash screen; invisible portal links to thurn-and-taxis.html
thurn-and-taxis.html  — Password gate with coordinate-based hints
waste.html            — Main decoder interface ("Press Play" to start listening)
thurn.js              — Password validation and coordinate hint logic
decoder.js            — Core engine: mic input, FSK decoding, image render
generator.html        — WAV encoder: upload image → download FSK WAV for playback
main.css              — Shared styles (splash + decoder)
thurn.css             — Password screen styles
images/               — Pixel art assets (splash, icon, decoder overlay)
```

## Tech Stack

- Vanilla JS (ES6+), no frameworks
- Web Audio API — `AnalyserNode` (leader detection), `ScriptProcessorNode` (chirp + bit detection)
- `getUserMedia` — microphone access, all browser voice processing disabled
- Canvas API — 320×192 at 2× display scale (640×384), supports portrait rotation
- File API — WAV upload path for offline testing

## User Flow

`index.html` → `thurn-and-taxis.html` (password gate) → `waste.html` (decoder)

Passwords are hardcoded in `thurn.js` with coordinate hints (e.g. "kirsch" → `1.1.20`). 8 transmissions in sequence; after the last, CRT fuzz animation plays then redirects to `index.html`.

---

## Image Spec

- Resolution: 320×192
- 2-tone: ink `#1a1a1a`, background `#D2C5A0`
- 1-bit row-major, MSB = leftmost pixel per byte
- Orientation (landscape/portrait) transmitted as first byte of stream

---

## Protocol — Current Implementation (sstv-decoder branch)

### Stream format

```
[7s leader: 1800 Hz]
[chirp: 500→4000 Hz sweep, 250ms]
[orientation: 8 raw FSK bits, MSB-first]
[192 rows × (320 pixel bits + 8 checksum bits)]
```

- **No UART framing.** Each bit period = one pixel directly.
- `2400 Hz` = background pixel (off) — 8.0 exact cycles per 147-sample window
- `3000 Hz` = ink pixel (on) — 10.0 exact cycles per 147-sample window
- Row checksum: XOR of 40 groups of 8 pixel bits. Failed row → static/glitch, not abort. After 10 consecutive failed rows, decoder stops and re-enters leader detection.
- Duration: 192 × 328 bits at 300 baud ≈ 210s (~3.5 min)

### Key constants

```js
SAMPLE_RATE      = 44100;
BAUD_RATE        = 300;           // 147 samples/bit
BIT_SAMPLES      = 147;
LEADER_FREQ      = 1800;          // Hz — continuous during leader (distinct from data tones)
FREQ_ZERO        = 2400;          // Hz — background pixel (8.0 cycles/window)
FREQ_ONE         = 3000;          // Hz — ink pixel (10.0 cycles/window)
CHIRP_START_FREQ = 500;           // Hz
CHIRP_END_FREQ   = 4000;          // Hz
CHIRP_DURATION_S = 0.25;          // seconds
CHIRP_THRESHOLD  = 0.20;          // normalised correlation trigger
CHIRP_CHECK_STRIDE = 8;           // samples between correlation checks
IMG_WIDTH        = 320;
IMG_HEIGHT       = 192;
DISPLAY_SCALE    = 2;             // each pixel → 2×2 block (Atari display ratio)
```

### Why these frequencies

At 300 baud (147 samples/bit): 2400×147/44100 = 8.0 and 3000×147/44100 = 10.0 — both exact integers, so Goertzel cross-leakage is zero. 2-bin separation. Hamming window applied to Goertzel reduces sidelobe noise from −13 dB to −43 dB.

Leader at 1800 Hz (= 6×300, also integer-cycle) is kept distinct from both data tones so pixel data cannot falsely retrigger leader detection after a signal-lost reset.

CHIRP_THRESHOLD = 0.20: with stride=8, the nearest check to the chirp peak can land at lag=4. At lag=4, autocorrelation of a 500→4000 Hz chirp is ~0.24. Threshold 0.20 catches this reliably; leader/noise gives < 0.01.

600 baud tested and failed acoustically (Goertzel power scales with N², halving window cuts power 4×).

### Frequency history (iPhone speaker → MacBook mic)

| Pair | Outcome |
|------|---------|
| 1200/2400 Hz (KCS) | 1200 Hz absent — phone speaker can't produce it |
| 2400/4000 Hz | 4000 Hz absent at mic |
| 5327/3995 Hz (original Atari) | 3995 Hz too weak; partial only |
| 2400/3000 Hz | Both strong; UART framing was the failure mode |
| 2400/3600 Hz | 3600 Hz confirmed absent from phone speaker |
| **2400/3000 Hz (current, leader=1800 Hz)** | **192/192 rows OK — fully confirmed** |

---

## Current State (as of 2026-08-12)

### Git branches

- `main` — stable baseline (pre-rewrite)
- `sstv-decoder` — **active branch**, decoder fully working acoustically
- `decoder-update` — previous UART-based work, preserved for reference

### What is confirmed working

- WAV path: generator → WAV upload → perfect decode ✓
- Acoustic path: iPhone speaker → MacBook mic → 192/192 rows OK ✓
- Chirp matched-filter sync (CHIRP_THRESHOLD=0.20, CHIRP_CHECK_STRIDE=8) ✓
- Signal-lost detection: 10 consecutive checksum failures → stops decode, re-enters leader listen ✓
- generator.html: in-project WAV encoder (was ~/Downloads/fsk_test_generator-2.html) ✓

### Immediate next step

**Merge `sstv-decoder` → `main`**, then load the 8 transmission images and test the full sequence.

---

## How the Decoder Works

### 1. Leader detection

AnalyserNode FFT looks for 1800 Hz for 3 continuous seconds (0.5s dropout grace). When confirmed, switches to the ScriptProcessorNode.

### 2. Chirp sync (matched filter)

A 500→4000 Hz linear sweep template is generated at startup. The ScriptProcessorNode maintains a circular ring buffer (11025 samples = 250ms). Every 8 samples, normalised cross-correlation between the ring buffer and the template is computed. When correlation > 0.20, the chirp end position locks the bit clock.

Nothing in a normal room produces a 250ms linear frequency sweep — false trigger rate is effectively zero.

### 3. Pixel reading

From the chirp end, samples are counted in exact 147-sample windows. Each window is evaluated via Goertzel (with Hamming window) at 2400 Hz and 3000 Hz. Higher power wins → bit 0 or 1. No start/stop bits. Bit clock never drifts because 300 × 147 = 44100 exactly.

### 4. Row structure

320 pixel bits → draw row (or glitch if checksum fails) → move to next row. 192 rows total. Each row is independently recoverable — a noise burst corrupts at most one row. After 10 consecutive glitch rows, the decoder stops and re-enters leader detection so the user can replay without reloading the page.

### 5. Image rendering

Rows drawn to canvas in real-time as they arrive (~1 row/second at 300 baud). Ink `#1a1a1a`, background `#D2C5A0`. Portrait mode: 90° CW rotation using canvas coordinate transform.

---

## Local Development

VS Code Live Server on port **5501** (configured in `.vscode/settings.json`). No build step.

**WAV generator**: `generator.html`
- Upload image → scale to 320×192, set threshold and orientation
- Generates: leader (1800 Hz) + chirp + orientation bits + pixel rows with checksums
- Upload result via `wav-test` input in `waste.html`, or play from phone for acoustic test

---

## Deferred — Intentionally Not Now

### UART removal was the right call — do not reintroduce
UART stop-bit framing was the primary acoustic failure mode. The new row-checksum approach is strictly better: one corrupted row shows as glitch, not signal abort.

### Image compression (RLE / quadtree)
2-color images have large flat regions. RLE (fax CCITT Group 3/4 model) would reduce transmission time. **Deferred because** it requires variable-length encoding — one corrupted run length destroys all subsequent pixels. The current fixed-length row format means a noise burst corrupts at most one row. Revisit only after transmission time becomes the main annoyance (currently ~3.5 min).

### POKEY audio soundtrack
Infrastructure (`startAudioLoop`, `parseAudioInstructions`, `TRANSMISSION_TIMINGS`) existed in the old `decoder-update` branch but is not present in `sstv-decoder`. The vision: Jacquard punch-card style melody per transmission, referencing the 1804 loom as the conceptual ancestor of stored programs. **On hold** until images are loaded and the sequence is verified.

### Browser voice processing note
`getUserMedia` now explicitly sets `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`. On macOS/Safari, disabling `echoCancellation` can silently force stereo capture even with `channelCount: 1` — watch for this if the Goertzel produces unexpected results on Safari.

---

## Stretch Goals

### Drawing app + encoder
A 320×192 two-colour canvas feeding directly into the same pixel grid the encoder consumes. Pairs with a browser-side encoder so users create and transmit their own images. Comes after decode is acoustically reliable.

### POKEY / Jacquard soundtrack
See POKEY note above. As each image plays, synthesised POKEY chip audio (square/sawtooth/noise, 4 channels) plays a melody encoded like a Jacquard loom punch card — tying the piece's oldest ancestor to its sound.

### Telecoms history unlockable
The project has organically retraced 200 years of sending data as sound: Jacquard (1804) → KCS → Atari cassette → FSK → fax/RLE → matched filters (radar/GPS). An unlockable page after the 8th transmission could recontextualise the experience as a telecoms-history lesson disguised as interactive art.

---

## Status Checklist

- [x] Site built, portal functional
- [x] Password gate (`thurn-and-taxis.html`) working
- [x] Leader detection reliable
- [x] Goertzel + Hamming window discrimination confirmed
- [x] Image rendering: row-by-row reveal, landscape + portrait
- [x] New decoder written (`sstv-decoder` branch): chirp sync, per-pixel FSK, row checksums
- [x] Generator in project (`generator.html`)
- [x] WAV path confirmed working
- [x] **Acoustic path confirmed: 192/192 rows OK (2400/3000 Hz, leader 1800 Hz)**
- [x] Signal-lost auto-reset after 10 consecutive glitch rows
- [ ] Merge `sstv-decoder` → `main`
- [ ] Load 8 transmission images, test full sequence
- [ ] Stretch: drawing app + encoder
- [ ] Stretch: POKEY / Jacquard soundtrack
- [ ] Deferred: RLE/quadtree compression
- [ ] Deferred: telecoms history page
