# FpS — 3D Multiplayer FPS

One server: **test**. Two games included, both join **test**:

1. **FPS2** (the downloaded game) → `public/fps2/` — full game with 11 weapons,
   4 maps (Cargo, Vertex, Ghost, City), vehicles, store, touch + gamepad support.
   Open `/fps2/` or press **PLAY FPS2 ON TEST** in the menu.
2. **FpS Classic** (built-in arena) → `/` — lightweight Socket.IO deathmatch with bots.

Patched so there is only one server: FPS2's lobby browser / create / code
options are bypassed — Quick Play goes straight to `src.html?lobby=test`,
and `src.html` forces the multiplayer channel to `"test"`.

## Run locally
```
npm install
npm start
```
Open http://localhost:3000

## Put on Render (website)
1. Push this folder to GitHub.
2. Go to https://dashboard.render.com → New → Web Service → select repo.
3. Render reads `render.yaml` automatically:
   - Build: `npm install`
   - Start: `npm start`
4. Open your `https://fps-game.onrender.com` link — everyone joins server **test**.

## Controls
- PC: WASD move, mouse look (click to lock), click shoot, R reload, Shift sprint, Space jump, Tab scores, Enter chat.
- Mobile (auto-detected): left stick move, drag right side look, 🔥 shoot, ▲ jump, ⟳ reload.

## Features
- Main menu + server browser (only "test")
- Procedural 3D soldiers with walk / shoot / death animations + nametags
- Detailed FP gun viewmodel: bob, recoil, muzzle flash + light, reload dip animation, tracers, impacts, blood
- Arena map with crates, towers, glow pillar, health packs
- Multiplayer via Socket.IO: positions, authoritative HP/kills, killfeed, scoreboard, chat
- 3 practice bots so it's fun even alone
