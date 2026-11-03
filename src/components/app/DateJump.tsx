import { useRef } from "react";
import { Input } from "@/components/ui/input";
import { parseDayKey } from "@contracts/time";

/**
 * A date field that jumps to the day chosen: at once from the picker, but while typing only on Enter or
 * on leaving the field. Typing "2" on the way to "25" was taken as the 2nd, and the popover closed.
 */
export function DateJump({ id, value, onPick, className }: { id?: string; value: string; onPick: (day: Date) => void; className?: string }) {
  const typing = useRef(false);
  const commit = (raw: string) => {
    typing.current = false;
    const day = parseDayKey(raw);
    if (day) onPick(day);
  };
  return (
    <Input
      id={id}
      type="date"
      defaultValue={value}
      className={className}
      onKeyDown={e => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key.length === 1 || e.key === "Backspace" || e.key.startsWith("Arrow")) typing.current = true;
      }}
      onChange={e => {
        if (!typing.current) commit(e.target.value);
      }}
      onBlur={e => {
        if (typing.current) commit(e.currentTarget.value);
      }}
    />
  );
}
