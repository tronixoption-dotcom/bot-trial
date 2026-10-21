# Copilot service

This Node.js service keeps GitHub OAuth tokens away from the browser and uses the GitHub Copilot SDK to return validated autonomous plans.

```powershell
npm install
$env:GITHUB_CLIENT_ID = "your-client-id"
$env:GITHUB_CLIENT_SECRET = "your-client-secret"
$env:PUBLIC_URL = "http://localhost:8787"
$env:FRONTEND_ORIGIN = "http://localhost:5173"
npm start
```

Register the OAuth callback as `PUBLIC_URL/auth/callback`. The trading UI should use the service URL as its Copilot base URL. Tokens are held in memory and expire after eight hours; restarting the service signs users out.
