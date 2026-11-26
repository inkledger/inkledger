// Icons as lucide-react 0.562 drew them. Lucide 1.x redrew these (calendars a unit shorter, other
// strokes moved); the app keeps the drawings the looks were approved with, built by lucide's own
// createLucideIcon (same lucide-<name> classes and props). Import these from here, not from
// lucide-react. Deleting an entry (and importing it from lucide-react again) adopts lucide's redraw.
import { createLucideIcon } from "lucide-react";

export const Bold = createLucideIcon("bold", [
    ["path", { d: "M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8", key: "mg9rjx" }],
  ]);

export const Bookmark = createLucideIcon("bookmark", [
    ["path", { d: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z", key: "1fy3hk" }],
  ]);

export const BookOpen = createLucideIcon("book-open", [
    ["path", { d: "M12 7v14", key: "1akyts" }],
    ["path", { d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z", key: "ruj8y" }],
  ]);

export const Calendar = createLucideIcon("calendar", [
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2", key: "1hopcy" }],
    ["path", { d: "M3 10h18", key: "8toen8" }],
  ]);

export const CalendarCheck = createLucideIcon("calendar-check", [
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2", key: "1hopcy" }],
    ["path", { d: "M3 10h18", key: "8toen8" }],
    ["path", { d: "m9 16 2 2 4-4", key: "19s6y9" }],
  ]);

export const CalendarClock = createLucideIcon("calendar-clock", [
    ["path", { d: "M16 14v2.2l1.6 1", key: "fo4ql5" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    ["path", { d: "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5", key: "1osxxc" }],
    ["path", { d: "M3 10h5", key: "r794hk" }],
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["circle", { cx: "16", cy: "16", r: "6", key: "qoo3c4" }],
  ]);

export const CalendarDays = createLucideIcon("calendar-days", [
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2", key: "1hopcy" }],
    ["path", { d: "M3 10h18", key: "8toen8" }],
    ["path", { d: "M8 14h.01", key: "6423bh" }],
    ["path", { d: "M12 14h.01", key: "1etili" }],
    ["path", { d: "M16 14h.01", key: "1gbofw" }],
    ["path", { d: "M8 18h.01", key: "lrp35t" }],
    ["path", { d: "M12 18h.01", key: "mhygvu" }],
    ["path", { d: "M16 18h.01", key: "kzsmim" }],
  ]);

export const CalendarRange = createLucideIcon("calendar-range", [
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2", key: "1hopcy" }],
    ["path", { d: "M16 2v4", key: "4m81vk" }],
    ["path", { d: "M3 10h18", key: "8toen8" }],
    ["path", { d: "M8 2v4", key: "1cmpym" }],
    ["path", { d: "M17 14h-6", key: "bkmgh3" }],
    ["path", { d: "M13 18H7", key: "bb0bb7" }],
    ["path", { d: "M7 14h.01", key: "1qa3f1" }],
    ["path", { d: "M17 18h.01", key: "1bdyru" }],
  ]);

export const Carrot = createLucideIcon("carrot", [
    ["path", { d: "M2.27 21.7s9.87-3.5 12.73-6.36a4.5 4.5 0 0 0-6.36-6.37C5.77 11.84 2.27 21.7 2.27 21.7zM8.64 14l-2.05-2.04M15.34 15l-2.46-2.46", key: "rfqxbe" }],
    ["path", { d: "M22 9s-1.33-2-3.5-2C16.86 7 15 9 15 9s1.33 2 3.5 2S22 9 22 9z", key: "6b25w4" }],
    ["path", { d: "M15 2s-2 1.33-2 3.5S15 9 15 9s2-1.84 2-3.5C17 3.33 15 2 15 2z", key: "fn65lo" }],
  ]);

export const CircleCheckIcon = createLucideIcon("circle-check", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }],
  ]);

export const CircleDot = createLucideIcon("circle-dot", [
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
    ["circle", { cx: "12", cy: "12", r: "1", key: "41hilf" }],
  ]);

export const Clock = createLucideIcon("clock", [
    ["path", { d: "M12 6v6l4 2", key: "mmk7yg" }],
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ]);

export const Clock3 = createLucideIcon("clock-3", [
    ["path", { d: "M12 6v6h4", key: "135r8i" }],
    ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ]);

export const CloudOff = createLucideIcon("cloud-off", [
    ["path", { d: "m2 2 20 20", key: "1ooewy" }],
    ["path", { d: "M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193", key: "yfwify" }],
    ["path", { d: "M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07", key: "jlfiyv" }],
  ]);

export const CreditCard = createLucideIcon("credit-card", [
    ["rect", { width: "20", height: "14", x: "2", y: "5", rx: "2", key: "ynyp8z" }],
    ["line", { "x1": "2", "x2": "22", "y1": "10", "y2": "10", key: "1b3vmo" }],
  ]);

export const FileClock = createLucideIcon("file-clock", [
    ["path", { d: "M16 22h2a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v2.85", key: "ryk6xj" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
    ["path", { d: "M8 14v2.2l1.6 1", key: "6m4bie" }],
    ["circle", { cx: "8", cy: "16", r: "6", key: "10v15b" }],
  ]);

export const FileKey = createLucideIcon("file-key", [
    ["path", { d: "M10.65 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v10.1", key: "1a2hbp" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5", key: "wfsgrz" }],
    ["path", { d: "m10 15 1 1", key: "1h4vmv" }],
    ["path", { d: "m11 14-4.586 4.586", key: "maylof" }],
    ["circle", { cx: "5", cy: "20", r: "2", key: "860zyv" }],
  ]);

export const GitBranch = createLucideIcon("git-branch", [
    ["line", { "x1": "6", "x2": "6", "y1": "3", "y2": "15", key: "17qcm7" }],
    ["circle", { cx: "18", cy: "6", r: "3", key: "1h7g24" }],
    ["circle", { cx: "6", cy: "18", r: "3", key: "fqmcym" }],
    ["path", { d: "M18 9a9 9 0 0 1-9 9", key: "n2h4wq" }],
  ]);

export const Route = createLucideIcon("route", [
    ["circle", { cx: "6", cy: "19", r: "3", key: "1kj8tv" }],
    ["path", { d: "M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15", key: "1d8sl" }],
    ["circle", { cx: "18", cy: "5", r: "3", key: "gq8acd" }],
  ]);

export const SquareCheck = createLucideIcon("square-check", [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
    ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }],
  ]);

export const Trophy = createLucideIcon("trophy", [
    ["path", { d: "M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978", key: "1n3hpd" }],
    ["path", { d: "M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978", key: "rfe1zi" }],
    ["path", { d: "M18 9h1.5a1 1 0 0 0 0-5H18", key: "7xy6bh" }],
    ["path", { d: "M4 22h16", key: "57wxv0" }],
    ["path", { d: "M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z", key: "1mhfuq" }],
    ["path", { d: "M6 9H4.5a1 1 0 0 1 0-5H6", key: "tex48p" }],
  ]);
