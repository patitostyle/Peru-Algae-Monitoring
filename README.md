# Macroalgae Stranding Detector (Peru Coast)

Detects candidate mass strandings of brown macroalgae (e.g. *Lessonia* spp., harvested artisanally along southern Peru) that pile up on beaches after strong swell events, using Sentinel-2 multitemporal NDVI change detection in the intertidal zone, on Google Earth Engine (GEE).

**Status: working prototype.**

## Why storm-triggered

Strandings are episodic, not constant — they follow specific swell events. Instead of scanning every scene blindly, this tool first identifies candidate storm-swell days from wave data, then only inspects Sentinel-2 imagery around those dates.

## How it works

1. Pulls Copernicus Marine significant wave height (VHM0, hindcast only) over the AOI to flag candidate storm-swell days above a tunable threshold.
2. Builds a per-pixel **baseline** of typical dry-sand NDVI from ~40 days of pre-storm Sentinel-2 scenes. Each baseline scene contributes only at the pixels *it* classifies as dry (via its own MNDWI) — this makes the baseline tide-aware without needing an external tide table (see [Known Limitations](#known-limitations)).
3. Restricts every stage to **natural bare ground** (ESA WorldCover class 60), which structurally excludes built-up areas and vegetation regardless of exactly how the AOI was drawn.
4. For the earliest usable post-storm scene, flags pixels whose NDVI is anomalously high (z-score above baseline) **and** that form a spatially connected patch above a minimum size.
5. Cross-checks that a storm-swell event actually preceded the image, and reports the flagged area in m².

## Quick start

1. Open the [GEE Code Editor](https://code.earthengine.google.com/).
2. Paste the contents of `macroalgae_stranding_detection.js`.
3. **Set your own AOI** — a thin polygon drawn tightly around the beach/intertidal strip, not a large bounding box (see [Configuration](#configuration)). A worked example (Playa Pozo Lizas, Ilo) is included, commented in, for reference.
4. Click **Run**.
5. Check the Console for the list of storm-swell candidate days, pick one, paste it into `eventDate` (Section 3), and re-run.
6. Check the "Estimated stranded-algae area (m²)" print and the diagnostics block underneath it (numbered 1–6) — these break down exactly how many pixels survived each masking/thresholding stage, so a zero result can be told apart from an over-restrictive filter.

## Configuration

| Parameter | Location | Default | Notes |
|---|---|---|---|
| `aoi` | Section 1 | Playa Pozo Lizas, Ilo (example) | A thin polygon around the beach strip. Draw your own with the Code Editor's polygon tool rather than guessing coordinates — see [Lessons Learned](#lessons-learned). |
| `startDate` / `endDate` | Section 1 | `2026-01-01` / `2026-08-21` | Analysis window for the wave time series. |
| `waveThresholdM` | Section 2 | `2.5` m | Significant wave height (VHM0) considered a storm swell. |
| `eventDate` | Section 3 | `2026-03-13` (example) | Pick one date from the printed storm-swell candidate list. |
| `waterThreshold` | Section 6 | `0` (MNDWI) | Per-scene wet/dry cutoff; more negative = stricter "dry". |
| `zThreshold` | Section 9 | `2` | Std devs above typical dry-sand NDVI for a candidate pixel. |
| `minPatchPixels` | Section 9 | `4` (~400 m² at 10 m/px) | Minimum connected-patch size. Tune per beach — see [Lessons Learned](#lessons-learned); this is not a universal number. |

## Known limitations

- **Optical, not radar — this tool is blind through cloud/fog.** Sentinel-2 is a passive optical sensor: if the beach is cloud-covered on every pass within the post-storm search window, no usable image exists and the script reports this explicitly rather than crashing. This is common in the austral winter (June–August) on the southern Peru coast, when coastal "garúa" fog is more persistent. A companion SAR-based tool ([sar_biogenic_slick_detection.js](https://github.com/patitostyle/harmful-algal-bloom-sar-detection)) is unaffected by cloud/fog and could act as a cloud-gap-filling cross-check in a future version.
- **No external tide table.** Tide state is inferred per-scene from MNDWI, not from a tide model — this is a pragmatic workaround, not a substitute for real tide data. A scene captured at an unusually low or high tide relative to the baseline scenes can bias the dry-sand baseline.
- **Not species-specific.** NDVI is a proxy for "chlorophyll-bearing organic matter on dry sand" — dense wrack of any vegetation/algae type, or certain wet-sand/organic debris mixes, can trigger it.
- **Timing-sensitive.** Wrack piles disperse, dry out (changing their NDVI signature), or get collected by artisanal harvesters within days of a storm. The script prioritizes the earliest cloud-free scene after the event for this reason, but a scene from the *same day* as the storm can still be too early if the satellite pass preceded that day's peak wave height — the deposit may not have fully formed yet.
- **`minPatchPixels` needs per-AOI tuning.** A small, thin beach polygon has relatively few valid pixels to begin with; a patch-size threshold picked for one beach is not guaranteed to transfer to another without re-checking the diagnostics.

## Lessons learned

- **Wave data collections can mix hindcast and forecast records.** `COPERNICUS/MARINE/WAV/ANFC_0_083DEG_PT3H` bundles observed ("hindcast") records with 10-day-ahead forecast runs at multiple lead times; without filtering by `observation_type == 'hindcast'`, a modest date range balloons into tens of thousands of images and triggers `Collection query aborted after accumulating over 5000 elements`.
- **A dataset can be an `ImageCollection` with a single image, not a plain `Image`.** `ESA/WorldCover/v200` throws `Asset ... is not an Image` if loaded with `ee.Image()` directly; it needs `ee.ImageCollection(...).first()`.
- **Charting many points against a string x-axis can silently fail.** With ~1800+ points, `ui.Chart` with a string `xProperty` (e.g. a formatted date string) throws `Data column(s) for axis #0 cannot be of type string`. Using the numeric `system:time_start` property instead fixes it.
- **Coarse ocean-model grids often mask the cells closest to the real coastline.** Sampling wave stats directly over a small coastal AOI can return `null`; sampling a ~15 km buffer around the AOI's centroid instead reliably lands on valid nearby open-water cells.
- **Guessed coordinates are not a substitute for looking at the imagery.** An early version of the example AOI, typed from an approximate mental picture of the town, ended up partly over the town's street grid instead of the beach. Visually confirming coordinates against satellite imagery before shipping an example — and adding the structural ESA WorldCover bare-ground mask as a second line of defense — fixed both the immediate error and the broader class of "AOI drifted onto non-beach terrain" bugs.
- **A collapsed dictionary in the Console reads as "nothing happened."** `reduceRegion()` results print as a collapsed `Object (N properties)` that needs an extra click to expand; printing the specific value with `.get('key')` instead avoids a real (non-zero) result being missed.
- **An empty `ImageCollection` fails loudly but unhelpfully, and repeatedly.** If no post-storm scene clears the cloud filter, calling `.first()` on the empty collection returns `null`, and every downstream line (`select`, `clip`, the diagnostics, the wave cross-check) throws its own version of `Parameter 'input' is required and may not be null` — a wall of near-identical errors. Checking `collection.size().getInfo() === 0` once, up front, and printing a single actionable message is much clearer.
- **Sorting post-storm candidates by cloud percentage, not by date, can pick a scene too late.** The least-cloudy scene in a 10-day window is not necessarily the earliest one — and stranded algae can disperse or be harvested well within that window. Sorting by `system:time_start` instead prioritizes freshness over marginal cloud-cover gains.
- **A patch-size threshold tuned on one beach does not necessarily transfer to another.** An initial `minPatchPixels=8` (borrowed directly from a mental model of "solid slab of algae") found real candidate pixels but zero contiguous patches of that size — wrack piles here formed several smaller, scattered clumps rather than one mass. Lowering the threshold, informed by inspecting the largest actual connected patch found, produced a physically reasonable detection.

## Related work

Part of a broader set of independent Google Earth Engine tools for coastal monitoring in Peru. See also: [harmful-algal-bloom-sar-detection](https://github.com/patitostyle/harmful-algal-bloom-sar-detection) (SAR detection of red tides / "aguajes" through persistent coastal fog). Kelp forest monitoring and illegal nocturnal kelp harvesting detection are planned as separate future repos.

## Requirements

- A [Google Earth Engine](https://earthengine.google.com/) account (free for research/non-commercial use).
- No local installation needed — the script runs entirely in the browser-based Code Editor.

## License

MIT
