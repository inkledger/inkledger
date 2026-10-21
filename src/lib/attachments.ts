/** An attachment through the server, on the connection its issue lives on (a key may be on two). */
export function attachmentUrl(id: string, kind: "content" | "thumbnail", connectionId?: number | null): string {
  return `/api/attachments/${id}/${kind}${connectionId ? `?c=${connectionId}` : ""}`;
}
