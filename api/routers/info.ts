import { z } from "zod";
import { createRouter, permProcedure, protectedProcedure } from "../middleware";
import { readManifest } from "../downloads";
import {
  addHosts,
  dnsHostInput,
  extraHosts,
  getAccess,
  lanHostInput,
  setAccess,
  tailnetHosts,
  tailnetOrigins,
  tailscaleHostInput,
} from "../lib/serverHosts";

/** Server-wide: for whoever may manage the server. */
const server = permProcedure("manageServer");

export const infoRouter = createRouter({
  /**
   * How devices reach this server (Tailscale names, the user's DNS names,
   * LAN names) and the published app builds.
   */
  get: protectedProcedure.query(async () => ({
    tailnetHosts: await tailnetHosts(),
    tailnetOrigins: await tailnetOrigins(),
    customHosts: (await getAccess()).customHosts,
    lanHosts: await extraHosts(),
    downloads: readManifest(),
  })),

  /**
   * The desktop app shares this server on the Wi-Fi: its ".local" name and
   * LAN addresses must be accepted by the host check.
   */
  addHosts: server
    .input(z.object({ hosts: z.array(lanHostInput).min(1).max(20) }))
    .mutation(async ({ input }) => {
      await addHosts(input.hosts);
      return { hosts: await extraHosts() };
    }),

  /** Settings → Dispositivi: the Tailscale name and the user's own DNS names. */
  setAccess: server
    .input(
      z.object({
        tailscaleHost: tailscaleHostInput.nullable().optional(),
        tailscalePort: z.number().int().min(1).max(65535).nullable().optional(),
        customHosts: z.array(dnsHostInput).max(10).optional(),
      }),
    )
    .mutation(({ input }) => setAccess(input)),
});
