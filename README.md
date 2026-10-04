# Tire Roll

Let go of a tire near the top of a mountain and watch where it ends up. There are no controls and no paths: just untouched terrain, real physics and a different line every time.

Open `index.html` in a browser, or serve the folder (for example `python3 -m http.server`).

## Modes

- **Roll down a mountain**: the tire is released at a random spot near the summit and rolls until it runs out of energy, wobbles and falls over.
- **Endless slope**: the mountainside never ends. Terrain, forest and rocks stream in around the tire. If it ever stops, it is picked up and let go again.

Five places: Alpine Meadow, Red Rock Desert, Glacier Peak, Ash Volcano and Lunar Highlands (one-sixth gravity, no air).

## Physics

Real-world units: 9.81 m/s² gravity (1.62 on the Moon), an 11 kg tire, air drag, rolling resistance per surface (grass, sand, snow, cinder, regolith), Coulomb friction, bounces, gyroscopic steering on side slopes, collisions with trunks and boulders, and toppling once it is too slow to stay upright.

## Controls

None for the tire. `C` changes the camera, `M` mutes, `Esc` pauses, `R` lets go again. Phones get a portrait layout and a battery-saver graphics setting automatically.

## Checks

`node tools/test-levels.js` simulates several random releases on every mountain plus ten minutes of endless mode, headlessly.
