// ============================================================
// SICAMORE — decoder.js
// waste.html — the decode experience
// ============================================================

// ── CONSTANTS ────────────────────────────────────────────────

const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;

// Authentic Atari 800XL FSK frequencies
const LEADER_FREQ = 5327; // mark frequency — continuous during leader
const LEADER_THRESHOLD_S = 3; // confirm after 3 seconds

const BAUD_RATE = 600;
const BIT_DURATION = 1 / BAUD_RATE;

const FREQ_ONE = 5327; // mark  — bit 1
const FREQ_ZERO = 3995; // space — bit 0

// Zero crossing threshold in samples
// 5327 Hz half-period = 44100 / (5327 * 2) = ~4.1 samples
// 3995 Hz half-period = 44100 / (3995 * 2) = ~5.5 samples
// Threshold sits between them
const ZERO_CROSS_THRESHOLD = 5;

const IMG_WIDTH = 320;
const IMG_HEIGHT = 192;
const DISPLAY_SCALE = 2;

const INK_COLOUR = "#1a1a1a";
const BG_COLOUR = "#D2C5A0";

const PACKET_TYPE_IMAGE = 1;
const PACKET_TYPE_AUDIO = 2;
const PACKET_TYPE_END = 3;

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

const STATE_WAITING_HEADER = "waiting_header";
const STATE_READING_PAYLOAD = "reading_payload";

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

function setupCanvas() {
  let canvas = document.getElementById("decode-canvas");

  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "decode-canvas";
    document.getElementById("waste").appendChild(canvas);
  }

  canvas.width = IMG_WIDTH * DISPLAY_SCALE;
  canvas.height = IMG_HEIGHT * DISPLAY_SCALE;
  canvas.style.imageRendering = "pixelated";

  const ctx2d = canvas.getContext("2d");
  ctx2d.fillStyle = BG_COLOUR;
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);

  return { canvas, ctx2d };
}

function renderImage(imageBytes, onComplete) {
  const decoderImg = document.getElementById("decoder");
  if (decoderImg) decoderImg.style.display = "none";

  const { canvas, ctx2d } = setupCanvas();
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
        ctx2d.fillRect(
          x * DISPLAY_SCALE,
          row * DISPLAY_SCALE,
          DISPLAY_SCALE,
          DISPLAY_SCALE,
        );
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
  let row = IMG_HEIGHT - 1;

  function clearNextRow() {
    if (row < 0) {
      if (onComplete) onComplete();
      return;
    }

    ctx2d.fillStyle = BG_COLOUR;
    ctx2d.fillRect(
      0,
      row * DISPLAY_SCALE,
      IMG_WIDTH * DISPLAY_SCALE,
      DISPLAY_SCALE,
    );

    row--;
    setTimeout(clearNextRow, 0);
  }

  clearNextRow();
}

// ── PACKET PARSER ────────────────────────────────────────────

function createParser(onImageComplete, onAudioComplete, onEnd) {
  let state = STATE_WAITING_HEADER;
  let packetType = null;
  let payloadLength = 0;
  let payloadBuffer = [];

  function process(byteBuffer) {
    while (byteBuffer.length > 0) {
      if (state === STATE_WAITING_HEADER) {
        if (byteBuffer.length < 5) break;

        const header = byteBuffer.splice(0, 5);
        packetType = header[0];
        payloadLength =
          (header[1] << 24) | (header[2] << 16) | (header[3] << 8) | header[4];

        console.log(
          "header received — type:",
          packetType,
          "length:",
          payloadLength,
        );

        if (packetType === PACKET_TYPE_END) {
          if (onEnd) onEnd();
          break;
        }

        payloadBuffer = [];
        state = STATE_READING_PAYLOAD;
      } else if (state === STATE_READING_PAYLOAD) {
        const remaining = payloadLength - payloadBuffer.length;
        const chunk = byteBuffer.splice(0, remaining);
        payloadBuffer.push(...chunk);

        if (payloadBuffer.length === payloadLength) {
          console.log("payload complete — type:", packetType);

          if (packetType === PACKET_TYPE_IMAGE) {
            onImageComplete(payloadBuffer.slice());
          } else if (packetType === PACKET_TYPE_AUDIO) {
            onAudioComplete(payloadBuffer.slice());
          }

          state = STATE_WAITING_HEADER;
          packetType = null;
          payloadLength = 0;
          payloadBuffer = [];
        } else break;
      }
    }
  }

  return { process };
}

// ── BIT DETECTION — ZERO CROSSING (ATARI METHOD) ─────────────
//
// Instead of FFT frequency analysis, we watch the raw waveform
// and time the gaps between zero crossings — exactly how the
// Atari 800XL POKEY chip decoded cassette FSK signals.
//
// 5327 Hz half-period = ~4.1 samples at 44100 Hz  → bit 1 (mark)
// 3995 Hz half-period = ~5.5 samples at 44100 Hz  → bit 0 (space)
// Threshold = 5 samples — short gap = 1, long gap = 0

function startBitDetection(ctx, analyser, parser, source) {
  const byteBuffer = [];
  let bitQueue = [];
  let inByte = false;
  let framingErrors = 0;

  function processBit(bit) {
    if (!inByte) {
      if (bit === 0) {
        // start bit is always 0 (space)
        inByte = true;
        bitQueue = [];
      }
      return;
    }

    bitQueue.push(bit);

    if (bitQueue.length === 9) {
      // 8 data bits + 1 stop bit
      const stopBit = bitQueue[8];
      const dataBits = bitQueue.slice(0, 8);

      if (stopBit === 1) {
        // stop bit must be 1 (mark)
        let byte = 0;
        for (let i = 0; i < 8; i++) {
          byte |= dataBits[i] << i; // LSB first
        }
        console.log("byte received:", byte, String.fromCharCode(byte));
        byteBuffer.push(byte);
        framingErrors = 0;
        parser.process(byteBuffer);
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

      inByte = false;
      bitQueue = [];
    }
  }

  const processor = ctx.createScriptProcessor(256, 1, 1);

  // Stop bit detection after 5 seconds — data section is short
  setTimeout(() => {
    try {
      processor.disconnect();
    } catch (e) {}
    log("bit detection stopped");
  }, 60000);

  let lastSign = 0;
  let lastCrossingSample = 0;
  let totalSamples = 0;

  processor.onaudioprocess = function (e) {
    const inputData = e.inputBuffer.getChannelData(0);

    for (let i = 0; i < inputData.length; i++) {
      const sample = inputData[i];
      const sign = sample >= 0 ? 1 : -1;

      if (sign !== lastSign && lastSign !== 0) {
        // Zero crossing — measure gap since last crossing
        const gap = totalSamples + i - lastCrossingSample;
        lastCrossingSample = totalSamples + i;

        // Short gap = fast wave = 5327 Hz = mark = bit 1
        // Long gap  = slow wave = 3995 Hz = space = bit 0
        const bit = gap <= ZERO_CROSS_THRESHOLD ? 1 : 0;
        processBit(bit);
      }

      lastSign = sign;
    }

    totalSamples += inputData.length;
  };

  // Connect source directly — no analyser needed for zero crossing
  source.connect(processor);
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

  let bitProcessor = null;

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const binData = new Float32Array(analyser.frequencyBinCount);
  const leaderBin = freqToBin(LEADER_FREQ);
  const noiseBin = freqToBin(LEADER_FREQ + 400);

  const parser = createParser(
    (imageBytes) => {
      log("receiving image...");
      renderImage(imageBytes, () => {
        const timing =
          TRANSMISSION_TIMINGS[transmissionIndex] ||
          TRANSMISSION_TIMINGS[TRANSMISSION_TIMINGS.length - 1];
        setTimeout(() => {
          fadeOutAudio(timing.fadeMs);
        }, timing.playMs);
      });
    },
    (audioBytes) => {
      log("receiving audio...");
      const instructions = parseAudioInstructions(audioBytes);
      startAudioLoop(audioCtx, instructions);
    },
    () => {
      dissolveImage(() => {
        onAllTransmissionsComplete();
      });
    },
  );

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

          // Leader is 7s total, confirmed at 3s — wait 4.2s for it to finish
          // then start zero crossing bit detection
          setTimeout(() => {
            log("listening for data...");
            const result = startBitDetection(
              audioCtx,
              analyser,
              parser,
              source,
            );
            bitProcessor = result.processor;
          }, 4200);

          const canvas = document.getElementById("decode-canvas");
          if (canvas && canvas.style.display !== "none") {
            stopAudio();
            dissolveImage(() => {
              transmissionIndex++;
            });
          }

          return;
        }
      } else {
        if (leaderStart !== null && !leaderConfirmed) {
          if (
            lastSignalTime !== null &&
            audioCtx.currentTime - lastSignalTime > DROPOUT_GRACE_S
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

  listenForLeader();
}

document.getElementById("listen-btn").addEventListener("click", startListening);

// >>>>>>>>>>>>> TEST
document
  .getElementById("wav-test")
  .addEventListener("change", async function (e) {
    const file = e.target.files[0];
    const arrayBuffer = await file.arrayBuffer();
    const tmpCtx = new AudioContext();
    const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
    const samples = audioBuffer.getChannelData(0);

    let lastSign = 0;
    let lastCrossingSample = 0;
    const startSample = Math.floor(44100 * 7.5);
    const gaps = [];

    for (let i = startSample; i < samples.length; i++) {
      const sign = samples[i] >= 0 ? 1 : -1;
      if (sign !== lastSign && lastSign !== 0) {
        const gap = i - lastCrossingSample;
        lastCrossingSample = i;
        gaps.push(gap);
      }
      lastSign = sign;
    }

    const dist = {};
    gaps.forEach((g) => {
      dist[g] = (dist[g] || 0) + 1;
    });
    console.log("gap distribution:", JSON.stringify(dist));
    console.log("total crossings:", gaps.length);
  });
// >>>>>>
