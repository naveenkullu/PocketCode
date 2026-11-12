# Security

PocketCode is early-stage software. The controls below are based on the current source, not a security certification or guarantee. Review and test the application before exposing it to users, especially while agent-runtime recovery is in progress.

## Implemented controls

- **Authentication:** GitHub OAuth uses server-side session handling and PKCE-related state. Session cookies and ownership checks are implemented in the authentication/routes layer.
- **CSRF:** State-changing authenticated API operations validate a CSRF token.
- **Credential handling:** Web AI provider credentials and GitHub credentials are stored encrypted when configured with `TOKEN_ENCRYPTION_KEY`. Provider credentials are not returned in the settings response. The encryption key must be 32 bytes encoded as 64 hexadecimal characters.
- **Provider configuration:** Provider selection and credentials are associated with the authenticated user. Agent sessions are invalidated when provider credentials are changed or removed.
- **Workspace ownership and paths:** Workspace services scope operations by user, validate relative paths, reject traversal and symlinks, and reject secret-looking filenames. Workspace file count, per-file size, and aggregate size are bounded in code.
- **Secret detection:** The secret scanner recognizes classes such as private keys, bearer tokens, JWTs, GitHub tokens, cloud-provider credentials, and credential assignments. It can redact detected values and configured literal credentials in provider-facing data.
- **Proposal control:** Proposed workspace changes have explicit approve/reject routes scoped to the workspace owner. Approval changes the isolated workspace; it does not push code to GitHub.
- **GitHub operations:** Repository access is performed through configured GitHub OAuth/App services. Persistent branch creation requires explicit confirmation and GitHub write permission.

## Limitations and operator responsibilities

- The active agent runtime is damaged and under recovery. Do not expose it as a production service or rely on it for unattended code modifications.
- A scanner is pattern-based; it cannot guarantee detection of every secret or sensitive data format. Do not send sensitive data to an AI provider unless you have authorization to do so.
- Encryption at rest depends on a strong, private `TOKEN_ENCRYPTION_KEY`. Back it up securely; losing it can make encrypted credentials unusable. Never commit it, print it, or put it in `.env.example`.
- OAuth/GitHub App secrets and private keys belong in a private local `.env` or deployment secret manager. Restrict GitHub App permissions to what the deployment needs.
- Use HTTPS and secure production cookie/configuration settings when deploying. The local development defaults are not production deployment guidance.
- Local SQLite databases may contain user/session/provider data and are excluded from source control. Protect backups and host-level storage.
- Secret scanning and workspace isolation do not replace code review, dependency review, or deployment hardening.

## Reporting a vulnerability

Do not include credentials, private repository contents, or exploit payloads in a public issue. Until a private security contact is published, report only a concise description and reproduction impact to the repository owner through a private channel.
