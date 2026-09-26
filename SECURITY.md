# Security Policy

## Supported versions

Only the latest `main` branch and the latest published release, if one exists,
are expected to receive security fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature for this repository. If it
is not enabled yet, contact the repository maintainer [@ddannyc](https://github.com/ddannyc)
privately through GitHub and include:

- the affected commit or version;
- reproduction steps or a minimal proof of concept;
- the impact and any required configuration;
- a suggested fix, if available.

Do not include production credentials, customer data, access tokens, or other
secrets in a report. Rotate any potentially exposed secret immediately.

## Scope

This project handles authentication data, customer messages, uploaded files,
Facebook credentials, and AI-provider requests. Do not use real customer data
or production credentials in local development, tests, issues, or pull
requests.
