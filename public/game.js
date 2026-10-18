// Wspólna logika gry: używana przez serwer (Node.js) i przeglądarkę. Bez kodu rysowania.
(function (root) {
  const C = {
    W: 810, H: 468, FIELD_L: 36, FIELD_R: 774, GOAL_TOP: 171, GOAL_BOTTOM: 297, POST_R: 6,
    PLAYER_R: 19, BALL_R: 12, SHOT_SCALE: 0.132, MAX_DRAG: 100, MAX_SPEED: 14, STOP_SPEED: 0.04,
    WALL_E: 0.8, BALL_E: 0.65, FOOTBALL_E: 0.8, STEP_MS: 1000 / 60,
    PLAN_TIME: 20, WIN_SCORE: 3, MAX_SIM_STEPS: 900, GOAL_STEPS: 100
  };
  const { W, H, FIELD_L, FIELD_R, GOAL_TOP, GOAL_BOTTOM } = C;

  function create() {
    const mk = (team, x, y, r, m, fr) =>
      ({ team, x, y, sx: x, sy: y, vx: 0, vy: 0, r, m, fr, plan: null, alive: true });
    const form = [[180, 234], [279, 135], [279, 333]];
    const ents = [
      ...form.map(([x, y]) => mk("blue", x, y, C.PLAYER_R, 1, 0.985)),
      ...form.map(([x, y]) => mk("red", W - x, y, C.PLAYER_R, 1, 0.985)),
      mk("ball", W / 2, H / 2, C.BALL_R, 0.5, 0.988)
    ];
    const ball = ents[6];
    const posts = [[FIELD_L, GOAL_TOP], [FIELD_L, GOAL_BOTTOM], [FIELD_R, GOAL_TOP], [FIELD_R, GOAL_BOTTOM]]
      .map(([x, y]) => ({ x, y, vx: 0, vy: 0, r: C.POST_R, m: Infinity }));

    const g = {
      C, ents, ball, posts, phase: "plan", timeLeft: C.PLAN_TIME, timerOn: true, aiTeam: null, aiLevel: "easy",
      ready: { blue: false, red: false }, score: { blue: 0, red: 0 },
      simSteps: 0, goalTimer: 0, lastScorer: null, goalByElim: false, winner: null
    };
    const teamEnts = t => ents.filter(e => e.team === t);

    // ---------- Komputer (czerwoni) ----------
    const PR = C.PLAYER_R, BR = C.BALL_R;
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const vec = (angle, power) => ({ vx: Math.cos(angle) * power * C.SHOT_SCALE, vy: Math.sin(angle) * power * C.SHOT_SCALE });

    // Plan "leć do punktu": siła ~ odległość / (SHOT_SCALE * 66) (zasięg przy tarciu) + dodatek.
    function toPoint(p, tx, ty, extra, jitter) {
      const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
      return vec(Math.atan2(dy, dx) + (Math.random() - 0.5) * jitter, clamp(d / (C.SHOT_SCALE * 66) + extra, 8, C.MAX_DRAG));
    }

    // Prosty schemat: napastnik uderza piłkę w stronę bramki, drugi jedzie na piłkę, trzeci broni.
    function heuristicPlans(team, jitter) {
      const atk = team === "red" ? FIELD_L : FIELD_R, own = team === "red" ? FIELD_R - 130 : FIELD_L + 130;
      const mine = teamEnts(team), out = mine.map(() => null);
      const order = mine.filter(e => e.alive).sort((a, b) =>
        Math.hypot(a.x - ball.x, a.y - ball.y) - Math.hypot(b.x - ball.x, b.y - ball.y));
      const gx = atk - ball.x, gy = H / 2 - ball.y, gl = Math.hypot(gx, gy) || 1;
      if (order[0]) out[mine.indexOf(order[0])] = toPoint(order[0], ball.x - gx / gl * (PR + BR), ball.y - gy / gl * (PR + BR), 30, jitter);
      if (order[1]) out[mine.indexOf(order[1])] = toPoint(order[1], ball.x, ball.y, 20, jitter);
      if (order[2]) out[mine.indexOf(order[2])] = toPoint(order[2], own, clamp(ball.y, GOAL_TOP, GOAL_BOTTOM), 0, jitter);
      return out;
    }

    // Losowe pomysły na ruch jednej kulki (do przeszukiwania).
    const KINDS = ["strike", "strike", "strike", "direct", "ram", "defend", "free", "idle"];
    const pickKind = () => KINDS[Math.floor(Math.random() * KINDS.length)];
    function actionPlan(p, team, kind) {
      const atk = team === "red" ? FIELD_L : FIELD_R, own = team === "red" ? FIELD_R : FIELD_L;
      if (kind === "strike") {      // uderzenie w piłkę w kierunku losowego punktu bramki
        const ux = atk - ball.x, uy = rnd(GOAL_TOP + 15, GOAL_BOTTOM - 15) - ball.y, l = Math.hypot(ux, uy) || 1;
        return toPoint(p, ball.x - ux / l * (PR + BR), ball.y - uy / l * (PR + BR), rnd(5, 70), 0.02);
      }
      if (kind === "direct") return toPoint(p, ball.x, ball.y, rnd(0, 60), 0.02);
      if (kind === "ram") {         // taranowanie kulki przeciwnika
        const foes = ents.filter(e => e.team !== team && e.team !== "ball" && e.alive);
        const f = foes[Math.floor(Math.random() * foes.length)];
        return f ? toPoint(p, f.x, f.y, rnd(0, 60), 0.02) : null;
      }
      if (kind === "defend") {
        const dx = own + (team === "red" ? -1 : 1) * rnd(70, 200);
        return toPoint(p, dx, clamp(ball.y + rnd(-60, 60), GOAL_TOP + 5, GOAL_BOTTOM - 5), 0, 0.02);
      }
      if (kind === "free") return vec(rnd(0, Math.PI * 2), rnd(20, C.MAX_DRAG));
      return null;
    }
    function randomPlans(team) {
      return teamEnts(team).map(e => e.alive ? actionPlan(e, team, pickKind()) : null);
    }
    function mutate(plans, team) {   // drobna zmiana najlepszego dotąd planu
      const mine = teamEnts(team), out = plans.slice();
      const n = Math.random() < 0.4 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const k = Math.floor(Math.random() * 3), e = mine[k];
        if (!e || !e.alive) continue;
        const p = out[k];
        if (!p) { out[k] = actionPlan(e, team, pickKind()); continue; }
        const a = Math.atan2(p.vy, p.vx) + (Math.random() + Math.random() + Math.random() - 1.5) * 0.4;
        out[k] = vec(a, clamp(Math.hypot(p.vx, p.vy) / C.SHOT_SCALE * rnd(0.75, 1.25), 8, C.MAX_DRAG));
      }
      return out;
    }

    // Inteligentny komputer: sprawdza wiele własnych planów w symulacji (na kopii silnika),
    // zakładając kilka możliwych ruchów przeciwnika, i wybiera plan o najlepszym wyniku.
    let sandbox = null;
    function playout(redPlans, bluePlans) {
      const s = sandbox;
      s.copyFrom(g);
      s.setPlans("red", redPlans); s.setPlans("blue", bluePlans);
      s.ready.red = s.ready.blue = true;
      s.step();
      for (let n = 0; s.phase === "sim" && n < 1200; n++) s.step();
      let v = ((s.score.red - g.score.red) - (s.score.blue - g.score.blue)) * 1000;
      if (v === 0) {
        const b = s.ball, red = s.ents.filter(e => e.team === "red" && e.alive), blue = s.ents.filter(e => e.team === "blue" && e.alive);
        const near = list => list.reduce((m, e) => Math.min(m, Math.hypot(e.x - b.x, e.y - b.y)), 600);
        v += (FIELD_R - b.x) / (FIELD_R - FIELD_L) * 120 - Math.abs(b.y - H / 2) * 0.06;
        v += (red.length - blue.length) * 45 - near(red) * 0.05 + near(blue) * 0.03;
      }
      return v;
    }
    function smartPlans(level) {
      const hard = level === "hard", budgetMs = hard ? 700 : 250, K = hard ? 5 : 3;
      sandbox = sandbox || create();
      const opp = [heuristicPlans("blue", 0.05)];
      for (let i = 1; i < K; i++) opp.push(i % 2 ? randomPlans("blue") : heuristicPlans("blue", 0.2));
      const score = plans => {
        let sum = 0, min = Infinity;
        for (const bp of opp) { const v = playout(plans, bp); sum += v; if (v < min) min = v; }
        const mean = sum / opp.length;
        return hard ? 0.6 * mean + 0.4 * min : mean;
      };
      let best = heuristicPlans("red", 0.03), bestV = score(best);
      const t0 = Date.now();
      for (let n = 1; n < 8 || Date.now() - t0 < budgetMs; n++) {
        const cand = n > 8 && Math.random() < 0.45 ? mutate(best, "red") : randomPlans("red");
        const v = score(cand);
        if (v > bestV) { best = cand; bestV = v; }
      }
      return best;
    }
    function aiPlan() {
      const plans = g.aiLevel === "easy" ? heuristicPlans("red", 0.12) : smartPlans(g.aiLevel);
      teamEnts("red").forEach((e, k) => { e.plan = e.alive ? plans[k] || null : null; });
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
      if (g.aiTeam === "red") { aiPlan(); g.ready.red = true; }
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

    // Kopiuje położenia i wynik z innego silnika (używane przez symulacje komputera).
    g.copyFrom = o => {
      g.phase = "plan"; g.timeLeft = C.PLAN_TIME; g.timerOn = true; g.ready.blue = g.ready.red = false;
      g.score.blue = o.score.blue; g.score.red = o.score.red;
      g.simSteps = g.goalTimer = 0; g.winner = g.lastScorer = null; g.goalByElim = false;
      o.ents.forEach((e, i) => { const d = ents[i]; d.x = e.x; d.y = e.y; d.vx = d.vy = 0; d.alive = e.alive; d.plan = null; });
    };
    g.heuristicPlans = heuristicPlans;

    g.newGame();
    return g;
  }

  root.Globulos = { C, create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Globulos;
})(typeof window !== "undefined" ? window : globalThis);
