import { defineConfig } from "@neon/config/v1";

/**
 * Neon project misty-water-72985311 — Cometloop's Postgres and auth.
 * `auth: true` provisions Neon Auth (Better Auth) on the project: users,
 * sessions and organizations live as tables in this database, and the
 * organization is the tenant (docs/platform-architecture.md).
 * Non-default branches (PR previews via `neon checkout <name>`) expire on
 * their own so nothing accumulates.
 */
export default defineConfig({
  auth: true,
  branch: (branch) => {
    if (branch.isDefault) return {};
    if (!branch.exists) return { ttl: "7d" };
    return {};
  },
});
