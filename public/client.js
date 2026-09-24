import * as THREE from 'three';

/* ============ DEVICE DETECT (auto PC / mobile) ============ */
const isMobile = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const badge = document.getElementById('device-badge');
badge.textContent = isMobile ? '📱 mobile controls: ON' : '🖥️ pc controls: WASD + mouse';
document.getElementById('controls-help').textContent = isMobile
  ? 'Left stick = move · drag right side = look · 🔥 = shoot'
  : 'Click PLAY then click the game to lock mouse. WASD move, Click shoot.';

/* ============ MENU / SERVER BROWSER (only server: "test") ============ */
const socket = io();
const $ = (id) => document.getElementById(id);
let serverList = [{ id: 'test', name: 'test', players: 0, max: 12 }];
let myName = 'Player';

function renderServers() {
  const el = $('server-list'); el.innerHTML = '';
  serverList.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'server-row';
    row.innerHTML = `<div class="sname">🟢 ${s.name} <small>${s.map || ''}</small></div><div class="splayers">${s.players}/${s.max}</div>`;
    row.onclick = () => joinGame();
    el.appendChild(row);
  });
}
socket.on('servers', (s) => { serverList = s; renderServers(); });
socket.on('connect', () => socket.emit('get-servers'));
renderServers();
$('play-btn').onclick = () => joinGame();

let joined = false;
function joinGame() {
  myName = ($('nickname').value || 'Player').slice(0, 16);
  socket.emit('join-server', { serverId: 'test', name: myName });
}
socket.on('join-error', (m) => { $('menu-error').textContent = m; });
socket.on('joined', ({ you }) => {
  joined = true;
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (isMobile) $('mobile-ui').classList.remove('hidden');
  me.id = you.id;
  startGame(you);
});

/* ============ GAME CORE ============ */
let scene, camera, renderer, clock;
let me = { id: null, pos: new THREE.Vector3(0, 1.7, 0), yaw: 0, pitch: 0, vy: 0, grounded: true, hp: 100, alive: true, mag: 30, reserve: 90, reloading: false, kills: 0, deaths: 0 };
let keys = {}, shooting = false, lastShot = 0, walkTime = 0, recoil = 0, reloadT = 0;
let remotes = new Map();   // socketId -> { group, parts, data, walkPhase, deadT }
let bots = [];             // local practice bots so game is fun solo
let crates = [];           // { mesh, box:THREE.Box3 }
let tracers = [], particles = [], packs = [];
let gun, muzzle, muzzleLight, gunBase = new THREE.Vector3(0.32, -0.3, -0.6);
let started = false;

const SPAWN_Y = 1.7;

/* ---------- 3D soldier model (procedural, animated) ---------- */
function makeNameSprite(name, color = '#fff') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 8, 0, 0);
  g.font = 'bold 34px Arial'; g.textAlign = 'center';
  g.fillStyle = color; g.fillText(name.slice(0, 14), 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set(2.2, 0.55, 1); sp.position.y = 2.35;
  return sp;
}

function createSoldier(colorHex, name) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 });
  const skin = mat(0xe8b98a), shirt = mat(colorHex), pants = mat(0x2d3436), dark = mat(0x111111);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.75, 0.34), shirt); torso.position.y = 1.2; g.add(torso);
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.4, 0.38), mat(0x222831)); vest.position.y = 1.22; g.add(vest);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), skin); head.position.y = 1.85; g.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 10, 0, Math.PI * 2, 0, 1.4), mat(0x3d4a3d)); helmet.position.y = 1.9; g.add(helmet);

  const mkLimb = (w, h, m, x, y) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), m); mesh.geometry.translate(0, -h / 2, 0); mesh.position.set(x, y, 0); g.add(mesh); return mesh; };
  const armL = mkLimb(0.16, 0.65, shirt, -0.42, 1.5);
  const armR = mkLimb(0.16, 0.65, shirt, 0.42, 1.5);
  const legL = mkLimb(0.2, 0.8, pants, -0.16, 0.85);
  const legR = mkLimb(0.2, 0.8, pants, 0.16, 0.85);

  // enemy gun (low-poly rifle)
  const gunG = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.85), dark); gunG.add(body);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.12), mat(0x555555)); mag.position.set(0, -0.14, 0.05); mag.rotation.x = 0.3; gunG.add(mag);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.25), mat(0x888888)); tip.position.z = -0.5; gunG.add(tip);
  gunG.position.set(0.3, 1.35, -0.4); gunG.rotation.y = Math.PI;
  g.add(gunG);

  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0 }));
  flash.position.set(0.3, 1.35, -0.95); g.add(flash);

  // hitbox (invisible, for raycast)
  const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.1, 0.9), new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.position.y = 1.05; hitbox.userData.isPlayer = true; g.add(hitbox);

  if (name) g.add(makeNameSprite(name, '#9fd0ff'));
  g.traverse((o) => { o.frustumCulled = false; });
  return { group: g, armL, armR, legL, legR, head, flash, hitbox, gunG };
}

/* ---------- first-person view-model gun ---------- */
function createViewGun() {
  const grp = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d23, roughness: 0.45, metalness: 0.6 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x39414f, roughness: 0.5, metalness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x1e90ff, roughness: 0.4, emissive: 0x0a2a55 });
  const add = (geo, m, x, y, z, rx = 0) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.x = rx; grp.add(o); return o; };
  add(new THREE.BoxGeometry(0.09, 0.13, 0.7), dark, 0, 0, 0);                       // receiver
  add(new THREE.BoxGeometry(0.07, 0.07, 0.45), mid, 0, 0.02, -0.55);                 // barrel
  add(new THREE.BoxGeometry(0.03, 0.1, 0.03), accent, 0, 0.09, -0.5);                // front sight
  add(new THREE.BoxGeometry(0.08, 0.16, 0.1), dark, 0, -0.13, 0.12, 0.25);           // grip
  add(new THREE.BoxGeometry(0.07, 0.18, 0.14), mid, 0, -0.14, -0.08, 0.25);          // mag
  add(new THREE.BoxGeometry(0.1, 0.14, 0.22), dark, 0, -0.01, 0.42);                 // stock
  add(new THREE.BoxGeometry(0.02, 0.02, 0.2), accent, -0.045, 0.045, -0.1);          // rail glow
  const hands = new THREE.MeshStandardMaterial({ color: 0xe8b98a, roughness: 0.8 });
  add(new THREE.BoxGeometry(0.09, 0.09, 0.12), hands, 0.01, -0.12, 0.12);
  add(new THREE.BoxGeometry(0.09, 0.09, 0.12), hands, 0.01, -0.13, -0.1);
  muzzle = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 10), new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0 }));
  muzzle.rotation.x = -Math.PI / 2; muzzle.position.set(0, 0.02, -0.85); grp.add(muzzle);
  muzzleLight = new THREE.PointLight(0xffaa33, 0, 8); muzzleLight.position.set(0, 0, -1); grp.add(muzzleLight);
  grp.position.copy(gunBase);
  return grp;
}

/* ---------- map ---------- */
function buildMap() {
  scene.fog = new THREE.Fog(0x0b0e14, 40, 110);
  scene.background = new THREE.Color(0x0b0e14);
  scene.add(new THREE.HemisphereLight(0x8ab4ff, 0x223311, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(20, 30, 10); scene.add(sun);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(62, 62), new THREE.MeshStandardMaterial({ color: 0x1c2333, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.userData.ground = true; scene.add(floor);
  const grid = new THREE.GridHelper(62, 31, 0x1e90ff, 0x2a3a5f); grid.position.y = 0.01; scene.add(grid);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c3e57, roughness: 0.8 });
  const mkWall = (x, z, w, d, h = 4) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, h / 2, z); scene.add(m);
    crates.push({ mesh: m, box: new THREE.Box3().setFromObject(m) });
  };
  mkWall(0, -30.5, 62, 1, 6); mkWall(0, 30.5, 62, 1, 6); mkWall(-30.5, 0, 1, 62, 6); mkWall(30.5, 0, 1, 62, 6);

  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6b4f2a, roughness: 0.85 });
  const crateMat2 = new THREE.MeshStandardMaterial({ color: 0x3f5a3a, roughness: 0.85 });
  const spots = [[-8, -8, 2], [8, -6, 1.5], [0, 0, 2.4], [-12, 8, 1.6], [12, 10, 2], [0, -16, 1.6], [-16, 0, 2], [16, -2, 1.6], [5, 14, 1.4], [-5, 16, 1.4], [10, -14, 2], [-10, 14, 1.5]];
  spots.forEach(([x, z, s], i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), i % 2 ? crateMat2 : crateMat);
    m.position.set(x, s / 2, z); m.rotation.y = (i * 0.4) % 1; scene.add(m);
    crates.push({ mesh: m, box: new THREE.Box3().setFromObject(m) });
  });
  // towers
  [[-22, -22], [22, -22], [-22, 22], [22, 22]].forEach(([x, z]) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 4), wallMat);
    t.position.set(x, 2.5, z); scene.add(t);
    crates.push({ mesh: t, box: new THREE.Box3().setFromObject(t) });
  });
  // center glowing pillar
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.3, 7, 12), new THREE.MeshStandardMaterial({ color: 0x1e90ff, emissive: 0x0a2c66, roughness: 0.3 }));
  pillar.position.set(0, 3.5, -8); scene.add(pillar);
}

function spawnPack(x, z) {
  const grp = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x2ecc71, emissive: 0x0a5a2a }));
  const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  grp.add(box, c1, c2); grp.position.set(x, 0.5, z); scene.add(grp);
  packs.push({ grp, x, z, taken: false });
}
function collide(pos, r = 0.5) {
  pos.x = Math.max(-29, Math.min(29, pos.x));
  pos.z = Math.max(-29, Math.min(29, pos.z));
  for (const c of crates) {
    const b = c.box;
    if (pos.x + r > b.min.x && pos.x - r < b.max.x && pos.z + r > b.min.z && pos.z - r < b.max.z && pos.y < b.max.y + 0.3) {
      const dx1 = pos.x + r - b.min.x, dx2 = b.max.x - (pos.x - r);
      const dz1 = pos.z + r - b.min.z, dz2 = b.max.z - (pos.z - r);
      const m = Math.min(dx1, dx2, dz1, dz2);
      if (m === dx1) pos.x = b.min.x - r; else if (m === dx2) pos.x = b.max.x + r;
      else if (m === dz1) pos.z = b.min.z - r; else pos.z = b.max.z + r;
    }
  }
}

/* ---------- bots (fun solo play) ---------- */
function spawnBots() {
  const names = ['RexBOT', 'NovaBOT', 'ViperBOT'];
  const colors = [0xe74c3c, 0x9b59b6, 0xe67e22];
  names.forEach((n, i) => {
    const s = createSoldier(colors[i], n + ' 🤖');
    s.group.position.set(-10 + i * 10, 0, 12);
    scene.add(s.group);
    bots.push({ name: n, parts: s, pos: s.group.position, yaw: Math.random() * 6, hp: 100, alive: true, speed: 2 + Math.random() * 1.5, t: Math.random() * 5, shootCd: 2, walkPhase: 0, respawnT: 0 });
  });
}

/* ---------- game start ---------- */
function startGame(you) {
  if (started) return; started = true;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.05, 300);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  document.body.appendChild(renderer.domElement);
  clock = new THREE.Clock();
  buildMap();
  gun = createViewGun(); camera.add(gun); scene.add(camera);
  me.pos.set(you.pos.x, SPAWN_Y, you.pos.z); me.yaw = you.rotY || 0;

  spawnPack(-8, 4); spawnPack(8, -4); spawnPack(0, 20); spawnPack(-20, 0);
  spawnBots();
  bindInputs();
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  setInterval(sendUpdate, 50);
  addChat('sys', 'Welcome to FpS · server "test" · good luck!');
  renderer.setAnimationLoop(loop);
}

/* ---------- input: PC + mobile auto ---------- */
function bindInputs() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); refreshScores(); }
    if (e.code === 'Enter' && document.activeElement !== $('chat-input')) { e.preventDefault(); $('chat-input').focus(); }
    if (e.code === 'KeyR') startReload();
  });
  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
  });
  // pointer lock shooting (PC)
  document.addEventListener('mousedown', (e) => {
    if (!joined || isMobile) return;
    if (document.pointerLockElement !== renderer.domElement) { renderer.domElement.requestPointerLock?.(); $('hint').style.display = 'none'; return; }
    if (e.button === 0) shooting = true;
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) shooting = false; });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement || !me.alive) return;
    me.yaw -= e.movementX * 0.0022;
    me.pitch -= e.movementY * 0.0022;
    me.pitch = Math.max(-1.4, Math.min(1.4, me.pitch));
  });
  renderer.domElement.addEventListener('click', () => { if (!isMobile) renderer.domElement.requestPointerLock?.(); });

  /* mobile: joystick + look drag + buttons */
  if (isMobile) {
    const joy = $('joystick'), stick = $('stick');
    let joyId = null, jx = 0, jy = 0;
    joy.addEventListener('touchstart', (e) => { joyId = e.changedTouches[0].identifier; }, { passive: true });
    addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          const r = joy.getBoundingClientRect();
          let dx = t.clientX - (r.left + 60), dy = t.clientY - (r.top + 60);
          const len = Math.hypot(dx, dy) || 1, max = 45;
          if (len > max) { dx *= max / len; dy *= max / len; }
          stick.style.left = 35 + dx + 'px'; stick.style.top = 35 + dy + 'px';
          jx = dx / max; jy = dy / max;
        }
      }
    }, { passive: true });
    addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; jx = jy = 0; stick.style.left = '35px'; stick.style.top = '35px'; }
    });
    me.joy = () => ({ jx, jy });

    const look = $('look-area');
    let lookId = null, lx = 0, ly = 0;
    look.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; }, { passive: true });
    addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === lookId && me.alive) {
        me.yaw -= (t.clientX - lx) * 0.0045;
        me.pitch -= (t.clientY - ly) * 0.0045;
        me.pitch = Math.max(-1.4, Math.min(1.4, me.pitch));
        lx = t.clientX; ly = t.clientY;
      }
    }, { passive: true });
    addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; });
    const hold = (id, down, up) => {
      const b = $(id);
      b.addEventListener('touchstart', (e) => { e.preventDefault(); down(); }, { passive: false });
      b.addEventListener('touchend', () => up?.());
    };
    hold('btn-fire', () => (shooting = true), () => (shooting = false));
    hold('btn-jump', () => { if (me.grounded && me.alive) { me.vy = 5; me.grounded = false; } });
    hold('btn-reload', () => startReload());
  }
}

/* ---------- shooting / reload ---------- */
function startReload() {
  if (me.reloading || me.mag === 30 || me.reserve <= 0 || !me.alive) return;
  me.reloading = true; reloadT = 0;
  $('reload-hint').textContent = 'reloading…';
}
function finishReload() {
  const need = 30 - me.mag, take = Math.min(need, me.reserve);
  me.mag += take; me.reserve -= take; me.reloading = false;
  $('reload-hint').textContent = '';
}

function shoot() {
  const now = performance.now();
  if (now - lastShot < 130 || me.reloading || !me.alive) return;
  if (me.mag <= 0) { startReload(); return; }
  lastShot = now; me.mag--; recoil = Math.min(1, recoil + 0.35);
  // muzzle flash anim
  muzzle.material.opacity = 1; muzzle.scale.setScalar(0.8 + Math.random() * 0.6);
  muzzleLight.intensity = 6;
  setTimeout(() => { muzzle.material.opacity = 0; muzzleLight.intensity = 0; }, 50);

  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02), camera);
  rc.far = 80;

  // gather targets: remote hitboxes + bot hitboxes
  const targets = [];
  remotes.forEach((r, id) => { if (r.data.alive) { r.parts.hitbox.userData.pid = id; r.parts.hitbox.userData.isBot = false; targets.push(r.parts.hitbox); } });
  bots.forEach((b, i) => { if (b.alive) { b.parts.hitbox.userData.pid = 'bot' + i; b.parts.hitbox.userData.isBot = true; targets.push(b.parts.hitbox); } });
  const hits = rc.intersectObjects(targets, false);
  // wall distance for tracer end
  const wallHits = rc.intersectObjects(crates.map((c) => c.mesh), false);
  let end;
  if (hits.length) {
    const h = hits[0];
    const isHead = h.point.y > (h.object.userData.isBot ? botHeadY(h.object) : h.object.getWorldPosition(new THREE.Vector3()).y + 0.6);
    end = h.point;
    damageTarget(h.object.userData.pid, h.object.userData.isBot, isHead, h.point);
  } else {
    end = wallHits.length ? wallHits[0].point : rc.ray.at(60, new THREE.Vector3());
    impactFX(end);
  }
  tracerFX(end);
  updateAmmoUI();
  if (me.mag === 0) startReload();
}
function botHeadY(hitbox) {
  const p = new THREE.Vector3(); hitbox.getWorldPosition(p); return p.y + 0.55;
}

function damageTarget(pid, isBot, headshot, point) {
  hitFX();
  if (isBot) {
    const b = bots[+String(pid).replace('bot', '')];
    if (!b || !b.alive) return;
    b.hp -= headshot ? 50 : 25;
    bloodFX(point);
    if (b.hp <= 0) {
      b.alive = false; b.respawnT = 3; me.kills++;
      addKill(`${myName} 💥 ${b.name}`, true);
      addChat('sys', `☠️ you eliminated ${b.name}${headshot ? ' (HEADSHOT)' : ''}`);
      updateScoreUI();
    }
    return;
  }
  bloodFX(point);
  socket.emit('shoot-hit', { targetId: pid, headshot });
}

/* ---------- FX: tracers, impacts, blood, muzzle ---------- */
function tracerFX(end) {
  const start = new THREE.Vector3(); muzzle.getWorldPosition(start);
  const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95 }));
  scene.add(line); tracers.push({ line, life: 0.07 });
}
function impactFX(p) {
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: 0xffcc66 }));
    m.position.copy(p);
    m.userData.v = new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5);
    scene.add(m); particles.push({ m, life: 0.4 });
  }
}
function bloodFX(p) {
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), new THREE.MeshBasicMaterial({ color: 0xdd2222 }));
    m.position.copy(p);
    m.userData.v = new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3 + 1, (Math.random() - 0.5) * 4);
    scene.add(m); particles.push({ m, life: 0.5 });
  }
}

/* ---------- HUD ---------- */
function updateAmmoUI() { $('ammo-mag').textContent = me.mag; $('ammo').childNodes[1].textContent = ` / ${me.reserve}`; }
function updateScoreUI() { $('score-mini').textContent = `${me.kills} K · ${me.deaths} D`; }
function hitFX() {
  const h = $('hitmarker'); h.classList.add('show');
  clearTimeout(hitFX.t); hitFX.t = setTimeout(() => h.classList.remove('show'), 120);
}
function addKill(html, mine) {
  const d = document.createElement('div'); d.className = 'kill-item';
  d.innerHTML = mine ? `<b>${html}</b>` : html;
  $('killfeed').prepend(d);
  setTimeout(() => d.remove(), 5000);
  while ($('killfeed').children.length > 5) $('killfeed').lastChild.remove();
}
function addChat(name, text) {
  const d = document.createElement('div'); d.className = 'chat-msg' + (name === 'sys' ? ' sys' : '');
  d.innerHTML = name === 'sys' ? text : `<b>${name}:</b> ${text.replace(/</g, '&lt;')}`;
  $('chat-log').appendChild(d);
  while ($('chat-log').children.length > 30) $('chat-log').firstChild.remove();
}
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) { socket.emit('chat', { text: e.target.value }); e.target.value = ''; e.target.blur(); }
  e.stopPropagation();
});
function refreshScores() {
  let rows = `<tr><th>player</th><th>K</th><th>D</th></tr>`;
  rows += `<tr><td>⭐ ${myName} (you)</td><td>${me.kills}</td><td>${me.deaths}</td></tr>`;
  remotes.forEach((r) => { rows += `<tr><td>${r.data.name}</td><td>${r.data.kills}</td><td>${r.data.deaths}</td></tr>`; });
  bots.forEach((b) => { rows += `<tr><td>🤖 ${b.name}</td><td>–</td><td>–</td></tr>`; });
  $('score-table').innerHTML = rows;
}

/* ---------- network events ---------- */
socket.on('players-snapshot', (list) => {
  list.forEach((p) => { if (p.id !== me.id && !remotes.has(p.id)) addRemote(p); });
});
socket.on('player-joined', (p) => { if (p.id !== me.id) { addRemote(p); addChat('sys', `🟢 ${p.name} joined`); } });
socket.on('player-moved', (p) => {
  if (p.id === me.id) return;
  let r = remotes.get(p.id);
  if (!r) r = addRemote(p);
  r.data = p;
});
socket.on('player-left', ({ id, name }) => { removeRemote(id); addChat('sys', `🔴 ${name} left`); });
socket.on('damage', ({ targetId, hp }) => {
  if (targetId === me.id) {
    me.hp = hp; updateHP();
    if (hp <= 0) die();
  }
});
socket.on('killed', ({ killer, victim, headshot }) => {
  addKill(`<i>${killer}</i> 💥 <b>${victim}</b>${headshot ? ' 🎯' : ''}`, killer === myName || victim === myName);
  if (killer === myName) { me.kills++; updateScoreUI(); }
  if (victim === myName) return;
  const r = [...remotes.values()].find((x) => x.data.name === victim);
  if (r) playDeath(r);
});
socket.on('respawned', (p) => {
  if (p.id === me.id) { me.hp = 100; me.alive = true; me.pos.set(p.pos.x, SPAWN_Y, p.pos.z); updateHP(); $('respawn-overlay').classList.add('hidden'); return; }
  const r = remotes.get(p.id);
  if (r) { r.data = p; r.group.visible = true; r.group.rotation.x = 0; r.group.position.y = 0; }
});
socket.on('chat', (m) => { m.sys ? addChat('sys', m.text) : addChat(m.name, m.text); });

function addRemote(p) {
  const parts = createSoldier(p.color, p.name);
  parts.group.position.set(p.pos.x, 0, p.pos.z);
  scene.add(parts.group);
  const r = { parts, group: parts.group, data: p, walkPhase: 0 };
  remotes.set(p.id, r);
  return r;
}
function removeRemote(id) { const r = remotes.get(id); if (r) { scene.remove(r.group); remotes.delete(id); } }
function playDeath(r) { r.deadT = 0.001; }
function updateHP() {
  $('hp-fill').style.width = me.hp + '%';
  $('hp-text').textContent = Math.max(0, Math.ceil(me.hp));
  $('hp-fill').style.background = me.hp > 50 ? '' : me.hp > 25 ? 'linear-gradient(90deg,#f39c12,#e67e22)' : 'linear-gradient(90deg,#e74c3c,#c0392b)';
}
function die() {
  me.alive = false; me.deaths++; shooting = false; updateScoreUI();
  $('respawn-overlay').classList.remove('hidden');
  $('respawn-timer').textContent = 'respawning in 3…2…1';
}

/* ---------- net send ---------- */
let movingNow = false;
function sendUpdate() {
  if (!joined || !started) return;
  socket.emit('player-update', { pos: { x: me.pos.x, y: me.pos.y, z: me.pos.z }, rotY: me.yaw, pitch: me.pitch, anim: { moving: movingNow, shooting, jumping: !me.grounded } });
}

/* ---------- bots AI ---------- */
function updateBots(dt) {
  for (const b of bots) {
    if (!b.alive) {
      b.respawnT -= dt;
      b.parts.group.rotation.x = Math.min(Math.PI / 2, b.parts.group.rotation.x + dt * 4);
      if (b.respawnT <= 0) {
        b.alive = true; b.hp = 100;
        b.pos.set(-15 + Math.random() * 30, 0, -15 + Math.random() * 30);
        b.parts.group.rotation.x = 0; b.parts.group.visible = true;
      }
      continue;
    }
    b.t -= dt;
    if (b.t <= 0) { b.t = 2 + Math.random() * 3; b.yaw = Math.random() * Math.PI * 2; }
    // chase player a bit
    const toMe = new THREE.Vector3().subVectors(new THREE.Vector3(me.pos.x, 0, me.pos.z), b.pos);
    const dist = toMe.length();
    if (me.alive && dist < 16) b.yaw = Math.atan2(-toMe.x, -toMe.z) + Math.PI;
    const nx = b.pos.x + Math.sin(b.yaw) * b.speed * dt * -1;
    const nz = b.pos.z + Math.cos(b.yaw) * b.speed * dt * -1;
    const tmp = new THREE.Vector3(nx, 0, nz); collide(tmp, 0.5);
    b.pos.x = tmp.x; b.pos.z = tmp.z;
    b.parts.group.position.copy(b.pos);
    b.parts.group.rotation.y = b.yaw;
    // walk anim
    b.walkPhase += dt * 9;
    b.parts.legL.rotation.x = Math.sin(b.walkPhase) * 0.7;
    b.parts.legR.rotation.x = -Math.sin(b.walkPhase) * 0.7;
    b.parts.armL.rotation.x = -Math.sin(b.walkPhase) * 0.5;
    // bot shoots at player
    b.shootCd -= dt;
    if (me.alive && dist < 20 && b.shootCd <= 0) {
      b.shootCd = 0.9 + Math.random();
      b.parts.flash.material.opacity = 1;
      setTimeout(() => (b.parts.flash.material.opacity = 0), 80);
      // 35% hit chance, worse at range
      if (Math.random() < 0.35 && dist < 18) {
        me.hp -= 8; updateHP(); hitDirFX();
        if (me.hp <= 0) { me.hp = 0; updateHP(); die(); me.kills = me.kills; socket.emit('chat', { text: `died to ${b.name} 🤖` }); setTimeout(() => { me.hp = 100; me.alive = true; updateHP(); $('respawn-overlay').classList.add('hidden'); me.pos.set(0, SPAWN_Y, 20); }, 3000); }
      }
    }
  }
}
function hitDirFX() {
  document.body.style.boxShadow = 'inset 0 0 120px rgba(255,0,0,.7)';
  setTimeout(() => (document.body.style.boxShadow = ''), 150);
}

/* ---------- main loop ---------- */
const vel = new THREE.Vector3();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // movement (PC + mobile stick)
  movingNow = false;
  if (me.alive) {
    const speed = (keys.ShiftLeft || keys.ShiftRight) ? 8 : 5;
    const f = new THREE.Vector3(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const wish = new THREE.Vector3();
    if (!isMobile) {
      if (keys.KeyW) wish.add(f); if (keys.KeyS) wish.sub(f);
      if (keys.KeyD) wish.add(r); if (keys.KeyA) wish.sub(r);
      if (keys.Space && me.grounded) { me.vy = 5.2; me.grounded = false; }
    } else if (me.joy) {
      const { jx, jy } = me.joy();
      wish.addScaledVector(f, -jy); wish.addScaledVector(r, jx);
    }
    if (wish.lengthSq() > 0) { wish.normalize().multiplyScalar(speed * dt); movingNow = true; walkTime += dt; }
    me.pos.add(wish); collide(me.pos, 0.5);
    // gravity / jump
    me.vy -= 12 * dt; me.pos.y += me.vy * dt;
    if (me.pos.y <= SPAWN_Y) { me.pos.y = SPAWN_Y; me.vy = 0; me.grounded = true; }

    if (shooting) shoot();
    if (me.reloading) { reloadT += dt; if (reloadT > 1.6) finishReload(); }
    recoil = Math.max(0, recoil - dt * 4);

    // health packs
    for (const p of packs) {
      if (p.taken) continue;
      p.grp.rotation.y += dt * 2; p.grp.position.y = 0.5 + Math.sin(t * 3) * 0.12;
      if (Math.hypot(me.pos.x - p.x, me.pos.z - p.z) < 1.2 && me.hp < 100) {
        me.hp = Math.min(100, me.hp + 40); updateHP(); p.taken = true; p.grp.visible = false;
        setTimeout(() => { p.taken = false; p.grp.visible = true; }, 15000);
        addChat('sys', '💚 +40 HP');
      }
    }
  }

  // camera = head
  camera.position.set(me.pos.x, me.pos.y + (me.alive ? Math.sin(walkTime * 10) * 0.03 : -0.8), me.pos.z);
  camera.rotation.set(0, 0, 0); camera.rotateY(me.yaw); camera.rotateX(me.pitch + recoil * 0.06);

  // viewmodel gun animation: bob + recoil + reload dip
  if (gun) {
    const bobY = movingNow ? Math.sin(walkTime * 11) * 0.018 : Math.sin(t * 1.8) * 0.006;
    const bobX = movingNow ? Math.cos(walkTime * 9) * 0.012 : 0;
    gun.position.set(gunBase.x + bobX, gunBase.y + bobY - recoil * 0.03, gunBase.z + recoil * 0.12);
    gun.rotation.x = recoil * 0.18;
    if (me.reloading) { const k = Math.sin(Math.min(1, reloadT / 1.6) * Math.PI); gun.position.y -= k * 0.25; gun.rotation.x -= k * 0.9; gun.rotation.z = k * 0.4; }
    else gun.rotation.z = 0;
    gun.visible = me.alive;
  }

  // remotes animation: walk cycle + death fall + face
  remotes.forEach((r) => {
    const d = r.data;
    r.group.position.set(d.pos.x, 0, d.pos.z);
    r.group.rotation.y = d.rotY;
    if (!d.alive) { r.group.rotation.x = Math.min(Math.PI / 2.2, r.group.rotation.x + dt * 5); return; }
    r.group.rotation.x = 0;
    if (d.anim?.moving) {
      r.walkPhase += dt * 10;
      r.parts.legL.rotation.x = Math.sin(r.walkPhase) * 0.75;
      r.parts.legR.rotation.x = -Math.sin(r.walkPhase) * 0.75;
      r.parts.armL.rotation.x = -Math.sin(r.walkPhase) * 0.55;
    } else {
      r.parts.legL.rotation.x *= 0.85; r.parts.legR.rotation.x *= 0.85; r.parts.armL.rotation.x *= 0.85;
    }
    r.parts.armR.rotation.x = d.anim?.shooting ? -1.2 : -0.15;
    r.parts.flash.material.opacity = d.anim?.shooting ? 1 : Math.max(0, r.parts.flash.material.opacity - dt * 12);
    r.parts.head.rotation.x = THREE.MathUtils.clamp(-(d.pitch || 0) * 0.5, -0.6, 0.6);
  });

  updateBots(dt);

  // fx lifetimes
  for (let i = tracers.length - 1; i >= 0; i--) { tracers[i].life -= dt; tracers[i].line.material.opacity = Math.max(0, tracers[i].life * 12); if (tracers[i].life <= 0) { scene.remove(tracers[i].line); tracers.splice(i, 1); } }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt;
    p.m.userData.v.y -= 9 * dt; p.m.position.addScaledVector(p.m.userData.v, dt);
    if (p.life <= 0) { scene.remove(p.m); particles.splice(i, 1); }
  }

  renderer.render(scene, camera);
}
