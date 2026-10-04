# Tire Roll

A 3D downhill physics ride: pick a hill, let go of the tire, and watch gravity, bumps and banked turns carry it to the bottom, where it wobbles and falls over.

Open `index.html` in a browser (or serve the folder, e.g. `python3 -m http.server`).

- Five hills: Greenhill Meadow, Sunscorch Canyon, Frostbite Peaks, Magma Ridge, Lunar Drift (low gravity)
- `C` cycles camera views, `M` mutes, `Esc` pauses, `R` rolls again
- `node tools/test-levels.js` runs every hill headlessly to check the tire reaches the bottom and topples
