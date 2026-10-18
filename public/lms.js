// Tryb "Last man standing": okrągła arena z dziurą pośrodku, wielu graczy, każdy ma jedną kulkę.
// Wspólny kod serwera (Node.js) i przeglądarki. Zasady planowania i ruchu jak w trybie Football.
(function (root) {
  const L = {
    S: 560, R: 260, HOLE_R: 85,            // płótno 560x560, arena o promieniu 260, dziura o promieniu 85 (ok. 1/3 areny)
    BALL_R: 19, BALLS: 1, MAX_PLAYERS: 6,
    SHOT_SCALE: 0.132, MAX_DRAG: 100, MAX_SPEED: 14, STOP_SPEED: 0.04,
    WALL_E: 0.8, BALL_E: 0.65, FRICTION: 0.985, STEP_MS: 1000 / 60, PLAN_TIME: 20, MAX_SIM_STEPS: 900
  };
  const COLORS = ["#2878e8", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899"];
  const C0 = L.S / 2;                       // środek areny

  function create(n) {
    const ents = [];
    for (let p = 0; p < n; p++) {
      const th = -Math.PI / 2 + 2 * Math.PI * p / n;     // pierwszy gracz u góry, reszta równo wokół
      for (let k = 0; k < L.BALLS; k++) {
        const a = th + (k - (L.BALLS - 1) / 2) * 0.27;   // kulki gracza obok siebie, wyśrodkowane
        const x = C0 + Math.cos(a) * L.R * 0.66, y = C0 + Math.sin(a) * L.R * 0.66;
        ents.push({ owner: p, x, y, vx: 0, vy: 0, r: L.BALL_R, plan: null, alive: true });
      }
    }
    const g = {
      L, n, ents, phase: "plan", timeLeft: L.PLAN_TIME, timerOn: true, simSteps: 0,
      ready: new Array(n).fill(false), out: new Array(n).fill(false), winner: null   // winner: numer gracza, -1 = remis
    };

    const remaining = () => g.out.map((o, i) => o ? -1 : i).filter(i => i >= 0);
    function checkOver() {
      const rem = remaining();
      if (rem.length <= 1) { g.phase = "over"; g.winner = rem.length ? rem[0] : -1; return true; }
      return false;
    }
    function startPlanning() {
      g.phase = "plan"; g.timeLeft = L.PLAN_TIME;
      g.ready = g.out.slice();                // wyeliminowani nie muszą klikać "Gotowe"
      ents.forEach(e => { e.plan = null; });
    }
    function startSim() {
      for (const e of ents) {
        if (e.alive && e.plan && !g.out[e.owner]) { e.vx = e.plan.vx; e.vy = e.plan.vy; }
        e.plan = null;
      }
      g.phase = "sim"; g.simSteps = 0;
    }
    function endTurn() {
      for (let i = 0; i < n; i++) if (!ents.some(e => e.owner === i && e.alive)) g.out[i] = true;
      if (!checkOver()) startPlanning();
    }

    function move(e) {
      const s = Math.hypot(e.vx, e.vy);
      if (s > L.MAX_SPEED) { e.vx = e.vx / s * L.MAX_SPEED; e.vy = e.vy / s * L.MAX_SPEED; }
      e.vx *= L.FRICTION; e.vy *= L.FRICTION;
      if (Math.hypot(e.vx, e.vy) < L.STOP_SPEED) { e.vx = 0; e.vy = 0; }
      e.x += e.vx; e.y += e.vy;
    }
    function wall(e) {                          // odbicie od okrągłej ściany
      const dx = e.x - C0, dy = e.y - C0, d = Math.hypot(dx, dy), max = L.R - e.r;
      if (d <= max) return;
      const nx = dx / d, ny = dy / d;
      e.x = C0 + nx * max; e.y = C0 + ny * max;
      const vn = e.vx * nx + e.vy * ny;
      if (vn > 0) { e.vx -= (1 + L.WALL_E) * vn * nx; e.vy -= (1 + L.WALL_E) * vn * ny; }
    }
    function collide(a, b) {                    // równe masy
      let dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
      const minDist = a.r + b.r;
      if (dist >= minDist) return;
      if (dist < 0.0001) { dx = 1; dy = 0; dist = 1; }
      const nx = dx / dist, ny = dy / dist, corr = Math.max(minDist - dist - 0.01, 0) / 2;
      a.x -= nx * corr; a.y -= ny * corr; b.x += nx * corr; b.y += ny * corr;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel >= 0) return;
      const j = -(1 + L.BALL_E) * rel / 2;
      a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny;
    }

    // plans: tablica {vx, vy} lub null, po jednym wpisie na kulkę gracza
    g.setPlans = (pi, plans) => {
      if (g.phase !== "plan" || g.out[pi] || g.ready[pi] || !Array.isArray(plans)) return false;
      const max = L.MAX_DRAG * L.SHOT_SCALE;
      for (let k = 0; k < L.BALLS; k++) {
        const e = ents[pi * L.BALLS + k], p = plans[k];
        if (!e.alive || !p || typeof p.vx !== "number" || typeof p.vy !== "number" || !isFinite(p.vx) || !isFinite(p.vy)) { e.plan = null; continue; }
        const s = Math.hypot(p.vx, p.vy);
        if (s < 1e-6) { e.plan = null; continue; }
        const f = s > max ? max / s : 1;
        e.plan = { vx: p.vx * f, vy: p.vy * f };
      }
      return true;
    };
    g.setReady = (pi, v) => { if (g.phase === "plan" && !g.out[pi]) g.ready[pi] = !!v; };

    // Gracz opuścił grę: jego kulki znikają.
    g.eliminate = pi => {
      ents.forEach(e => { if (e.owner === pi) { e.alive = false; e.vx = e.vy = 0; e.plan = null; } });
      g.out[pi] = true; g.ready[pi] = true;
      if (g.phase !== "sim" && g.phase !== "over") checkOver();
    };

    g.step = () => {
      if (g.phase === "over") return;
      if (g.phase === "plan") {
        if (g.timerOn) {
          g.timeLeft -= L.STEP_MS / 1000;
          if (g.timeLeft <= 0) g.ready.fill(true);
        } else g.timeLeft = L.PLAN_TIME;
        if (g.ready.every(Boolean)) startSim();
        return;
      }
      const live = ents.filter(e => e.alive);
      live.forEach(move);
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) collide(live[i], live[j]);
      live.forEach(wall);
      for (const e of live) {                   // kulka, której środek wpadł do dziury, przepada
        if (Math.hypot(e.x - C0, e.y - C0) < L.HOLE_R) { e.alive = false; e.vx = e.vy = 0; }
      }
      g.simSteps++;
      if (ents.every(e => !e.alive || (e.vx === 0 && e.vy === 0)) || g.simSteps > L.MAX_SIM_STEPS) {
        ents.forEach(e => { e.vx = e.vy = 0; });
        endTurn();
      }
    };

    const r1 = v => Math.round(v * 10) / 10;
    g.snapshot = () => ({
      p: g.phase, tl: r1(g.timeLeft), to: g.timerOn ? 1 : 0,
      r: g.ready.map(x => x ? 1 : 0), o: g.out.map(x => x ? 1 : 0),
      e: ents.map(e => [r1(e.x), r1(e.y), e.alive ? 1 : 0]), w: g.winner
    });
    g.apply = s => {
      if (s.p === "plan" && g.phase !== "plan") ents.forEach(e => { e.plan = null; });
      g.phase = s.p; g.timeLeft = s.tl; g.timerOn = !!s.to; g.winner = s.w;
      g.ready = s.r.map(Boolean); g.out = s.o.map(Boolean);
      s.e.forEach((a, i) => { ents[i].x = a[0]; ents[i].y = a[1]; ents[i].alive = !!a[2]; });
    };
    return g;
  }

  root.Lms = { L, COLORS, create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Lms;
})(typeof window !== "undefined" ? window : globalThis);
