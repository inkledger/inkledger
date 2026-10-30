import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

type Transitions = inferRouterOutputs<AppRouter>["issues"]["transitions"];
/** A field a tracker asks for (a transition's, or a new issue's type's). */
export type Field = Transitions[number]["requirements"][number];
export type Value = string | number | string[] | { date: string } | { user: string };

/** One field's input, by its kind; a field of a kind inkledger doesn't know draws nothing. */
export function FieldInput({ field, value, error, onChange, provider }: { field: Field; value: Value | undefined; error?: string; onChange: (v: Value | undefined) => void; provider: string }) {
  const id = `tf-${field.id}`;
  const label = (
    <Label htmlFor={id}>
      {field.name}
      {!field.required && <span className="ml-1 font-normal text-muted-foreground">({t("pages.issueDetail.optional")})</span>}
    </Label>
  );
  const err = error && (
    <p className="text-caption text-danger" id={`${id}-error`}>
      {error === "required" ? t("pages.issueDetail.required") : error}
    </p>
  );
  const described = error ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
  switch (field.type) {
    case "choice":
      return (
        <div className="grid gap-2">
          {label}
          <Select value={typeof value === "string" ? value : ""} onValueChange={v => onChange(v)}>
            <SelectTrigger id={id} {...described}>
              <SelectValue placeholder={t("pages.issueDetail.choose")} />
            </SelectTrigger>
            <SelectContent>
              {field.options.map(o => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {err}
        </div>
      );
    case "multiChoice": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset className="grid gap-2" id={id} tabIndex={-1} {...described}>
          <legend className="mb-1 text-body-sm font-medium">{field.name}</legend>
          {field.options.map(o => (
            <label key={o.id} className="flex items-center gap-2 text-body-sm">
              <Checkbox checked={picked.includes(o.id)} onCheckedChange={on => onChange(on === true ? [...picked, o.id] : picked.filter(x => x !== o.id))} />
              {o.name}
            </label>
          ))}
          {err}
        </fieldset>
      );
    }
    case "text":
      return (
        <div className="grid gap-2">
          {label}
          {field.multiline ? (
            <Textarea id={id} value={typeof value === "string" ? value : ""} onChange={e => onChange(e.target.value || undefined)} {...described} />
          ) : (
            <Input id={id} value={typeof value === "string" ? value : ""} onChange={e => onChange(e.target.value || undefined)} {...described} />
          )}
          {err}
        </div>
      );
    case "number":
      return (
        <div className="grid gap-2">
          {label}
          <Input id={id} type="number" value={typeof value === "number" ? value : ""} onChange={e => onChange(e.target.value === "" ? undefined : Number(e.target.value))} {...described} />
          {err}
        </div>
      );
    case "date":
      return (
        <div className="grid gap-2">
          {label}
          <Input id={id} type="date" value={value && typeof value === "object" && "date" in value ? value.date : ""} onChange={e => onChange(e.target.value ? { date: e.target.value } : undefined)} {...described} />
          {err}
        </div>
      );
    case "user":
      return (
        <div className="grid gap-2">
          {label}
          <Input id={id} value={value && typeof value === "object" && "user" in value ? value.user : ""} onChange={e => onChange(e.target.value ? { user: e.target.value } : undefined)} {...described} />
          <p className="text-caption text-muted-foreground">{t("pages.issueDetail.userHint", { provider })}</p>
          {err}
        </div>
      );
    case "unknown":
      return null;
  }
}
