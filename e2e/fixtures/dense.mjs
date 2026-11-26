// Dense demo data for the visual sweep (e2e/visual-sweep.test.mjs): many people with long names,
// months with 100+ h, long issue titles, TODOs and ideas, so a layout that only fits sparse data shows.
const PEOPLE = [
  "Lorenzo Muscherà Bertolazzi", "Federico Sandri", "Ugochukwu Uzoamaka-Okonkwo", "Gianluca Basso", "Giovanni Mittone",
  "Maria Antonietta Della Valle", "Chiara Lombardi", "Bartolomeo Castiglioni-Visconti", "Anna Rossi", "Teodoro Ferrante",
  "Valentina Esposito Marchetti", "Luca Neri",
];
const TITLES = [
  "Aggiornare la sezione giacenze negative con il nuovo calcolo dei lotti e la riconciliazione notturna",
  "REST righe multiple per lotto",
  "Chiamata a un collega dall'app quando la consegna è in ritardo di oltre due ore rispetto alla finestra",
  "Verifica abbigliamento ordine di vendita Macrì",
  "Accorciare lo spazio tra le righe dei prodotti nella vista compatta del catalogo",
  "Migrazione del motore di ricerca a indici incrementali con fallback su scansione completa",
];

export async function seedDense(db) {
  const now = Date.now();
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const days = [];
  for (let d = new Date(first); d <= today; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d));
  const statuses = [["To Do", "To Do"], ["In corso", "In Progress"], ["Fatto", "Done"], ["In revisione", "In Progress"]];
  for (let i = 0; i < 30; i++) {
    const key = `LONG-${1000 + i}`;
    const [status, category] = statuses[i % statuses.length];
    await db.q(
      `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
       VALUES (1, ?, ?, ?, ?, ?, 'LONG', 'Progetto con un nome davvero molto lungo', 'Task', ?, '[]', 'mrossi', ?, ?, ?)`,
      key, key, TITLES[i % TITLES.length] + (i > 5 ? ` (${i})` : ""), status, category, ["Highest", "High", "Medium", "Low"][i % 4], `https://jira.example.it/browse/${key}`, now, i < 4 ? 1 : 0,
    );
  }
  // Mario (user 1): a full month and more, 7–9 h a day on long-titled issues.
  let w = 0;
  for (const d of days) {
    for (const [h, len] of [[9, 3], [12, 2.5], [15, 2.5 + (d.getDate() % 3)]]) {
      const start = new Date(d); start.setHours(h, 0, 0, 0);
      if (start.getTime() > now - 3600_000) continue;
      await db.q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at, comment) VALUES (1, 1, ?, ?, ?, ?, ?, ?)",
        `LONG-${1000 + (w % 30)}`, `dense-1-${w}`, Math.round(len * 3600), start.getTime(), now, "Analisi, sviluppo e revisione con il cliente delle modifiche richieste nella riunione",
      );
      w++;
    }
  }
  // The team: everyone with their own tracker and a month of time, some with none.
  for (const [n, name] of PEOPLE.entries()) {
    const id = n + 2;
    await db.q("INSERT INTO users (id, username, role, display_name, created_at) VALUES (?, ?, 'member', ?, ?)", id, `u${id}`, name, now);
    await db.q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, ?, 'jira', 'https://jira.example.it', ?, '{}', 'x', ?)", id, id, `u${id}`, now);
    await db.q("INSERT INTO connection_sync (connection_id, stream, last_ok_at) VALUES (?, 'worklogs', ?)", id, now);
    if (n % 4 === 3) continue;
    for (const [k, d] of days.entries()) {
      const start = new Date(d); start.setHours(9, 0, 0, 0);
      if (start.getTime() > now) continue;
      await db.q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'LONG-1001', ?, ?, ?, ?)",
        id, id, `dense-${id}-${k}`, (8 + (k % 3 === 0 ? 1.5 : 0) - (n % 3)) * 3600, start.getTime(), now,
      );
    }
  }
  const [{ id: team }] = await db.q("INSERT INTO teams (name, created_at) VALUES ('Sviluppo piattaforma e integrazioni', ?) RETURNING id", now);
  for (const [n] of PEOPLE.entries()) await db.q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')", team, n + 2);
  for (let i = 0; i < 8; i++)
    await db.q("INSERT INTO todos (user_id, text, position, created_at, updated_at, issue_key, connection_id) VALUES (1, ?, ?, ?, ?, ?, ?)", TITLES[i % TITLES.length] + " — da ricontrollare con il team prima della consegna", i, now, now, i % 2 ? `LONG-${1000 + i}` : null, i % 2 ? 1 : null);
  // Notifications: a busy issue (comments, status changes, a mention), then one or two on many others, some read.
  const notes = [
    ...["commented", "status", "commented", "mentioned", "commented", "status"].map(kind => [kind, "LONG-1000"]),
    ...Array.from({ length: 26 }, (_, i) => [["commented", "status", "assigned", "mentioned", "due", "watch_added", "review", "priority"][i % 8], `LONG-${1001 + i}`]),
    ...Array.from({ length: 8 }, (_, i) => ["commented", `LONG-${1001 + i * 3}`]),
  ];
  for (const [i, [kind, key]] of notes.entries()) {
    const detail = kind === "status" ? "In revisione con il cliente → In lavorazione presso il fornitore" : kind === "priority" ? "Critica" : kind === "due" ? new Date(now + 86_400_000).toISOString().slice(0, 10) : "";
    await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at, read_at) VALUES (1, 1, ?, ?, ?, ?, ?, ?)", kind, key, detail, `dense-n-${i}`, now - i * 7 * 60_000, i % 5 === 4 ? now : null);
  }
  for (let i = 0; i < 6; i++)
    await db.q("INSERT INTO ideas (user_id, title, body, position, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)", TITLES[(i + 2) % TITLES.length], "Una descrizione lunga dell'idea, con il perché e i criteri di accettazione da discutere.", i, now, now);
  // Feedback (Info › Feedback): long titles, every state, a thread with a change of state and a shared one.
  const kinds = ["problem", "idea", "improvement"];
  const states = ["new", "discussion", "accepted", "in_progress", "implemented", "rejected"];
  for (let i = 0; i < 6; i++) {
    const [{ id }] = await db.q(
      "INSERT INTO feedback (user_id, type, title, body, page, app_version, look, density, status, status_reason, share_consent, share_state, shared_at, upstream_status, created_at, updated_at) VALUES (1, ?, ?, ?, ?, 'dev', 'light·standard·normal', 'compact', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      kinds[i % 3], TITLES[i % TITLES.length] + " — la pagina si blocca quando trascino una voce lunga", "Succede ogni volta che apro il pannello laterale con molte voci: la lista salta e perdo il punto in cui ero. Allego i passi per riprodurlo.\n\n1. Apri la board\n2. Trascina una issue dal titolo molto lungo",
      `/issues/LONG-${1000 + i}`, states[i], states[i] === "rejected" ? "Fuori dal perimetro di questa versione: la riprendiamo con il nuovo editor." : null, i % 2, i % 2 ? "sent" : null, i % 2 ? now : null, i % 2 ? "new" : null, now - i * 3600_000, now,
    );
    if (i === 0) {
      await db.q("INSERT INTO feedback_comments (feedback_id, author_id, origin, body, created_at) VALUES (?, 1, 'admin', ?, ?)", id, "Grazie! Con quale browser e quale densità? Riesci ad allegare una schermata della board?", now);
      await db.q("INSERT INTO feedback_comments (feedback_id, author_id, origin, body, status_from, status_to, created_at) VALUES (?, 1, 'status', '', 'new', 'discussion', ?)", id, now);
      await db.q("INSERT INTO feedback_comments (feedback_id, author_id, origin, body, upstream_id, created_at) VALUES (?, NULL, 'upstream', ?, 'c1', ?)", id, "Lo stiamo guardando: sembra legato alla misura delle righe lunghe.", now);
    }
  }
}
