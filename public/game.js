// Wspólna logika gry: używana przez serwer (Node.js) i przeglądarkę. Bez kodu rysowania.
(function (root) {
  const C = {
    W: 900, H: 520, FIELD_L: 40, FIELD_R: 860, GOAL_TOP: 190, GOAL_BOTTOM: 330, POST_R: 6,
    PLAYER_R: 19, BALL_R: 12, SHOT_SCALE: 0.12, MAX_DRAG: 100, MAX_SPEED: 14, STOP_SPEED: 0.04,
    WALL_E: 0.8, BALL_E: 0.65, FOOTBALL_E: 0.8, STEP_MS: 1000 / 60,
    PLAN_TIME: 20, WIN_SCORE: 3, MAX_SIM_STEPS: 900, GOAL_STEPS: 100
  };
  const { W, H, FIELD_L, FIELD_R, GOAL_TOP, GOAL_BOTTOM } = C;

  function create() {
    const mk = (team, x, y, r, m, fr) =>
      ({ team, x, y, sx: x, sy: y, vx: 0, vy: 0, r, m, fr, plan: null, alive: true });
    const form = [[200, 260], [310, 150], [310, 370]];
    const ents = [
      ...form.map(([x, y]) => mk("blue", x, y, C.PLAYER_R, 1, 0.985)),
      ...form.map(([x, y]) => mk("red", W - x, y, C.PLAYER_R, 1, 0.985)),
      mk("ball", W / 2, H / 2, C.BALL_R, 0.5, 0.988)
    ];
    const ball = ents[6];
    const posts = [[FIELD_L, GOAL_TOP], [FIELD_L, GOAL_BOTTOM], [FIELD_R, GOAL_TOP], [FIELD_R, GOAL_BOTTOM]]
      .map(([x, y]) => ({ x, y, vx: 0, vy: 0, r: C.POST_R, m: Infinity }));

    const g = {
      C, ents, ball, posts, phase: "plan", timeLeft: C.PLAN_TIME, timerOn: true, aiTeam: null,
      ready: { blue: false, red: false }, score: { blue: 0, red: 0 },
      simSteps: 0, goalTimer: 0, lastScorer: null, goalByElim: false, winner: null
    };
    const teamEnts = t => ents.filter(e => e.team === t);

    // ---------- Komputer (czerwoni) ----------
    function planToPoint(p, tx, ty, extra) {
      const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
      const power = Math.min(C.MAX_DRAG, Math.max(8, d / 7.9 + extra));
      const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.12;
      p.plan = { vx: Math.cos(a) * power * C.SHOT_SCALE, vy: Math.sin(a) * power * C.SHOT_SCALE };
    }
    function aiPlanRed() {
      const s = teamEnts("red").filter(e => e.alive).sort((a, b) =>
        Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
      const gx = FIELD_L - ball.x, gy = H / 2 - ball.y, gl = Math.hypot(gx, gy) || 1;
      if (s[0]) planToPoint(s[0], ball.x - gx / gl * (C.PLAYER_R + C.BALL_R), ball.y - gy / gl * (C.PLAYER_R + C.BALL_R), 30);
      if (s[1]) planToPoint(s[1], ball.x, ball.y, 20);
      if (s[2]) planToPoint(s[2], FIELD_R - 130, Math.min(330, Math.max(190, ball.y)), 0);
    }

    // ---------- Fizyka ----------
    function moveEntity(e) {
      const s = Math.hypot(e.vx, e.vy);
      if (s > C.MAX_SPEED) { e.vx = e.vx / s * C.MAX_SPEED; e.vy = e.vy / s * C.MAX_SPEED; }
      e.vx *= e.fr; e.vy *= e.fr;
      if (Math.hypot(e.vx, e.vy) < C.STOP_SPEED) { e.vx = 0; e.vy = 0; }
      e.x += e.vx; e.y += e.vy;
    }
    function clampBounce(e, minX, maxX, minY, maxY) {
      if (e.x < minX) { e.x = minX; if (e.vx < 0) e.vx = -e.vx * C.WALL_E; }
      else if (e.x > maxX) { e.x = maxX; if (e.vx > 0) e.vx = -e.vx * C.WALL_E; }
      if (e.y < minY) { e.y = minY; if (e.vy < 0) e.vy = -e.vy * C.WALL_E; }
      else if (e.y > maxY) { e.y = maxY; if (e.vy > 0) e.vy = -e.vy * C.WALL_E; }
    }
    function walls(b) {   // kulki i piłka mogą wjechać do bramki
      const r = b.r, inGap = b.y > GOAL_TOP && b.y < GOAL_BOTTOM;
      let minY = r, maxY = H - r;
      if (b.x < FIELD_L || b.x > FIELD_R) { minY = Math.max(minY, GOAL_TOP + r); maxY = Math.min(maxY, GOAL_BOTTOM - r); }
      clampBounce(b, inGap ? r : FIELD_L + r, inGap ? W - r : FIELD_R - r, minY, maxY);
    }
    function collide(a, b) {
      let dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
      const minDist = a.r + b.r;
      if (dist >= minDist) return;
      if (dist < 0.0001) { dx = 1; dy = 0; dist = 1; }
      const nx = dx / dist, ny = dy / dist, ima = 1 / a.m, imb = 1 / b.m, total = ima + imb;
      const corr = Math.max(minDist - dist - 0.01, 0) / total;
      a.x -= nx * corr * ima; a.y -= ny * corr * ima; b.x += nx * corr * imb; b.y += ny * corr * imb;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel >= 0) return;
      const e = (a === ball || b === ball) ? C.FOOTBALL_E : C.BALL_E;
      const j = -(1 + e) * rel / total;
      a.vx -= j * ima * nx; a.vy -= j * ima * ny; b.vx += j * imb * nx; b.vy += j * imb * ny;
    }

    // ---------- Przebieg gry ----------
    function resetPositions() {
      for (const e of ents) { e.x = e.sx; e.y = e.sy; e.vx = e.vy = 0; e.plan = null; e.alive = true; }
    }
    function startPlanning() {
      g.phase = "plan"; g.timeLeft = C.PLAN_TIME; g.ready.blue = g.ready.red = false;
      for (const e of ents) e.plan = null;
      if (g.aiTeam === "red") { aiPlanRed(); g.ready.red = true; }
    }
    function startSim() {
      for (const e of ents) {
        if (e.team !== "ball" && e.alive && e.plan) { e.vx = e.plan.vx; e.vy = e.plan.vy; }
        e.plan = null;
      }
      g.phase = "sim"; g.simSteps = 0;
    }
    function scoreGoal(team, byElim) {
      g.goalByElim = !!byElim; g.score[team]++; g.lastScorer = team; g.phase = "goal"; g.goalTimer = C.GOAL_STEPS;
    }

    g.newGame = () => {
      g.score.blue = g.score.red = 0; g.winner = g.lastScorer = null; g.goalByElim = false;
      resetPositions(); startPlanning();
    };

    // plans: tablica 3 elementów: {vx, vy} lub null (kolejność jak kulki drużyny)
    g.setPlans = (team, plans) => {
      if (g.phase !== "plan" || g.ready[team] || !Array.isArray(plans)) return false;
      const max = C.MAX_DRAG * C.SHOT_SCALE;
      teamEnts(team).forEach((e, k) => {
        const p = plans[k];
        if (!e.alive || !p || typeof p.vx !== "number" || typeof p.vy !== "number" ||
            !isFinite(p.vx) || !isFinite(p.vy)) { e.plan = null; return; }
        const s = Math.hypot(p.vx, p.vy);
        if (s < 1e-6) { e.plan = null; return; }
        const f = s > max ? max / s : 1;
        e.plan = { vx: p.vx * f, vy: p.vy * f };
      });
      return true;
    };
    g.setReady = (team, v) => { if (g.phase === "plan") g.ready[team] = !!v; };

    g.step = () => {
      if (g.phase === "over") return;
      if (g.phase === "plan") {
        if (g.timerOn) {
          g.timeLeft -= C.STEP_MS / 1000;
          if (g.timeLeft <= 0) g.ready.blue = g.ready.red = true;
        } else g.timeLeft = C.PLAN_TIME;
        if (g.ready.blue && g.ready.red) startSim();
        return;
      }
      const live = ents.filter(e => e.alive);
      live.forEach(moveEntity);
      for (const e of live) for (const p of g.posts) collide(e, p);
      for (let i = 0; i < live.length; i++)
        for (let j = i + 1; j < live.length; j++) collide(live[i], live[j]);
      live.forEach(walls);

      if (g.phase === "sim") {
        g.simSteps++;
        for (const e of ents) {   // kulka, której środek przekroczył linię bramkową, znika
          if (e.team !== "ball" && e.alive && (e.x < FIELD_L || e.x > FIELD_R)) { e.alive = false; e.vx = e.vy = 0; }
        }
        const blueLeft = teamEnts("blue").some(e => e.alive), redLeft = teamEnts("red").some(e => e.alive);
        if (!blueLeft && !redLeft) {          // obie drużyny wyeliminowane: bez punktu
          ents.forEach(e => { e.vx = e.vy = 0; }); resetPositions(); startPlanning(); return;
        }
        if (!blueLeft || !redLeft) { ents.forEach(e => { e.vx = e.vy = 0; }); scoreGoal(blueLeft ? "blue" : "red", true); return; }
        if (ball.x < FIELD_L) scoreGoal("red");
        else if (ball.x > FIELD_R) scoreGoal("blue");
        else if (ents.every(e => e.vx === 0 && e.vy === 0) || g.simSteps > C.MAX_SIM_STEPS) {
          ents.forEach(e => { e.vx = e.vy = 0; }); startPlanning();
        }
      } else if (g.phase === "goal" && --g.goalTimer <= 0) {
        if (g.score.blue >= C.WIN_SCORE || g.score.red >= C.WIN_SCORE) {
          g.winner = g.score.blue > g.score.red ? "blue" : "red"; g.phase = "over";
        } else { resetPositions(); startPlanning(); }
      }
    };

    // ---------- Sieć: migawka stanu (bez planów graczy) ----------
    const r1 = n => Math.round(n * 10) / 10;
    g.snapshot = () => ({
      p: g.phase, tl: r1(g.timeLeft), to: g.timerOn ? 1 : 0,
      r: [g.ready.blue ? 1 : 0, g.ready.red ? 1 : 0], s: [g.score.blue, g.score.red],
      e: ents.map(e => [r1(e.x), r1(e.y), e.alive ? 1 : 0]),
      ls: g.lastScorer, ge: g.goalByElim ? 1 : 0, w: g.winner
    });
    g.apply = s => {
      if (s.p === "plan" && g.phase !== "plan") ents.forEach(e => { e.plan = null; });
      g.phase = s.p; g.timeLeft = s.tl; g.timerOn = !!s.to;
      g.ready.blue = !!s.r[0]; g.ready.red = !!s.r[1];
      g.score.blue = s.s[0]; g.score.red = s.s[1];
      s.e.forEach((a, i) => { ents[i].x = a[0]; ents[i].y = a[1]; ents[i].alive = !!a[2]; });
      g.lastScorer = s.ls; g.goalByElim = !!s.ge; g.winner = s.w;
    };

    g.newGame();
    return g;
  }

  root.Globulos = { C, create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Globulos;
})(typeof window !== "undefined" ? window : globalThis);
