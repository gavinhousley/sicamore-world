# Execution Order — Sicamore World

Master index for the project's planning material. Read this first to understand
the whole journey. Every planning doc is linked below in build order, with open
decisions and outstanding work tracked so nothing is lost between sessions.

Last updated: 2026-06-17

---

## Source of Truth

**`../CLAUDE.md` is the single source of truth for design and current state.** It holds
the protocol, constants, frequency history, branch structure, and status checklist.
An earlier `sicamore-world-project.md` covered the same ground but has been retired to
avoid two docs drifting out of sync — `CLAUDE.md` is more current and stays authoritative.

The docs in this `scoping/` folder are the *decision record* around that source of truth,
not a duplicate of it.

| Doc | Role |
|-----|------|
| `../CLAUDE.md` | **Authoritative** design + state. Read at the start of every session. |
| `execution-order.md` | This file — index, build order, open decisions, decision log. |
| `deferred-ideas.md` | Ideas intentionally parked (RLE/quadtree, telecoms-history page), reasoning preserved. |
| `decoder-review-01.md` | Review of the first from-scratch decoder rebuild — two decisions + six fixes. |

Note: Claude Code also maintains its own `.memory/` folder (hidden, tool-managed state).
That is separate from these human-authored planning docs — leave it to the tool.

---

## Build Order (current)

1. **[NEXT] WAV path test with new format.** Generate a test WAV from the updated
   generator, upload via the `wav-test` input in `waste.html`, confirm full
   generator -> decoder -> render pipeline works end-to-end. This is the known-good
   floor to reach before anything acoustic.
2. **Acoustic frequency check — 3600 Hz.** Play 3600 Hz from the actual phone
   speaker, confirm it arrives strongly at the mic. See Open Decision A.
3. **Address decoder-review-01 fixes** (items 1–5) once the WAV path is proven.
4. **Full acoustic path test** with the new decoder.
5. **Merge `sstv-decoder` -> `main`** once the WAV path (and ideally acoustic path) is confirmed.
6. Stretch goals (drawing app + encoder, POKEY/Jacquard soundtrack) — only after
   decode is acoustically reliable.
7. Deferred (RLE/quadtree, telecoms-history page) — only when their preconditions are met.

---

## Open Decisions (resolve, then log the outcome here)

### A. FREQ_ONE — 3600 Hz vs revert to 3000 Hz
- **Status: OPEN — pending acoustic test.**
- 3600 Hz was chosen for cleaner Hamming-window separation (4 cycles vs 2) but is
  untested from the phone speaker. Documented history shows 4000 Hz absent at the
  mic and 3000 Hz previously confirmed strong.
- **Do not settle this by reasoning — test it.** If 3600 fades, 3000 Hz is the
  proven-good fallback (note: `CLAUDE.md` frames the old 2400/3000 result as "UART
  was the failure mode," but 3000 itself was acoustically fine — don't lose that).
- **Decision logged:** _(fill in after test: which frequency, and the measured result)_

### B. Per-row realignment — recovery vs glitch
- **Status: OPEN — design decision.**
- Current code implements **detect + glitch** (checksum flags a bad row, draws
  static, but the bit clock free-runs with no per-row resync). The project originally
  described **detect + recover** (per-row sync anchor re-locks the clock).
- Decide which the piece should be. Glitch is simpler and thematically apt; recover
  prevents a single dropped sample cascading through all later rows.
- **Decision logged:** _(fill in: glitch or recover, and why)_

---

## Outstanding Implementation Fixes (from decoder-review-01)

Tracked here because `CLAUDE.md` documents design, not these implementation-level items.

- [ ] 1. Chirp correlated on band-limited signal (bandpass before correlation); make
      acoustic and WAV paths consistent — correlate full-band or match template to filter.
- [ ] 2. Chirp fires on first threshold crossing, not the peak — scan for peak with
      sub-sample (parabolic) interpolation.
- [ ] 3. 44100 Hz assumption unguarded — assert/handle `audioCtx.sampleRate !== 44100`
      (48000 is common with Bluetooth/some Macs).
- [ ] 4. Orientation byte unprotected — add redundancy/checksum.
- [ ] 5. `bpFilter`/`analyser` nodes not disconnected between the 8 transmissions.
- [ ] 6. (Later) XOR-8 -> CRC-8 for stronger row checksum; `ScriptProcessorNode` ->
      `AudioWorklet` migration.

Also planned but not yet built (were always "later"): adaptive threshold during the
leader, and a pre-transmission calibration step.

---

## Decision Log (append as decisions are made)

- 2026-06-17 — Rebuilt decoder from scratch on `sstv-decoder` branch after the
  previous `decoder.js` was deleted. Chose to rebuild to the last known-good design
  (WAV-upload decode) first, then layer chirp sync on top. Old UART work preserved
  on `decoder-update` branch.
- 2026-06-17 — Adopted chirp preamble + matched-filter sync lock as the fix for the
  low-SNR framing-cascade failure. Additive change; FSK pixel stream unchanged.
- 2026-06-17 — Removed UART framing entirely (row checksums replace it). Marked
  "do not reintroduce" in CLAUDE.md.
- 2026-06-17 — Retired `sicamore-world-project.md`; `CLAUDE.md` is now the single
  source of truth for design/state, with `scoping/` holding the decision record only.
