# Mobile Prompts

Copy-paste prompts for continuing work on rave-app from the Claude app on your phone.

## Deploy / redeploy
> In rave-main/rave-app, follow SETUP.md to verify the backend `/health` endpoint and the frontend
> are live. Report any failing step with the exact error.

## Health check
> Curl the production `/health`, `/api/users` and `/api/analytics` endpoints for rave-app and tell me
> whether each returns 200 and valid JSON.

## Add an endpoint
> In rave-main/rave-app, add `DELETE /api/users/:id` to backend/server.js (404 if missing, 204 on success),
> keep the same validation style, add a delete button in frontend/src/App.jsx, test locally, then commit and push.

## Fix CORS
> The rave-app frontend shows "API offline". Check that FRONTEND_ORIGIN on the backend matches the
> Vercel URL and that VITE_API_URL points at the backend, and explain what to change.

## Add persistence
> Replace the in-memory users array in rave-app's backend with SQLite (better-sqlite3), seeded with the
> same 3 users. Keep the API contract identical. Test, commit and push.

## Security review
> Run a security review of rave-main/rave-app's backend: CORS, rate limiting, input validation,
> payload limits, headers. List issues by severity and fix anything high.
