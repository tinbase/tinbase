# Compliance

tinbase is a local-first, Docker-free Supabase-compatible backend. This document
is an honest map of what the software provides toward common compliance regimes
and, just as importantly, what it does **not** provide.

Read the first section before assuming any of the badges you may have seen
elsewhere apply here.

## What certifications actually mean

SOC 2 Type 2, ISO 27001, and HIPAA are **not** properties of a codebase. They are
organizational audits and legal regimes:

- **SOC 2 Type 2** audits a company's operational controls (access management,
  change control, monitoring, incident response) over a 6–12 month window,
  performed by an external auditor. It certifies an organization, not a library.
- **ISO 27001** certifies an Information Security Management System (ISMS), again
  an organization-level audit.
- **HIPAA** is a US legal regime for protected health information, involving
  Business Associate Agreements and administrative/physical/technical safeguards.
  It is a compliance obligation of the entity handling the data, not a feature.

tinbase is an alpha, self-hosted library. It has no hosted service, no company
operating it, and no audit. **It cannot be "SOC 2 certified", "ISO 27001
certified", or "HIPAA compliant" on its own**, and this repository makes no such
claim. What tinbase can do is provide technical building blocks that make it
easier for an operator who runs it to meet those regimes.

## GDPR

GDPR is the one regime with concrete, code-level mechanics, and tinbase ships
primitives for the main data-subject rights.

| Right | Support |
|---|---|
| Access / portability (Art. 15/20) | `GET /auth/v1/admin/users/:id/export` (service_role) returns the user's profile, identities, sessions, and MFA factors as JSON, with credentials stripped. |
| Erasure (Art. 17) | `DELETE /auth/v1/admin/users/:id` removes the user and cascades auth rows; returns a summary and a 404 for a missing user. **See the storage caveat below.** |
| Data minimization (Art. 5) | The `RetentionService` purges expired tokens, challenges, flow state, aged-out refresh tokens, and old audit entries. Windows are configurable. |
| Records of processing / audit | `auth.audit_log_entries` records auth and admin events; readable at `GET /auth/v1/admin/audit`. |

**Storage erasure caveat.** `storage.objects.owner` has no foreign key to
`auth.users`, so deleting a user does **not** remove their storage objects or the
underlying bytes. To fully erase a user you must also delete their objects, e.g.:

```sql
-- find and delete object rows owned by the user, then delete the bytes via the
-- storage API or driver for each returned key
delete from storage.objects where owner = '<user-id>' returning bucket_id, name;
```

## Security building blocks tinbase provides

- **Row Level Security**: real Postgres RLS, enforced per request via the request
  role and `request.jwt.claims`. This is the core tenant-isolation primitive.
- **Audit trail**: append-only `auth.audit_log_entries` for signup, login, failed
  login, logout, user erasure, and data export.
- **Secret encryption at rest**: the Vault emulation encrypts secrets with
  pgcrypto under a key held only in a session GUC (`app.settings.vault_key`), set
  from the `vaultKey` config (defaults to a value derived from `jwtSecret`).
- **Sensitive-data log hygiene**: OTP codes and magic links are not written to the
  server log by default (opt in with `logMailBody`).
- **Data retention**: configurable background cleanup (`RetentionService`).
- **Transport-layer auth**: HS256 JWTs with the algorithm pinned on verification.

## What the operator is responsible for

These are outside the software and required for any real compliance posture:

- **Change the default secrets.** Set `jwtSecret` and `vaultKey` to strong,
  unique values. The defaults are the well-known Supabase local-dev secret and a
  key derived from it; anything using the defaults is fully forgeable.
- **Transport encryption (TLS).** tinbase serves plain HTTP; terminate TLS at a
  reverse proxy or load balancer.
- **Encryption at rest for the database and object storage.** Vault secrets are
  encrypted, but the rest of the database and stored objects are only as encrypted
  as the disk/volume they sit on. Use encrypted volumes.
- **Access control and network exposure.** Do not expose the admin UI, `/inbox`
  dev mailer, or the backend itself to untrusted networks. `/inbox` serves email
  contents with no auth and is dev-only.
- **Backups, monitoring, incident response, and the organizational controls** that
  SOC 2 / ISO 27001 / HIPAA actually audit.
- **A HIPAA Business Associate Agreement** with any subprocessor, and a full risk
  assessment, if handling PHI.

## Production readiness

The project README currently describes tinbase as alpha and not production-ready.
Treat this document as a description of direction and available primitives, not as
a certification or a warranty. Nothing here should be read as legal advice.
