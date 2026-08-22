# Coastal Remote Sensing Toolkit for Peru (Google Earth Engine)

A collection of Google Earth Engine (GEE) tools for coastal and marine monitoring along the Peruvian coast, built around freely available satellite data (Sentinel-1, Sentinel-2, NOAA/ECMWF reanalysis). Each tool targets a specific coastal management problem where cloud cover, tidal timing, or small-target detection make naive optical remote sensing unreliable.

This repository currently ships two working modules, with more planned (see [Roadmap](#roadmap)).

## Modules

### 1. Early Detection of Red Tides / "Aguajes" via SAR (`sar_biogenic_slick_detection.js`)

**Status: working prototype.**

Detects candidate biogenic slicks — the smooth, low-backscatter water patches produced by the mucilage/surfactants that harmful algal blooms and "aguajes" (a Peruvian upwelling-related die-off phenomenon) release onto the sea surface — using Sentinel-1 SAR instead of optical imagery.

**Why SAR:** optical sensors (MODIS, Sentinel-2/3) are blind on the Peruvian coast for much of the year because of persistent fog ("garúa") and cloud cover. Radar penetrates both and works day or night, at the cost of being a much noisier, indirect proxy for biological activity.

#### How it works

1. Pulls Sentinel-1 GRD (VV, IW mode) over a user-defined area of interest (AOI).
2. Builds a strict water mask: JRC Global Surface Water occurrence (>=90%) **combined with** ETOPO1 bathymetry (< 0 m). Occurrence alone is not enough — it lets through desert/dune shadow that optical classifiers sometimes mislabel as water (see [Lessons Learned](#lessons-learned)).
3. Speckle-filters each scene (mean filter in the linear domain, not in dB).
4. Flags local anomalies with a spatial z-score: each pixel is compared against a 1500 m neighborhood, and pixels far enough below both a relative (z-score) and an absolute (dB) threshold are candidates.
5. Requires candidate pixels to form a **connected patch** of a minimum size, which removes the false-positive "noise floor" that a raw z-score threshold produces from ordinary speckle variability.
6. Cross-checks each candidate against wind speed (NOAA GFS for recent dates, ECMWF ERA5 for retrospective analysis) — under low wind, the *entire* sea surface looks smooth, so a slick-like signal without confirmed wind is not trustworthy.
7. Produces a per-scene time series (`% of AOI flagged as anomalous`) instead of raw backscatter, since raw backscatter mixes different Sentinel-1 orbit geometries and produces a sawtooth artifact unrelated to any real signal.

#### Quick start

1. Open the [GEE Code Editor](https://code.earthengine.google.com/).
2. Paste the contents of `sar_biogenic_slick_detection.js`.
3. **Set your own AOI** (see [Configuration](#configuration) below) — the script ships with the AOI left empty on purpose.
4. Click **Run**.
5. Check the Console for available scenes, wind status, and the list of candidate dates; check the Map for the "Possible biogenic slicks" layer.

#### Configuration

All tunable parameters live at the top of the relevant section:

| Parameter | Location | Default | Notes |
|---|---|---|---|
| `aoi` | Section 1 | *(empty — must be set)* | `ee.Geometry.Rectangle([minLon, minLat, maxLon, maxLat])`. A commented-out example (Paracas Bay, Peru) is included for reference. |
| `startDate` / `endDate` | Section 1 | `2026-01-01` / `2026-08-21` | Analysis window. |
| `zThreshold` | Section 6 | `-2` | How much darker than the local neighborhood a pixel must be. |
| `absoluteThreshold` | Section 6 | `-19` dB | Absolute backscatter ceiling for a candidate pixel. |
| `minPatchPixels` | Section 6 | `10` (~0.1 km² at 100 m/px) | Minimum connected-patch size; raise this if the noise floor isn't fully gone for your AOI. |

To validate a specific candidate date's wind conditions, call `windERA5('YYYY-MM-DD')` (events older than ~3 months) or `windGFS('YYYY-MM-DD')` (recent events) anywhere after their definitions in the script.

#### Known limitations

- **Not real-time**: with a single Sentinel-1 satellite covering a given relative orbit, revisit is roughly 6–12 days; combining ascending/descending orbits improves this but doesn't make it daily.
- **Not species- or cause-specific**: a detected slick can be biogenic, an oil sheen, a current-shear front, or a ship wake. This script flags *candidates* for follow-up, not confirmed blooms.
- **No optical confirmation built in**: Section 9 opportunistically loads a nearby cloud-free Sentinel-2 scene for visual context, but nothing automatically correlates it with the SAR detections yet.
- **Wind data resolution**: GFS/ERA5 are coarse (~25–28 km) reanalysis/forecast grids; they characterize regional wind regime, not micro-scale gustiness within a small bay.

#### Lessons learned

Documented here because they're genuinely useful for anyone adapting this script to a new AOI, not just historical trivia:

- **Water masks lie near dunes.** JRC Global Surface Water's `occurrence` band, used alone with a permissive threshold, misclassified shadowed desert dunes as water. Combining it with an elevation/bathymetry check (ETOPO1 < 0 m) fixed it — no optical misclassification survives a hard physical elevation constraint.
- **`reduceNeighborhood` kernels sized in real-world units are zoom-dependent when rendered on a map.** A 1500 m kernel that works fine in a `reduceRegion` call can throw `Kernel is too large` when displayed on the map at high zoom, because GEE recomputes the kernel's pixel footprint from the current display scale. Reprojecting to a fixed working scale *before* the kernel operation makes the computation zoom-invariant.
- **A z-score threshold alone doesn't give you a clean zero baseline.** Under a roughly normal distribution, a threshold like `z < -1.5` flags ~6.7% of any scene by chance alone. Pairing the threshold with a minimum connected-patch-size filter (`connectedPixelCount`) removes most of that statistical noise while preserving genuine, spatially coherent events.
- **ERA5 "final" has a multi-week-to-multi-month publication lag** in the GEE catalog; querying it for recent dates returns an empty collection (and a confusing "Image with no bands" error downstream). Use GFS analysis fields (`forecast_hours = 0`) for near-real-time wind, and reserve ERA5 for retrospective analysis of older events.

### 2. Massive Brown Macroalgae Stranding Detection (`macroalgae_stranding_detection.js`)

**Status: working prototype.**

Detects candidate mass strandings of brown macroalgae (e.g. *Lessonia* spp., harvested artisanally along southern Peru) that pile up on beaches after strong swell events, using Sentinel-2 multitemporal NDVI change detection in the intertidal zone.

**Why storm-triggered:** strandings are episodic, not constant — they follow specific swell events. Instead of scanning every scene blindly, this module first identifies candidate storm-swell days from wave data, then only inspects Sentinel-2 imagery around those dates.

#### How it works

1. Pulls Copernicus Marine significant wave height (VHM0, hindcast only) over the AOI to flag candidate storm-swell days above a tunable threshold.
2. Builds a per-pixel **baseline** of typical dry-sand NDVI from ~40 days of pre-storm Sentinel-2 scenes. Each baseline scene contributes only at the pixels *it* classifies as dry (via its own MNDWI) — this makes the baseline tide-aware without needing an external tide table (see [Known Limitations](#known-limitations-1)).
3. Restricts every stage to **natural bare ground** (ESA WorldCover class 60), which structurally excludes built-up areas and vegetation regardless of exactly how the AOI was drawn.
4. For the earliest usable post-storm scene, flags pixels whose NDVI is anomalously high (z-score above baseline) **and** that form a spatially connected patch above a minimum size — the same anomaly + patch-size pattern used in Module 1, just on NDVI instead of SAR backscatter.
5. Cross-checks that a storm-swell event actually preceded the image, and reports the flagged area in m².

#### Quick start

1. Open the [GEE Code Editor](https://code.earthengine.google.com/).
2. Paste the contents of `macroalgae_stranding_detection.js`.
3. **Set your own AOI** — a thin polygon drawn tightly around the beach/intertidal strip, not a large bounding box (see [Configuration](#configuration-1)). A worked example (Playa Pozo Lizas, Ilo) is included, commented in, for reference.
4. Click **Run**.
5. Check the Console for the list of storm-swell candidate days, pick one, paste it into `eventDate` (Section 3), and re-run.
6. Check the "Estimated stranded-algae area (m²)" print and the diagnostics block underneath it (numbered 1–6) — these break down exactly how many pixels survived each masking/thresholding stage, so a zero result can be told apart from an over-restrictive filter.

#### Configuration

| Parameter | Location | Default | Notes |
|---|---|---|---|
| `aoi` | Section 1 | Playa Pozo Lizas, Ilo (example) | A thin polygon around the beach strip. Draw your own with the Code Editor's polygon tool rather than guessing coordinates — see [Lessons Learned](#lessons-learned-1). |
| `startDate` / `endDate` | Section 1 | `2026-01-01` / `2026-08-21` | Analysis window for the wave time series. |
| `waveThresholdM` | Section 2 | `2.5` m | Significant wave height (VHM0) considered a storm swell. |
| `eventDate` | Section 3 | `2026-03-13` (example) | Pick one date from the printed storm-swell candidate list. |
| `waterThreshold` | Section 6 | `0` (MNDWI) | Per-scene wet/dry cutoff; more negative = stricter "dry". |
| `zThreshold` | Section 9 | `2` | Std devs above typical dry-sand NDVI for a candidate pixel. |
| `minPatchPixels` | Section 9 | `4` (~400 m² at 10 m/px) | Minimum connected-patch size. Lowered from an initial `8` — see [Lessons Learned](#lessons-learned-1); tune per beach, this is not a universal number. |

#### Known limitations

- **Optical, not radar — this module is blind through cloud/fog.** Unlike Module 1 (SAR), Sentinel-2 is a passive optical sensor: if the beach is cloud-covered on every pass within the post-storm search window, no usable image exists and the script reports this explicitly rather than crashing. This is common in the austral winter (June–August) on the southern Peru coast, when coastal "garúa" fog is more persistent. Reusing Module 1's SAR roughness-anomaly approach as a cloud-gap-filling layer (already noted for the kelp-forest module in the [Roadmap](#roadmap)) would apply equally well here.
- **No external tide table.** Tide state is inferred per-scene from MNDWI, not from a tide model — this is a pragmatic workaround, not a substitute for real tide data. A scene captured at an unusually low or high tide relative to the baseline scenes can bias the dry-sand baseline.
- **Not species-specific.** NDVI is a proxy for "chlorophyll-bearing organic matter on dry sand" — dense wrack of any vegetation/algae type, or certain wet-sand/organic debris mixes, can trigger it.
- **Timing-sensitive.** Wrack piles disperse, dry out (changing their NDVI signature), or get collected by artisanal harvesters within days of a storm. The script prioritizes the earliest cloud-free scene after the event for this reason, but a scene from the *same day* as the storm can still be too early if the satellite pass preceded that day's peak wave height — the deposit may not have fully formed yet.
- **`minPatchPixels` needs per-AOI tuning.** A small, thin beach polygon has relatively few valid pixels to begin with; a patch-size threshold picked for one beach is not guaranteed to transfer to another without re-checking the diagnostics.

#### Lessons learned

- **Wave data collections can mix hindcast and forecast records.** `COPERNICUS/MARINE/WAV/ANFC_0_083DEG_PT3H` bundles observed ("hindcast") records with 10-day-ahead forecast runs at multiple lead times; without filtering by `observation_type == 'hindcast'`, a modest date range balloons into tens of thousands of images and triggers `Collection query aborted after accumulating over 5000 elements`.
- **A dataset can be an `ImageCollection` with a single image, not a plain `Image`.** `ESA/WorldCover/v200` throws `Asset ... is not an Image` if loaded with `ee.Image()` directly; it needs `ee.ImageCollection(...).first()`.
- **Charting many points against a string x-axis can silently fail.** With ~1800+ points, `ui.Chart` with a string `xProperty` (e.g. a formatted date string) throws `Data column(s) for axis #0 cannot be of type string`. Using the numeric `system:time_start` property instead fixes it.
- **Coarse ocean-model grids often mask the cells closest to the real coastline.** Sampling wave stats directly over a small coastal AOI can return `null`; sampling a ~15 km buffer around the AOI's centroid instead reliably lands on valid nearby open-water cells.
- **Guessed coordinates are not a substitute for looking at the imagery.** An early version of the example AOI, typed from an approximate mental picture of the town, ended up partly over the town's street grid instead of the beach. Visually confirming coordinates against satellite imagery before shipping an example — and adding the structural ESA WorldCover bare-ground mask as a second line of defense — fixed both the immediate error and the broader class of "AOI drifted onto non-beach terrain" bugs.
- **A collapsed dictionary in the Console reads as "nothing happened."** `reduceRegion()` results print as a collapsed `Object (N properties)` that needs an extra click to expand; printing the specific value with `.get('key')` instead avoids a real (non-zero) result being missed.
- **An empty `ImageCollection` fails loudly but unhelpfully, and repeatedly.** If no post-storm scene clears the cloud filter, calling `.first()` on the empty collection returns `null`, and every downstream line (`select`, `clip`, the diagnostics, the wave cross-check) throws its own version of `Parameter 'input' is required and may not be null` — a wall of near-identical errors. Checking `collection.size().getInfo() === 0` once, up front, and printing a single actionable message is much clearer.
- **Sorting post-storm candidates by cloud percentage, not by date, can pick a scene too late.** The least-cloudy scene in a 10-day window is not necessarily the earliest one — and stranded algae can disperse or be harvested well within that window. Sorting by `system:time_start` instead prioritizes freshness over marginal cloud-cover gains.
- **A z-score threshold tuned on one beach does not necessarily transfer to another.** An initial `minPatchPixels=8` (borrowed directly from a mental model of "solid slab of algae") found real candidate pixels but zero contiguous patches of that size — wrack piles here formed several smaller, scattered clumps rather than one mass. Lowering the threshold, informed by inspecting the largest actual connected patch found, produced a physically reasonable detection.

## Roadmap

Planned modules, in rough order of technical maturity (see project notes for a fuller technical discussion of trade-offs for each):

- **Giant kelp forest health/density monitoring**: primarily optical canopy detection (Sentinel-2), with the SAR roughness-anomaly module (Module 1) reused as a cloud-gap-filling / cross-validation layer — the same cloud/fog blind spot documented for Module 2 above applies here too.
- **Nocturnal illegal kelp harvesting ("barreteo") detection** in Marine Protected Areas: SAR bright-point detection, most likely as a human-review trigger rather than an automated alert, given the weak radar cross-section of small wooden artisanal vessels.

## Requirements

- A [Google Earth Engine](https://earthengine.google.com/) account (free for research/non-commercial use).
- No local installation needed for the scripts above — they run entirely in the browser-based Code Editor.

## License

*(Add a license — e.g. MIT or Apache-2.0 — before publishing publicly.)*
