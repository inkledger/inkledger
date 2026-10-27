import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type { MarkdownSelection } from "./markdownEdit";

type Entry = { value: string; selection: MarkdownSelection };

export function useMarkdownHistory(
  value: string,
  onChange: (value: string) => void
) {
  const area = useRef<HTMLTextAreaElement>(null);
  const past = useRef<Entry[]>([]);
  const future = useRef<Entry[]>([]);
  const current = useRef<Entry>({ value, selection: { start: 0, end: 0 } });
  const pending = useRef<Entry | null>(null);
  const composing = useRef(false);
  const restore = useRef<MarkdownSelection | null>(null);
  const lastInput = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const flags = useCallback(() => {
    setCanUndo(past.current.length > 0 || pending.current !== null);
    setCanRedo(future.current.length > 0);
  }, []);

  const reset = useCallback((next: string) => {
    past.current = [];
    future.current = [];
    pending.current = null;
    current.current = { value: next, selection: { start: 0, end: 0 } };
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  useEffect(() => {
    if (current.current.value !== value) reset(value);
  }, [reset, value]);

  const remember = useCallback(
    (next: string, selection: MarkdownSelection, separate = false) => {
      const now = Date.now();
      if (composing.current) {
        current.current = { value: next, selection };
        onChange(next);
        return;
      }
      if (!pending.current && (separate || now - lastInput.current > 700))
        pending.current = current.current;
      lastInput.current = now;
      future.current = [];
      current.current = { value: next, selection };
      onChange(next);
      flags();
    },
    [flags, onChange]
  );

  const input = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      remember(event.target.value, {
        start: event.target.selectionStart,
        end: event.target.selectionEnd,
      });
    },
    [remember]
  );

  const commit = useCallback(() => {
    if (pending.current) past.current.push(pending.current);
    pending.current = null;
    flags();
  }, [flags]);

  const apply = useCallback(
    (next: string, selection: MarkdownSelection) => {
      if (next === value) return;
      if (!pending.current) pending.current = current.current;
      commit();
      current.current = { value: next, selection };
      restore.current = selection;
      future.current = [];
      onChange(next);
      flags();
    },
    [commit, flags, onChange, value]
  );

  const travel = useCallback(
    (direction: -1 | 1) => {
      commit();
      const from = direction < 0 ? past : future;
      const to = direction < 0 ? future : past;
      const entry = from.current.pop();
      if (!entry) return;
      const selection = {
        start: area.current?.selectionStart ?? 0,
        end: area.current?.selectionEnd ?? 0,
      };
      to.current.push({ ...current.current, selection });
      current.current = entry;
      restore.current = entry.selection;
      onChange(entry.value);
      flags();
    },
    [commit, flags, onChange]
  );

  useLayoutEffect(() => {
    const el = area.current;
    const selection = restore.current;
    if (!el || !selection) return;
    restore.current = null;
    el.focus({ preventScroll: true });
    el.setSelectionRange(selection.start, selection.end);
  }, [value]);

  const compositionStart = useCallback(() => {
    commit();
    composing.current = true;
  }, [commit]);
  const compositionEnd = useCallback(() => {
    composing.current = false;
    lastInput.current = 0;
  }, []);

  return {
    area,
    input,
    undo: () => travel(-1),
    redo: () => travel(1),
    canUndo,
    canRedo,
    apply,
    commit,
    reset,
    compositionStart,
    compositionEnd,
  };
}
