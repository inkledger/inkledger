import { describe, expect, it } from "vitest";
import { tIn, type MessageKey } from ".";

describe("Italian texts", () => {
  it("speak of one thing in the singular", () => {
    const one: [MessageKey, Record<string, string | number>, string][] = [
      ["pages.dashboard.overdueOne", { key: "APP-1", days: 1, count: 1 }, "APP-1 è scaduta da 1 giorno: aggiorna la scadenza o chiudila."],
      ["pages.timesheet.duplicated", { count: 1 }, "1 worklog duplicato su oggi"],
      ["pages.timesheet.exported", { count: 1 }, "Esportato 1 worklog"],
      ["pages.timesheet.deleteSelected", { count: 1 }, "Elimina 1 selezionato"],
      ["views.board.pinboard.deleteNotes", { count: 1 }, "Verrà eliminato anche il suo post-it."],
      ["server.auth.tooManyAttempts", { count: 1 }, "Troppi tentativi di accesso. Riprova tra 1 secondo."],
    ];
    for (const [key, vars, text] of one) expect(tIn("it", key, vars), key).toBe(text);
    expect(tIn("it", "pages.timesheet.duplicateBody", { count: 1, duration: "1h", date: "2 nov" })).toMatch(/^1 worklog \(1h\) del 2 nov verrà creato oggi/);
  });

  it("name the palette's focus mode in Italian", () => {
    expect(tIn("it", "ui.palette.focusMode")).not.toBe(tIn("en", "ui.palette.focusMode"));
  });
});
