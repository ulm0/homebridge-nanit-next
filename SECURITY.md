# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `homebridge-nanit`, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities via one of the following:

- **GitHub Security Advisories**: Use the [Report a vulnerability](https://github.com/ulm0/homebridge-nanit/security/advisories/new) feature on GitHub.
- **Email**: Contact the maintainer directly at the email listed in the npm package or GitHub profile.

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The affected version(s)
- Any suggested fix (optional but appreciated)

### Response timeline

- **Acknowledgment**: Within 72 hours of receiving your report
- **Initial assessment**: Within 1 week
- **Fix and release**: As soon as a fix is ready, typically within 2 weeks for critical issues

### Scope

The following are in scope:

- Authentication and token handling
- Network security (WebSocket, RTMP, RTSP connections)
- Input validation and injection vulnerabilities
- Sensitive data exposure (tokens, credentials, camera feeds)
- Dependencies with known vulnerabilities

The following are out of scope:

- Vulnerabilities in the Nanit API itself (report these to Nanit)
- Vulnerabilities in Homebridge core (report these to the Homebridge project)
- Issues requiring physical access to the Homebridge host
- Social engineering attacks

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | Yes                |
| < 1.0   | No                 |
