# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public issue.**
2. Email **kan.fushihara@gmail.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. You will receive an acknowledgment within 48 hours.
4. A fix will be released as soon as possible, typically within 7 days.

## Scope

The following are in scope:

- XSS / code injection via rendered content (markdown preview, file icons, etc.)
- Command injection via shell spawning, git CLI, or search execution
- Path traversal in file system or project operations
- Tauri IPC privilege escalation
- Supply chain risks in bundled binaries

Out of scope:

- Denial of service
- Attacks requiring physical access to the machine
- Social engineering
- Vulnerabilities in upstream dependencies (report to the upstream project instead)
