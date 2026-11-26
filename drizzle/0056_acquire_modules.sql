-- acquireModules: browsing the whole Store catalogue and buying or requesting a module.
-- Owners and IT admins get it (they manage the Store, which implies it anyway); members don't.
UPDATE "roles" SET "permissions" = ("permissions"::jsonb || '["acquireModules"]'::jsonb)::text
  WHERE "system" = 1 AND "key" IN ('owner', 'it-admin') AND NOT ("permissions"::jsonb ? 'acquireModules');
