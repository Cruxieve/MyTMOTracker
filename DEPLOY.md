# Running My TMO Tracker outside Claude

This folder is a complete, standalone React project. There's no external
service involved — everything (sales, customers, categories, SPIFFs,
goals) is stored locally in the browser, the same way it works inside
Claude right now. Deploying just gets you a real, permanent URL instead
of a preview link.

Nothing to configure — no accounts, no keys, no setup. Install and run.

---

## Option A — Run it on your own computer

**1. Install Node.js** (one-time, skip if you already have it)
Go to https://nodejs.org, download the "LTS" version, run the installer.

**2. Open a terminal in this folder**
- Windows: open the `tmo-tracker-app` folder in File Explorer, type `cmd`
  in the address bar, press Enter.
- Mac: right-click the `tmo-tracker-app` folder → Services → "New
  Terminal at Folder" (or open Terminal and `cd` into the folder).

**3. Install dependencies** (one-time)
```
npm install
```

**4. Run it**
```
npm run dev
```
Terminal will print a URL like `http://localhost:5173` — open that in
your browser. This is the real app, running locally on your machine.

Leave the terminal window open while you're using it this way; closing
it stops the app. This is a good way to confirm everything works before
deploying it somewhere permanent (Option B).

---

## Option B — Put it on the internet (free, so you can use it from your phone)

**Vercel** is the easiest option and has a generous free tier.

**1. Push this folder to GitHub**
- Create a free account at https://github.com if you don't have one.
- Create a new repository, upload this whole `tmo-tracker-app` folder to it.
  (GitHub's website lets you drag-and-drop files if you don't want to use
  git commands.)

**2. Connect Vercel**
- Go to https://vercel.com, sign up (you can sign up with your GitHub
  account directly, which makes step 3 easier).
- Click "Add New… → Project," pick the repository you just created.
- Vercel auto-detects this is a Vite project — leave the default settings
  and click "Deploy."

**3. Done**
In about a minute you'll get a real URL like
`my-tmo-tracker.vercel.app` — open it on your phone, bookmark it or "Add
to Home Screen," and it behaves like a real app icon. Every time you
push changes to GitHub, Vercel automatically redeploys.

---

## About your data once deployed

Everything stays in that browser's local storage on that device — the
same privacy model as right now, just without the Claude wrapper around
it. Nothing is sent to any server, which matters given this holds
customer information.

A couple of practical notes that come with that:

- **Local storage is tied to one browser on one device.** If you open
  the deployed URL on your phone and your laptop, those are two separate,
  unsynced copies of the app. Pick the one you'll actually use day to day.
- **Clearing your browser's site data, or switching browsers/devices,
  starts you fresh.** Use **Settings → Backup & Restore** regularly —
  it downloads an actual file you control, and it's the only way to move
  data between devices or recover it if local storage ever gets wiped.
- Store those backup files somewhere that matches your employer's policy
  for handling customer data, same as any other file with that
  information in it.
