# Spectroscope

A web page that reads a spectrum from a phone camera looking into a spectroscope
(a slit and a diffraction grating). It runs entirely in the browser and can be added
to an iPhone or Android home screen, where it also works offline.

## Using it

1. Open the page in Safari (iPhone) or Chrome (Android) and add it to the home screen.
2. **Source**: start the camera, or load a photo of the spectrum. Rotate or flip until
   the spectrum runs left to right with blue on the left.
3. **Band**: drag on the picture to put the sampling band on the spectrum. Each
   column inside the band is averaged to give the R, G, B and combined curves.
4. **Calibrate automatically**: point at a fluorescent lamp, or at blue sky or a white
   sheet in sunlight, cover the whole spectrum with the band, choose the light and tap
   **Auto-calibrate**. The lines it finds are listed and can be checked or edited.
   **Or calibrate by hand**: tap the plot on a line you recognise, pick or type its wavelength
   and add it. Add as many lines as you like: two give a straight-line fit, three a
   curved one, and from four on the fit also reports how well the lines agree.
   **Keep** stores a typed wavelength in the list for next time. The calibration is
   remembered for that camera, frame size and orientation.
5. **Save**: write the spectrum (CSV plus a settings file), the plot and the image.

## What it measures

- Column averages of R, G and B inside the band, and their sum.
- Optional: undo the sRGB brightness curve, subtract stray light measured in strips
  above and below the spectrum, average several video frames.
- Columns where pixels reach full scale are marked as clipped on the plot and in the CSV.
- Wavelength comes from a polynomial in the pixel offset from the centre of the frame,
  fitted to the lines you mark. "Shift to match" slides an existing calibration
  sideways using one known line, for when the phone has been remounted.
- Automatic calibration from a fluorescent lamp matches the detected peaks to the
  lamp's mercury, terbium and europium lines. From sunlight it matches the dark lines
  against a stored reference sunlight spectrum (`js/solar.js`, from the public ASTM G173
  standard), then fits through the individual dark features.

The CSV columns are `pixel, wavelength_nm, R, G, B, intensity, clipped_fraction`
(`wavelength_nm` only when calibrated).

## Privacy

Nothing is uploaded. The page has no server side, no analytics and loads nothing from
other sites; a content security policy in `index.html` blocks connections to anywhere
but the page's own address. Settings and calibrations are kept in the browser's local
storage. Files leave the device only through the share sheet or download you choose.

## Limits

- A phone camera sets exposure and white balance by itself and applies its own tone
  curve, so curve heights are relative and approximate. Line positions are reliable
  once calibrated.
- The page shows whatever manual camera controls the browser offers. Many phones
  offer none; in that case take the photo in the camera app with exposure locked and
  load it.
- The R, G and B curves are the camera's processed colour channels, not raw sensor data.

## Running it on a computer

Serve this folder over HTTP and open it in a browser, for example:

    python -m http.server 8000

then go to `http://localhost:8000/`. Opening `index.html` straight from disk does not
work, because browsers refuse to load script modules from `file:` addresses.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | The page and its layout |
| `js/core.js` | Analysis: column averages, peak finding, calibration fit, automatic calibration, CSV |
| `js/solar.js` | Reference sunlight spectrum for automatic calibration |
| `js/plot.js` | Draws the spectrum plot |
| `js/app.js` | Camera, photo loading, controls, saving |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home-screen install and the offline copy |
