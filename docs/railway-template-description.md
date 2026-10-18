# Deploy and Host Bemby on Railway

Bemby is a self-hosted automation tool for managing daily Telegram bot check-ins and Emby video watch sessions. It includes a web admin portal supporting multiple accounts, a built-in task scheduler, real-time logs, AI-assisted button recognition, and Telegram notifications.

## About Hosting Bemby

Hosting Bemby involves running a persistent Node.js/Express server that maintains active Telegram MTProto connections and a background task scheduler, together with a MongoDB instance that holds all of its data. A single container serves the backend API, the Vue 3 web portal, and the scheduler together. Railway provisions the container directly from the official Docker Hub image and exposes it on port 3000. You supply an admin username, password, a JWT secret, and a MongoDB connection string at deploy time — everything else is handled automatically.

## Common Use Cases

- Automate daily Telegram bot check-ins across multiple accounts on a randomised schedule
- Simulate Emby media server watch sessions to maintain active membership status
- Run multi-step custom Telegram bot workflows with AI-assisted captcha and button recognition

## Dependencies for Bemby Hosting

- A Telegram API ID and API Hash from [my.telegram.org/apps](https://my.telegram.org/apps) — required to add Telegram accounts for check-in tasks
- An Emby server URL and account credentials — required for Emby watch tasks

### Deployment Dependencies

- Docker Hub image: [liveinaus/bemby](https://hub.docker.com/r/liveinaus/bemby)
- Source code: [github.com/liveinaus/Bemby](https://github.com/liveinaus/Bemby)
- Telegram API credentials: [my.telegram.org/apps](https://my.telegram.org/apps)

### Implementation Details

Three environment variables must be set at deploy time:

```
ADMIN_USERNAME   # Web portal login username
ADMIN_PASSWORD   # Web portal login password
JWT_SECRET       # Random secret for session tokens — generate with: openssl rand -hex 32
MONGODB_URI      # MongoDB connection string — add a MongoDB service in Railway and paste its URL here
```

A persistent volume mounted at `/app/data` is still worth having: it keeps the downloaded browser, its profiles and fonts across restarts, so an upgrade does not re-download them.

## Why Deploy Bemby on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying Bemby on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
