# Security Policy

## Supported versions

Security fixes are accepted against the latest `main` branch of this repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email or message the maintainers privately with:

- Affected version / commit
- Reproduction steps
- Impact assessment (auth bypass, XSS, secret leak, etc.)

We will acknowledge the report and work on a fix before any public disclosure.

## Hardening tips for operators

- Change all seeded demo passwords on first login.
- Set `ONE_API_ADMIN_TOKEN`, `SKILL_GATEWAY_TOKEN`, and `KB_BRIDGE_SECRET` via environment or a secrets volume — never commit them.
- Prefer a separate origin for user uploads (`files-nginx.conf`) so uploaded content cannot read the portal origin’s session token.
- Keep `DATA_DIR` off public object storage without access controls; it contains password hashes and session secrets.
