// Estimates seed (e2e/estimates.test.mjs): closed issues with proven histories, one never read, an open one with a TODO.
const H = 3_600_000;

/**
 * Six closed issues of mine on connection 1: In Progress for 7 h (30 min logged there), then
 * "Waiting for customer" for 7 h (3 h logged there), then done. One more closed, never read.
 * EST-1 is open, and a TODO hangs on it with no estimate.
 */
export async function seed(db) {
  const now = Date.now();
  for (const [id, name, category] of [["11", "To Do", "todo"], ["21", "In Progress", "doing"], ["41", "Waiting for customer", "doing"], ["31", "Done", "done"]])
    await db.q("INSERT INTO status_snapshots (connection_id, status_id, name, category, seen_at) VALUES (1, ?, ?, ?, ?)", id, name, category, now);
  const issue = async (key, category, statusId, created) =>
    (
      await db.q(
        `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_id, category, status_category, project_key, project_name, issue_type, priority, labels, components, assignee_id, url, synced_at, jira_created_at, jira_updated_at)
         VALUES (1, 1, ?, ?, ?, 'x', ?, ?, 'To Do', 'EST', 'Estimates', 'Task', 'Medium', '[]', '[]', 'mrossi', ?, ?, ?, ?) RETURNING id`,
        `r-${key}`, key, `Work on ${key}`, statusId, category, `https://jira.example.it/browse/${key}`, now, created, created + 16 * H,
      )
    )[0].id;
  for (let n = 0; n < 6; n++) {
    const created = now - (30 - n) * 24 * H;
    const id = await issue(`EST-${10 + n}`, "done", "31", created);
    for (const [ordinal, [from, to, hours]] of [["11", "21", 1], ["21", "41", 8], ["41", "31", 15]].entries())
      await db.q("INSERT INTO issue_status_changes (item_id, ordinal, at, from_status_id, to_status_id) VALUES (?, ?, ?, ?, ?)", id, ordinal, created + hours * H, from, to);
    await db.q(
      "INSERT INTO issue_history_reads (item_id, user_id, state, read_at, source_updated_at, status_id_at_read, changes) VALUES (?, 1, 'available', ?, ?, '31', 3)",
      id, now, created + 16 * H,
    );
    for (const [w, [hours, seconds]] of [[2, 1800], [9, 10800]].entries())
      await db.q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, item_id, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (1, 1, ?, ?, ?, ?, ?, ?)",
        `EST-${10 + n}`, id, `w-${n}-${w}`, seconds, created + hours * H, now,
      );
  }
  const unread = await issue("EST-20", "done", "31", now - 5 * 24 * H);
  await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, item_id, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (1, 1, 'EST-20', ?, 'w-20', 3600, ?, ?)", unread, now - 5 * 24 * H, now);
  await issue("EST-1", "doing", "21", now - 2 * 24 * H);
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await db.q("INSERT INTO todos (user_id, text, due_on, issue_key, connection_id, position, created_at, updated_at) VALUES (1, 'Finish EST-1', ?, 'EST-1', 1, 0, ?, ?)", day, now, now);
}
