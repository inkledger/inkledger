import type { Tree } from "../core";

// The server's texts the shell draws before the rest of English arrives (contracts/i18n/client.ts).
export const pinboard = {
  followReadOnly: "This board follows a tag: it shows what the tracker says: nothing is pinned, written or taken off by hand.",
  trackerNotFound: "This tracker isn't among yours.",
  defaultBoard: "My board",
  todoLink: "A TODO's post-it shows its TODO's issue: tie the TODO to one instead.",
  boardNotFound: "Board not found",
  bucketNotFound: "Bucket not found",
  noteNotFound: "Note not found",
  sameBoard: "The note is already on this board",
  maxBoards: {
    one: "At most {count} board.",
    other: "At most {count} boards.",
  },
  needBoard: "At least one board is needed.",
  boardFullNotes: {
    one: "The board is full ({count} note): remove something first.",
    other: "The board is full ({count} notes): remove something first.",
  },
  boardFull: "The board is full.",
  nameRequired: "Give the board a name",
} satisfies Tree;

export const placement = {
  overlaps: "Overlaps {list}",
  invalidDuration: "Invalid duration",
  noRoomBeforeStop: "No free space of this length before the stop",
  noRoomBeforeNow: "No free space of this length before now",
  dayFull: "The day has no room after the last worklog",
} satisfies Tree;

export const workSchedule = {
  invalidDate: "Invalid date",
  weekClosed: "The week of {week} is closed: pick a later date or reopen it.",
  firstCannotDelete: "The first schedule can't be deleted",
  invalidTime: "Invalid time (HH:MM)",
  endAfterStart: "The end must be after the start",
  invalidBreak: "Invalid break",
  breaksOrder: "Breaks must fall within working hours, in order and without overlapping",
} satisfies Tree;
