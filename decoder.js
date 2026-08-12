// ============================================================
// SICAMORE — decoder.js
// Direct per-pixel FSK, row-level checksums, chirp sync lock
// ============================================================

// ── CONSTANTS ────────────────────────────────────────────────

const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;

// 1800 Hz leader: confirmed deliverable from phone speaker (1200 Hz absent, 2400 Hz present).
// Must differ from FREQ_ZERO and FREQ_ONE so pixel data doesn't trigger false leader.
const LEADER_FREQ = 1800;
const LEADER_THRESHOLD_S = 3;
const LEADER_DROPOUT_S = 0.5;

const BAUD_RATE = 300;
const BIT_SAMPLES = Math.round(SAMPLE_RATE / BAUD_RATE); // 147

// 2400 Hz = 8.0 exact cycles per 147-sample window → background / off pixel
// 3000 Hz = 10.0 exact cycles per 147-sample window → ink / on pixel
// Both integers → zero Goertzel cross-leakage. 2-bin separation.
// (3600 Hz was original FREQ_ONE but is absent from phone speaker; 3000 Hz confirmed present.)
const FREQ_ZERO = 2400;
const FREQ_ONE = 3000;

// Chirp preamble: linear sweep used as matched-filter timing anchor.
// Nothing in a normal room produces this shape; correlation spikes sharply
// when the sweep passes, locking the bit clock to sub-sample precision.
const CHIRP_START_FREQ = 500;
const CHIRP_END_FREQ = 4000;
const CHIRP_DURATION_S = 0.25;
const CHIRP_SAMPLES = Math.round(CHIRP_DURATION_S * SAMPLE_RATE); // 11025
// Worst-case lag at stride=8: chirp end falls midway between checks (lag=4).
// At lag 4, the chirp autocorrelation for a 500→4000 Hz sweep is ~0.24.
// Leader/noise gives < 0.01, so 0.20 is safe.
const CHIRP_THRESHOLD = 0.20;
// Rule: stride < sampleRate / chirpBandwidth (44100/3500 ≈ 12.6).
// The correlation spike is only ~9 samples wide; stride=32 skipped it entirely.
const CHIRP_CHECK_STRIDE = 8;

const IMG_WIDTH = 320;
const IMG_HEIGHT = 192;
const DISPLAY_SCALE = 2; // each pixel → 2×2 block, matching the Atari display ratio

const ROW_BITS = IMG_WIDTH; // 320 pixel bits per row
const CHECKSUM_BITS = 8; // XOR checksum per row
const ROW_TOTAL_BITS = ROW_BITS + CHECKSUM_BITS; // 328
const ORIENTATION_BITS = 8; // first byte after chirp: 0=landscape 1=portrait

const INK_COLOUR = "#1a1a1a";
const BG_COLOUR = "#D2C5A0";

const TRANSMISSION_COUNT = 8;
const VIEW_DURATION_MS = 8000; // hold image before dissolving

// ── STATE ────────────────────────────────────────────────────

let transmissionIndex = 0;
let audioCtx = null;

// ── HELPERS ──────────────────────────────────────────────────

const statusEl = document.getElementById("status");

function log(msg) {
  console.log(msg);
  statusEl.textContent = msg;
}

function freqToBin(freq) {
  return Math.round(freq / (SAMPLE_RATE / FFT_SIZE));
}

// ── CHIRP TEMPLATE ───────────────────────────────────────────

function buildChirpTemplate(sampleRate = SAMPLE_RATE) {
  const n = Math.round(CHIRP_DURATION_S * sampleRate);
  const tpl = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq =
      CHIRP_START_FREQ +
      (CHIRP_END_FREQ - CHIRP_START_FREQ) * (t / CHIRP_DURATION_S);
    tpl[i] = Math.sin(phase);
    phase += (2 * Math.PI * freq) / sampleRate;
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += tpl[i] * tpl[i];
  return { tpl, rms: Math.sqrt(ss / n), n };
}

const CHIRP = buildChirpTemplate(); // pre-built at 44100 Hz; rebuilt lazily if context rate differs

// ── GOERTZEL + HAMMING WINDOW ────────────────────────────────
// Hamming window reduces sidelobe leakage from −13 dB to −43 dB,
// suppressing noise between the two FSK frequencies.

function goertzelPower(samples, targetFreq, sampleRate = SAMPLE_RATE) {
  const N = samples.length;
  const k = (2 * Math.PI * targetFreq) / sampleRate;
  const cosine = 2 * Math.cos(k);
  let s1 = 0,
    s2 = 0;
  for (let i = 0; i < N; i++) {
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1));
    const s = samples[i] * w + cosine * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - cosine * s1 * s2;
}

// ── CANVAS ───────────────────────────────────────────────────

function setupCanvas(isPortrait) {
  let canvas = document.getElementById("decode-canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "decode-canvas";
    document.getElementById("waste").appendChild(canvas);
  }
  canvas.width = (isPortrait ? IMG_HEIGHT : IMG_WIDTH) * DISPLAY_SCALE;
  canvas.height = (isPortrait ? IMG_WIDTH : IMG_HEIGHT) * DISPLAY_SCALE;
  canvas.style.imageRendering = "pixelated";
  const ctx2d = canvas.getContext("2d");
  ctx2d.fillStyle = BG_COLOUR;
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx2d };
}

// ── ROW RENDERING ────────────────────────────────────────────

function drawRow(ctx2d, rowPixels, rowIndex, isPortrait) {
  for (let x = 0; x < IMG_WIDTH; x++) {
    ctx2d.fillStyle = rowPixels[x] ? INK_COLOUR : BG_COLOUR;
    if (isPortrait) {
      ctx2d.fillRect(
        (IMG_HEIGHT - 1 - rowIndex) * DISPLAY_SCALE,
        x * DISPLAY_SCALE,
        DISPLAY_SCALE,
        DISPLAY_SCALE,
      );
    } else {
      ctx2d.fillRect(
        x * DISPLAY_SCALE,
        rowIndex * DISPLAY_SCALE,
        DISPLAY_SCALE,
        DISPLAY_SCALE,
      );
    }
  }
}

function drawGlitchRow(ctx2d, rowIndex, isPortrait) {
  for (let x = 0; x < IMG_WIDTH; x++) {
    ctx2d.fillStyle = Math.random() > 0.5 ? INK_COLOUR : BG_COLOUR;
    if (isPortrait) {
      ctx2d.fillRect(
        (IMG_HEIGHT - 1 - rowIndex) * DISPLAY_SCALE,
        x * DISPLAY_SCALE,
        DISPLAY_SCALE,
        DISPLAY_SCALE,
      );
    } else {
      ctx2d.fillRect(
        x * DISPLAY_SCALE,
        rowIndex * DISPLAY_SCALE,
        DISPLAY_SCALE,
        DISPLAY_SCALE,
      );
    }
  }
}

// ── ROW CHECKSUM ─────────────────────────────────────────────
// Group 320 pixel bits into 40 bytes (MSB first), XOR them together.

function computeRowChecksum(rowPixels) {
  let checksum = 0;
  for (let i = 0; i < 40; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | rowPixels[i * 8 + b];
    checksum ^= byte;
  }
  return checksum;
}

// ── DISSOLVE ─────────────────────────────────────────────────

function dissolveImage(onComplete) {
  const canvas = document.getElementById("decode-canvas");
  if (!canvas) {
    if (onComplete) onComplete();
    return;
  }
  const ctx2d = canvas.getContext("2d");
  const rows = canvas.height / DISPLAY_SCALE;
  let row = rows - 1;
  function next() {
    if (row < 0) {
      if (onComplete) onComplete();
      return;
    }
    ctx2d.fillStyle = BG_COLOUR;
    ctx2d.fillRect(0, row * DISPLAY_SCALE, canvas.width, DISPLAY_SCALE);
    row--;
    setTimeout(next, 0);
  }
  next();
}

// ── ATARI FUZZ ───────────────────────────────────────────────

function atariFuzz(onComplete) {
  const canvas = document.getElementById("decode-canvas");
  const ctx2d = canvas.getContext("2d");
  let frames = 0;
  const TOTAL = 30;
  function frame() {
    if (frames >= TOTAL) {
      if (onComplete) onComplete();
      return;
    }
    const img = ctx2d.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() > 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx2d.putImageData(img, 0, 0);
    frames++;
    requestAnimationFrame(frame);
  }
  frame();
}

// ── SEQUENCE ─────────────────────────────────────────────────

function onAllTransmissionsComplete() {
  log("end of transmission");
  setTimeout(() => {
    atariFuzz(() => {
      window.location.href = "index.html";
    });
  }, 2000);
}

// ── DECODE ENGINE ────────────────────────────────────────────
// Handles both chirp detection (matched filter) and pixel reading
// (sample-exact bit clock) in a single ScriptProcessorNode.

function startDecodeEngine(
  ctx,
  source,
  onImageComplete,
  actualRate = SAMPLE_RATE,
  onSignalLost = null,
) {
  const chirp =
    actualRate === SAMPLE_RATE ? CHIRP : buildChirpTemplate(actualRate);
  const chirpN = chirp.n;
  const bitSamples = Math.round(actualRate / BAUD_RATE);
  console.log("DECODE ENGINE");
  console.log("  ctx.sampleRate:", ctx.sampleRate);
  console.log("  actualRate param:", actualRate);
  console.log("  bitSamples:", bitSamples, "(expected:", Math.round(ctx.sampleRate / BAUD_RATE) + ")");
  console.log("  chirpN:", chirpN);

  // Chirp ring buffer — circular, chirpN deep
  const chirpRing = new Float32Array(chirpN);
  let ringPos = 0;
  let ringFull = false;
  let sampleCount = 0;

  function correlate() {
    let dot = 0,
      wss = 0;
    for (let i = 0; i < chirpN; i++) {
      const s = chirpRing[(ringPos + i) % chirpN];
      dot += s * chirp.tpl[i];
      wss += s * s;
    }
    const windowRMS = Math.sqrt(wss / chirpN);
    return windowRMS > 0.001 ? dot / (windowRMS * chirp.rms * chirpN) : 0;
  }

  // Bit-reading state
  let state = "chirp"; // "chirp" | "bits"

  const bitWindow = new Float32Array(bitSamples);
  let bitFill = 0;
  let bitCount = 0; // diagnostic: log first N bits

  let orientationBits = [];
  let isPortrait = false;
  let ctx2d = null;

  let currentRow = 0;
  const rowPixels = new Array(IMG_WIDTH);
  let rowPixelCount = 0;
  const rowCsumBits = [];
  let consecutiveGlitch = 0;
  const SIGNAL_LOST_ROWS = 10; // ~11s of pure noise → give up and re-listen

  function processBit(bit) {
    // Phase 1: collect 8 orientation bits
    if (orientationBits.length < ORIENTATION_BITS) {
      orientationBits.push(bit);
      if (orientationBits.length === ORIENTATION_BITS) {
        let val = 0;
        for (let b = 0; b < 8; b++) val = (val << 1) | orientationBits[b];
        isPortrait = val === 1;
        const result = setupCanvas(isPortrait);
        ctx2d = result.ctx2d;
        document.getElementById("decode-canvas").style.display = "block";
        const decoderImg = document.getElementById("decoder");
        if (decoderImg) decoderImg.style.display = "none";
        log("receiving image...");
      }
      return;
    }

    // Phase 2: pixel rows
    if (currentRow >= IMG_HEIGHT) return;

    if (rowPixelCount < ROW_BITS) {
      rowPixels[rowPixelCount++] = bit;
    } else {
      rowCsumBits.push(bit);

      if (rowCsumBits.length === CHECKSUM_BITS) {
        let received = 0;
        for (let b = 0; b < 8; b++) received = (received << 1) | rowCsumBits[b];
        const expected = computeRowChecksum(rowPixels);

        if (received === expected) {
          drawRow(ctx2d, rowPixels, currentRow, isPortrait);
          consecutiveGlitch = 0;
          console.log("row", currentRow, "ok");
        } else {
          console.warn("row", currentRow, "GLITCH — expected", expected, "got", received);
          drawGlitchRow(ctx2d, currentRow, isPortrait);
          consecutiveGlitch++;
          if (onSignalLost && consecutiveGlitch >= SIGNAL_LOST_ROWS) {
            try { processor.disconnect(); } catch (_) {}
            log("signal lost — press play again");
            onSignalLost();
            return;
          }
        }

        currentRow++;
        rowPixelCount = 0;
        rowCsumBits.length = 0;

        if (currentRow >= IMG_HEIGHT) {
          try {
            processor.disconnect();
          } catch (_) {}
          log("image complete");
          setTimeout(onImageComplete, VIEW_DURATION_MS);
        }
      }
    }
  }

  // No hardware bandpass — the chirp correlation needs full-band signal (500–4000 Hz),
  // and the Hamming-windowed Goertzel is selective enough for pixel reading without it.
  const processor = ctx.createScriptProcessor(256, 1, 1);

  processor.onaudioprocess = function (e) {
    const input = e.inputBuffer.getChannelData(0);

    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      sampleCount++;

      if (state === "chirp") {
        chirpRing[ringPos] = sample;
        ringPos = (ringPos + 1) % chirpN;
        if (ringPos === 0) ringFull = true;

        if (ringFull && sampleCount % CHIRP_CHECK_STRIDE === 0) {
          const corr = correlate();
          if (corr > CHIRP_THRESHOLD) {
            // First threshold crossing locks the bit clock.
            // With stride=8 and a 9-sample-wide peak, the error is < 8 samples (< 6% of a bit).
            state = "bits";
            bitFill = 0;
            log("sync locked — receiving pixels...");
            console.log("chirp corr:", corr.toFixed(3));
          }
        }
      } else {
        // "bits"
        bitWindow[bitFill++] = sample;

        if (bitFill === bitSamples) {
          const p1 = goertzelPower(bitWindow, FREQ_ONE, actualRate);
          const p0 = goertzelPower(bitWindow, FREQ_ZERO, actualRate);
          if (bitCount < 10) {
            console.log("bit", bitCount, "p1:", p1.toFixed(1), "p0:", p0.toFixed(1), "→", p1 > p0 ? 1 : 0);
            bitCount++;
          }
          processBit(p1 > p0 ? 1 : 0);
          bitFill = 0;
        }
      }
    }
  };

  source.connect(processor);
  processor.connect(ctx.destination);

  return processor;
}

// ── LEADER DETECTION ─────────────────────────────────────────

async function startListening() {
  log("requesting microphone...");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  console.log("AudioContext sampleRate:", audioCtx.sampleRate);

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const binData = new Float32Array(analyser.frequencyBinCount);
  const leaderBin = freqToBin(LEADER_FREQ);
  const noiseBin = freqToBin(LEADER_FREQ + 400);

  function listenForLeader() {
    let leaderStart = null;
    let leaderConfirmed = false;
    let lastSignalTime = null;

    function tick() {
      analyser.getFloatFrequencyData(binData);
      const leaderPower = binData[leaderBin];
      const noisePower = binData[noiseBin];
      const signalPresent = leaderPower > -70 && leaderPower - noisePower > 8;

      if (signalPresent) {
        if (leaderStart === null) {
          leaderStart = audioCtx.currentTime;
          lastSignalTime = audioCtx.currentTime;
          log("tone detected — holding...");
        }
        lastSignalTime = audioCtx.currentTime;
        const elapsed = audioCtx.currentTime - leaderStart;
        statusEl.textContent = `tone held for ${elapsed.toFixed(1)}s`;

        if (!leaderConfirmed && elapsed >= LEADER_THRESHOLD_S) {
          leaderConfirmed = true;
          log("leader confirmed — waiting for sync chirp...");

          startDecodeEngine(
            audioCtx,
            source,
            () => {
              dissolveImage(() => {
                transmissionIndex++;
                if (transmissionIndex >= TRANSMISSION_COUNT) {
                  onAllTransmissionsComplete();
                } else {
                  listenForLeader();
                }
              });
            },
            audioCtx.sampleRate,
            () => listenForLeader(),
          );

          return; // stop ticking
        }
      } else {
        if (leaderStart !== null && !leaderConfirmed) {
          if (
            lastSignalTime !== null &&
            audioCtx.currentTime - lastSignalTime > LEADER_DROPOUT_S
          ) {
            log("tone lost — waiting again");
            leaderStart = null;
          }
        }
      }

      requestAnimationFrame(tick);
    }

    tick();
  }

  log("listener activated — press play on device");
  listenForLeader();
}

document.getElementById("listen-btn").addEventListener("click", startListening);

// ── WAV TEST PATH ────────────────────────────────────────────

document
  .getElementById("wav-test")
  .addEventListener("change", async function (e) {
    const file = e.target.files[0];
    if (!file) return;
    log("decoding WAV...");

    const arrayBuffer = await file.arrayBuffer();
    const tmpCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
    const samples = audioBuffer.getChannelData(0);

    const actualRate = tmpCtx.sampleRate;
    const wavChirp =
      actualRate === SAMPLE_RATE ? CHIRP : buildChirpTemplate(actualRate);
    const wavChirpN = wavChirp.n;
    const wavBitSamples = Math.round(actualRate / BAUD_RATE);
    console.log(
      "WAV ctx sampleRate:",
      actualRate,
      "| samples:",
      samples.length,
      "| duration:",
      (samples.length / actualRate).toFixed(1) + "s | bitSamples:",
      wavBitSamples,
      "| chirpN:",
      wavChirpN,
    );

    if (!audioCtx) audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    // ── Find chirp via matched filter ──
    const chirpRing = new Float32Array(wavChirpN);
    let ringPos = 0;
    let ringFull = false;
    let chirpEnd = -1;
    let maxCorr = 0;
    let maxCorrAt = -1;
    let peakCorr = 0, peakAt = -1, seenPeak = false;

    for (let i = 0; i < samples.length && chirpEnd < 0; i++) {
      chirpRing[ringPos] = samples[i];
      ringPos = (ringPos + 1) % wavChirpN;
      if (ringPos === 0) ringFull = true;

      if (ringFull && i % CHIRP_CHECK_STRIDE === 0) {
        let dot = 0,
          wss = 0;
        for (let j = 0; j < wavChirpN; j++) {
          const s = chirpRing[(ringPos + j) % wavChirpN];
          dot += s * wavChirp.tpl[j];
          wss += s * s;
        }
        const wRMS = Math.sqrt(wss / wavChirpN);
        const corr = wRMS > 0.001 ? dot / (wRMS * wavChirp.rms * wavChirpN) : 0;
        if (corr > maxCorr) { maxCorr = corr; maxCorrAt = i; }
        if (corr > CHIRP_THRESHOLD) {
          seenPeak = true;
          if (corr > peakCorr) { peakCorr = corr; peakAt = i; }
        } else if (seenPeak) {
          // correlation just dropped below threshold — lock to the true peak sample
          chirpEnd = peakAt;
          console.log("chirp locked at sample", chirpEnd, "corr:", peakCorr.toFixed(3));
        }
      }
    }

    console.log(
      "max corr:",
      maxCorr.toFixed(4),
      "at sample",
      maxCorrAt,
      "(threshold:",
      CHIRP_THRESHOLD + ")",
    );
    if (chirpEnd < 0) {
      log(
        "chirp not found — max corr: " +
          maxCorr.toFixed(3) +
          " (need " +
          CHIRP_THRESHOLD +
          ") — check console",
      );
      return;
    }

    // ── Read bits from chirp end ──
    let pos = chirpEnd;

    function readBit() {
      if (pos + wavBitSamples > samples.length) return 0;
      const window = samples.subarray(pos, pos + wavBitSamples);
      pos += wavBitSamples;
      return goertzelPower(window, FREQ_ONE, actualRate) >
        goertzelPower(window, FREQ_ZERO, actualRate)
        ? 1
        : 0;
    }

    // Orientation byte
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | readBit();
    const isPortrait = val === 1;
    console.log("orientation:", isPortrait ? "portrait" : "landscape");

    const { ctx2d } = setupCanvas(isPortrait);
    document.getElementById("decode-canvas").style.display = "block";
    const decoderImg = document.getElementById("decoder");
    if (decoderImg) decoderImg.style.display = "none";

    // Rows
    const rowPixels = new Array(IMG_WIDTH);
    let glitchCount = 0;

    for (let row = 0; row < IMG_HEIGHT; row++) {
      for (let x = 0; x < IMG_WIDTH; x++) rowPixels[x] = readBit();

      let received = 0;
      for (let b = 0; b < 8; b++) received = (received << 1) | readBit();
      const expected = computeRowChecksum(rowPixels);

      if (received === expected) {
        drawRow(ctx2d, rowPixels, row, isPortrait);
      } else {
        drawGlitchRow(ctx2d, row, isPortrait);
        glitchCount++;
      }
    }

    log(
      "WAV decode complete" +
        (glitchCount ? ` — ${glitchCount} glitch rows` : ""),
    );
  });
