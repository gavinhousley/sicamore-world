// ============================================================
// SICAMORE — decoder.js
// waste.html — the decode experience
// ============================================================

// ── CONSTANTS ────────────────────────────────────────────────

const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;

// FSK frequencies chosen for phone speaker reliability and perfect Goertzel alignment.
// 2400 Hz confirmed strong. 3600 Hz = next integer-cycle candidate above 3000 Hz.
// At 300 baud (147 samples/bit): 2400×147/44100 = 8.0 and 3600×147/44100 = 12.0 —
// both exact integers → zero Goertzel cross-leakage. 4-bin separation vs 2 with 2400/3000.
const LEADER_FREQ = 3000; // mark frequency — continuous during leader
const LEADER_THRESHOLD_S = 3; // confirm after 3 seconds

const BAUD_RATE = 300;
const BIT_DURATION = 1 / BAUD_RATE;

const FREQ_ONE = 3600; // mark  — bit 1  (12.0 exact cycles per 147-sample window)
const FREQ_ZERO = 2400; // space — bit 0  (8.0 exact cycles per 147-sample window)

// Zero crossing threshold in samples
// 3600 Hz half-period = 44100 / (3600 * 2) = 6.125 samples  (mark)
// 2400 Hz half-period = 44100 / (2400 * 2) = 9.19 samples   (space)
// Threshold 8 sits between them; start bit (space) triggers reliably
const ZERO_CROSS_THRESHOLD = 8;

const IMG_WIDTH = 320;
const IMG_HEIGHT = 192;
const DISPLAY_SCALE = 2;

const INK_COLOUR = "#1a1a1a";
const BG_COLOUR = "#D2C5A0";

const IMAGE_BYTES = IMG_WIDTH * IMG_HEIGHT / 8; // 7680 — raw pixel bytes
const STREAM_BYTES = 1 + IMAGE_BYTES;           // 7681 — orientation flag + image data

// Per-transmission music timing
// playMs must match the silence you encode on the tape
const TRANSMISSION_TIMINGS = [
  { playMs: 25000, fadeMs: 3000 }, // 1 — The Chapel
  { playMs: 25000, fadeMs: 3000 }, // 2 — Unconscious/Conscious
  { playMs: 25000, fadeMs: 3000 }, // 3 — Shadow Work
  { playMs: 25000, fadeMs: 3000 }, // 4 — Lose Yourself
  { playMs: 25000, fadeMs: 3000 }, // 5 — The Mirror
  { playMs: 25000, fadeMs: 3000 }, // 6 — Land of Dreams
  { playMs: 25000, fadeMs: 3000 }, // 7 — The Bookseller
  { playMs: 30000, fadeMs: 4000 }, // 8 — The Fused Figure
];

const DURATION_TABLE = [
  62, 83, 104, 125, 167, 188, 208, 250, 333, 375, 417, 500, 667, 750, 1000,
  2000,
];

const WAVEFORMS = ["square", "sawtooth", "noise", "square"];

// ── STATE ────────────────────────────────────────────────────

let activeOscillators = [];
let activeGainNodes = [];
let audioLoopTimer = null;
let musicFadeTimer = null;
let transmissionIndex = 0;

// ── HELPERS ──────────────────────────────────────────────────

const statusEl = document.getElementById("status");

function freqToBin(freq) {
  return Math.round(freq / (SAMPLE_RATE / FFT_SIZE));
}

function divisorToFreq(divisor) {
  if (divisor === 0) return 0;
  return 1789773 / (2 * divisor);
}

function log(msg) {
  console.log(msg);
  statusEl.textContent = msg;
}

// ── AUDIO — STOP AND FADE ────────────────────────────────────

function stopAudio() {
  activeOscillators.forEach((node) => {
    try {
      node.stop();
    } catch (e) {}
  });
  activeOscillators = [];
  activeGainNodes = [];

  if (audioLoopTimer) {
    clearTimeout(audioLoopTimer);
    audioLoopTimer = null;
  }
  if (musicFadeTimer) {
    clearInterval(musicFadeTimer);
    musicFadeTimer = null;
  }
}

function fadeOutAudio(fadeDuration_ms) {
  const fadeSteps = 30;
  const stepDuration = fadeDuration_ms / fadeSteps;
  let step = 0;

  musicFadeTimer = setInterval(() => {
    step++;
    const gain = Math.max(0, 1 - step / fadeSteps);

    activeGainNodes.forEach((gainNode) => {
      gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, 0.1);
    });

    if (step >= fadeSteps) {
      clearInterval(musicFadeTimer);
      musicFadeTimer = null;
      stopAudio();
    }
  }, stepDuration);
}

// ── AUDIO — PLAYBACK ─────────────────────────────────────────

function parseAudioInstructions(audioBytes) {
  const instructions = [];
  const INSTRUCTION_SIZE = 5;

  for (
    let i = 0;
    i + INSTRUCTION_SIZE <= audioBytes.length;
    i += INSTRUCTION_SIZE
  ) {
    const channel = audioBytes[i];
    const divisor = (audioBytes[i + 1] << 8) | audioBytes[i + 2];
    const volume = audioBytes[i + 3];
    const packed = audioBytes[i + 4];
    const waveformIdx = (packed >> 4) & 0x0f;
    const durationIdx = packed & 0x0f;

    instructions.push({
      channel,
      divisor,
      volume,
      waveform: WAVEFORMS[waveformIdx] || "square",
      duration_ms: DURATION_TABLE[durationIdx] || 250,
    });
  }

  return instructions;
}

function startAudioLoop(ctx, instructions) {
  stopAudio();
  if (!instructions || instructions.length === 0) return;

  const channelDurations = { 1: 0, 2: 0, 3: 0, 4: 0 };
  instructions.forEach((inst) => {
    channelDurations[inst.channel] += inst.duration_ms;
  });
  const loopDuration = Math.max(...Object.values(channelDurations)) / 1000;

  console.log("loop duration:", loopDuration.toFixed(2), "seconds");

  function scheduleLoop(startTime) {
    const channelTime = {
      1: startTime,
      2: startTime,
      3: startTime,
      4: startTime,
    };

    instructions.forEach((inst) => {
      const freq = divisorToFreq(inst.divisor);
      const start = channelTime[inst.channel];
      const duration = inst.duration_ms / 1000;
      const gain = inst.volume / 15;

      if (inst.volume > 0) {
        const gainNode = ctx.createGain();

        if (inst.waveform === "noise") {
          const bufferSize = Math.ceil(ctx.sampleRate * duration);
          const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
          const data = noiseBuffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
          }
          const noise = ctx.createBufferSource();
          noise.buffer = noiseBuffer;

          gainNode.gain.value = gain * 0.3;
          noise.connect(gainNode);
          gainNode.connect(ctx.destination);
          noise.start(start);
          noise.stop(start + duration);

          activeOscillators.push(noise);
          activeGainNodes.push(gainNode);
        } else if (freq > 0) {
          const osc = ctx.createOscillator();
          osc.type = inst.waveform;
          osc.frequency.value = freq;

          gainNode.gain.value = gain * 0.25;
          osc.connect(gainNode);
          gainNode.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + duration);

          activeOscillators.push(osc);
          activeGainNodes.push(gainNode);
        }
      }

      channelTime[inst.channel] += duration;
    });

    const nextLoopStart = startTime + loopDuration;
    const scheduleAhead = (nextLoopStart - ctx.currentTime - 0.1) * 1000;

    audioLoopTimer = setTimeout(
      () => {
        scheduleLoop(nextLoopStart);
      },
      Math.max(0, scheduleAhead),
    );
  }

  scheduleLoop(ctx.currentTime + 0.1);
}

// ── IMAGE RENDERING ──────────────────────────────────────────

function setupCanvas(isPortrait) {
  let canvas = document.getElementById("decode-canvas");

  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "decode-canvas";
    document.getElementById("waste").appendChild(canvas);
  }

  canvas.width  = (isPortrait ? IMG_HEIGHT : IMG_WIDTH)  * DISPLAY_SCALE;
  canvas.height = (isPortrait ? IMG_WIDTH  : IMG_HEIGHT) * DISPLAY_SCALE;
  canvas.style.imageRendering = "pixelated";

  const ctx2d = canvas.getContext("2d");
  ctx2d.fillStyle = BG_COLOUR;
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);

  return { canvas, ctx2d };
}

function renderImage(imageBytes, isPortrait, onComplete) {
  const decoderImg = document.getElementById("decoder");
  if (decoderImg) decoderImg.style.display = "none";

  const { canvas, ctx2d } = setupCanvas(isPortrait);
  canvas.style.display = "block";

  let row = 0;

  function drawNextRow() {
    if (row >= IMG_HEIGHT) {
      console.log("image render complete");
      if (onComplete) onComplete();
      return;
    }

    const byteIndex = row * (IMG_WIDTH / 8);

    for (let bytePos = 0; bytePos < IMG_WIDTH / 8; bytePos++) {
      const byte = imageBytes[byteIndex + bytePos];

      for (let bit = 7; bit >= 0; bit--) {
        const pixelValue = (byte >> bit) & 1;
        const x = bytePos * 8 + (7 - bit);

        ctx2d.fillStyle = pixelValue === 1 ? INK_COLOUR : BG_COLOUR;

        if (isPortrait) {
          // 90° CW: original (x, y) → display (IMG_HEIGHT-1-y, x)
          ctx2d.fillRect(
            (IMG_HEIGHT - 1 - row) * DISPLAY_SCALE,
            x * DISPLAY_SCALE,
            DISPLAY_SCALE,
            DISPLAY_SCALE,
          );
        } else {
          ctx2d.fillRect(
            x * DISPLAY_SCALE,
            row * DISPLAY_SCALE,
            DISPLAY_SCALE,
            DISPLAY_SCALE,
          );
        }
      }
    }

    row++;
    setTimeout(drawNextRow, 0);
  }

  drawNextRow();
}

// ── DISSOLVE ─────────────────────────────────────────────────

function dissolveImage(onComplete) {
  const canvas = document.getElementById("decode-canvas");
  const ctx2d = canvas.getContext("2d");
  const rows = canvas.height / DISPLAY_SCALE;
  let row = rows - 1;

  function clearNextRow() {
    if (row < 0) {
      if (onComplete) onComplete();
      return;
    }

    ctx2d.fillStyle = BG_COLOUR;
    ctx2d.fillRect(0, row * DISPLAY_SCALE, canvas.width, DISPLAY_SCALE);

    row--;
    setTimeout(clearNextRow, 0);
  }

  clearNextRow();
}


// ── GOERTZEL TONE DETECTOR ────────────────────────────────────
//
// Measures power at a single frequency over a sample block.
// Hamming window applied per-sample: reduces sidelobe leakage from ~-13 dB
// (rectangular) to ~-43 dB, suppressing noise between the two FSK frequencies.
// At 147 samples / 300 baud: FREQ_ZERO (2400 Hz) = 8.0 cycles, FREQ_ONE (3600 Hz) = 12.0 cycles —
// integer counts give zero main-lobe cross-leakage between the two bins regardless of window.

function goertzelPower(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = (2 * Math.PI * targetFreq) / sampleRate;
  const cosine = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hamming
    const s = samples[i] * w + cosine * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - cosine * s1 * s2;
}

// ── BIT DETECTION — GOERTZEL FREQUENCY COMPARISON ────────────
//
// Each 74-sample bit window is classified by comparing power at
// FREQ_ONE (5327 Hz) vs FREQ_ZERO (3995 Hz) via Goertzel.
// Bit clock is anchored to each start bit's falling edge (zero-crossing
// gap detection) so windows never drift across bit boundaries.

function startBitDetection(ctx, analyser, source, onImageReceived) {
  const BIT_SAMPLES = Math.round(SAMPLE_RATE / BAUD_RATE); // 147 at 44100/300

  const byteBuffer = [];
  let framingErrors = 0;

  // State machine: hunting for the start bit's falling edge, or inside a byte
  let state = "hunting"; // 'hunting' | 'in_byte'
  let bitQueue = [];
  let bitCount = 0; // 0=start bit, 1-8=data bits, 9=stop bit

  // Amplitude noise gate — only count zero crossings when the signal
  // envelope is above this level. Prevents microphone noise from adding
  // spurious crossings that push space-bit counts above CROSSINGS_ONE.
  // Peak follower: rises instantly, decays at 0.9997/sample (~30ms half-life).
  const SIGNAL_THRESHOLD = 0.05;

  let samplePos = 0;
  let windowStart = 0;
  let windowSamples = [];
  let lastSign = 0;
  let prevCrossingPos = 0;
  let peakAmp = 0;
  let debugWindowCount = 0;

  const processor = ctx.createScriptProcessor(256, 1, 1);

  setTimeout(() => {
    try {
      processor.disconnect();
    } catch (e) {}
    log("bit detection stopped");
  }, 320000); // 320s — enough for 7680 bytes at 300 baud (256s) plus margin

  processor.onaudioprocess = function (e) {
    const inputData = e.inputBuffer.getChannelData(0);

    for (let i = 0; i < inputData.length; i++) {
      const absVal = Math.abs(inputData[i]);
      peakAmp = absVal > peakAmp ? absVal : peakAmp * 0.9997;

      const sign = inputData[i] >= 0 ? 1 : -1;

      if (sign !== lastSign && lastSign !== 0 && peakAmp > SIGNAL_THRESHOLD) {
        const gap = samplePos - prevCrossingPos;

        if (state === "hunting" && gap > ZERO_CROSS_THRESHOLD) {
          // Long gap = first space half-period = start bit found.
          // Align bit clock to prevCrossingPos (where mark→space began).
          windowStart = prevCrossingPos;
          windowSamples = [];
          bitCount = 0;
          bitQueue = [];
          state = "in_byte";
        }

        prevCrossingPos = samplePos;
      }

      if (state === "in_byte") {
        windowSamples.push(inputData[i]);
      }

      lastSign = sign;
      samplePos++;

      if (state === "in_byte" && samplePos - windowStart >= BIT_SAMPLES) {
        // Guard: window far shorter than a bit period means prevCrossingPos was stale
        // (signal dropout left it unupdated, so windowStart anchored to the past).
        // The evaluation loop would fire repeatedly with near-zero samples — discard.
        if (windowSamples.length < Math.floor(BIT_SAMPLES / 4)) {
          state = "hunting";
          prevCrossingPos = samplePos;
          windowSamples = [];
          windowStart = samplePos;
        } else {
          const p1 = goertzelPower(windowSamples, FREQ_ONE, SAMPLE_RATE);
          const p0 = goertzelPower(windowSamples, FREQ_ZERO, SAMPLE_RATE);
          const bit = p1 > p0 ? 1 : 0;
          if (debugWindowCount < 60) {
            console.log("G bit" + bitCount + ": p0=" + Math.round(p0) + " p1=" + Math.round(p1) + " →" + bit + " len=" + windowSamples.length);
            debugWindowCount++;
          }
          windowSamples = [];
          windowStart += BIT_SAMPLES;

          if (bitCount === 0) {
            // Verify start bit is 0; if not, it was a false trigger
            if (bit !== 0) {
              state = "hunting";
              prevCrossingPos = samplePos;
            } else {
              bitCount = 1;
            }
          } else if (bitCount <= 8) {
            bitQueue.push(bit);
            bitCount++;
          } else {
            // Stop bit — must be 1
            if (bit === 1) {
              let byte = 0;
              for (let j = 0; j < 8; j++) byte |= bitQueue[j] << j; // LSB first
              byteBuffer.push(byte);
              framingErrors = 0;
              if (byteBuffer.length >= STREAM_BYTES) {
                try { processor.disconnect(); } catch (e) {}
                log("image received — rendering");
                onImageReceived(byteBuffer.slice(0, STREAM_BYTES));
                return;
              }
            } else {
              console.warn("framing error — resyncing");
              framingErrors++;
              if (framingErrors > 20) {
                try {
                  processor.disconnect();
                } catch (e) {}
                log("signal ended");
                return;
              }
            }
            state = "hunting";
            prevCrossingPos = samplePos;
            bitQueue = [];
            bitCount = 0;
          }
        }
      }
    }
  };

  // Bandpass filter centred on the geometric mean of the two FSK frequencies.
  // f0 = sqrt(2400 * 3600) ≈ 2939 Hz   Q = 1.5 → -3dB bandwidth ≈ 1960 Hz
  // Passband ≈ 1960–3920 Hz — both 2400 and 3600 Hz sit comfortably inside.
  const bpFilter = ctx.createBiquadFilter();
  bpFilter.type = "bandpass";
  bpFilter.frequency.value = 2939;
  bpFilter.Q.value = 1.5;

  source.connect(bpFilter);
  bpFilter.connect(processor);
  processor.connect(ctx.destination);

  return { byteBuffer, processor };
}

// ── SEQUENCE CONTROLLER ──────────────────────────────────────

function onAllTransmissionsComplete() {
  log("end of transmission");

  setTimeout(() => {
    atariFuzz(() => {
      window.location.href = "index.html";
    });
  }, 2000);
}

function atariFuzz(onComplete) {
  const canvas = document.getElementById("decode-canvas");
  const ctx2d = canvas.getContext("2d");
  let frames = 0;
  const TOTAL = 30;

  function fuzzFrame() {
    if (frames >= TOTAL) {
      onComplete();
      return;
    }

    const imageData = ctx2d.createImageData(canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const val = Math.random() > 0.5 ? 255 : 0;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }

    ctx2d.putImageData(imageData, 0, 0);
    frames++;
    requestAnimationFrame(fuzzFrame);
  }

  fuzzFrame();
}

// ── LEADER DETECTION + MAIN ENTRY POINT ─────────────────────

let audioCtx = null;

async function startListening() {
  log("requesting microphone...");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  console.log("AudioContext sampleRate:", audioCtx.sampleRate);

  let bitProcessor = null;

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const binData = new Float32Array(analyser.frequencyBinCount);
  const leaderBin = freqToBin(LEADER_FREQ);
  const noiseBin = freqToBin(LEADER_FREQ + 400);

  function onImageReceived(streamBytes) {
    const idx = transmissionIndex;
    const isPortrait = streamBytes[0] === 1;
    const imageBytes = streamBytes.slice(1);
    log("receiving image...");
    renderImage(imageBytes, isPortrait, () => {
      const timing = TRANSMISSION_TIMINGS[idx] || TRANSMISSION_TIMINGS[TRANSMISSION_TIMINGS.length - 1];
      setTimeout(() => {
        fadeOutAudio(timing.fadeMs);
        if (idx >= TRANSMISSION_TIMINGS.length - 1) {
          setTimeout(() => dissolveImage(onAllTransmissionsComplete), timing.fadeMs + 500);
        }
      }, timing.playMs);
    });
  }

  log("listener activated — press play on device");

  function listenForLeader() {
    let leaderStart = null;
    let leaderConfirmed = false;
    let lastSignalTime = null;
    const DROPOUT_GRACE_S = 0.5;

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
          log("transmission incoming");

          setTimeout(() => {
            log("listening for data...");
            startBitDetection(audioCtx, analyser, source, (imageBytes) => {
              onImageReceived(imageBytes);
              if (transmissionIndex < TRANSMISSION_TIMINGS.length - 1) {
                listenForLeader();
              }
            });
          }, 4200);

          const canvas = document.getElementById("decode-canvas");
          if (canvas && canvas.style.display !== "none") {
            stopAudio();
            dissolveImage(() => { transmissionIndex++; });
          }

          return;
        }
      } else {
        if (leaderStart !== null && !leaderConfirmed) {
          if (lastSignalTime !== null && audioCtx.currentTime - lastSignalTime > DROPOUT_GRACE_S) {
            log("tone lost — waiting again");
            leaderStart = null;
          }
        }
      }

      requestAnimationFrame(tick);
    }

    tick();
  }

  listenForLeader();
}

document.getElementById("listen-btn").addEventListener("click", startListening);

// >>>>>>>>>>>>> TEST — full offline decode from WAV file
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

    const BIT_SAMPLES = Math.round(SAMPLE_RATE / BAUD_RATE);
    // Start from 0 — the hunter ignores mark-frequency gaps (≤5 samples)
    // so it sails through the 7s leader and locks onto the first real start bit.
    const startSample = 0;

    const byteBuffer = [];
    let totalBytes = 0;
    let framingErrors = 0;
    let state = "hunting";
    let bitQueue = [];
    let bitCount = 0;
    let windowStart = 0;
    let windowSamples = [];
    let lastSign = 0;
    let prevCrossingPos = 0;

    if (!audioCtx) audioCtx = new AudioContext();

    for (let i = startSample; i < samples.length; i++) {
      const sign = samples[i] >= 0 ? 1 : -1;

      if (sign !== lastSign && lastSign !== 0) {
        const gap = i - prevCrossingPos;

        if (state === "hunting" && gap > ZERO_CROSS_THRESHOLD) {
          windowStart = prevCrossingPos;
          windowSamples = [];
          bitCount = 0;
          bitQueue = [];
          state = "in_byte";
        }

        prevCrossingPos = i;
      }

      if (state === "in_byte") {
        windowSamples.push(samples[i]);
      }

      lastSign = sign;

      if (state === "in_byte" && i - windowStart >= BIT_SAMPLES) {
        const p1 = goertzelPower(windowSamples, FREQ_ONE, SAMPLE_RATE);
        const p0 = goertzelPower(windowSamples, FREQ_ZERO, SAMPLE_RATE);
        const bit = p1 > p0 ? 1 : 0;
        windowSamples = [];
        windowStart += BIT_SAMPLES;

        if (bitCount === 0) {
          if (bit !== 0) {
            state = "hunting";
          } else {
            bitCount = 1;
          }
        } else if (bitCount <= 8) {
          bitQueue.push(bit);
          bitCount++;
        } else {
          if (bit === 1) {
            let byte = 0;
            for (let j = 0; j < 8; j++) byte |= bitQueue[j] << j;
            byteBuffer.push(byte);
            totalBytes++;
            framingErrors = 0;
            if (byteBuffer.length >= STREAM_BYTES) {
              const isPortrait = byteBuffer[0] === 1;
              log("image complete — rendering (" + (isPortrait ? "portrait" : "landscape") + ")");
              renderImage(byteBuffer.slice(1, STREAM_BYTES), isPortrait, () => { log("render complete"); });
              break;
            }
          } else {
            framingErrors++;
            console.warn("framing error #" + framingErrors);
            if (framingErrors > 20) {
              log("too many framing errors — stopping");
              break;
            }
          }
          state = "hunting";
          bitQueue = [];
          bitCount = 0;
        }
      }
    }

    log("WAV decode complete — " + totalBytes + " bytes decoded");
    console.log("total bytes:", totalBytes);
  });
// >>>>>>
