import { useEffect, useId, useRef, useState } from "react";
import { failureText } from "@/lib/errorText";
import { FormError } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

export type RenameValues = { displayName: string; username: string };

/** A username the server refused (taken, or not a valid one) is the username's error; anything else the form's. */
const onUsername = (error: unknown) => {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === "CONFLICT" || code === "BAD_REQUEST";
};

/**
 * An account's name and username (its own in Account, another in Users). A username
 * refused by the server takes the focus, its message tied to it; `onDirty` tells the
 * dialog's close guard whether anything was changed.
 */
export function RenameForm({
  initial,
  pending,
  error,
  onSubmit,
  onDirty,
}: {
  initial: RenameValues;
  pending: boolean;
  error: unknown;
  onSubmit: (values: RenameValues) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const id = useId();
  const [values, setValues] = useState(initial);
  const username = useRef<HTMLInputElement>(null);
  const usernameError = error && onUsername(error) ? failureText(error) : null;
  const formError = error && !onUsername(error) ? failureText(error) : null;

  useEffect(() => {
    if (usernameError) username.current?.focus();
  }, [error, usernameError]);

  const change = (next: RenameValues) => {
    setValues(next);
    onDirty(next.displayName !== initial.displayName || next.username !== initial.username);
  };
  const unchanged = values.displayName.trim() === initial.displayName && values.username.trim().toLowerCase() === initial.username;

  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        onSubmit({ displayName: values.displayName.trim(), username: values.username.trim() });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>{t("settings.users.displayName")}</Label>
        <Input id={`${id}-name`} value={values.displayName} maxLength={80} onChange={e => change({ ...values, displayName: e.target.value })} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-username`}>{t("settings.users.username")}</Label>
        <Input
          ref={username}
          id={`${id}-username`}
          value={values.username}
          maxLength={64}
          onChange={e => change({ ...values, username: e.target.value })}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={usernameError ? true : undefined}
          aria-describedby={usernameError ? `${id}-username-error` : undefined}
          required
        />
        {usernameError && (
          <p id={`${id}-username-error`} role="alert" className="text-body-sm text-danger">
            {usernameError}
          </p>
        )}
      </div>
      <FormError message={formError} />
      <Button type="submit" disabled={pending || unchanged || values.displayName.trim() === ""}>
        {t("settings.users.renameSave")}
      </Button>
    </form>
  );
}
