# Setup & Deployment

## 1. Push to GitHub

```bash
gh auth login
gh repo create rave-main/rave-app --private --source=. --remote=origin --push
```
(Or create an empty private repo named `rave-app` on github.com without a README, then
`git remote add origin https://github.com/rave-main/rave-app.git && git push -u origin main`.)

## 2. Deploy the backend (Render, free tier)

1. https://dashboard.render.com → **New → Web Service** → connect `rave-main/rave-app`
2. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
3. Environment variables: `FRONTEND_ORIGIN=http://localhost:5173` (this is updated in step 4)
4. Deploy, then check `https://<your-service>.onrender.com/health`

> Render injects `PORT` automatically; the server uses it, falling back to 3000.
> Free instances sleep after inactivity, so the first request can take ~30s.

## 3. Deploy the frontend (Vercel)

1. https://vercel.com/new → import `rave-main/rave-app`
2. **Root Directory:** `frontend` (Vercel detects Vite; `vercel.json` covers the rest)
3. Environment variable: `VITE_API_URL=https://<your-service>.onrender.com` (no trailing slash)
4. Deploy and note the URL, for example `https://rave-app.vercel.app`

CLI alternative:
```bash
cd frontend && npx vercel --prod -e VITE_API_URL=https://<your-service>.onrender.com
```

## 4. Lock CORS to the frontend

On Render, set `FRONTEND_ORIGIN=https://rave-app.vercel.app` (to allow several origins, separate them with commas,
for example `https://rave-app.vercel.app,http://localhost:5173`) and redeploy.

## 5. Verify

```bash
API=https://<your-service>.onrender.com
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
