# S5 security-vulnerable fixture repos (D6 owned)
- vuln-secrets (../repos/vuln-secrets): hardcoded creds/keys -> Gitleaks + Semgrep
- vuln-injection: command/SQL injection + eval -> Semgrep
- vuln-deps: vulnerable npm deps -> SCA / npm audit
- web-sqli-xss: sqli + xss -> Semgrep
- gitleaks-fp: fake/example secrets -> FP-handling validation