# Setup & Deployment

## 1. Push to GitHub

```bash
gh auth login
gh repo create rave-main/rave-app --private --source=. --remote=origin --push
```
(Or create an empty private repo named `rave-app` on github.com without a README, then
`git remote add origin https://github.com/rave-main/rave-app.git && git push -u origin main`.)

## 2. Deploy the backend (Railway)

1. https://railway.com/new → **Deploy from GitHub repo** → `rave-main/rave-app`
2. Service **Settings**:
   - **Root Directory:** `/backend`
   - **Start Command:** `npm start` (detected automatically)
   - **Networking → Generate Domain**
3. **Variables:** `FRONTEND_ORIGIN=http://localhost:5173` (this is updated in step 4)
4. Deploy, then check `https://<your-service>.up.railway.app/health`

CLI alternative (needs `RAILWAY_TOKEN`):
```bash
cd backend && npx @railway/cli up --service rave-app-backend
```

> Railway injects `PORT` automatically; the server uses it, falling back to 3000.

## 3. Deploy the frontend (Vercel)

1. https://vercel.com/new → import `rave-main/rave-app`
2. **Root Directory:** `frontend` (Vercel detects Vite; `vercel.json` covers the rest)
3. Environment variable: `VITE_API_URL=https://<your-service>.up.railway.app` (no trailing slash)
4. Deploy and note the URL, for example `https://rave-app.vercel.app`

CLI alternative:
```bash
cd frontend && npx vercel --prod -e VITE_API_URL=https://<your-service>.up.railway.app
```

Once the project is linked to the GitHub repo (Vercel GitHub App installed on `rave-main`), every push to `main`
deploys to production automatically, and pushes to other branches get preview deployments.

## 4. Lock CORS to the frontend

On Railway, set `FRONTEND_ORIGIN=https://rave-app.vercel.app` (to allow several origins, separate them with commas,
for example `https://rave-app.vercel.app,http://localhost:5173`) and redeploy.

## 5. Verify

```bash
API=https://<your-service>.up.railway.app
curl $API/health
curl $API/api/users
curl -X POST $API/api/users -H 'Content-Type: application/json' -d '{"name":"Test User","email":"test@example.com"}'
```
Open the Vercel URL. The status badge should read **API online** and show the users and analytics.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "API offline" / CORS error in console | `FRONTEND_ORIGIN` must exactly match the Vercel URL (scheme included, no trailing slash) |
| Frontend still calls localhost | `VITE_API_URL` is baked in at build time; redeploy Vercel after changing it |
| `429 Too many requests` | Rate limit (100/min/IP); wait a minute |
| `413 Payload too large` | Request body is over 1KB |
