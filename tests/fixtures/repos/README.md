# S5 vulnerable fixture repos (D6 owned)
- vuln-secrets: hardcoded creds/keys -> Gitleaks + Semgrep
- vuln-injection: command/SQL injection + eval -> Semgrep
- vuln-deps: vulnerable npm deps -> SCA / npm audit