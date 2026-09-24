// FpS — multiplayer server. Single server: "test"
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const MAX_PLAYERS = 12;
const SERVER_ID = 'test';

const spawns = [
  { x: -20, z: -20, ry: Math.PI / 4 },
  { x: 20, z: -20, ry: -Math.PI / 4 },
  { x: -20, z: 20, ry: (3 * Math.PI) / 4 },
  { x: 20, z: 20, ry: (-3 * Math.PI) / 4 },
  { x: 0, z: -24, ry: 0 },
  { x: 0, z: 24, ry: Math.PI },
  { x: -24, z: 0, ry: Math.PI / 2 },
  { x: 24, z: 0, ry: -Math.PI / 2 },
  { x: -10, z: 0, ry: Math.PI / 2 },
  { x: 10, z: 0, ry: -Math.PI / 2 },
  { x: 0, z: -10, ry: 0 },
  { x: 0, z: 10, ry: Math.PI },
];

// players: socketId -> { id, name, color, pos, rotY, pitch, hp, kills, deaths, alive, anim, lastUpdate }
const players = new Map();

function randomColor() {
  const palette = [0x3498db, 0xe74c3c, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xfd79a8, 0x00cec9, 0x6c5ce7, 0xffeaa7, 0xfab1a0];
  return palette[Math.floor(Math.random() * palette.length)];
}
function getSpawn() {
  return spawns[Math.floor(Math.random() * spawns.length)];
}
function serverInfo() {
  return { id: SERVER_ID, name: 'test', players: players.size, max: MAX_PLAYERS, map: 'Arena-67', mode: 'Deathmatch' };
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, pos: p.pos, rotY: p.rotY, pitch: p.pitch || 0, hp: p.hp, kills: p.kills, deaths: p.deaths, alive: p.alive, anim: p.anim };
}

io.on('connection', (socket) => {
  // server browser
  socket.emit('servers', [serverInfo()]);

  socket.on('get-servers', () => socket.emit('servers', [serverInfo()]));

  socket.on('join-server', ({ serverId, name } = {}) => {
    if (serverId !== SERVER_ID) return socket.emit('join-error', 'Server not found. Only "test" exists.');
    if (players.size >= MAX_PLAYERS) return socket.emit('join-error', 'Server "test" is full.');
    const clean = String(name || 'Player').slice(0, 16) || 'Player';
    const s = getSpawn();
    const p = {
      id: socket.id, name: clean, color: randomColor(),
      pos: { x: s.x, y: 1.7, z: s.z }, rotY: s.ry, pitch: 0,
      hp: 100, kills: 0, deaths: 0, alive: true,
      anim: { moving: false, shooting: false, jumping: false },
    };
    players.set(socket.id, p);
    socket.join(SERVER_ID);
    socket.emit('joined', { you: publicPlayer(p), server: serverInfo() });
    socket.to(SERVER_ID).emit('player-joined', publicPlayer(p));
    io.to(SERVER_ID).emit('players-snapshot', [...players.values()].map(publicPlayer));
    io.emit('servers', [serverInfo()]);
    io.to(SERVER_ID).emit('chat', { sys: true, text: `🟢 ${clean} joined test` });
  });

  socket.on('player-update', (d = {}) => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    if (d.pos && isFinite(d.pos.x) && isFinite(d.pos.z)) {
      p.pos.x = Math.max(-29, Math.min(29, d.pos.x));
      p.pos.z = Math.max(-29, Math.min(29, d.pos.z));
      p.pos.y = Math.max(0.5, Math.min(8, d.pos.y ?? p.pos.y));
    }
    if (isFinite(d.rotY)) p.rotY = d.rotY;
    if (isFinite(d.pitch)) p.pitch = Math.max(-1.4, Math.min(1.4, d.pitch));
    if (d.anim) p.anim = { moving: !!d.anim.moving, shooting: !!d.anim.shooting, jumping: !!d.anim.jumping };
    socket.to(SERVER_ID).emit('player-moved', publicPlayer(p));
  });

  // authoritative damage
  socket.on('shoot-hit', ({ targetId, damage, headshot } = {}) => {
    const shooter = players.get(socket.id);
    const target = players.get(targetId);
    if (!shooter || !target || !target.alive) return;
    if (socket.id === targetId) return;
    const dmg = headshot ? 50 : 25;
    target.hp -= dmg;
    io.to(SERVER_ID).emit('damage', { targetId, hp: Math.max(0, target.hp), attacker: shooter.name, headshot: !!headshot });
    if (target.hp <= 0) {
      target.alive = false;
      target.deaths++;
      shooter.kills++;
      io.to(SERVER_ID).emit('killed', {
        killer: shooter.name, killerId: shooter.id, victim: target.name, victimId: target.id,
        headshot: !!headshot, kills: shooter.kills,
      });
      io.to(SERVER_ID).emit('players-snapshot', [...players.values()].map(publicPlayer));
      // auto respawn after 3s
      setTimeout(() => {
        if (!players.has(targetId)) return;
        const t = players.get(targetId);
        const s = getSpawn();
        t.hp = 100; t.alive = true;
        t.pos = { x: s.x, y: 1.7, z: s.z }; t.rotY = s.ry;
        io.to(SERVER_ID).emit('respawned', publicPlayer(t));
        io.to(SERVER_ID).emit('players-snapshot', [...players.values()].map(publicPlayer));
      }, 3000);
    }
  });

  socket.on('chat', ({ text } = {}) => {
    const p = players.get(socket.id);
    const msg = String(text || '').slice(0, 120);
    if (!msg.trim()) return;
    io.to(SERVER_ID).emit('chat', { name: p ? p.name : '???', text: msg, id: socket.id });
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      players.delete(socket.id);
      io.to(SERVER_ID).emit('player-left', { id: socket.id, name: p.name });
      io.to(SERVER_ID).emit('chat', { sys: true, text: `🔴 ${p.name} left` });
      io.emit('servers', [serverInfo()]);
    }
  });
});

setInterval(() => { io.emit('servers', [serverInfo()]); }, 5000);

server.listen(PORT, () => console.log(`FpS server "test" running on :${PORT}`));
