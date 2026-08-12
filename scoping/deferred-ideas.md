# Deferred Ideas & Future Optimisations

Ideas that are real and correct but intentionally NOT being built now, with the reasoning preserved so it isn't lost. Log any future re-scoping decisions here too.

---

## 1. Image compression (RLE / quadtree) — DEFERRED

**The idea:** The image is 2-color (ink / background, i.e. on / off). Large flat regions of a single color don't need to be sent pixel-by-pixel. Two established techniques do this:

- **Run-length encoding (RLE):** transmit runs instead of pixels — "40 off, 12 on, 90 off…" rather than 320 individual pixels per line. This is the foundation of **fax machines** (CCITT Group 3/4), which compress 2-color pages with huge white runs — structurally the same kind of data as this project's images.
- **Quadtree encoding:** recursively divide the image into quarters; any quarter that is entirely one color collapses to a single block; only mixed quarters subdivide further. Big uniform regions cost almost nothing. Used in image compression, collision detection, and mapping.

**Why deferred — the core tension:**
The current format's best property is that **every pixel is independent and positional**. If one line is corrupted by noise, all following lines are unaffected — this is exactly what makes line-by-line realignment recovery possible.

RLE and quadtrees are **variable-length**. A single corrupted run destroys the length count and shifts everything after it — one bad bit cascades through the rest of the image instead of glitching a single line. That trades away the project's best resilience property in exchange for shorter transmission time — the wrong trade while noise-robustness is the active battle.

**When to revisit:** Only once acoustic noise is solved thoroughly enough that transmission *time* (~200s) becomes the main annoyance. At that point RLE is the obvious next lever, and fax-style encoding is the proven template to copy.

**Related near-term use (not compression):** the on/off + transparency framing IS useful now as a mental model for the future drawing app + encoder — the canvas is genuinely just on/off (transparency = off), so the drawing tool and the transmission pixel format share one model. Keep this for that stretch goal; don't touch the fragile transmission layer with it.

---

## 2. Telecommunications-history angle — WEBSITE INTEGRATION IDEA

This project has organically become a walk through the real history of how humans have sent data as sound and signal. That lineage could become part of the Sicamore World experience itself, not just its backstory.

The history the project has actually retraced / touched:

- **Jacquard loom punch cards** (1804) — pattern encoded as holes; the conceptual ancestor of stored programs (already surfacing in the POKEY punch-card soundtrack stretch goal).
- **Kansas City Standard** — early cassette audio data encoding; discovered mid-project.
- **Atari 800XL cassette encoding** — the direct aesthetic and technical influence.
- **FSK (frequency-shift keying)** — two tones for two states; the current encoding.
- **Fax / CCITT Group 3/4 RLE** — 2-color run-length image compression (see idea 1).
- **Matched filters / chirp detection** — radar, GPS, bats; the basis of the chirp-preamble sync lock now in the decoder.
- **Spread spectrum / pseudo-noise codes** — GPS, CDMA; the "signal nothing can imitate" endgame.

**Possible forms this could take on the site:**
- A hidden/unlockable page revealed after completing the 8 transmissions — a reward that recontextualises what the user just did as part of a 200-year lineage.
- Short in-world "transmission notes" between transmissions, each tied to one historical method.
- An about/colophon page framing the whole piece as a telecommunications history lesson disguised as an interactive art object.

Fits the piece's identity: it's already a ritual of decoding sound into image — making the history explicit deepens rather than dilutes it.
