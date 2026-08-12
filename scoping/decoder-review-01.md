# Decoder Review 01 — `decoder.js` (chirp + per-pixel FSK rebuild)

A review of the first from-scratch decoder rebuild. Overall the code is close to the spec and the hard-to-get-right parts are correct: the normalised cross-correlation math is sound, the chirp template integrates phase continuously (no discontinuity), the `getUserMedia` constraints correctly disable browser processing, and the checksum → glitch-row path works.

The points below are split into **two decisions to make first** (these are design choices, not bugs — do not auto-fix) and **six items safe to address**.

---

## DECIDE FIRST (design decisions — reason through before writing code)

### A. `FREQ_ONE` was changed 3000 → 3600 Hz
The rebuild uses `FREQ_ONE = 3600` (12.0 cycles/window) instead of the previously-tested 3000 Hz. This was likely paired with the new Hamming window: Hamming widens the main lobe, so it wants more separation than the old 2400/3000 pair (2 cycles apart); 2400/3600 gives 4 cycles of separation, which is cleaner in theory.

**But** the documented frequency history — from real iPhone-speaker → MacBook-mic testing — shows 3000 Hz confirmed strong and 4000 Hz *absent* at the mic. 3600 Hz is untested and sits closer to the dead zone.

**This must be resolved by an acoustic test, not in the abstract.** Play a 3600 Hz tone from the actual phone speaker and confirm it arrives strongly at the mic before committing. If it fades, revert to 3000 and solve the Hamming/separation concern another way. Do not "fix" this by reasoning alone — the phone-speaker behaviour is real-world data the model doesn't have.

### B. Per-row "realignment": recovery vs glitch
The project doc describes **line-by-line realignment recovery**, but the current code implements **detect + glitch**: after one chirp lock the bit clock free-runs at 147 samples/bit forever, with no per-row resync. Row checksums *detect* corruption and draw a graceful glitch row (good, and thematically apt), but a single dropped/added sample shifts every subsequent row and nothing re-locks.

**Decision needed:** is the intended behaviour
- **detect + glitch** (what exists) — simpler, one sync point, corrupted rows show as static; or
- **detect + recover** — a per-row sync anchor (mini-chirp or known preamble each line) that re-locks the clock so a glitch can't cascade?

This is a scoping decision about what the piece *is*, not a defect. Answer it before implementing — it changes what the next ticket even is.

---

## SAFE TO ADDRESS (closer to real bugs)

### 1. Bandpass filters the chirp before it's correlated (acoustic path only)
Signal flow is `source → bandpass(2939 Hz, Q≈1.5) → processor`, and the processor runs the chirp correlation. The chirp sweeps 500–4000 Hz, but that bandpass passes only ~1960–3920 Hz — so the matched filter correlates a full-band template against a band-limited received chirp, smearing the correlation peak and undermining the sync lock. The WAV path correlates on raw (unfiltered) samples, so the two paths behave differently. Fix: correlate the chirp off a full-band (pre-bandpass) tap, or match the template to the filtered chirp — and make both paths consistent.

### 2. Chirp fires on first threshold crossing, not the peak
The point of the chirp was sub-sample timing precision. Firing on the first `corr > CHIRP_THRESHOLD` (possibly on the rising flank), checked only every `CHIRP_CHECK_STRIDE = 32` samples, discards that precision — misalignment up to ~32 samples, ~20% of a bit. Once near the crossing, scan every sample to find the correlation *peak*, ideally with parabolic interpolation for true sub-sample lock.

### 3. 44100 Hz assumption is load-bearing and unguarded
`BIT_SAMPLES = 147` and all the integer-cycle math assume a 44100 Hz context. If the AudioContext comes up at 48000 (common with Bluetooth/AirPods, and some Macs default there), everything breaks silently — and `decodeAudioData` resamples the test WAV to the context rate too. The `AudioContext({ sampleRate })` hint can be ignored by browsers. Assert or explicitly handle `audioCtx.sampleRate !== 44100` rather than trusting the constructor.

### 4. Orientation byte is unprotected
It's read immediately at chirp-end with no checksum, so any edge imprecision (see item 2) that flips a bit swaps landscape/portrait and ruins the whole frame. Give it redundancy or its own check.

### 5. Nodes not disconnected between transmissions
The `bpFilter` and `analyser` nodes aren't torn down between the 8 transmissions. Disconnect old nodes each cycle to avoid accumulation.

### 6. Checksum + deprecated API (minor, later)
- The XOR-8 row checksum misses paired same-column bit flips; a CRC-8 is much stronger for the same 8 bits.
- `ScriptProcessorNode` is deprecated; `AudioWorklet` is the modern path. Current code works — this is a future migration, not urgent.

---

## Not yet implemented (expected — was planned as "later")
- Adaptive threshold (sample ambient noise floor during the leader, set decision threshold relative to it)
- Pre-transmission calibration step (measure p0/p1, tell user "move closer / too noisy")

---

## Suggested handling
Feed this file to Claude Code as a **review-and-decide** task, not a fix task:
> "For each point tell me whether you agree and how you'd address it — but don't write code yet. For items A and B, give me your reasoning first; those are decisions I need to make. Items 1–5 you can propose fixes for."
