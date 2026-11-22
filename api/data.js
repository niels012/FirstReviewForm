// Shared storage for review answers, so every device that opens the site sees the same data.
// Stored in the Neon Postgres database connected to this Vercel project (DATABASE_URL).
//
//   GET  /api/data                      -> { people: { "<PID>": { ...answers, updatedAt } } }
//   POST /api/data  { people: { ... } } -> saves the given people's answers
//
// Optional: set an EDIT_KEY environment variable in Vercel to require a passcode for saving.
import { neon } from "@neondatabase/serverless";

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

const CHECKS = ["largeTree", "sources", "hint", "dup", "dupMerged",
  "baptism", "confirmation", "initiatory", "endowment", "sealingParents", "sealingSpouse"];
const PID_RE = /^[A-Z0-9]{4}-[A-Z0-9]{3,4}$/;
const MAX_PEOPLE_PER_SAVE = 200;

let tableReady;
function ensureTable() {
  tableReady ??= sql`CREATE TABLE IF NOT EXISTS review_answers (
    pid        text PRIMARY KEY,
    data       jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.catch(err => { tableReady = undefined; throw err; });
  return tableReady;
}

// Keep only known fields with sensible types and sizes.
function clean(p) {
  const out = {};
  for (const k of CHECKS) out[k] = typeof p?.[k] === "string" ? p[k].slice(0, 60) : "";
  out.changes = Array.isArray(p?.changes)
    ? p.changes.filter(x => typeof x === "string").map(x => x.slice(0, 120)).slice(0, 50) : [];
  out.notes = typeof p?.notes === "string" ? p.notes.slice(0, 10000) : "";
  out.submitted = p?.submitted === true;
  const review = p?.review === "Assigned" ? "Started" : p?.review;
  out.review = ["Not Started", "Started", "Complete"].includes(review) ? review : "Not Started";
  // When the review was started / completed (milliseconds since 1970), or null
  for (const k of ["startedAt", "completedAt"]) out[k] = Number.isFinite(p?.[k]) && p[k] > 0 ? Math.round(p[k]) : null;
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(503).json({ error: "Database is not connected" });

  try {
    await ensureTable();

    if (req.method === "GET") {
      const rows = await sql`SELECT pid, data, updated_at FROM review_answers`;
      const people = {};
      for (const r of rows) people[r.pid] = { ...r.data, updatedAt: new Date(r.updated_at).getTime() };
      return res.status(200).json({ people });
    }

    if (req.method === "POST") {
      const key = process.env.EDIT_KEY;
      if (key && req.headers["x-edit-key"] !== key) return res.status(401).json({ error: "Passcode required" });

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
      const entries = Object.entries(body?.people && typeof body.people === "object" ? body.people : {})
        .filter(([pid]) => PID_RE.test(pid));
      if (!entries.length) return res.status(400).json({ error: "Nothing to save" });
      if (entries.length > MAX_PEOPLE_PER_SAVE) return res.status(413).json({ error: "Too many people in one save" });

      const saved = {};
      for (const [pid, p] of entries) {
        const data = clean(p);
        const [row] = await sql`
          INSERT INTO review_answers (pid, data, updated_at) VALUES (${pid}, ${JSON.stringify(data)}::jsonb, now())
          ON CONFLICT (pid) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
          RETURNING updated_at`;
        saved[pid] = new Date(row.updated_at).getTime();
      }
      return res.status(200).json({ ok: true, saved });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("api/data failed:", err);
    return res.status(500).json({ error: "Database error" });
  }
}
