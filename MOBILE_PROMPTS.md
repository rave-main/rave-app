# Mobile Prompts

Copy-paste prompts for continuing work on rave-app from the Claude app on your phone.

## Deploy / redeploy
> In rave-main/rave-app, follow the Verify section of SETUP.md to check the frontend, backend and database
> are live. Report any failing step with the exact error.

## Health check
> Curl https://rave-app-eight.vercel.app/api/health and the backend's `/health` for rave-app and tell me
> whether each returns 200 and valid JSON, and whether the database check is ok.

## Add an endpoint
> In rave-main/rave-app, add a signed-in endpoint to the backend (follow backend/src/notes.js), with a migration
> in backend/src/db.js if it needs a table, tests in backend/test, and UI in frontend/src. Run the tests, then push
> to a branch and give me the Vercel preview URL.

## Fix "API offline"
> The rave-app frontend shows "API offline". Check /api/health on the Vercel URL, the /api rewrite in
> frontend/vercel.json, FRONTEND_ORIGIN and DATABASE_URL on Railway, and explain what to change.

## Security review
> Run a security review of rave-main/rave-app's backend: authentication and sessions, CORS, rate limiting,
> input validation, payload limits, headers. List issues by severity and fix anything high.
