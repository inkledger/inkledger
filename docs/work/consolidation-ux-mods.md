# Status: consolidation, UX and mods/Store/Lighthouse plans

Plans: the audit's `hulkling-namor-wasp.md` (UX) and `argent-green-lantern-green-lantern.md`
(mods, Store, Lighthouse). The technical plan is in consolidation-batch0.md.

## UX
- [x] UX-A (32822c9): a day with entries takes one more on that day; the header says "today";
  Day/Week/Month keep the period; trackers' search starts from the local query; Board column
  → catalogue on its status and done ones; Days export waits for the days.
- [x] UX-C.14/15 TransitionDialog: title in every branch (loading branch by review: not reachable deterministically from e2e), first refused field focused, multi-choice errors tied to their fieldset.
- [x] UX-C.19 loading: PageSpinner one status (spinner decorative inside it), skeletons aria-hidden (by review).
