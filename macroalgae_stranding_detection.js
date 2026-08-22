/****************************************************************
 * MASSIVE BROWN MACROALGAE STRANDING DETECTION AFTER STORM SWELL
 * (Sentinel-2 multitemporal change detection, intertidal zone)
 *
 * Targets mass strandings of brown macroalgae (e.g. Lessonia spp.,
 * harvested artisanally along southern Peru) that pile up on beaches
 * after strong swell events.
 *
 * METHOD (mirrors the SAR slick-detection module's proven pattern —
 * baseline statistics + z-score anomaly + minimum patch size + a
 * physical driver cross-check):
 *   1. Use Copernicus Marine significant wave height (VHM0) to find
 *      candidate storm-swell days.
 *   2. Build a per-pixel BASELINE of "typical dry-sand NDVI" from many
 *      pre-storm Sentinel-2 scenes, using each scene's OWN dry/wet mask
 *      (MNDWI) so tide state is handled per-image instead of assuming a
 *      fixed shoreline.
 *   3. For a chosen post-storm scene, flag pixels whose NDVI is
 *      anomalously high (z-score) relative to that baseline, AND that
 *      form a spatially connected patch above a minimum size.
 *   4. Cross-check that a storm-swell event actually preceded the
 *      post-storm image.
 *
 * WHY NDVI: stranded wet algae biomass (chlorophyll-bearing organic
 * matter) reads as a moderate-to-strong positive NDVI bump relative to
 * bare dry sand, which sits close to zero. This is a proxy, not a
 * species-specific detector — dense wrack of ANY vegetation/algae type,
 * or even certain wet-sand/organic debris mixes, can trigger it.
 *
 * CRITICAL LIMITATION — TIDES: this script does NOT use an external tide
 * table. Instead, each Sentinel-2 scene's own water mask (MNDWI) is used
 * to define what counts as "exposed" at that moment. This is a pragmatic
 * workaround, not a substitute for real tide data — see README for
 * details and a suggested improvement path.
 ****************************************************************/

// ==================================================================
// 1. STUDY AREA AND DATE RANGE
// ==================================================================
// Working example — Playa Pozo Lizas, Ilo (Moquegua, southern Peru): an
// open sandy beach next to the Ilo airport, checked against satellite
// imagery to confirm it is clean beach with no buildings inside the
// polygon (unlike the first coordinates tried for this module, which
// landed on the town). Same region as the SAR-slick module's coastline,
// with a documented history of artisanal brown-algae (Lessonia spp.)
// harvesting.
var aoi = ee.Geometry.Polygon([[
  [-71.357098, -17.692402],
  [-71.347392, -17.693000],
  [-71.347392, -17.694197],
  [-71.357098, -17.694197],
  [-71.357098, -17.692402]
]]);

// To monitor your OWN beach instead: comment out the block above, and
// uncomment the line below, then draw a THIN polygon tightly around the
// beach / intertidal strip using the Code Editor's polygon tool (icon
// above the map, top-left) — NOT a large bounding box, and not a shape
// that includes streets or buildings. There is no reliable, coordinate-
// only way to guarantee an AOI stays on the beach without looking at the
// actual imagery first.
// var aoi = ee.Geometry.Polygon([]); // <-- draw or paste your own beach polygon here

Map.centerObject(aoi, 15);
Map.addLayer(aoi, {color: 'red'}, 'AOI (beach strip)', false);

// The AOI itself is a very thin strip (a few hundred meters). At a fixed
// zoom level the visible viewport is much larger than that, so imagery
// layers that are clipped tightly to `aoi` only paint a small rectangle,
// leaving the rest of the viewport blank/gray (no bug — just nothing was
// drawn there). `displayBuffer` is used ONLY for the RGB context layers
// below, purely so there's visual surroundings to orient yourself; it is
// never used in the actual detection math.
var displayBuffer = aoi.buffer(300);

var startDate = '2026-01-01';
var endDate   = '2026-08-21';

// ==================================================================
// 2. STORM-SWELL EVENTS (Copernicus Marine wave analysis/forecast)
// ==================================================================
var waveThresholdM = 2.5; // significant wave height (m) considered a storm swell (tunable)

// IMPORTANT: this collection mixes already-observed ("hindcast") records
// with 10-day-ahead FORECAST records, and each daily forecast run leaves
// one image per lead time. Without filtering by observation_type, a date
// range of a few months can balloon into tens of thousands of images
// (duplicated valid-times from overlapping forecast runs), which is what
// caused "Collection query aborted after accumulating over 5000 elements"
// on the chart below. Keeping only 'hindcast' fixes this and also matches
// what we want here: real observed wave conditions, not a forecast.
var waveCollection = ee.ImageCollection('COPERNICUS/MARINE/WAV/ANFC_0_083DEG_PT3H')
  .filterBounds(aoi)
  .filterDate(startDate, endDate)
  .filter(ee.Filter.eq('observation_type', 'hindcast'))
  .select('VHM0'); // total significant wave height (combined wind sea + swell)

print('Wave records available (hindcast only):', waveCollection.size());
print('If this is 0, hindcast may not be published yet for this date range — ' +
  'try an older end date, or ask about switching part of the query to forecast_hours=0.');

// The wave model's ~9 km grid often MASKS the cells closest to a real
// coastline (unresolved nearshore bathymetry), so sampling the tiny beach
// AOI directly can return null. Sampling a 15 km buffer around the AOI's
// centroid instead reliably lands on valid open-water grid cells nearby;
// masked land pixels inside the buffer are simply ignored by the mean
// reducer.
var waveSamplingArea = aoi.centroid().buffer(15000);

function waveStats(img) {
  var stats = img.reduceRegion({reducer: ee.Reducer.mean(), geometry: waveSamplingArea, scale: 9000, bestEffort: true});
  return ee.Feature(null, {
    'system:time_start': img.get('system:time_start'),
    'datetime': ee.Date(img.get('system:time_start')).format('YYYY-MM-dd HH:mm'),
    'day': ee.Date(img.get('system:time_start')).format('YYYY-MM-dd'),
    'vhm0': stats.get('VHM0')
  });
}
var waveFeatures = ee.FeatureCollection(waveCollection.map(waveStats)).sort('system:time_start');

// NOTE: xProperty is the numeric 'system:time_start' (not the 'datetime'
// string) — with ~1800+ points, a string x-axis triggered "Data column(s)
// for axis #0 cannot be of type string" from the underlying chart library.
var waveChart = ui.Chart.feature.byFeature({
  features: waveFeatures,
  xProperty: 'system:time_start',
  yProperties: ['vhm0']
}).setChartType('LineChart').setOptions({
  title: 'Significant wave height (VHM0) near the AOI',
  vAxis: {title: 'Hs (m)'},
  hAxis: {title: 'Date', slantedText: true},
  lineWidth: 1,
  pointSize: 2
});
print(waveChart);

// Daily max Hs, to spot storm days without 3-hourly noise
var uniqueDays = ee.List(waveFeatures.aggregate_array('day')).distinct();
var dailyMaxFeatures = uniqueDays.map(function (d) {
  d = ee.String(d);
  var dayFeatures = waveFeatures.filter(ee.Filter.eq('day', d));
  return ee.Feature(null, {
    'day': d,
    'max_vhm0': dayFeatures.aggregate_max('vhm0')
  });
});
var dailyMaxFC = ee.FeatureCollection(dailyMaxFeatures).sort('day');

var stormDays = dailyMaxFC.filter(ee.Filter.gt('max_vhm0', waveThresholdM));
print('--- Storm-swell candidate days (max Hs > ' + waveThresholdM + ' m) ---');
print('Number of storm-swell days found:', stormDays.size());
print('Storm dates (copy one into eventDate below):', stormDays.aggregate_array('day'));
print('Max Hs on those dates, same order:', stormDays.aggregate_array('max_vhm0'));

// ==================================================================
// 3. PICK ONE STORM EVENT TO INSPECT
//    Copy a date from the "Storm dates" list printed above.
// ==================================================================
var eventDate = '2026-03-13'; // <-- EDIT: pick one of the printed storm dates
var eventDateEE = ee.Date(eventDate);

// ==================================================================
// 4. CLOUD MASKING (Sentinel-2 QA60 bit mask)
// ==================================================================
function maskS2Clouds(image) {
  var qa = image.select('QA60');
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0).and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  return image.updateMask(mask);
}

// ==================================================================
// 5. NATURAL BEACH SURFACE MASK (ESA WorldCover) — robustness fix
//    Even a carefully-drawn AOI can end up including a street, a roof,
//    or garden vegetation at its edges. Restricting the analysis to
//    "Bare / sparse vegetation" (class 60 — the class sand beaches fall
//    under) structurally excludes Built-up areas (class 50) and other
//    vegetation, regardless of exactly how the AOI was drawn.
// ==================================================================
// ESA/WorldCover/v200 is technically an ImageCollection (one single
// global-mosaic image inside it), not a plain Image — ee.Image() on the
// asset ID directly throws "Asset ... is not an Image".
var bareGround = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').eq(60);
Map.addLayer(bareGround.selfMask().clip(aoi), {palette: ['yellow']}, 'Natural bare-ground mask (ESA WorldCover)', false);

// ==================================================================
// 6. SPECTRAL INDICES: NDVI (algae/vegetation proxy) + MNDWI (wet/dry)
// ==================================================================
var waterThreshold = 0; // MNDWI above this value is classified as water/wet (tunable)

function addIndices(img) {
  var ndvi = img.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var mndwi = img.normalizedDifference(['B3', 'B11']).rename('MNDWI');
  var dry = mndwi.lt(waterThreshold).rename('dry');
  return img.addBands(ndvi).addBands(mndwi).addBands(dry);
}

// ==================================================================
// 7. BASELINE: TYPICAL DRY-SAND NDVI FROM PRE-STORM SCENES
//    Each scene contributes NDVI only at the pixels IT classifies as
//    dry AND natural bare ground — this is what makes the baseline
//    tide-aware (no external tide table needed) and immune to whatever
//    non-beach surface might have slipped into the AOI.
// ==================================================================
var baselineStart = eventDateEE.advance(-45, 'day');
var baselineEnd   = eventDateEE.advance(-5, 'day'); // small buffer before the storm

var s2Baseline = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(aoi)
  .filterDate(baselineStart, baselineEnd)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
  .map(maskS2Clouds)
  .map(addIndices);

print('Baseline (pre-storm) Sentinel-2 scenes:', s2Baseline.size());

var baselineDryNdvi = s2Baseline.map(function (img) {
  return img.select('NDVI').updateMask(img.select('dry').and(bareGround));
});

var baselineMean = baselineDryNdvi.mean().rename('ndvi_mean');
var baselineStdDev = baselineDryNdvi.reduce(ee.Reducer.stdDev()).rename('ndvi_std');

Map.addLayer(s2Baseline.median().clip(displayBuffer),
  {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000}, 'Baseline RGB (pre-storm composite)', false);

// ==================================================================
// 8. POST-STORM SCENE (earliest usable scene within 10 days after)
// ==================================================================
// NOTE: sorted by DATE (closest to the event), not by cloud percentage.
// Stranded wrack piles disperse, dry out (changing their NDVI signature),
// or get collected by artisanal harvesters within days of a storm — so
// picking the least-cloudy scene in the window, even if it's 8-9 days
// later, can mean imaging the beach well after the pile has changed or
// gone. Taking the earliest scene that still clears the cloud filter
// gives the detector its best shot at the fresh deposit.
var s2After = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(aoi)
  .filterDate(eventDateEE, eventDateEE.advance(10, 'day'))
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
  .map(maskS2Clouds)
  .map(addIndices)
  .sort('system:time_start');

print('Candidate post-storm scenes (within 10 days of ' + eventDate + '):', s2After.size());

// A one-time getInfo() here is deliberate: without checking client-side
// whether ANY scene was found, an empty s2After doesn't fail cleanly —
// every line downstream (afterImage, the RGB layer, NDVI, z-score,
// diagnostics, the wave check) throws its own opaque "Parameter ... is
// required and may not be null" error, one after another. Checking once,
// up front, gives ONE clear, actionable message instead of a wall of them.
var s2AfterCount = s2After.size().getInfo();

if (s2AfterCount === 0) {
  print('*** NO POST-STORM SCENE FOUND for ' + eventDate + ' — stopping here. ***');
  print('No Sentinel-2 scene with < 60% cloud cover was found within 10 days after this ' +
    'date (this can happen in a persistently cloudy stretch, or if no satellite pass ' +
    'happened to intersect the AOI in that window). Try: (a) picking a different date from ' +
    'the "Storm dates" list above, (b) widening the search window in Section 8 (change ' +
    '.advance(10, \'day\') to .advance(15, \'day\') or more), or (c) raising the ' +
    'CLOUDY_PIXEL_PERCENTAGE threshold in Section 8 if this beach is often cloudy.');
} else {

var afterImage = ee.Image(s2After.first());
var afterDate = ee.Date(afterImage.get('system:time_start'));
print('Post-storm scene date actually used:', afterDate);

Map.addLayer(afterImage.clip(displayBuffer),
  {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000}, 'Post-storm RGB');
Map.addLayer(afterImage.select('dry').selfMask().clip(aoi),
  {palette: ['orange']}, 'Exposed/dry zone in the post-storm scene', false);

// ==================================================================
// 9. ANOMALY DETECTION: NDVI z-score + minimum connected patch size
// ==================================================================
var zThreshold = 2;        // std devs above typical dry-sand NDVI (tunable)
// Lowered from 8 to 4 (~400 m^2 contiguous at 10 m/pixel). Real wrack lines
// from artisanal-harvested beaches are rarely one solid slab; they tend to
// pile up as several smaller clumps along the high-water mark. A first run
// with minPatchPixels=8 found 27 candidate pixels (z-score > threshold) but
// ZERO of them formed an 8-pixel connected patch — see diagnostic #6 below
// for the largest connected patch actually found, and raise this back up
// if it turns out to be catching noise rather than real clumps.
var minPatchPixels = 4;

var afterNdviDry = afterImage.select('NDVI').updateMask(afterImage.select('dry').and(bareGround));
var zScore = afterNdviDry.subtract(baselineMean).divide(baselineStdDev).rename('zScore');

var candidateMask = zScore.gt(zThreshold);
var patchSize = candidateMask.selfMask().connectedPixelCount({maxSize: 128, eightConnected: true}).rename('patchSize');
var strandingMask = patchSize.gte(minPatchPixels).unmask(0).rename('stranding').selfMask();

Map.addLayer(strandingMask.clip(aoi), {palette: ['brown']}, 'Possible algae stranding');

var strandingAreaM2 = strandingMask.multiply(ee.Image.pixelArea()).reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: aoi,
  scale: 10,
  maxPixels: 1e9,
  bestEffort: true
});
// Printed as a plain number (via .get('stranding')) instead of the raw
// reduceRegion dictionary — the dictionary prints collapsed as "Object (1
// property)" in the Console and needs an extra click to expand, which is
// easy to miss when scanning a long run's output.
print('Estimated stranded-algae area (m^2):', strandingAreaM2.get('stranding'));

// ==================================================================
// 9b. DIAGNOSTICS — pixel counts at every masking stage.
//     A "stranding: 0" result can mean two very different things: (a) a
//     genuine negative (no stranding large/bright enough to trigger the
//     detector for this event), or (b) an upstream mask (bare-ground,
//     dry/wet, or the AOI itself being tiny) leaving too few valid
//     pixels for anything to ever pass. These prints tell them apart —
//     read them top to bottom; whichever count collapses to (near) zero
//     first is the actual bottleneck.
// ==================================================================
print('--- Diagnostics: where did the pixels go? ---');

var bareGroundCount = bareGround.selfMask().reduceRegion({
  reducer: ee.Reducer.count(), geometry: aoi, scale: 10, maxPixels: 1e9, bestEffort: true
});
print('1) "Bare ground" (ESA WorldCover class 60) pixels inside the AOI:', bareGroundCount,
  '(compare against the AOI\'s total ~10 m pixel count — if this is 0 or very low, ' +
  'WorldCover is not classifying this beach as bare ground, and everything downstream ' +
  'will be masked out regardless of any real stranding.)');

var baselineValidCount = baselineMean.reduceRegion({
  reducer: ee.Reducer.count(), geometry: aoi, scale: 10, maxPixels: 1e9, bestEffort: true
});
print('2) Pixels with a valid baseline mean NDVI (dry AND bare-ground, across all baseline scenes):',
  baselineValidCount);

var afterValidCount = afterNdviDry.reduceRegion({
  reducer: ee.Reducer.count(), geometry: aoi, scale: 10, maxPixels: 1e9, bestEffort: true
});
print('3) Pixels valid for z-scoring in the chosen post-storm scene (dry AND bare-ground):',
  afterValidCount, '(if (1) is healthy but this is low, the post-storm scene itself was ' +
  'mostly wet/underwater at capture time — a tide effect, not a mask bug.)');

var zScoreStats = zScore.reduceRegion({
  reducer: ee.Reducer.minMax().combine({reducer2: ee.Reducer.mean(), sharedInputs: true}),
  geometry: aoi, scale: 10, maxPixels: 1e9, bestEffort: true
});
print('4) z-score min / max / mean over the AOI (only where valid):', zScoreStats,
  '(if the max here is well below zThreshold=' + zThreshold + ', that is a genuine negative ' +
  'for this event, not a bug.)');

var candidateCount = candidateMask.selfMask().reduceRegion({
  reducer: ee.Reducer.count(), geometry: aoi, scale: 10, maxPixels: 1e9, bestEffort: true
});
print('5) Candidate pixels BEFORE the minimum patch-size filter (z-score > ' + zThreshold + '):',
  candidateCount, '(if this is >0 but the final stranding area is still 0, minPatchPixels=' +
  minPatchPixels + ' is too strict for this AOI — lower it and re-run.)');

var largestPatch = patchSize.reduceRegion({
  reducer: ee.Reducer.max(), geometry: aoi, scale: 10, maxPixels: 1e9, bestEffort: true
});
print('6) Largest connected candidate patch actually found (pixels):', largestPatch.get('patchSize'),
  '(compare against minPatchPixels=' + minPatchPixels + '. If this is 1-2, the candidate ' +
  'pixels are scattered/isolated — likely noise or misclassification, not a real deposit. ' +
  'If it is close to but just under minPatchPixels, the deposit is real but fragmented, and ' +
  'lowering minPatchPixels further is justified rather than arbitrary.)');

// ==================================================================
// 10. PHYSICAL PLAUSIBILITY CHECK: was there really a storm before
//     the post-storm image was taken?
// ==================================================================
var wavesBetweenEventAndImage = waveFeatures.filter(ee.Filter.and(
  ee.Filter.gte('system:time_start', eventDateEE.advance(-1, 'day').millis()),
  ee.Filter.lte('system:time_start', afterDate.advance(1, 'day').millis())
));
print('Max Hs between the storm date and the post-storm image date:',
  wavesBetweenEventAndImage.aggregate_max('vhm0'));
print('If this is well above ' + waveThresholdM + ' m, the detected stranding is ' +
  'physically consistent with a real storm-swell event.');

} // end of "if a post-storm scene was actually found"
